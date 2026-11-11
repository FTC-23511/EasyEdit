import { z } from "zod";
import { LIMITS } from "@/lib/limits";
import { OpError } from "./errors";
import type { Op } from "./ops";
import { FORMAT_PRESETS, TRACK_ACCEPTS } from "./presets";
import { MediaClip, TextClip, Transform, TextStyle } from "./types";
import type { Clip, TimelineDoc, Track } from "./types";

// update_clip re-validates strictly so a typo'd or foreign key is rejected, not dropped.
const StrictMediaClip = MediaClip.extend({ transform: Transform.strict() }).strict();
const StrictTextClip = TextClip.extend({ transform: Transform.strict(), style: TextStyle.strict() }).strict();
const FROZEN_CLIP_KEYS = ["id", "type", "start", "duration"];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => isEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => k in b && isEqual(a[k], b[k]));
  }
  return false;
}

// The fields that differ between before and after, with their old and new values.
function diffFields<T extends object>(before: T, after: T): { old: Partial<T>; now: Partial<T> } {
  const old: Partial<T> = {};
  const now: Partial<T> = {};
  for (const key of Object.keys(before) as (keyof T)[]) {
    if (!isEqual(before[key], after[key])) {
      old[key] = before[key];
      now[key] = after[key];
    }
  }
  return { old, now };
}

// An op's `expect` guard: every listed field must still hold its listed value.
// Plain objects (transform, style) compare only their listed sub-keys.
function holds(current: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => {
    if (value === undefined) return true;
    const actual = current[key];
    if (isPlainObject(value) && isPlainObject(actual)) {
      return Object.entries(value).every(([sub, v]) => isEqual(actual[sub], v));
    }
    return isEqual(actual, value);
  });
}

// The same ids, in any order.
function sameIds(actual: string[], expected: string[]): boolean {
  const set = new Set(expected);
  return actual.length === expected.length && set.size === expected.length && actual.every((id) => set.has(id));
}

function sortTrack(track: Track) {
  track.clips.sort((a, b) => a.start - b.start);
}

function findTrack(doc: TimelineDoc, trackId: string, opIndex: number, opName: string) {
  const trackIndex = doc.tracks.findIndex((t) => t.id === trackId);
  if (trackIndex < 0) throw new OpError("NOT_FOUND", `${opName}: track "${trackId}" not found`, opIndex);
  return { track: doc.tracks[trackIndex], trackIndex };
}

function findClip(doc: TimelineDoc, clipId: string, opIndex: number, opName: string) {
  for (let trackIndex = 0; trackIndex < doc.tracks.length; trackIndex++) {
    const track = doc.tracks[trackIndex];
    const clipIndex = track.clips.findIndex((c) => c.id === clipId);
    if (clipIndex >= 0) return { track, trackIndex, clipIndex };
  }
  throw new OpError("NOT_FOUND", `${opName}: clip "${clipId}" not found`, opIndex);
}

function assertUnlocked(track: Track, opIndex: number, opName: string) {
  if (track.locked) {
    throw new OpError("TRACK_LOCKED", `${opName}: track "${track.id}" is locked`, opIndex);
  }
}

function assertAccepts(track: Track, clip: Clip, opIndex: number, opName: string) {
  if (!TRACK_ACCEPTS[track.kind].includes(clip.type)) {
    throw new OpError(
      "WRONG_TRACK_KIND",
      `${opName}: ${clip.type} clip "${clip.id}" cannot go on ${track.kind} track "${track.id}"`,
      opIndex,
    );
  }
}

function assertNoOverlap(track: Track, opIndex: number, opName: string) {
  const sorted = [...track.clips].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const next = sorted[i];
    if (prev.start + prev.duration > next.start) {
      throw new OpError(
        "OVERLAP",
        `${opName}: clips "${prev.id}" and "${next.id}" overlap on track "${track.id}"`,
        opIndex,
      );
    }
  }
}

function assertRoomForTrack(doc: TimelineDoc, opIndex: number, opName: string) {
  if (doc.tracks.length + 1 > LIMITS.tracksPerProject) {
    throw new OpError("LIMIT_EXCEEDED", `${opName}: a project can have at most ${LIMITS.tracksPerProject} tracks`, opIndex);
  }
}

function assertClipCount(trackId: string, countAfter: number, opIndex: number, opName: string) {
  if (countAfter > LIMITS.clipsPerTrack) {
    throw new OpError("LIMIT_EXCEEDED", `${opName}: track "${trackId}" can have at most ${LIMITS.clipsPerTrack} clips`, opIndex);
  }
}

function assertOneCaptionTrack(doc: TimelineDoc, incoming: Track, replacedIndex: number, opIndex: number, opName: string) {
  const countNow = doc.tracks.filter((t) => t.kind === "caption").length;
  const replaced = replacedIndex >= 0 && doc.tracks[replacedIndex].kind === "caption" ? 1 : 0;
  const countAfter = countNow - replaced + (incoming.kind === "caption" ? 1 : 0);
  if (countAfter > 1 && countAfter > countNow) {
    throw new OpError("INVALID", `${opName}: a project can have only one caption track`, opIndex);
  }
}

function clipIdInUse(doc: TimelineDoc, clipId: string, exceptTrackId?: string): boolean {
  return doc.tracks.some((t) => t.id !== exceptTrackId && t.clips.some((c) => c.id === clipId));
}

export function applyOps(input: TimelineDoc, ops: Op[]): { doc: TimelineDoc; inverse: Op[] } {
  const doc = structuredClone(input);
  // One group of inverse ops per op, each in apply order. The groups are reversed
  // at the end, so a multi-op group keeps its own order.
  const groups: Op[][] = [];

  ops.forEach((op, opIndex) => {
    const name = op.op;
    const stale = (what: string) => new OpError("STALE", `${name}: ${what} changed since this edit`, opIndex);
    switch (op.op) {
      case "add_track": {
        if (doc.tracks.some((t) => t.id === op.track.id)) {
          throw new OpError("DUPLICATE_ID", `${name}: track id "${op.track.id}" already exists`, opIndex);
        }
        const index = op.index ?? doc.tracks.length;
        if (index < 0 || index > doc.tracks.length) {
          throw new OpError(
            "INVALID",
            `${name}: index ${index} is outside 0..${doc.tracks.length} for track "${op.track.id}"`,
            opIndex,
          );
        }
        assertRoomForTrack(doc, opIndex, name);
        assertOneCaptionTrack(doc, op.track as Track, -1, opIndex, name);
        doc.tracks.splice(index, 0, {
          id: op.track.id,
          kind: op.track.kind,
          name: op.track.name,
          muted: false,
          hidden: false,
          locked: false,
          clips: [],
        });
        groups.push([{ op: "remove_track", trackId: op.track.id, expect: { clipIds: [] } }]);
        break;
      }

      case "remove_track": {
        const { track, trackIndex } = findTrack(doc, op.trackId, opIndex, name);
        if (op.expect && !sameIds(track.clips.map((c) => c.id), op.expect.clipIds)) {
          throw stale(`track "${op.trackId}"`);
        }
        const [removed] = doc.tracks.splice(trackIndex, 1);
        groups.push([{ op: "replace_track", track: removed, index: trackIndex, restore: true }]);
        break;
      }

      case "update_track": {
        const { track } = findTrack(doc, op.trackId, opIndex, name);
        if (op.expect && !holds(track, op.expect)) throw stale(`track "${op.trackId}"`);
        const fields = (t: Track) => ({ name: t.name, muted: t.muted, hidden: t.hidden, locked: t.locked });
        const before = fields(track);
        if (op.patch.name !== undefined) track.name = op.patch.name;
        if (op.patch.muted !== undefined) track.muted = op.patch.muted;
        if (op.patch.hidden !== undefined) track.hidden = op.patch.hidden;
        if (op.patch.locked !== undefined) track.locked = op.patch.locked;
        const { old, now } = diffFields(before, fields(track));
        if (Object.keys(old).length) {
          groups.push([{ op: "update_track", trackId: op.trackId, patch: old, expect: now }]);
        }
        break;
      }

      case "move_track": {
        const { trackIndex } = findTrack(doc, op.trackId, opIndex, name);
        if (op.expect && op.expect.index !== trackIndex) throw stale(`track "${op.trackId}"`);
        const [moved] = doc.tracks.splice(trackIndex, 1);
        const index = Math.min(op.index, doc.tracks.length);
        doc.tracks.splice(index, 0, moved);
        if (index !== trackIndex) {
          groups.push([{ op: "move_track", trackId: op.trackId, index: trackIndex, expect: { index } }]);
        }
        break;
      }

      case "replace_track": {
        const incoming = structuredClone(op.track);
        const existingIndex = doc.tracks.findIndex((t) => t.id === incoming.id);
        if (op.restore && existingIndex >= 0) {
          throw new OpError("DUPLICATE_ID", `${name}: track id "${incoming.id}" already exists`, opIndex);
        }
        if (!op.restore && existingIndex < 0 && (op.index < 0 || op.index > doc.tracks.length)) {
          throw new OpError(
            "INVALID",
            `${name}: index ${op.index} is outside 0..${doc.tracks.length} for track "${incoming.id}"`,
            opIndex,
          );
        }
        if (existingIndex < 0) assertRoomForTrack(doc, opIndex, name);
        assertOneCaptionTrack(doc, incoming, existingIndex, opIndex, name);
        const before = existingIndex >= 0 ? doc.tracks[existingIndex].clips.length : 0;
        if (incoming.clips.length > before) assertClipCount(incoming.id, incoming.clips.length, opIndex, name);
        const seen = new Set<string>();
        for (const c of incoming.clips) {
          if (seen.has(c.id) || clipIdInUse(doc, c.id, incoming.id)) {
            throw new OpError("DUPLICATE_ID", `${name}: clip id "${c.id}" already exists`, opIndex);
          }
          seen.add(c.id);
          assertAccepts(incoming, c, opIndex, name);
        }
        sortTrack(incoming);
        assertNoOverlap(incoming, opIndex, name);
        if (existingIndex >= 0) {
          groups.push([{ op: "replace_track", track: doc.tracks[existingIndex], index: existingIndex }]);
          doc.tracks[existingIndex] = incoming;
        } else {
          groups.push([{ op: "remove_track", trackId: incoming.id, expect: { clipIds: incoming.clips.map((c) => c.id) } }]);
          doc.tracks.splice(Math.min(op.index, doc.tracks.length), 0, incoming);
        }
        break;
      }

      case "add_clip": {
        const { track } = findTrack(doc, op.trackId, opIndex, name);
        assertUnlocked(track, opIndex, name);
        if (clipIdInUse(doc, op.clip.id)) {
          throw new OpError("DUPLICATE_ID", `${name}: clip id "${op.clip.id}" already exists`, opIndex);
        }
        assertAccepts(track, op.clip, opIndex, name);
        assertClipCount(track.id, track.clips.length + 1, opIndex, name);
        if (op.ripple) {
          for (const c of track.clips) if (c.start >= op.clip.start) c.start += op.clip.duration;
          // Guarded: if the new clip was moved or resized since, closing the gap where it now sits would leave one where it was.
          groups.push([
            { op: "remove_clip", clipId: op.clip.id, ripple: true, expect: { start: op.clip.start, duration: op.clip.duration } },
          ]);
        } else {
          groups.push([{ op: "remove_clip", clipId: op.clip.id }]);
        }
        track.clips.push(structuredClone(op.clip));
        sortTrack(track);
        assertNoOverlap(track, opIndex, name);
        break;
      }

      case "remove_clip": {
        const { track, clipIndex } = findClip(doc, op.clipId, opIndex, name);
        assertUnlocked(track, opIndex, name);
        if (op.expect && !holds(track.clips[clipIndex], op.expect)) throw stale(`clip "${op.clipId}"`);
        const [removed] = track.clips.splice(clipIndex, 1);
        if (op.ripple) {
          const removedEnd = removed.start + removed.duration;
          for (const c of track.clips) if (c.start >= removedEnd) c.start -= removed.duration;
          groups.push([{ op: "add_clip", trackId: track.id, clip: removed, ripple: true }]);
        } else {
          groups.push([{ op: "add_clip", trackId: track.id, clip: removed }]);
        }
        sortTrack(track);
        break;
      }

      case "move_clip": {
        const from = findClip(doc, op.clipId, opIndex, name);
        const moving = from.track.clips[from.clipIndex];
        if (op.expect && !holds({ start: moving.start, trackId: from.track.id }, op.expect)) {
          throw stale(`clip "${op.clipId}"`);
        }
        const to = op.trackId ? findTrack(doc, op.trackId, opIndex, name) : from;
        assertUnlocked(from.track, opIndex, name);
        assertUnlocked(to.track, opIndex, name);
        assertAccepts(to.track, moving, opIndex, name);
        if (to.trackIndex !== from.trackIndex) assertClipCount(to.track.id, to.track.clips.length + 1, opIndex, name);
        groups.push([
          to.trackIndex === from.trackIndex
            ? { op: "move_clip", clipId: op.clipId, start: moving.start, expect: { start: op.start } }
            : {
                op: "move_clip",
                clipId: op.clipId,
                start: moving.start,
                trackId: from.track.id,
                expect: { start: op.start, trackId: to.track.id },
              },
        ]);
        from.track.clips.splice(from.clipIndex, 1);
        moving.start = op.start;
        to.track.clips.push(moving);
        sortTrack(to.track);
        assertNoOverlap(to.track, opIndex, name);
        break;
      }

      case "trim_clip": {
        const { track, clipIndex } = findClip(doc, op.clipId, opIndex, name);
        assertUnlocked(track, opIndex, name);
        const target = track.clips[clipIndex];
        if (op.expect && !holds(target, op.expect)) throw stale(`clip "${op.clipId}"`);
        if (op.in !== undefined && (op.edge !== "start" || target.type === "text")) {
          throw new OpError(
            "INVALID",
            `${name}: "in" is only allowed when trimming the start of a media clip`,
            opIndex,
          );
        }
        const outOfRange = (why: string) =>
          new OpError("TRIM_OUT_OF_RANGE", `${name}: clip "${op.clipId}" ${why}`, opIndex);
        if (op.to < 0) throw outOfRange(`${op.edge} cannot move to frame ${op.to}`);
        let start = target.start;
        let duration = target.duration;
        let sourceIn: number | undefined;
        if (op.edge === "start") {
          const delta = op.to - target.start;
          start = op.to;
          duration = target.duration - delta;
          // An image has no source timeline, so a start trim leaves its `in` alone.
          if (op.in !== undefined) {
            sourceIn = op.in;
          } else if (target.type === "video" || target.type === "audio") {
            sourceIn = target.in + Math.round(delta * target.speed);
            if (sourceIn < 0) throw outOfRange("cannot start before the start of its source");
          }
        } else {
          duration = op.to - target.start;
        }
        if (duration < 1) throw outOfRange(`would have a duration of ${duration} frames`);
        // An end-trim undo sets the end, so it needs start and duration unchanged. A
        // start-trim undo keeps the current end, so a later end trim by someone else survives it.
        if (op.edge === "end") {
          const to = target.start + target.duration;
          groups.push([{ op: "trim_clip", clipId: op.clipId, edge: "end", to, expect: { start, duration } }]);
        } else if (target.type === "text" || sourceIn === undefined) {
          groups.push([{ op: "trim_clip", clipId: op.clipId, edge: "start", to: target.start, expect: { start } }]);
        } else {
          groups.push([
            {
              op: "trim_clip",
              clipId: op.clipId,
              edge: "start",
              to: target.start,
              in: target.in,
              expect: { start, in: sourceIn },
            },
          ]);
        }
        target.start = start;
        target.duration = duration;
        if (target.type !== "text" && sourceIn !== undefined) target.in = sourceIn;
        sortTrack(track);
        assertNoOverlap(track, opIndex, name);
        break;
      }

      case "split_clip": {
        const { track, clipIndex } = findClip(doc, op.clipId, opIndex, name);
        assertUnlocked(track, opIndex, name);
        const left = track.clips[clipIndex];
        const end = left.start + left.duration;
        if (op.at <= left.start || op.at >= end) {
          throw new OpError(
            "INVALID",
            `${name}: at ${op.at} must be inside clip "${op.clipId}" (${left.start}, ${end})`,
            opIndex,
          );
        }
        if (clipIdInUse(doc, op.newClipId)) {
          throw new OpError("DUPLICATE_ID", `${name}: clip id "${op.newClipId}" already exists`, opIndex);
        }
        assertClipCount(track.id, track.clips.length + 1, opIndex, name);
        groups.push([
          { op: "remove_clip", clipId: op.newClipId, expect: { start: op.at, duration: end - op.at } },
          {
            op: "trim_clip",
            clipId: op.clipId,
            edge: "end",
            to: end,
            expect: { start: left.start, duration: op.at - left.start },
          },
        ]);
        const right = structuredClone(left);
        right.id = op.newClipId;
        right.start = op.at;
        right.duration = end - op.at;
        if (right.type !== "text" && left.type !== "text") {
          right.in = left.in + Math.round((op.at - left.start) * left.speed);
        }
        left.duration = op.at - left.start;
        track.clips.push(right);
        sortTrack(track);
        break;
      }

      case "update_clip": {
        const { track, clipIndex } = findClip(doc, op.clipId, opIndex, name);
        assertUnlocked(track, opIndex, name);
        const current = track.clips[clipIndex];
        if (op.expect && !holds(current, op.expect)) throw stale(`clip "${op.clipId}"`);
        for (const key of FROZEN_CLIP_KEYS) {
          if (key in op.patch) {
            throw new OpError("INVALID", `${name}: "${key}" cannot be changed with update_clip`, opIndex);
          }
        }
        const merged: Record<string, unknown> = { ...current };
        for (const [key, value] of Object.entries(op.patch)) {
          const existing = merged[key];
          merged[key] =
            isPlainObject(existing) && isPlainObject(value) ? { ...existing, ...value } : value;
        }
        const schema = current.type === "text" ? StrictTextClip : StrictMediaClip;
        const result = schema.safeParse(merged);
        if (!result.success) {
          const issue = result.error.issues[0];
          const where = issue.path.length ? `${issue.path.join(".")}: ` : "";
          throw new OpError(
            "INVALID",
            `${name}: clip "${op.clipId}" patch is invalid: ${where}${issue.message}`,
            opIndex,
          );
        }
        const before: Record<string, unknown> = current;
        const after: Record<string, unknown> = result.data;
        const undo: Record<string, unknown> = {};
        const written: Record<string, unknown> = {};
        for (const key of Object.keys(op.patch)) {
          // Plain objects (transform, style) are compared one level deep, so the
          // undo only touches the sub-keys this op changed.
          const b = before[key];
          const a = after[key];
          if (isPlainObject(b) && isPlainObject(a)) {
            const { old, now } = diffFields(b, a);
            if (Object.keys(old).length) {
              undo[key] = old;
              written[key] = now;
            }
          } else if (!isEqual(b, a)) {
            undo[key] = b;
            written[key] = a;
          }
        }
        if (Object.keys(undo).length) {
          groups.push([{ op: "update_clip", clipId: op.clipId, patch: undo, expect: written }]);
        }
        track.clips[clipIndex] = result.data as z.infer<typeof schema>;
        break;
      }

      case "set_format": {
        if (op.expect && op.expect.format !== doc.format) throw stale("the format");
        groups.push([{ op: "set_format", format: doc.format, expect: { format: op.format } }]);
        const preset = FORMAT_PRESETS[op.format];
        doc.format = op.format;
        doc.width = preset.width;
        doc.height = preset.height;
        break;
      }

      default: {
        const unhandled: never = op;
        throw new OpError("INVALID", `Unhandled op: ${JSON.stringify(unhandled)}`, opIndex);
      }
    }
  });

  return { doc, inverse: groups.reverse().flat() };
}
