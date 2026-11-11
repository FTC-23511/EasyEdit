import { describe, expect, it } from "vitest";
import { LIMITS } from "@/lib/limits";
import { DEFAULT_TRANSFORM, applyOps, createEmptyDoc, prepareOps, type Clip, type TimelineDoc, type Transform } from "@/lib/timeline";

const video = (id: string, start: number, duration: number, extra: Record<string, unknown> = {}) =>
  ({ id, type: "video", assetId: "a", start, duration, in: 0, speed: 1, volume: 1, transform: { ...DEFAULT_TRANSFORM }, ...extra }) as Clip;
const textClip = (id: string, text: string) =>
  ({ id, type: "text", start: 0, duration: 30, text, transform: { ...DEFAULT_TRANSFORM },
     style: { fontFamily: "Inter", fontSize: 64, fontWeight: 700, color: "#fff", align: "center" } }) as Clip;
const fails = (fn: () => unknown, code: string) => expect(fn).toThrow(expect.objectContaining({ name: "OpError", code }));
const track = (id: string, kind = "audio") => ({ id, kind, name: id, muted: false, hidden: false, locked: false, clips: [] }) as TimelineDoc["tracks"][number];

describe("limits", () => {
  it("holds the agreed values", () => {
    expect(LIMITS).toEqual({ projectNameChars: 100, textClipChars: 2000, tracksPerProject: 20, clipsPerTrack: 1000,
      docBytes: 2_097_152, opsPerRequest: 500, opsPageDefault: 100, opsPageMax: 500, opLogRowBytes: 1_048_576,
      opsPageBytes: 2_097_152, trackNameChars: 100, connectorReadChars: 16_000, connectorEchoChars: 6_000,
      connectorListPage: 50, connectorConflictEntries: 10, connectorTextItems: 20, connectorWritesPerMinute: 30,
      connectorBytesPerDay: 10_485_760, connectorProjectsPerDay: 50 });
  });

  it("text up to 2,000 characters is accepted; 2,001 is INVALID on add and on update", () => {
    expect(prepareOps([{ op: "add_clip", trackId: "t1", clip: textClip("x1", "x".repeat(2000)) }])).toHaveLength(1);
    fails(() => prepareOps([{ op: "add_clip", trackId: "t1", clip: textClip("x1", "x".repeat(2001)) }]), "INVALID");
    const d = applyOps(createEmptyDoc("short_9x16"), [{ op: "add_clip", trackId: "t1", clip: textClip("x1", "hi") }]).doc;
    fails(() => applyOps(d, [{ op: "update_clip", clipId: "x1", patch: { text: "x".repeat(2001) } }]), "INVALID");
  });

  it("a 21st track is LIMIT_EXCEEDED; the 20th is fine", () => {
    const d = createEmptyDoc("short_9x16");
    for (let i = 0; i < 15; i++) d.tracks.push(track(`x${i}`));
    const twenty = applyOps(d, [{ op: "add_track", track: { id: "n20", kind: "audio", name: "20" } }]).doc;
    expect(twenty.tracks).toHaveLength(20);
    fails(() => applyOps(twenty, [{ op: "add_track", track: { id: "n21", kind: "audio", name: "21" } }]), "LIMIT_EXCEEDED");
    fails(() => applyOps(twenty, [{ op: "replace_track", track: track("n21"), index: 0 }]), "LIMIT_EXCEEDED");
  });

  it("a 1,001st clip on a track is LIMIT_EXCEEDED for add, split and a cross-track move", () => {
    const d = createEmptyDoc("short_9x16");
    d.tracks[0].clips = Array.from({ length: 999 }, (_, i) => video(`k${i}`, i * 2, 2));
    d.tracks.push({ ...track("o1", "overlay"), clips: [video("m", 0, 5)] });
    const full = applyOps(d, [{ op: "add_clip", trackId: "v1", clip: video("k999", 5000, 2) }]).doc;
    fails(() => applyOps(full, [{ op: "add_clip", trackId: "v1", clip: video("k1000", 6000, 2) }]), "LIMIT_EXCEEDED");
    fails(() => applyOps(full, [{ op: "split_clip", clipId: "k0", at: 1, newClipId: "s" }]), "LIMIT_EXCEEDED");
    fails(() => applyOps(full, [{ op: "move_clip", clipId: "m", start: 7000, trackId: "v1" }]), "LIMIT_EXCEEDED");
  });
});

describe("timeline rules", () => {
  it("a project can have only one caption track", () => {
    const d = createEmptyDoc("short_9x16");
    expect(() => applyOps(d, [{ op: "add_track", track: { id: "cap2", kind: "caption", name: "More" } }]))
      .toThrow(expect.objectContaining({ code: "INVALID", message: expect.stringContaining("only one caption track") }));
    fails(() => applyOps(d, [{ op: "replace_track", track: track("cap2", "caption"), index: 0 }]), "INVALID");
    const without = applyOps(d, [{ op: "remove_track", trackId: "cap" }]).doc;
    expect(applyOps(without, [{ op: "add_track", track: { id: "cap2", kind: "caption", name: "Captions" } }]).doc.tracks).toHaveLength(4);
  });

  it("an image clip can be trimmed from the left; its in stays 0 and undo restores it", () => {
    const d = createEmptyDoc("short_9x16");
    d.tracks[0].clips = [video("i1", 30, 60, { type: "image" })];
    const { doc, inverse } = applyOps(d, [{ op: "trim_clip", clipId: "i1", edge: "start", to: 10 }]);
    expect(doc.tracks[0].clips[0]).toMatchObject({ start: 10, duration: 80, in: 0 });
    expect(applyOps(doc, inverse).doc).toEqual(d);
  });

  it("DEFAULT_TRANSFORM is frozen", () => {
    expect(Object.isFrozen(DEFAULT_TRANSFORM)).toBe(true);
    expect(() => { (DEFAULT_TRANSFORM as Transform).x = 0; }).toThrow(TypeError);
  });
});

describe("rules only apply when a count grows", () => {
  const withClips = (id: string, n: number, kind = "video") =>
    ({ ...track(id, kind), clips: Array.from({ length: n }, (_, i) => video(`${id}c${i}`, i * 2, 2)) }) as TimelineDoc["tracks"][number];

  it("replace_track with 1,001 clips over a 1,000-clip track is LIMIT_EXCEEDED; 1,000 is fine", () => {
    const d = createEmptyDoc("short_9x16");
    d.tracks[0] = withClips("v1", 1000);
    fails(() => applyOps(d, [{ op: "replace_track", track: withClips("v1", 1001), index: 0 }]), "LIMIT_EXCEEDED");
    expect(applyOps(d, [{ op: "replace_track", track: withClips("v1", 1000), index: 0 }]).doc.tracks[0].clips).toHaveLength(1000);
  });

  it("replacing an existing track at 20 tracks is fine", () => {
    const d = createEmptyDoc("short_9x16");
    for (let i = 0; i < 16; i++) d.tracks.push(track(`x${i}`));
    expect(d.tracks).toHaveLength(20);
    const out = applyOps(d, [{ op: "replace_track", track: { ...track("x0"), name: "renamed" }, index: 0 }]).doc;
    expect(out.tracks).toHaveLength(20);
    expect(out.tracks.find((t) => t.id === "x0")?.name).toBe("renamed");
  });

  it("a document already over the track limit can still be edited down", () => {
    const d = createEmptyDoc("short_9x16");
    for (let i = 0; i < 17; i++) d.tracks.push(track(`x${i}`));
    d.tracks[0].clips = [video("k1", 0, 10)];
    expect(d.tracks).toHaveLength(21);
    expect(applyOps(d, [{ op: "remove_track", trackId: "x0" }]).doc.tracks).toHaveLength(20);
    const moved = applyOps(d, [{ op: "move_clip", clipId: "k1", start: 20 }]).doc;
    expect(moved.tracks[0].clips[0].start).toBe(20);
    expect(applyOps(d, [{ op: "replace_track", track: { ...track("x1"), name: "n" }, index: 0 }]).doc.tracks).toHaveLength(21);
  });

  it("with two caption tracks already, replacing one with a caption track works and a third is refused", () => {
    const d = createEmptyDoc("short_9x16");
    d.tracks.push(track("cap2", "caption"));
    const out = applyOps(d, [{ op: "replace_track", track: { ...track("cap2", "caption"), name: "n" }, index: 0 }]).doc;
    expect(out.tracks.filter((t) => t.kind === "caption")).toHaveLength(2);
    fails(() => applyOps(d, [{ op: "add_track", track: { id: "cap3", kind: "caption", name: "3" } }]), "INVALID");
    fails(() => applyOps(d, [{ op: "replace_track", track: track("cap3", "caption"), index: 0 }]), "INVALID");
  });

  it("replace_track with a 2,001-character text clip is INVALID", () => {
    const t = { ...track("t9", "text"), clips: [textClip("x1", "x".repeat(2001))] };
    fails(() => prepareOps([{ op: "replace_track", track: t, index: 0 }] as never), "INVALID");
    const ok = { ...track("t9", "text"), clips: [textClip("x1", "x".repeat(2000))] };
    expect(prepareOps([{ op: "replace_track", track: ok, index: 0 }] as never)).toHaveLength(1);
  });
});

describe("expect guards are validated like the fields they guard", () => {
  const invalid = (op: unknown) => fails(() => prepareOps([op as never]), "INVALID");
  const valid = (op: unknown) => expect(prepareOps([op as never])).toHaveLength(1);

  it("update_clip expect takes the clip's editable fields, each optional, and nothing else", () => {
    valid({ op: "update_clip", clipId: "c", patch: { text: "a" }, expect: { text: "b" } });
    valid({ op: "update_clip", clipId: "c", patch: { volume: 1 }, expect: { volume: 0.5, transform: { x: 0.1 }, style: { color: "#000" } } });
    valid({ op: "update_clip", clipId: "c", patch: { in: 1 }, expect: {} });
    invalid({ op: "update_clip", clipId: "c", patch: {}, expect: { bogus: 1 } });
    invalid({ op: "update_clip", clipId: "c", patch: {}, expect: { volume: "loud" } });
    invalid({ op: "update_clip", clipId: "c", patch: {}, expect: { transform: { x: 0.1, bogus: 1 } } });
    invalid({ op: "update_clip", clipId: "c", patch: {}, expect: { style: { weight: 1 } } });
    invalid({ op: "update_clip", clipId: "c", patch: {}, expect: { text: "x".repeat(2001) } });
  });

  it("update_track expect takes the track patch fields, each optional, and nothing else", () => {
    valid({ op: "update_track", trackId: "v1", patch: { muted: true }, expect: { muted: false, name: "V" } });
    invalid({ op: "update_track", trackId: "v1", patch: { muted: true }, expect: { muted: false, bogus: 1 } });
    invalid({ op: "update_track", trackId: "v1", patch: { muted: true }, expect: { muted: "no" } });
  });

  it("trim_clip, move_clip, set_format, remove_clip and remove_track refuse unknown keys in expect", () => {
    valid({ op: "trim_clip", clipId: "c", edge: "end", to: 5, expect: { start: 0, duration: 3 } });
    invalid({ op: "trim_clip", clipId: "c", edge: "end", to: 5, expect: { start: 0, bogus: 1 } });
    valid({ op: "move_clip", clipId: "c", start: 5, expect: { start: 0, trackId: "v1" } });
    invalid({ op: "move_clip", clipId: "c", start: 5, expect: { start: 0, bogus: 1 } });
    valid({ op: "set_format", format: "long_16x9", expect: { format: "short_9x16" } });
    invalid({ op: "set_format", format: "long_16x9", expect: { format: "short_9x16", bogus: 1 } });
    invalid({ op: "remove_clip", clipId: "c", expect: { start: 0, duration: 3, bogus: 1 } });
    invalid({ op: "remove_track", trackId: "v1", expect: { clipIds: [], bogus: 1 } });
  });
});

describe("text Postgres can store", () => {
  const unstorable = ["a\u0000b", "a\ud800", "\udc00b", "\udc00\ud800"];
  const fullTrack = (name: string) => ({ ...track("n1", "overlay"), name });

  it("clip text with a NUL or a lone surrogate is INVALID on add, replace and update; an emoji is fine", () => {
    for (const text of unstorable) {
      fails(() => prepareOps([{ op: "add_clip", trackId: "t1", clip: textClip("x1", text) }]), "INVALID");
      fails(() => prepareOps([{ op: "replace_track", track: { ...track("t9", "text"), clips: [textClip("x1", text)] }, index: 0 }] as never), "INVALID");
    }
    const d = applyOps(createEmptyDoc("short_9x16"), [{ op: "add_clip", trackId: "t1", clip: textClip("x1", "GO 🤖🇺🇸") }]).doc;
    fails(() => applyOps(d, [{ op: "update_clip", clipId: "x1", patch: { text: "a\u0000b" } }]), "INVALID");
    fails(() => applyOps(d, [{ op: "update_clip", clipId: "x1", patch: { text: "a\ud800" } }]), "INVALID");
  });

  it("track names with a NUL or a lone surrogate, or over 100 characters, are INVALID on add, update and replace", () => {
    for (const name of [...unstorable, "x".repeat(101)]) {
      fails(() => prepareOps([{ op: "add_track", track: { kind: "overlay", name } }]), "INVALID");
      fails(() => prepareOps([{ op: "update_track", trackId: "v1", patch: { name } }]), "INVALID");
      fails(() => prepareOps([{ op: "replace_track", track: fullTrack(name), index: 0 }] as never), "INVALID");
    }
    for (const name of ["x".repeat(100), "🤖 Robot cam"]) {
      expect(prepareOps([{ op: "add_track", track: { kind: "overlay", name } }])).toHaveLength(1);
      expect(prepareOps([{ op: "update_track", trackId: "v1", patch: { name } }])).toHaveLength(1);
      expect(prepareOps([{ op: "replace_track", track: fullTrack(name), index: 0 }] as never)).toHaveLength(1);
    }
  });
});
