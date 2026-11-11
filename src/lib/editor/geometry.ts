import type { Clip, TimelineDoc, Track, TrackKind } from "@/lib/timeline";

// Zoom is in pixels per frame.
export const ZOOM_MIN = 0.02;
export const ZOOM_MAX = 40;
export const ZOOM_STEP = 1.25; // one step of the zoom buttons and keys
export const MAX_CONTENT_PX = 8_000_000; // widest scroll area the timeline may ask a browser for
export const ROW_HEIGHT = 40;
export const RULER_HEIGHT = 24;
export const HEADER_WIDTH = 240;
export const MIN_TICK_PX = 80;

export function frameToPx(frame: number, zoom: number): number {
  return frame * zoom;
}

export function pxToFrame(px: number, zoom: number): number {
  return Math.max(0, Math.round(px / zoom));
}

// The timeline always runs on past the end, by 30 s, and is at least a minute long.
export function contentFrames(duration: number, fps: number): number {
  return Math.max(duration + 30 * fps, 60 * fps);
}

// Into [ZOOM_MIN, ZOOM_MAX], then low enough that the content stays within MAX_CONTENT_PX. For a
// project of many hours that last cap can go below ZOOM_MIN.
export function clampZoom(zoom: number, duration: number, fps: number): number {
  const inRange = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
  return Math.min(inRange, MAX_CONTENT_PX / contentFrames(duration, fps));
}

// The zoom that shows the whole project with a 10% margin, or 10 s when it is shorter.
export function fitZoom(duration: number, fps: number, viewportPx: number): number {
  return clampZoom(viewportPx / Math.max(duration * 1.1, 10 * fps), duration, fps);
}

// The scrollLeft that keeps the frame at anchorPx (from the left of the visible area) in place.
export function zoomAt(input: { scrollLeft: number; anchorPx: number; zoom: number; nextZoom: number }): number {
  const frame = (input.scrollLeft + input.anchorPx) / input.zoom;
  return Math.max(0, frame * input.nextZoom - input.anchorPx);
}

// The scrollLeft that puts the playhead 10% in from the left, or null when it is already in view.
export function revealScroll(input: { playheadPx: number; scrollLeft: number; viewportPx: number }): number | null {
  const { playheadPx, scrollLeft, viewportPx } = input;
  if (playheadPx >= scrollLeft && playheadPx < scrollLeft + viewportPx) return null;
  return Math.max(0, playheadPx - viewportPx * 0.1);
}

function tickSteps(fps: number): number[] {
  const half = Math.max(1, Math.round(fps / 2)); // frames are whole numbers
  return [1, 5, half, fps, 2 * fps, 5 * fps, 10 * fps, 30 * fps, 60 * fps, 300 * fps, 600 * fps, 1800 * fps, 3600 * fps];
}

// Labeled ticks for the range in view. The count is bounded by the range's width over MIN_TICK_PX,
// whatever the zoom, because the loop starts at the range and not at frame 0.
export function rulerTicks(input: { zoom: number; fps: number; fromFrame: number; toFrame: number }): {
  step: number;
  ticks: { frame: number; label: string }[];
} {
  const { zoom, fps, fromFrame, toFrame } = input;
  const steps = tickSteps(fps);
  let step = steps.find((s) => s * zoom >= MIN_TICK_PX) ?? steps[steps.length - 1];
  if (!(zoom > 0)) return { step, ticks: [] };
  while (step * zoom < MIN_TICK_PX) step *= 2;
  const label = step < fps ? formatTimecode : formatClock;
  const ticks: { frame: number; label: string }[] = [];
  for (let frame = Math.ceil(Math.max(0, fromFrame) / step) * step; frame <= toFrame; frame += step) {
    ticks.push({ frame, label: label(frame, fps) });
  }
  return { step, ticks };
}

const pad = (n: number) => String(n).padStart(2, "0");

// "0:03:15" (minutes, seconds, frames), with hours "1:00:03:15".
export function formatTimecode(frame: number, fps: number): string {
  const whole = Math.max(0, Math.floor(frame));
  return `${formatClock(whole, fps)}:${pad(whole % fps)}`;
}

// "0:03" (minutes, seconds), with hours "1:00:03".
export function formatClock(frame: number, fps: number): string {
  const seconds = Math.floor(Math.max(0, frame) / fps);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// The clips that overlap [fromFrame, toFrame); touching does not count. Clips on a track are sorted
// by start and never overlap, so their ends are sorted too and a binary search finds the first one.
export function visibleClips(clips: Clip[], fromFrame: number, toFrame: number): Clip[] {
  let lo = 0;
  let hi = clips.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (clips[mid].start + clips[mid].duration > fromFrame) hi = mid;
    else lo = mid + 1;
  }
  const out: Clip[] = [];
  for (let i = lo; i < clips.length && clips[i].start < toFrame; i++) out.push(clips[i]);
  return out;
}

// Top to bottom: the front-most layer first (a later track draws on top), then audio in document order.
export function displayRows(doc: TimelineDoc): Track[] {
  const visual = doc.tracks.filter((t) => t.kind !== "audio").reverse();
  return [...visual, ...doc.tracks.filter((t) => t.kind === "audio")];
}

export function rowAt(y: number, rowCount: number): number {
  return Math.min(Math.max(0, rowCount - 1), Math.max(0, Math.floor(y / ROW_HEIGHT)));
}

// The ids of the clips a box covers, row by row, then by start. The box may be dragged any way.
export function clipsInBox(rows: Track[], box: { fromFrame: number; toFrame: number; fromRow: number; toRow: number }): string[] {
  const fromFrame = Math.min(box.fromFrame, box.toFrame);
  const toFrame = Math.max(box.fromFrame, box.toFrame);
  const fromRow = Math.max(0, Math.min(box.fromRow, box.toRow));
  const toRow = Math.min(rows.length - 1, Math.max(box.fromRow, box.toRow));
  const ids: string[] = [];
  for (let r = fromRow; r <= toRow; r++) {
    for (const clip of visibleClips(rows[r].clips, fromFrame, toFrame)) ids.push(clip.id);
  }
  return ids;
}

// Which switches a track of this kind offers besides lock.
export function trackToggles(kind: TrackKind): ("hidden" | "muted")[] {
  switch (kind) {
    case "video":
    case "overlay":
      return ["hidden", "muted"];
    case "text":
    case "caption":
      return ["hidden"];
    case "audio":
      return ["muted"];
  }
}
