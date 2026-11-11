import { z } from "zod";
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

function clipIdInUse(doc: TimelineDoc, clipId: string, exceptTrackId?: string): boolean {
  return doc.tracks.some((t) => t.id !== exceptTrackId && t.clips.some((c) => c.id === clipId));
}

export function applyOps(input: TimelineDoc, ops: Op[]): { doc: TimelineDoc; inverse: Op[] } {
  const doc = structuredClone(input);
  const inverse: Op[] = [];

  const snapshot = (trackIndex: number): Op => ({
    op: "replace_track",
    track: structuredClone(doc.tracks[trackIndex]),
    index: trackIndex,
  });

  ops.forEach((op, opIndex) => {
    const name = op.op;
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
        doc.tracks.splice(index, 0, {
          id: op.track.id,
          kind: op.track.kind,
          name: op.track.name,
          muted: false,
          hidden: false,
          locked: false,
          clips: [],
        });
        inverse.push({ op: "remove_track", trackId: op.track.id });
        break;
      }

      case "remove_track": {
        const { trackIndex } = findTrack(doc, op.trackId, opIndex, name);
        inverse.push(snapshot(trackIndex));
        doc.tracks.splice(trackIndex, 1);
        break;
      }

      case "update_track": {
        const { track, trackIndex } = findTrack(doc, op.trackId, opIndex, name);
        inverse.push(snapshot(trackIndex));
        if (op.patch.name !== undefined) track.name = op.patch.name;
        if (op.patch.muted !== undefined) track.muted = op.patch.muted;
        if (op.patch.hidden !== undefined) track.hidden = op.patch.hidden;
        if (op.patch.locked !== undefined) track.locked = op.patch.locked;
        break;
      }

      case "replace_track": {
        const incoming = structuredClone(op.track);
        const existingIndex = doc.tracks.findIndex((t) => t.id === incoming.id);
        if (existingIndex < 0 && (op.index < 0 || op.index > doc.tracks.length)) {
          throw new OpError(
            "INVALID",
            `${name}: index ${op.index} is outside 0..${doc.tracks.length} for track "${incoming.id}"`,
            opIndex,
          );
        }
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
          inverse.push(snapshot(existingIndex));
          doc.tracks[existingIndex] = incoming;
        } else {
          inverse.push({ op: "remove_track", trackId: incoming.id });
          doc.tracks.splice(op.index, 0, incoming);
        }
        break;
      }

      case "add_clip": {
        const { track, trackIndex } = findTrack(doc, op.trackId, opIndex, name);
        assertUnlocked(track, opIndex, name);
        if (clipIdInUse(doc, op.clip.id)) {
          throw new OpError("DUPLICATE_ID", `${name}: clip id "${op.clip.id}" already exists`, opIndex);
        }
        assertAccepts(track, op.clip, opIndex, name);
        inverse.push(snapshot(trackIndex));
        track.clips.push(structuredClone(op.clip));
        sortTrack(track);
        assertNoOverlap(track, opIndex, name);
        break;
      }

      case "remove_clip": {
        const { track, trackIndex, clipIndex } = findClip(doc, op.clipId, opIndex, name);
        assertUnlocked(track, opIndex, name);
        inverse.push(snapshot(trackIndex));
        const [removed] = track.clips.splice(clipIndex, 1);
        if (op.ripple) {
          const removedEnd = removed.start + removed.duration;
          for (const c of track.clips) {
            if (c.start >= removedEnd) c.start -= removed.duration;
          }
        }
        sortTrack(track);
        break;
      }

      case "move_clip": {
        const from = findClip(doc, op.clipId, opIndex, name);
        const to = op.trackId ? findTrack(doc, op.trackId, opIndex, name) : from;
        assertUnlocked(from.track, opIndex, name);
        assertUnlocked(to.track, opIndex, name);
        const moving = from.track.clips[from.clipIndex];
        assertAccepts(to.track, moving, opIndex, name);
        // The track that loses the clip is snapshotted first: undo runs in reverse,
        // so it restores the destination before the source and no id is ever doubled.
        inverse.push(snapshot(from.trackIndex));
        if (to.trackIndex !== from.trackIndex) inverse.push(snapshot(to.trackIndex));
        from.track.clips.splice(from.clipIndex, 1);
        moving.start = op.start;
        to.track.clips.push(moving);
        sortTrack(to.track);
        assertNoOverlap(to.track, opIndex, name);
        break;
      }

      case "trim_clip": {
        const { track, trackIndex, clipIndex } = findClip(doc, op.clipId, opIndex, name);
        assertUnlocked(track, opIndex, name);
        const target = track.clips[clipIndex];
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
          if (target.type !== "text") {
            sourceIn = target.in + Math.round(delta * target.speed);
            if (sourceIn < 0) throw outOfRange("cannot start before the start of its source");
          }
        } else {
          duration = op.to - target.start;
        }
        if (duration < 1) throw outOfRange(`would have a duration of ${duration} frames`);
        inverse.push(snapshot(trackIndex));
        target.start = start;
        target.duration = duration;
        if (target.type !== "text" && sourceIn !== undefined) target.in = sourceIn;
        sortTrack(track);
        assertNoOverlap(track, opIndex, name);
        break;
      }

      case "split_clip": {
        const { track, trackIndex, clipIndex } = findClip(doc, op.clipId, opIndex, name);
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
        inverse.push(snapshot(trackIndex));
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
        const { track, trackIndex, clipIndex } = findClip(doc, op.clipId, opIndex, name);
        assertUnlocked(track, opIndex, name);
        for (const key of FROZEN_CLIP_KEYS) {
          if (key in op.patch) {
            throw new OpError("INVALID", `${name}: "${key}" cannot be changed with update_clip`, opIndex);
          }
        }
        const current = track.clips[clipIndex];
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
        inverse.push(snapshot(trackIndex));
        track.clips[clipIndex] = result.data as z.infer<typeof schema>;
        break;
      }

      case "set_format": {
        inverse.push({ op: "set_format", format: doc.format });
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

  return { doc, inverse: inverse.reverse() };
}
