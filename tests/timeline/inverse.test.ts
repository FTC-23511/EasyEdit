import { describe, expect, it } from "vitest";
import { DEFAULT_TRANSFORM, Op, applyOps, createEmptyDoc, prepareOps, type Clip, type TimelineDoc } from "@/lib/timeline";

const video = (id: string, start: number, duration: number, extra: Record<string, unknown> = {}) =>
  ({ id, type: "video", assetId: "a", start, duration, in: 0, speed: 1, volume: 1, transform: { ...DEFAULT_TRANSFORM }, ...extra }) as Clip;
const text = (id: string, start: number, duration: number) =>
  ({ id, type: "text", start, duration, text: "hi", transform: { ...DEFAULT_TRANSFORM },
     style: { fontFamily: "Inter", fontSize: 64, fontWeight: 700, color: "#fff", align: "center" } }) as Clip;

// Tracks: v1 [c1 0-30 (in 10, speed 1.5), c2 30-60, c3 60-90], o1 (empty overlay), t1 [x1 0-60], cap, a1
function rich(): TimelineDoc {
  const d = createEmptyDoc("short_9x16");
  d.tracks[0].clips = [video("c1", 0, 30, { in: 10, speed: 1.5 }), video("c2", 30, 30), video("c3", 60, 30)];
  d.tracks.splice(1, 0, { id: "o1", kind: "overlay", name: "Overlay 1", muted: false, hidden: false, locked: false, clips: [] });
  d.tracks.find((t) => t.id === "t1")!.clips = [text("x1", 0, 60)];
  return d;
}
const ids = (d: TimelineDoc, trackId: string) => d.tracks.find((t) => t.id === trackId)!.clips.map((c) => c.id);
const clipOf = (d: TimelineDoc, id: string) => d.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
const inv = (op: Op) => applyOps(rich(), [op]).inverse;

const CASES: [string, Op][] = [
  ["add_track", { op: "add_track", track: { id: "n1", kind: "audio", name: "Music" }, index: 2 }],
  ["remove_track", { op: "remove_track", trackId: "t1" }],
  ["update_track", { op: "update_track", trackId: "v1", patch: { name: "Main", muted: true } }],
  ["replace_track existing", { op: "replace_track", track: { ...rich().tracks[0], clips: [video("z", 0, 10)] }, index: 0 }],
  ["replace_track absent", { op: "replace_track", track: { id: "n2", kind: "audio", name: "SFX", muted: false, hidden: false, locked: false, clips: [] }, index: 2 }],
  ["replace_track absent with clips", { op: "replace_track", track: { id: "n3", kind: "overlay", name: "New", muted: false, hidden: false, locked: false, clips: [video("z1", 0, 10), video("z2", 20, 10)] }, index: 1 }],
  ["add_clip", { op: "add_clip", trackId: "v1", clip: video("c4", 90, 30) }],
  ["add_clip ripple", { op: "add_clip", trackId: "v1", clip: video("c4", 30, 15), ripple: true }],
  ["remove_clip", { op: "remove_clip", clipId: "c2" }],
  ["remove_clip ripple", { op: "remove_clip", clipId: "c1", ripple: true }],
  ["move_clip same track", { op: "move_clip", clipId: "c3", start: 120 }],
  ["move_clip across tracks", { op: "move_clip", clipId: "c1", start: 5, trackId: "o1" }],
  ["trim_clip start at speed 1.5", { op: "trim_clip", clipId: "c1", edge: "start", to: 5 }],
  ["trim_clip end", { op: "trim_clip", clipId: "c3", edge: "end", to: 70 }],
  ["split_clip at speed 1.5", { op: "split_clip", clipId: "c1", at: 11, newClipId: "c5" }],
  ["update_clip", { op: "update_clip", clipId: "x1", patch: { text: "GO", style: { color: "#000" } } }],
  ["move_track", { op: "move_track", trackId: "t1", index: 0 }],
  ["set_format", { op: "set_format", format: "long_16x9" }],
];

describe("inverse round trip", () => {
  it.each(CASES)("%s: applying the inverse restores the document", (_name, op) => {
    const base = rich();
    const { doc, inverse } = applyOps(base, [op]);
    expect(doc).not.toEqual(base);
    expect(applyOps(doc, inverse).doc).toEqual(base);
  });

  // Stored inverses go to the database and back to the client as JSON, and return as an ordinary request.
  const viaJson = (ops: Op[]) => prepareOps(JSON.parse(JSON.stringify(ops)));

  it.each(CASES)("%s: the inverse survives JSON and prepareOps, and so does the inverse of the undo", (_name, op) => {
    const base = rich();
    const edit = applyOps(base, [op]);
    const undo = applyOps(edit.doc, viaJson(edit.inverse));
    expect(undo.doc).toEqual(base);
    expect(applyOps(undo.doc, viaJson(undo.inverse)).doc).toEqual(edit.doc);
  });

  it("covers every op type", () => {
    expect(new Set(CASES.map(([, op]) => op.op))).toEqual(new Set(Op.options.map((o) => o.shape.op.value)));
  });

  it("clip ops never invert to a whole-track snapshot", () => {
    for (const [name, op] of CASES) {
      if (op.op === "remove_track" || op.op === "replace_track") continue;
      expect(inv(op).map((o) => o.op), name).not.toContain("replace_track");
    }
  });

  it("a mixed batch undoes in reverse order", () => {
    const base = rich();
    const { doc, inverse } = applyOps(base, [
      { op: "split_clip", clipId: "c2", at: 45, newClipId: "c5" },
      { op: "move_clip", clipId: "c5", start: 200 },
      { op: "remove_clip", clipId: "c1", ripple: true },
      { op: "update_clip", clipId: "c5", patch: { volume: 0.5 } },
    ]);
    expect(applyOps(doc, inverse).doc).toEqual(base);
  });
});

describe("inverse shapes", () => {
  it("add_clip inverts to a plain remove_clip; remove_clip to add_clip of the snapshot", () => {
    expect(inv({ op: "add_clip", trackId: "v1", clip: video("c4", 90, 30) })).toEqual([{ op: "remove_clip", clipId: "c4" }]);
    expect(inv({ op: "remove_clip", clipId: "c2" })).toEqual([{ op: "add_clip", trackId: "v1", clip: video("c2", 30, 30) }]);
  });

  it("a ripple delete inverts to one ripple insert of the snapshot, and a ripple insert to a ripple delete", () => {
    expect(inv({ op: "remove_clip", clipId: "c1", ripple: true })).toEqual([
      { op: "add_clip", trackId: "v1", clip: video("c1", 0, 30, { in: 10, speed: 1.5 }), ripple: true },
    ]);
    expect(inv({ op: "add_clip", trackId: "v1", clip: video("c4", 30, 10), ripple: true })).toEqual([
      { op: "remove_clip", clipId: "c4", ripple: true, expect: { start: 30, duration: 10 } },
    ]);
  });

  it("undoing a ripple insert after a teammate moved the inserted clip is refused STALE", () => {
    const a = applyOps(rich(), [{ op: "add_clip", trackId: "v1", clip: video("n", 30, 15), ripple: true }]);
    const b = applyOps(a.doc, [{ op: "move_clip", clipId: "n", start: 200 }]);
    expect(() => applyOps(b.doc, a.inverse)).toThrow(expect.objectContaining({ name: "OpError", code: "STALE", opIndex: 0 }));
    // Untouched, the same undo closes the gap again.
    expect(applyOps(a.doc, a.inverse).doc).toEqual(rich());
  });

  it("move_clip names the old track only when the clip changed tracks", () => {
    expect(inv({ op: "move_clip", clipId: "c3", start: 120 })).toEqual([
      { op: "move_clip", clipId: "c3", start: 60, expect: { start: 120 } },
    ]);
    expect(inv({ op: "move_clip", clipId: "c1", start: 5, trackId: "o1" })).toEqual([
      { op: "move_clip", clipId: "c1", start: 0, trackId: "v1", expect: { start: 5, trackId: "o1" } },
    ]);
  });

  it("trim_clip restores the old edge, and for a start trim the exact source in", () => {
    expect(inv({ op: "trim_clip", clipId: "c1", edge: "start", to: 5 })).toEqual([
      { op: "trim_clip", clipId: "c1", edge: "start", to: 0, in: 10, expect: { start: 5, in: 18 } },
    ]);
    expect(inv({ op: "trim_clip", clipId: "c3", edge: "end", to: 70 })).toEqual([
      { op: "trim_clip", clipId: "c3", edge: "end", to: 90, expect: { start: 60, duration: 10 } },
    ]);
  });

  it("split_clip removes the new clip, then trims the left clip back", () => {
    expect(inv({ op: "split_clip", clipId: "c2", at: 45, newClipId: "c5" })).toEqual([
      { op: "remove_clip", clipId: "c5", expect: { start: 45, duration: 15 } },
      { op: "trim_clip", clipId: "c2", edge: "end", to: 60, expect: { start: 30, duration: 15 } },
    ]);
  });

  it("update_clip and update_track carry only the fields that changed", () => {
    expect(inv({ op: "update_clip", clipId: "x1", patch: { text: "hi", style: { color: "#000", align: "center" } } })).toEqual([
      { op: "update_clip", clipId: "x1", patch: { style: { color: "#fff" } }, expect: { style: { color: "#000" } } },
    ]);
    expect(inv({ op: "update_track", trackId: "v1", patch: { name: "Video 1", muted: true } })).toEqual([
      { op: "update_track", trackId: "v1", patch: { muted: false }, expect: { muted: true } },
    ]);
  });

  it("set_format expects the format it wrote", () => {
    expect(inv({ op: "set_format", format: "long_16x9" })).toEqual([
      { op: "set_format", format: "short_9x16", expect: { format: "long_16x9" } },
    ]);
  });

  it("a batch that changes nothing has an empty inverse", () => {
    expect(inv({ op: "update_clip", clipId: "x1", patch: { text: "hi" } })).toEqual([]);
  });

  it("add_track and an inserting replace_track invert to a remove_track guarded by the clips they added", () => {
    expect(inv({ op: "add_track", track: { id: "n1", kind: "audio", name: "Music" } })).toEqual([
      { op: "remove_track", trackId: "n1", expect: { clipIds: [] } },
    ]);
    const track = { id: "n2", kind: "overlay" as const, name: "New", muted: false, hidden: false, locked: false, clips: [video("z2", 20, 10), video("z1", 0, 10)] };
    expect(inv({ op: "replace_track", track, index: 1 })).toEqual([
      { op: "remove_track", trackId: "n2", expect: { clipIds: ["z1", "z2"] } },
    ]);
  });

  it("remove_track inverts to a restoring replace_track at the old index", () => {
    expect(inv({ op: "remove_track", trackId: "t1" })).toEqual([
      { op: "replace_track", track: rich().tracks[2], index: 2, restore: true },
    ]);
  });

  it("a restoring replace_track refuses a track that exists again, and clamps its index", () => {
    const removed = applyOps(rich(), [{ op: "remove_track", trackId: "t1" }]);
    const readded = applyOps(removed.doc, [{ op: "add_track", track: { id: "t1", kind: "text", name: "New" } }]).doc;
    expect(() => applyOps(readded, removed.inverse)).toThrow(expect.objectContaining({ code: "DUPLICATE_ID", opIndex: 0 }));
    const last = applyOps(rich(), [{ op: "remove_track", trackId: "a1" }]); // was at index 4
    const fewer = applyOps(last.doc, [{ op: "remove_track", trackId: "o1" }]).doc;
    expect(applyOps(fewer, last.inverse).doc.tracks.map((t) => t.id)).toEqual(["v1", "t1", "cap", "a1"]);
  });

  it("trim_clip in is INVALID on an end trim and on a text clip", () => {
    expect(() => applyOps(rich(), [{ op: "trim_clip", clipId: "c3", edge: "end", to: 70, in: 0 }])).toThrow(expect.objectContaining({ code: "INVALID" }));
    expect(() => applyOps(rich(), [{ op: "trim_clip", clipId: "x1", edge: "start", to: 10, in: 0 }])).toThrow(expect.objectContaining({ code: "INVALID" }));
  });
});

describe("ripple insert", () => {
  it("a ripple delete then its inverse restores the document exactly; the inverse's inverse repeats the delete", () => {
    const base = rich();
    const deleted = applyOps(base, [{ op: "remove_clip", clipId: "c2", ripple: true }]);
    const undone = applyOps(deleted.doc, deleted.inverse);
    expect(undone.doc).toEqual(base);
    expect(applyOps(undone.doc, undone.inverse).doc).toEqual(deleted.doc);
  });

  it("shifts every clip at or after the new clip's start right by its duration, then inserts it", () => {
    const { doc } = applyOps(rich(), [{ op: "add_clip", trackId: "v1", clip: video("n", 30, 15), ripple: true }]);
    expect(doc.tracks[0].clips.map((c) => [c.id, c.start])).toEqual([["c1", 0], ["n", 30], ["c2", 45], ["c3", 75]]);
  });

  it("a clip straddling the insert point is OVERLAP; lock, kind and id rules are those of add_clip", () => {
    const fails = (d: TimelineDoc, op: Op, code: string) =>
      expect(() => applyOps(d, [op])).toThrow(expect.objectContaining({ name: "OpError", code, opIndex: 0 }));
    fails(rich(), { op: "add_clip", trackId: "v1", clip: video("n", 10, 5), ripple: true }, "OVERLAP");
    fails(rich(), { op: "add_clip", trackId: "v1", clip: video("c2", 30, 5), ripple: true }, "DUPLICATE_ID");
    fails(rich(), { op: "add_clip", trackId: "t1", clip: video("n", 0, 5), ripple: true }, "WRONG_TRACK_KIND");
    const locked = applyOps(rich(), [{ op: "update_track", trackId: "v1", patch: { locked: true } }]).doc;
    fails(locked, { op: "add_clip", trackId: "v1", clip: video("n", 0, 5), ripple: true }, "TRACK_LOCKED");
  });

  it("prepareOps accepts ripple: true on add_clip and rejects ripple: false", () => {
    const clip = video("n", 0, 5);
    expect(prepareOps([{ op: "add_clip", trackId: "v1", clip, ripple: true }])[0]).toMatchObject({ ripple: true });
    expect(() => prepareOps([{ op: "add_clip", trackId: "v1", clip, ripple: false } as never])).toThrow(
      expect.objectContaining({ code: "INVALID" }),
    );
  });

  it("ten ripple deletes on a 60-clip track undo with ten ops in one request", () => {
    const base = createEmptyDoc("short_9x16");
    base.tracks[0].clips = Array.from({ length: 60 }, (_, i) => video(`k${i}`, i * 10, 10));
    const ops: Op[] = Array.from({ length: 10 }, (_, i) => ({ op: "remove_clip", clipId: `k${i * 2}`, ripple: true }));
    const { doc, inverse } = applyOps(base, ops);
    expect(inverse).toHaveLength(10);
    expect(applyOps(doc, inverse).doc).toEqual(base);
  });
});

describe("undo after a teammate's edit", () => {
  it("undoing A's add_clip removes only A's clip after B added one on the same track", () => {
    const a = applyOps(rich(), [{ op: "add_clip", trackId: "v1", clip: video("ax", 90, 30) }]);
    const b = applyOps(a.doc, [{ op: "add_clip", trackId: "v1", clip: video("by", 120, 30) }]);
    expect(ids(applyOps(b.doc, a.inverse).doc, "v1")).toEqual(["c1", "c2", "c3", "by"]);
  });

  it("undoing A's text change keeps B's colour change on the same clip", () => {
    const a = applyOps(rich(), [{ op: "update_clip", clipId: "x1", patch: { text: "GO" } }]);
    const b = applyOps(a.doc, [{ op: "update_clip", clipId: "x1", patch: { style: { color: "#f00" } } }]);
    expect(clipOf(applyOps(b.doc, a.inverse).doc, "x1")).toMatchObject({ text: "hi", style: { color: "#f00" } });
  });

  it("undoing A's rename keeps B's mute on the same track", () => {
    const a = applyOps(rich(), [{ op: "update_track", trackId: "v1", patch: { name: "Main" } }]);
    const b = applyOps(a.doc, [{ op: "update_track", trackId: "v1", patch: { muted: true } }]);
    expect(applyOps(b.doc, a.inverse).doc.tracks[0]).toMatchObject({ name: "Video 1", muted: true });
  });

  it("undoing A's start trim keeps B's end trim", () => {
    const a = applyOps(rich(), [{ op: "trim_clip", clipId: "c3", edge: "start", to: 65 }]);
    const b = applyOps(a.doc, [{ op: "trim_clip", clipId: "c3", edge: "end", to: 80 }]);
    expect(clipOf(applyOps(b.doc, a.inverse).doc, "c3")).toMatchObject({ start: 60, duration: 20, in: 0 });
  });

  it("an undo whose clip a teammate removed fails with NOT_FOUND", () => {
    const a = applyOps(rich(), [{ op: "add_clip", trackId: "v1", clip: video("ax", 90, 30) }]);
    const b = applyOps(a.doc, [{ op: "remove_clip", clipId: "ax" }]);
    expect(() => applyOps(b.doc, a.inverse)).toThrow(expect.objectContaining({ name: "OpError", code: "NOT_FOUND", opIndex: 0 }));
  });

  it("undoing a ripple delete fails with OVERLAP and changes nothing when a teammate placed a clip across the gap start", () => {
    const a = applyOps(rich(), [{ op: "remove_clip", clipId: "c2", ripple: true }]); // v1: c1 0-30, c3 30-60
    const b = applyOps(a.doc, [
      { op: "trim_clip", clipId: "c1", edge: "end", to: 20 },
      { op: "move_clip", clipId: "c3", start: 40 },
      { op: "add_clip", trackId: "v1", clip: video("by", 20, 20) }, // spans frame 30, where c2 goes back
    ]);
    const before = structuredClone(b.doc);
    expect(() => applyOps(b.doc, a.inverse)).toThrow(expect.objectContaining({ code: "OVERLAP", opIndex: 0 }));
    expect(b.doc).toEqual(before);
  });

  it("undoing A's ripple delete after B moved a later clip shifts B's clip right by the restored duration", () => {
    const a = applyOps(rich(), [{ op: "remove_clip", clipId: "c1", ripple: true }]); // v1: c2 0-30, c3 30-60
    const b = applyOps(a.doc, [{ op: "move_clip", clipId: "c3", start: 100 }]);
    const undone = applyOps(b.doc, a.inverse).doc;
    expect(ids(undone, "v1")).toEqual(["c1", "c2", "c3"]);
    expect(clipOf(undone, "c1")).toEqual(clipOf(rich(), "c1"));
    expect(clipOf(undone, "c2")).toMatchObject({ start: 30 });
    expect(clipOf(undone, "c3")).toMatchObject({ start: 130 });
  });
});

describe("an undo refuses to overwrite a teammate's later change", () => {
  // Applies A's inverse on top of B's doc and checks it fails STALE without touching B's doc.
  function refused(bDoc: TimelineDoc, inverse: Op[], opIndex = 0) {
    const before = structuredClone(bDoc);
    expect(() => applyOps(bDoc, inverse)).toThrow(expect.objectContaining({ name: "OpError", code: "STALE", opIndex }));
    expect(bDoc).toEqual(before);
  }

  it("a. start trim, then a teammate moves the clip", () => {
    const a = applyOps(rich(), [{ op: "trim_clip", clipId: "c3", edge: "start", to: 65 }]);
    const b = applyOps(a.doc, [{ op: "move_clip", clipId: "c3", start: 100 }]);
    refused(b.doc, a.inverse);
  });

  it("b. end trim, then a teammate moves the clip", () => {
    const a = applyOps(rich(), [{ op: "trim_clip", clipId: "c3", edge: "end", to: 70 }]);
    const b = applyOps(a.doc, [{ op: "move_clip", clipId: "c3", start: 62 }]);
    refused(b.doc, a.inverse);
  });

  it("c. move, then a teammate moves the clip again", () => {
    const a = applyOps(rich(), [{ op: "move_clip", clipId: "c3", start: 120 }]);
    const b = applyOps(a.doc, [{ op: "move_clip", clipId: "c3", start: 150 }]);
    refused(b.doc, a.inverse);
  });

  it("d. text change, then a teammate changes the same text", () => {
    const a = applyOps(rich(), [{ op: "update_clip", clipId: "x1", patch: { text: "GO" } }]);
    const b = applyOps(a.doc, [{ op: "update_clip", clipId: "x1", patch: { text: "STOP" } }]);
    refused(b.doc, a.inverse);
  });

  it("e. format change, then a teammate sets another format", () => {
    const a = applyOps(rich(), [{ op: "set_format", format: "long_16x9" }]);
    const b = applyOps(a.doc, [{ op: "set_format", format: "square_1x1" }]);
    refused(b.doc, a.inverse);
  });

  it("f. add track, then a teammate adds a clip to it; the teammate's clip stays", () => {
    const a = applyOps(rich(), [{ op: "add_track", track: { id: "n1", kind: "overlay", name: "New" } }]);
    const b = applyOps(a.doc, [{ op: "add_clip", trackId: "n1", clip: video("by", 0, 30) }]);
    expect(() => applyOps(b.doc, a.inverse)).toThrow(
      expect.objectContaining({ code: "STALE", message: 'remove_track: track "n1" changed since this edit' }),
    );
    refused(b.doc, a.inverse);
    expect(ids(b.doc, "n1")).toEqual(["by"]);
  });

  it("g. split, then a teammate moves the right half", () => {
    const a = applyOps(rich(), [{ op: "split_clip", clipId: "c2", at: 45, newClipId: "c5" }]);
    const b = applyOps(a.doc, [{ op: "move_clip", clipId: "c5", start: 100 }]);
    expect(() => applyOps(b.doc, a.inverse)).toThrow(
      expect.objectContaining({ code: "STALE", message: 'remove_clip: clip "c5" changed since this edit' }),
    );
    refused(b.doc, a.inverse);
  });

  it("h. replace_track that inserted a track, then a teammate adds a clip to it", () => {
    const track = { id: "n2", kind: "overlay" as const, name: "New", muted: false, hidden: false, locked: false, clips: [video("z1", 0, 10), video("z2", 20, 10)] };
    const a = applyOps(rich(), [{ op: "replace_track", track, index: 1 }]);
    const b = applyOps(a.doc, [{ op: "add_clip", trackId: "n2", clip: video("by", 40, 10) }]);
    refused(b.doc, a.inverse);
  });

  it("the add-track, split and inserting replace_track undos succeed when nothing changed in between", () => {
    const track = { id: "n2", kind: "overlay" as const, name: "New", muted: false, hidden: false, locked: false, clips: [video("z1", 0, 10)] };
    for (const op of [
      { op: "add_track", track: { id: "n1", kind: "overlay", name: "New" } },
      { op: "split_clip", clipId: "c2", at: 45, newClipId: "c5" },
      { op: "replace_track", track, index: 1 },
    ] as Op[]) {
      const a = applyOps(rich(), [op]);
      const b = applyOps(a.doc, [{ op: "update_clip", clipId: "x1", patch: { text: "B" } }]);
      const undone = applyOps(b.doc, a.inverse).doc;
      expect(undone.tracks.map((t) => t.id), op.op).toEqual(rich().tracks.map((t) => t.id));
      expect(ids(undone, "v1"), op.op).toEqual(["c1", "c2", "c3"]);
    }
  });

  it("a remove_track guard matches the clip ids in any order; a remove_clip guard checks start and duration", () => {
    expect(applyOps(rich(), [{ op: "remove_track", trackId: "v1", expect: { clipIds: ["c3", "c1", "c2"] } }]).doc.tracks).toHaveLength(4);
    refused(rich(), [{ op: "remove_track", trackId: "v1", expect: { clipIds: ["c1", "c2"] } }]);
    refused(rich(), [{ op: "remove_track", trackId: "v1", expect: { clipIds: ["c1", "c2", "c3", "c9"] } }]);
    expect(ids(applyOps(rich(), [{ op: "remove_clip", clipId: "c2", expect: { start: 30, duration: 30 } }]).doc, "v1")).toEqual(["c1", "c3"]);
    refused(rich(), [{ op: "remove_clip", clipId: "c2", expect: { start: 30, duration: 20 } }]);
    refused(rich(), [{ op: "remove_clip", clipId: "c2", expect: { start: 31, duration: 30 } }]);
  });

  it("still undoes a move when a teammate edited a different clip on the same track", () => {
    const a = applyOps(rich(), [{ op: "move_clip", clipId: "c3", start: 120 }]);
    const b = applyOps(a.doc, [{ op: "update_clip", clipId: "c2", patch: { volume: 0.5 } }]);
    const undone = applyOps(b.doc, a.inverse).doc;
    expect(clipOf(undone, "c3")).toMatchObject({ start: 60 });
    expect(clipOf(undone, "c2")).toMatchObject({ volume: 0.5 });
  });

  it("an ordinary op without expect still applies to a clip a teammate changed", () => {
    const moved = applyOps(rich(), [{ op: "move_clip", clipId: "c3", start: 100 }]).doc;
    const { doc } = applyOps(moved, [{ op: "trim_clip", clipId: "c3", edge: "end", to: 110 }]);
    expect(clipOf(doc, "c3")).toMatchObject({ start: 100, duration: 10, in: 0 });
  });
});
