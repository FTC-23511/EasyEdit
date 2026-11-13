import { sourceFrames } from "@/lib/media/rules";
import type { AssetKind } from "@/lib/media/types";
import { DEFAULT_TRANSFORM, type MediaClip } from "@/lib/timeline";

export const DEFAULT_IMAGE_SECONDS = 3;

// What a new clip needs to know about its asset. An AssetView and the server's AssetFact both fit.
export type ClipSource = { id: string; kind: AssetKind; durationMs: number | null };

// An asset's length in a project's frames, or undefined when it has none (an image) or is not known.
export function mediaLengthFrames(asset: ClipSource | undefined, fps: number): number | undefined {
  return asset && asset.durationMs !== null ? sourceFrames(asset.durationMs, fps) : undefined;
}

// A new clip for an asset, without an id. Video and audio: from inSeconds (default 0) for durationSeconds
// (default: to the end), never past the end. An image: durationSeconds, default 3. Null when inSeconds is at or
// past the end, and for a video or audio of unknown length (the library holds none: its length is required).
export function mediaClipFor(
  asset: ClipSource,
  start: number,
  fps: number,
  opts: { inSeconds?: number; durationSeconds?: number } = {},
): Omit<MediaClip, "id"> | null {
  const clip = { type: asset.kind, assetId: asset.id, start, speed: 1, volume: 1, transform: { ...DEFAULT_TRANSFORM } };
  if (asset.kind === "image") {
    const duration = Math.max(1, Math.round((opts.durationSeconds ?? DEFAULT_IMAGE_SECONDS) * fps));
    return { ...clip, duration, in: 0 };
  }
  if (asset.durationMs === null) return null;
  const frames = sourceFrames(asset.durationMs, fps);
  const sourceIn = Math.round((opts.inSeconds ?? 0) * fps);
  if (sourceIn >= frames) return null;
  const room = frames - sourceIn;
  const wanted = opts.durationSeconds === undefined ? room : Math.round(opts.durationSeconds * fps);
  return { ...clip, duration: Math.min(room, Math.max(1, wanted)), in: sourceIn };
}

// How far a clip's edges can go before its media runs out, in timeline frames: exactly what the engine and the
// server accept. A start trim keeps where the clip ends in its footage (in = end − round(duration × speed)), so the
// start can go back while that `in` stays at 0 or more; the end can go on while in + round(duration × speed) stays
// within the media. Undefined for an image or an unknown length.
export function trimBounds(clip: MediaClip, lengthFrames: number | undefined): { minStart: number; maxEnd: number } | undefined {
  if (clip.type === "image" || lengthFrames === undefined) return undefined;
  const { speed } = clip;
  const used = (duration: number) => Math.round(duration * speed);

  let longest = Math.floor((lengthFrames - clip.in + 0.5) / speed);
  while (clip.in + used(longest) > lengthFrames) longest--;

  const end = clip.in + used(clip.duration);
  let back = Math.floor((end + 0.5) / speed) - clip.duration;
  while (back > 0 && used(clip.duration + back) > end) back--;

  return { minStart: Math.max(0, clip.start - Math.max(0, back)), maxEnd: clip.start + longest };
}
