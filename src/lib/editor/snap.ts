import type { TimelineDoc } from "@/lib/timeline";

export const SNAP_PX = 8; // how close, on screen, a dragged edge must come to a target
export const SECOND_SNAP_MIN_PX = 24; // whole seconds are targets only when one second is at least this wide

// The starts and ends of every clip but the excluded ones, sorted, each once.
export function clipEdges(doc: TimelineDoc, excludeClipIds: string[]): number[] {
  const excluded = new Set(excludeClipIds);
  const edges = new Set<number>();
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (excluded.has(clip.id)) continue;
      edges.add(clip.start);
      edges.add(clip.start + clip.duration);
    }
  }
  return [...edges].sort((a, b) => a - b);
}

// The edge closest to frame, by binary search over the sorted edges.
function nearest(edges: number[], frame: number): number | null {
  if (edges.length === 0) return null;
  let lo = 0;
  let hi = edges.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (edges[mid] < frame) lo = mid + 1;
    else hi = mid;
  }
  const after = edges[lo];
  const before = lo > 0 ? edges[lo - 1] : after;
  return Math.abs(before - frame) <= Math.abs(after - frame) ? before : after;
}

// The frames to add to the candidates so the closest one lands on a target within SNAP_PX, and that
// target; null when none is in reach. On equal distance a clip edge wins over the playhead, and the
// playhead over a whole second.
export function snap(
  candidates: number[],
  ctx: { edges: number[]; playhead: number; fps: number; zoom: number },
): { delta: number; guide: number } | null {
  const reach = SNAP_PX / ctx.zoom;
  const seconds = ctx.fps * ctx.zoom >= SECOND_SNAP_MIN_PX;
  let best: { delta: number; guide: number } | null = null;
  let bestDistance = Infinity;
  let bestRank = Infinity;
  for (const candidate of candidates) {
    const targets = [nearest(ctx.edges, candidate), ctx.playhead, seconds ? Math.round(candidate / ctx.fps) * ctx.fps : null];
    for (const [rank, target] of targets.entries()) {
      if (target === null) continue;
      const distance = Math.abs(target - candidate);
      if (distance > reach || distance > bestDistance || (distance === bestDistance && rank >= bestRank)) continue;
      best = { delta: target - candidate, guide: target };
      bestDistance = distance;
      bestRank = rank;
    }
  }
  return best;
}
