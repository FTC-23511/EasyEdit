import { describe, expect, it } from "vitest";
import { DRIFT_SECONDS, MAX_ELEMENT_RATE, MIN_ELEMENT_RATE, PRELOAD_SECONDS, STILL_SECONDS, mediaWants, needsSeek, upcomingAssetIds } from "@/lib/editor/media-plan";
import { createEmptyDoc, type Clip, type TimelineDoc } from "@/lib/timeline";
import { text, video } from "./fixtures";

// A 30 fps project whose tracks are, in order: v1 (video), o1 (overlay), t1, cap, a1 (audio).
// c1: a video clip of asset a1 on v1, frames 30 to 120, in 60, speed 1, volume 0.5.
// i1: an image clip of asset a3 on o1, frames 0 to 90. m1: an audio clip of asset a2 on a1, frames 0 to 300, volume 1.
function makeDoc(): TimelineDoc {
  const d = createEmptyDoc("short_9x16");
  d.tracks.splice(1, 0, { id: "o1", kind: "overlay", name: "Overlay 1", muted: false, hidden: false, locked: false, clips: [] });
  d.tracks[0].clips = [video("c1", 30, 90, { assetId: "a1", in: 60, volume: 0.5 })];
  d.tracks[1].clips = [video("i1", 0, 90, { type: "image", assetId: "a3" })];
  d.tracks[4].clips = [video("m1", 0, 300, { type: "audio", assetId: "a2" })];
  return d;
}
const doc = makeDoc();

// Each returns a copy of the doc with that one change.
const withClip = (d: TimelineDoc, clipId: string, change: Partial<Clip>): TimelineDoc => ({
  ...d,
  tracks: d.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === clipId ? ({ ...c, ...change } as Clip) : c)) })),
});
const withSpeed = (d: TimelineDoc, clipId: string, speed: number) => withClip(d, clipId, { speed } as Partial<Clip>);
const withVolume = (d: TimelineDoc, clipId: string, volume: number) => withClip(d, clipId, { volume } as Partial<Clip>);
const muted = (d: TimelineDoc, trackId: string): TimelineDoc => ({ ...d, tracks: d.tracks.map((t) => (t.id === trackId ? { ...t, muted: true } : t)) });
const hidden = (d: TimelineDoc, trackId: string): TimelineDoc => ({ ...d, tracks: d.tracks.map((t) => (t.id === trackId ? { ...t, hidden: true } : t)) });

describe("what should be playing at a frame", () => {
  it("gives each clip under the playhead its moment in the media", () => {
    expect(mediaWants(doc, 45, { playing: false, rate: 1 })).toEqual([
      { clipId: "c1", assetId: "a1", type: "video", seconds: 2.5, rate: 0, volume: 0 }, // (60 + 15) / 30
      { clipId: "i1", assetId: "a3", type: "image", seconds: 0, rate: 0, volume: 0 },
      { clipId: "m1", assetId: "a2", type: "audio", seconds: 1.5, rate: 0, volume: 0 },
    ]);
  });
  it("plays forward at the clip's speed, with its volume", () => {
    const wants = mediaWants(withSpeed(doc, "c1", 2), 45, { playing: true, rate: 1 });
    expect(wants[0]).toMatchObject({ seconds: 3, rate: 2, volume: 0.5 }); // (60 + 15 × 2) / 30
    expect(wants[2]).toMatchObject({ rate: 1, volume: 1 });
    expect(mediaWants(doc, 45, { playing: true, rate: 2 })[2].rate).toBe(2); // L pressed twice
  });
  it("stands still and silent when playing backward", () => {
    expect(mediaWants(doc, 45, { playing: true, rate: -1 }).map((w) => [w.rate, w.volume])).toEqual([[0, 0], [0, 0], [0, 0]]);
  });
  it("stands still at a speed the browser cannot play", () => {
    expect(mediaWants(withSpeed(doc, "c1", 20), 45, { playing: true, rate: 1 })[0]).toMatchObject({ seconds: 12, rate: 0, volume: 0 }); // (60 + 15 × 20) / 30
    expect(mediaWants(withSpeed(doc, "c1", 5), 45, { playing: true, rate: 4 })[0].rate).toBe(0); // 20, L pressed three times
    expect(mediaWants(withSpeed(doc, "c1", 4), 45, { playing: true, rate: 4 })[0].rate).toBe(16);
    expect(mediaWants(withSpeed(doc, "c1", 0.05), 45, { playing: true, rate: 1 })[0].rate).toBe(0);
  });
  it("is silent on a muted track, absent on a hidden one, and never louder than 1", () => {
    expect(mediaWants(muted(doc, "a1"), 45, { playing: true, rate: 1 })[2].volume).toBe(0);
    expect(mediaWants(hidden(doc, "v1"), 45, { playing: true, rate: 1 }).map((w) => w.clipId)).toEqual(["i1", "m1"]);
    expect(mediaWants(withVolume(doc, "m1", 2), 45, { playing: true, rate: 1 })[2].volume).toBe(1);
  });
  it("wants nothing where there is no clip", () => {
    expect(mediaWants(doc, 400, { playing: true, rate: 1 })).toEqual([]);
  });
  it("names the media to load ahead: under the playhead and within two seconds", () => {
    expect(upcomingAssetIds(doc, 0)).toEqual(["a1", "a3", "a2"]); // c1 starts at frame 30
    expect(upcomingAssetIds(doc, 300)).toEqual([]);
  });
  it("moves an element that has drifted", () => {
    const playing = { clipId: "c1", assetId: "a1", type: "video" as const, seconds: 2.5, rate: 1, volume: 1 };
    expect(needsSeek(2.45, playing)).toBe(false);
    expect(needsSeek(2.35, playing)).toBe(true);
    expect(needsSeek(2.47, { ...playing, rate: 0 })).toBe(true);
    expect(needsSeek(2.49, { ...playing, rate: 0 })).toBe(false);
  });
});

describe("the edges of what should be playing", () => {
  it("keeps its limits", () => {
    expect([MIN_ELEMENT_RATE, MAX_ELEMENT_RATE, PRELOAD_SECONDS, DRIFT_SECONDS, STILL_SECONDS]).toEqual([0.0625, 16, 2, 0.1, 0.02]);
  });
  it("counts a clip from its first frame to the frame before its end, and plays at the slowest and fastest rates the browser takes", () => {
    expect(mediaWants(doc, 30, { playing: true, rate: 1 })[0]).toMatchObject({ clipId: "c1", seconds: 2 });
    expect(mediaWants(doc, 120, { playing: true, rate: 1 }).map((w) => w.clipId)).toEqual(["m1"]);
    expect(mediaWants(doc, 29, { playing: true, rate: 1 }).map((w) => w.clipId)).toEqual(["i1", "m1"]);
    expect(mediaWants(withSpeed(doc, "c1", 0.0625), 45, { playing: true, rate: 1 })[0].rate).toBe(0.0625);
    expect(mediaWants(withSpeed(doc, "c1", 0.25), 45, { playing: true, rate: 0.25 })[0].rate).toBe(0.0625);
  });
  it("keeps a picture silent and at its start while playing", () => {
    expect(mediaWants(doc, 45, { playing: true, rate: 1 })[1]).toMatchObject({ clipId: "i1", seconds: 0, volume: 0 });
  });
  it("moves an element only past the distance, not at it", () => {
    const at = { clipId: "c1", assetId: "a1", type: "video" as const, seconds: 0, rate: 1, volume: 1 };
    expect(needsSeek(0.1, at)).toBe(false); // exactly DRIFT_SECONDS
    expect(needsSeek(0.02, { ...at, rate: 0 })).toBe(false); // exactly STILL_SECONDS
    expect(needsSeek(-0.2, at)).toBe(true);
  });
  it("keeps an audio clip on a hidden track, and the volume of a quiet clip", () => {
    expect(mediaWants(hidden(doc, "a1"), 45, { playing: true, rate: 1 }).map((w) => w.clipId)).toEqual(["c1", "i1", "m1"]);
    expect(mediaWants(withVolume(doc, "m1", 0.3), 45, { playing: true, rate: 1 })[2].volume).toBe(0.3);
    expect(mediaWants(muted(doc, "v1"), 45, { playing: true, rate: 1 })[0].volume).toBe(0);
  });
  it("leaves text out", () => {
    const d = makeDoc();
    d.tracks[2].clips = [text("x1", 0, 60)];
    expect(mediaWants(d, 45, { playing: false, rate: 1 }).map((w) => w.clipId)).toEqual(["c1", "i1", "m1"]);
    expect(upcomingAssetIds(d, 45)).toEqual(["a1", "a3", "a2"]);
  });
  it("loads ahead exactly two seconds, names an asset once, and skips a hidden track", () => {
    const d = makeDoc();
    d.tracks[0].clips.push(video("c2", 200, 30, { assetId: "a2" }), video("c3", 201, 30, { assetId: "a4" }));
    expect(upcomingAssetIds(d, 140)).toEqual(["a2"]); // c2 starts 60 frames ahead; c3 61
    expect(upcomingAssetIds(d, 141)).toEqual(["a2", "a4"]);
    expect(upcomingAssetIds(hidden(doc, "v1"), 0)).toEqual(["a3", "a2"]);
    expect(upcomingAssetIds(doc, 89)).toEqual(["a1", "a3", "a2"]);
    expect(upcomingAssetIds(doc, 90)).toEqual(["a1", "a2"]);
  });
});
