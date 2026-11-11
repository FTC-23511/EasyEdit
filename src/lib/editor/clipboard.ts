import { z } from "zod";
import { Clip, type TimelineDoc } from "@/lib/timeline";
import type { PlaceItem } from "./placement";

// Copied clips, each with the track it came from, earliest first.
export type Copied = { clips: { clip: Clip; trackId: string }[] };
export type ClipboardStore = { read(): Copied | null; write(value: Copied): void };

export const CLIPBOARD_KEY = "easyedit.clipboard";

const CopiedSchema = z.object({ clips: z.array(z.object({ clip: Clip, trackId: z.string() })).min(1) });

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
}

function parse(raw: string | null): Copied | null {
  if (raw === null) return null;
  try {
    const parsed = CopiedSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// Kept in storage as JSON, so another project in the same browser can paste it. Storage may throw
// (private mode, a full quota); then the clipboard holds what this tab copied in memory.
export function createClipboard(storage: Storage = memoryStorage()): ClipboardStore {
  let unsaved: string | null = null; // the last copy storage refused
  return {
    read() {
      if (unsaved !== null) return parse(unsaved);
      try {
        return parse(storage.getItem(CLIPBOARD_KEY));
      } catch {
        return null;
      }
    },
    write(value) {
      const raw = JSON.stringify(value);
      try {
        storage.setItem(CLIPBOARD_KEY, raw);
        unsaved = null;
      } catch {
        unsaved = raw;
      }
    },
  };
}

// The clips by start, then in document order; null when none of them exists.
export function copyClips(doc: TimelineDoc, clipIds: string[]): Copied | null {
  const wanted = new Set(clipIds);
  const clips = doc.tracks.flatMap((track) =>
    track.clips.filter((clip) => wanted.has(clip.id)).map((clip) => ({ clip: structuredClone(clip), trackId: track.id })),
  );
  if (clips.length === 0) return null;
  return { clips: clips.sort((a, b) => a.clip.start - b.clip.start) };
}

// The earliest clip lands on the playhead and the others keep their distance from it.
export function pasteItems(copied: Copied, playhead: number): PlaceItem[] {
  const earliest = Math.min(...copied.clips.map((c) => c.clip.start));
  return copied.clips.map(({ clip, trackId }) => ({ clip: { ...clip, start: clip.start - earliest + playhead }, trackId }));
}
