import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRANSFORM,
  FORMAT_PRESETS,
  TRACK_ACCEPTS,
  TextClip,
  TimelineDoc,
  createEmptyDoc,
  docDuration,
} from "@/lib/timeline";

function TextClipSchemaFixture(overrides: Record<string, unknown>) {
  return TextClip.parse({
    id: "x",
    type: "text",
    start: 0,
    duration: 30,
    transform: DEFAULT_TRANSFORM,
    text: "hi",
    style: { fontFamily: "Inter", fontSize: 64, fontWeight: 700, color: "#fff", align: "center" },
    ...overrides,
  });
}

describe("timeline presets", () => {
  it("short_9x16 is 1080x1920 at 30fps", () => {
    const d = createEmptyDoc("short_9x16");
    expect([d.width, d.height, d.fps]).toEqual([1080, 1920, 30]);
    expect(TimelineDoc.parse(d)).toEqual(d);
  });

  it("every preset has exact dimensions", () => {
    expect(FORMAT_PRESETS.short_9x16).toMatchObject({ width: 1080, height: 1920 });
    expect(FORMAT_PRESETS.feed_4x5).toMatchObject({ width: 1080, height: 1350 });
    expect(FORMAT_PRESETS.square_1x1).toMatchObject({ width: 1080, height: 1080 });
    expect(FORMAT_PRESETS.long_16x9).toMatchObject({ width: 1920, height: 1080 });
    expect(FORMAT_PRESETS.long_4k).toMatchObject({ width: 3840, height: 2160 });
  });

  it("default tracks", () => {
    const d = createEmptyDoc("long_16x9");
    expect(d.tracks.map((t) => [t.id, t.kind])).toEqual([
      ["v1", "video"],
      ["t1", "text"],
      ["cap", "caption"],
      ["a1", "audio"],
    ]);
    expect(d.tracks.map((t) => t.name)).toEqual(["Video 1", "Text 1", "Captions", "Audio 1"]);
    for (const t of d.tracks) {
      expect([t.muted, t.hidden, t.locked, t.clips]).toEqual([false, false, false, []]);
    }
  });

  it("track accept rules", () => {
    expect(TRACK_ACCEPTS).toEqual({
      video: ["video", "image"],
      overlay: ["image", "video"],
      text: ["text"],
      caption: [],
      audio: ["audio"],
    });
  });

  it("docDuration is the furthest clip end", () => {
    const d = createEmptyDoc("short_9x16");
    expect(docDuration(d)).toBe(0);
    d.tracks[1].clips.push({
      id: "x",
      type: "text",
      start: 30,
      duration: 45,
      transform: DEFAULT_TRANSFORM,
      text: "hi",
      style: { fontFamily: "Inter", fontSize: 64, fontWeight: 700, color: "#fff", align: "center" },
    });
    expect(docDuration(d)).toBe(75);
  });

  it("rejects a non-integer start", () => {
    expect(() => TextClipSchemaFixture({ start: 1.5 })).toThrow();
  });

  it("createEmptyDoc returns independent objects", () => {
    const a = createEmptyDoc("short_9x16");
    const b = createEmptyDoc("short_9x16");
    expect(a).toEqual(b);
    expect(a.tracks).not.toBe(b.tracks);
    expect(a.tracks[0]).not.toBe(b.tracks[0]);
    expect(a.tracks[0].clips).not.toBe(b.tracks[0].clips);
  });
});
