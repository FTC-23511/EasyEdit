import { LIMITS } from "@/lib/limits";

// The preview copy every video gets: H.264 and AAC in an MP4, small enough to play on any laptop.
export const PREVIEW = { shortSide: 720, videoBitrate: 2_500_000, maxFps: 30, keyFrameSeconds: 1, audioBitrate: 128_000, audioChannels: 2, audioSampleRate: 48_000 } as const;
const MIN_VIDEO_BITRATE = 300_000; // the least a long video's preview copy gets
// The still picture shown in the library: a JPEG.
export const POSTER = { width: 320, quality: 0.8, atSeconds: 1 } as const;
export const IMAGE_MAX_SIDE = 2160; // an image is decoded for the preview at no more than this on its longer side

// The even number at or below a length, and never less than 2: the smallest side an H.264 encoder takes.
const even = (px: number) => Math.max(2, Math.floor(px / 2) * 2);

// From the size as shown: the shorter side at most 720, never enlarged, both sides even.
export function previewSize(width: number, height: number): { width: number; height: number } {
  const short = Math.min(width, height);
  if (short <= PREVIEW.shortSide) return { width: even(width), height: even(height) };
  // The shorter side is set, not multiplied, so rounding can never take it below 720.
  const long = even((Math.max(width, height) * PREVIEW.shortSide) / short);
  return width <= height ? { width: PREVIEW.shortSide, height: long } : { width: long, height: PREVIEW.shortSide };
}

// At most 30; 30 when the source's rate is unknown or is not a rate at all.
export function previewFps(fps: number | null): number {
  if (fps === null || !Number.isFinite(fps) || fps <= 0) return PREVIEW.maxFps;
  return Math.min(fps, PREVIEW.maxFps);
}

// The preview's video rate: PREVIEW's, or less for a long video, so the copy stays under 90% of the largest file
// the library takes (from about 98 minutes on). Never below 300,000.
export function previewVideoBitrate(durationMs: number): number {
  const fits = Math.floor((LIMITS.mediaFileBytes * 8 * 0.9) / (durationMs / 1000)) - PREVIEW.audioBitrate;
  return Math.max(MIN_VIDEO_BITRATE, Math.min(PREVIEW.videoBitrate, fits));
}

// At most 320 wide, never enlarged, both sides even and at least 2.
export function posterSize(width: number, height: number): { width: number; height: number } {
  if (width <= POSTER.width) return { width: even(width), height: even(height) };
  return { width: POSTER.width, height: even((height * POSTER.width) / width) };
}

// Seconds into the video: 1, or the middle of a video shorter than 2 s.
export function posterTime(durationMs: number): number {
  return Math.min(POSTER.atSeconds, durationMs / 2000);
}
