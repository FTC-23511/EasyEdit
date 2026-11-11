import type { Clip, FormatId, TimelineDoc, Track, TrackKind, Transform } from "./types";

export const FORMAT_PRESETS: Record<FormatId, { width: number; height: number; label: string }> = {
  short_9x16: { width: 1080, height: 1920, label: "Short 9:16" },
  feed_4x5: { width: 1080, height: 1350, label: "Feed 4:5" },
  square_1x1: { width: 1080, height: 1080, label: "Square 1:1" },
  long_16x9: { width: 1920, height: 1080, label: "Long 16:9" },
  long_4k: { width: 3840, height: 2160, label: "Long 4K" },
};

export const DEFAULT_FPS = 30;

export const DEFAULT_TRANSFORM: Transform = {
  x: 0.5,
  y: 0.5,
  scale: 1,
  rotation: 0,
  opacity: 1,
  fit: "cover",
};

export const TRACK_ACCEPTS: Record<TrackKind, Clip["type"][]> = {
  video: ["video", "image"],
  overlay: ["image", "video"],
  text: ["text"],
  caption: [],
  audio: ["audio"],
};

function emptyTrack(id: string, kind: TrackKind, name: string): Track {
  return { id, kind, name, muted: false, hidden: false, locked: false, clips: [] };
}

export function createEmptyDoc(format: FormatId): TimelineDoc {
  const { width, height } = FORMAT_PRESETS[format];
  return {
    schemaVersion: 1,
    format,
    width,
    height,
    fps: DEFAULT_FPS,
    tracks: [
      emptyTrack("v1", "video", "Video 1"),
      emptyTrack("t1", "text", "Text 1"),
      emptyTrack("cap", "caption", "Captions"),
      emptyTrack("a1", "audio", "Audio 1"),
    ],
  };
}

export function docDuration(doc: TimelineDoc): number {
  let end = 0;
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      end = Math.max(end, clip.start + clip.duration);
    }
  }
  return end;
}
