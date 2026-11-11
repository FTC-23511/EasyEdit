import type { OpInput, TimelineDoc } from "@/lib/timeline";
import { moveOps } from "./commands";
import { clipEdges, snap } from "./snap";

// Moving and trimming clips with the pointer. A drag records where its clips were when it began;
// resolveDrag turns a pointer position into ops against the current document. Whether those ops
// may be applied is left to applyOps, through the store's setGesture.

export type DragOrigin = { clipId: string; start: number; duration: number; trackId: string };

export type Drag =
  | { type: "move"; grabFrame: number; primary: string; origins: DragOrigin[] }
  | { type: "trim"; edge: "start" | "end"; grabFrame: number; primary: string; origins: DragOrigin[] };

export type DragInput = { frame: number; rowTrackId: string | null; playhead: number; zoom: number; snapping: boolean };

// Where a dragged clip would be for this pointer position, drawn when the drop is not allowed.
export type DragGhost = { clipId: string; trackId: string; start: number; duration: number };

export type DragResult = { ops: OpInput[]; guide: number | null; label: "move" | "trim"; ghost: DragGhost[] };

// The clips with these ids on unlocked tracks, in document order.
function originsOf(doc: TimelineDoc, ids: Set<string>): DragOrigin[] {
  const origins: DragOrigin[] = [];
  for (const track of doc.tracks) {
    if (track.locked) continue;
    for (const clip of track.clips) {
      if (ids.has(clip.id)) origins.push({ clipId: clip.id, start: clip.start, duration: clip.duration, trackId: track.id });
    }
  }
  return origins;
}

// The selection moves when it holds the grabbed clip; otherwise the grabbed clip moves alone. Null
// when that clip is missing or on a locked track.
export function beginMove(doc: TimelineDoc, clipId: string, selection: string[], grabFrame: number): Drag | null {
  const origins = originsOf(doc, new Set(selection.includes(clipId) ? selection : [clipId]));
  if (!origins.some((o) => o.clipId === clipId)) return null;
  return { type: "move", grabFrame, primary: clipId, origins };
}

export function beginTrim(doc: TimelineDoc, clipId: string, edge: "start" | "end", grabFrame: number): Drag | null {
  const origins = originsOf(doc, new Set([clipId]));
  if (origins.length === 0) return null;
  return { type: "trim", edge, grabFrame, primary: clipId, origins };
}

function existingClipIds(doc: TimelineDoc): Set<string> {
  const ids = new Set<string>();
  for (const track of doc.tracks) for (const clip of track.clips) ids.add(clip.id);
  return ids;
}

// Null when the grabbed clip is gone. Other dragged clips that are gone are left out.
export function resolveDrag(doc: TimelineDoc, drag: Drag, input: DragInput): DragResult | null {
  const existing = existingClipIds(doc);
  const origins = drag.origins.filter((o) => existing.has(o.clipId));
  const primary = origins.find((o) => o.clipId === drag.primary);
  if (!primary) return null;
  const snapTo = (candidates: number[]) =>
    input.snapping
      ? snap(candidates, { edges: clipEdges(doc, origins.map((o) => o.clipId)), playhead: input.playhead, fps: doc.fps, zoom: input.zoom })
      : null;
  let delta = Math.round(input.frame - drag.grabFrame);

  if (drag.type === "move") {
    const snapped = snapTo([primary.start + delta, primary.start + primary.duration + delta]);
    if (snapped) delta += snapped.delta;
    const tracks = new Set(origins.map((o) => o.trackId));
    const toTrack = tracks.size === 1 && input.rowTrackId !== null && !tracks.has(input.rowTrackId) ? input.rowTrackId : undefined;
    const ops = moveOps(origins.map(({ clipId, start }) => ({ clipId, start })), delta, toTrack);
    const placed = new Map<string, { start: number; trackId?: string }>();
    for (const op of ops) if (op.op === "move_clip") placed.set(op.clipId, op);
    const ghost = origins.map(({ clipId, trackId, start, duration }) => {
      const at = placed.get(clipId);
      return { clipId, trackId: at?.trackId ?? trackId, start: at?.start ?? start, duration };
    });
    // moveOps raises a delta that would put a clip before frame 0; a target it then misses is not shown.
    const used = (placed.get(primary.clipId)?.start ?? primary.start) - primary.start;
    const guide = snapped && used === delta ? snapped.guide : null;
    return { ops, guide, label: "move", ghost };
  }

  const end = primary.start + primary.duration;
  const from = drag.edge === "start" ? primary.start : end;
  const snapped = snapTo([from + delta]);
  const wanted = from + delta + (snapped?.delta ?? 0);
  const to = drag.edge === "start" ? Math.min(Math.max(wanted, 0), end - 1) : Math.max(wanted, primary.start + 1);
  // A snap target the edge cannot reach is not shown.
  const guide = snapped && to === wanted ? snapped.guide : null;
  const ghost = [
    drag.edge === "start"
      ? { clipId: primary.clipId, trackId: primary.trackId, start: to, duration: end - to }
      : { clipId: primary.clipId, trackId: primary.trackId, start: primary.start, duration: to - primary.start },
  ];
  const ops: OpInput[] = to === from ? [] : [{ op: "trim_clip", clipId: primary.clipId, edge: drag.edge, to }];
  return { ops, guide, label: "trim", ghost };
}
