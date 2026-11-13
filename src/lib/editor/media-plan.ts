import type { Clip, MediaClip, TimelineDoc, Track } from "@/lib/timeline";

// What the preview's media should be doing at a frame: which clips show and sound, at what moment of their media,
// how fast and how loud. Pure, so the pool that drives the browser's elements only has to follow it.

export type MediaWant = { clipId: string; assetId: string; type: "video" | "image" | "audio"; seconds: number; rate: number; volume: number };

export const MIN_ELEMENT_RATE = 0.0625; // Edge throws when playbackRate is set outside these two
export const MAX_ELEMENT_RATE = 16;
export const PRELOAD_SECONDS = 2;
export const DRIFT_SECONDS = 0.1; // while playing, an element this far off is moved
export const STILL_SECONDS = 0.02; // while paused

// A media clip the preview uses: audio wherever it is, a picture only on a track that is shown.
function used(track: Track, clip: Clip): clip is MediaClip {
  if (clip.type === "audio") return true;
  return (clip.type === "video" || clip.type === "image") && !track.hidden;
}

const under = (clip: MediaClip, frame: number) => clip.start <= frame && frame < clip.start + clip.duration;

// What should be showing and sounding at this frame. A clip that cannot play at the browser's rate stands still and
// is moved to each frame instead, silent: backward, paused, or too slow or too fast for the element.
export function mediaWants(doc: TimelineDoc, frame: number, play: { playing: boolean; rate: number }): MediaWant[] {
  const wants: MediaWant[] = [];
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (!used(track, clip) || !under(clip, frame)) continue;
      const image = clip.type === "image";
      const product = play.rate * clip.speed;
      const rate = play.playing && product >= MIN_ELEMENT_RATE && product <= MAX_ELEMENT_RATE ? product : 0;
      wants.push({
        clipId: clip.id,
        assetId: clip.assetId,
        type: clip.type,
        seconds: image ? 0 : (clip.in + (frame - clip.start) * clip.speed) / doc.fps,
        rate,
        volume: image || rate === 0 || track.muted ? 0 : Math.min(clip.volume, 1),
      });
    }
  }
  return wants;
}

// The assets of the clips under the frame or starting within PRELOAD_SECONDS of it, each once, in document order.
export function upcomingAssetIds(doc: TimelineDoc, frame: number): string[] {
  const ahead = frame + PRELOAD_SECONDS * doc.fps;
  const ids = new Set<string>();
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (used(track, clip) && clip.start <= ahead && frame < clip.start + clip.duration) ids.add(clip.assetId);
    }
  }
  return [...ids];
}

// Whether an element that is at elementSeconds should be moved to the wanted moment.
export function needsSeek(elementSeconds: number, want: MediaWant): boolean {
  return Math.abs(elementSeconds - want.seconds) > (want.rate > 0 ? DRIFT_SECONDS : STILL_SECONDS);
}
