import type { OpInput, TimelineDoc, TrackKind } from "@/lib/timeline";
import { displayRows, trackToggles } from "./geometry";
import { newTrackIndex, nextTrackName } from "./placement";
import { clipEdges } from "./snap";

// Pure builders: each returns the ops for one command and never touches the store. An empty list
// means the command has nothing to do.

export type TrackSwitch = "locked" | "hidden" | "muted";

// Moves clips by frameDelta, raised so no clip starts before 0. Moving right, the latest clip goes
// first; moving left, the earliest; so clips that travel together never run into each other.
export function moveOps(clips: { clipId: string; start: number }[], frameDelta: number, toTrackId?: string): OpInput[] {
  if (clips.length === 0) return [];
  const delta = Math.max(frameDelta, -Math.min(...clips.map((c) => c.start)));
  if (delta === 0 && toTrackId === undefined) return [];
  const ordered = delta === 0 ? clips : [...clips].sort((a, b) => (delta > 0 ? b.start - a.start : a.start - b.start));
  return ordered.map(({ clipId, start }) => ({
    op: "move_clip",
    clipId,
    start: start + delta,
    ...(toTrackId !== undefined ? { trackId: toTrackId } : {}),
  }));
}

// Cuts the clips the playhead is inside of, on unlocked tracks, in document order. With a
// selection, only the selected ones among them.
export function splitOps(doc: TimelineDoc, playhead: number, selection: string[]): OpInput[] {
  const ops: OpInput[] = [];
  for (const track of doc.tracks) {
    if (track.locked) continue;
    for (const clip of track.clips) {
      if (clip.start >= playhead || clip.start + clip.duration <= playhead) continue;
      if (selection.length > 0 && !selection.includes(clip.id)) continue;
      ops.push({ op: "split_clip", clipId: clip.id, at: playhead });
    }
  }
  return ops;
}

export function deleteOps(clipIds: string[], ripple: boolean): OpInput[] {
  return clipIds.map((clipId) => (ripple ? { op: "remove_clip", clipId, ripple: true } : { op: "remove_clip", clipId }));
}

// A project has at most one caption track.
export function addTrackOps(doc: TimelineDoc, kind: TrackKind): OpInput[] {
  if (kind === "caption" && doc.tracks.some((t) => t.kind === "caption")) return [];
  return [{ op: "add_track", track: { kind, name: nextTrackName(doc, kind) }, index: newTrackIndex(doc, kind) }];
}

// Swaps a track with its neighbor one row up or down. Audio rows and the rows above them are two
// groups, and a track never leaves its group.
export function reorderTrackOps(doc: TimelineDoc, trackId: string, direction: "up" | "down"): OpInput[] {
  const rows = displayRows(doc);
  const row = rows.findIndex((t) => t.id === trackId);
  if (row < 0) return [];
  const neighbor = rows[direction === "up" ? row - 1 : row + 1];
  if (!neighbor || (neighbor.kind === "audio") !== (rows[row].kind === "audio")) return [];
  return [{ op: "move_track", trackId, index: doc.tracks.indexOf(neighbor) }];
}

// Surrounding spaces are dropped. An empty name, or the same one, changes nothing.
export function renameTrackOps(doc: TimelineDoc, trackId: string, name: string): OpInput[] {
  const track = doc.tracks.find((t) => t.id === trackId);
  const next = name.trim();
  if (!track || next === "" || next === track.name) return [];
  return [{ op: "update_track", trackId, patch: { name: next } }];
}

// Turns a switch the other way. Every track can be locked; hide and mute only where trackToggles offers them.
export function toggleTrackOps(doc: TimelineDoc, trackId: string, field: TrackSwitch): OpInput[] {
  const track = doc.tracks.find((t) => t.id === trackId);
  if (!track || (field !== "locked" && !trackToggles(track.kind).includes(field))) return [];
  const patch: Partial<Record<TrackSwitch, boolean>> = { [field]: !track[field] };
  return [{ op: "update_track", trackId, patch }];
}

// A locked track must be unlocked before it can be removed.
export function removeTrackOps(doc: TimelineDoc, trackId: string): OpInput[] {
  const track = doc.tracks.find((t) => t.id === trackId);
  if (!track || track.locked) return [];
  return [{ op: "remove_track", trackId }];
}

// 0 and every clip's start and end, sorted, each once.
export function edgeFrames(doc: TimelineDoc): number[] {
  const edges = clipEdges(doc, []);
  return edges[0] === 0 ? edges : [0, ...edges];
}

// prev: the greatest edge before frame, else 0. next: the smallest edge after it, else frame.
export function nearestEdge(edges: number[], frame: number, direction: "prev" | "next"): number {
  if (direction === "prev") return edges.findLast((e) => e < frame) ?? 0;
  return edges.find((e) => e > frame) ?? frame;
}
