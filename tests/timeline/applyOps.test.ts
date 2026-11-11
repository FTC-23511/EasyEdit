import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRANSFORM,
  OpError,
  applyOps,
  createEmptyDoc,
  prepareOps,
  type Op,
  type OpInput,
  type TimelineDoc,
} from "@/lib/timeline";

const doc0 = () => createEmptyDoc("short_9x16");
const clip = (id: string, start: number, duration: number) =>
  ({
    id,
    type: "video",
    assetId: "a",
    start,
    duration,
    in: 0,
    speed: 1,
    volume: 1,
    transform: { ...DEFAULT_TRANSFORM },
  }) as const;
const textClip = (id: string, start: number, duration: number) =>
  ({
    id,
    type: "text",
    start,
    duration,
    transform: { ...DEFAULT_TRANSFORM },
    text: "hi",
    style: { fontFamily: "Inter", fontSize: 64, fontWeight: 700, color: "#fff", align: "center" },
  }) as const;
const overlayTrack = { id: "o1", kind: "overlay", name: "Overlay 1" } as const;

function apply(d: TimelineDoc, ops: Op[]) {
  return applyOps(d, ops);
}
function clipIdOf(op: Op) {
  if (op.op !== "add_clip") throw new Error("expected add_clip");
  return op.clip.id;
}
function trackIdOf(op: Op) {
  if (op.op !== "add_track") throw new Error("expected add_track");
  return op.track.id;
}
function failsWith(fn: () => unknown, code: string, opIndex: number) {
  expect(fn).toThrow(expect.objectContaining({ name: "OpError", code, opIndex }));
}

describe("applyOps: clips", () => {
  it("add_clip then inverse restores the original doc", () => {
    const d = doc0();
    const { doc, inverse } = applyOps(d, [{ op: "add_clip", trackId: "v1", clip: clip("c1", 0, 30) }]);
    expect(doc.tracks[0].clips).toHaveLength(1);
    expect(d.tracks[0].clips).toHaveLength(0); // input untouched
    expect(applyOps(doc, inverse).doc).toEqual(d);
  });

  it("touching clips are allowed, overlapping are not", () => {
    const { doc } = applyOps(doc0(), [
      { op: "add_clip", trackId: "v1", clip: clip("c1", 0, 30) },
      { op: "add_clip", trackId: "v1", clip: clip("c2", 30, 30) },
    ]);
    expect(() => applyOps(doc, [{ op: "move_clip", clipId: "c2", start: 29 }])).toThrow(
      expect.objectContaining({ code: "OVERLAP", opIndex: 0 }),
    );
  });

  it("add_clip that overlaps an existing clip is OVERLAP", () => {
    const { doc } = apply(doc0(), [{ op: "add_clip", trackId: "v1", clip: clip("c1", 0, 30) }]);
    failsWith(() => apply(doc, [{ op: "add_clip", trackId: "v1", clip: clip("c2", 29, 10) }]), "OVERLAP", 0);
  });

  it("a bad op rejects the whole batch with its index", () => {
    const d = doc0();
    expect(() =>
      applyOps(d, [
        { op: "add_clip", trackId: "v1", clip: clip("c1", 0, 30) },
        { op: "remove_clip", clipId: "nope" },
      ]),
    ).toThrow(expect.objectContaining({ code: "NOT_FOUND", opIndex: 1 }));
    expect(d.tracks[0].clips).toHaveLength(0);
  });

  it("missing tracks and clips are NOT_FOUND", () => {
    failsWith(() => apply(doc0(), [{ op: "add_clip", trackId: "zz", clip: clip("c1", 0, 30) }]), "NOT_FOUND", 0);
    const { doc } = apply(doc0(), [{ op: "add_clip", trackId: "v1", clip: clip("c1", 0, 30) }]);
    failsWith(() => apply(doc, [{ op: "move_clip", clipId: "c1", start: 0, trackId: "zz" }]), "NOT_FOUND", 0);
    failsWith(() => apply(doc, [{ op: "move_clip", clipId: "zz", start: 0 }]), "NOT_FOUND", 0);
  });

  it("text clip on a video track is WRONG_TRACK_KIND", () => {
    failsWith(() => apply(doc0(), [{ op: "add_clip", trackId: "v1", clip: textClip("x", 0, 30) }]), "WRONG_TRACK_KIND", 0);
  });

  it("nothing is accepted on a caption track", () => {
    failsWith(() => apply(doc0(), [{ op: "add_clip", trackId: "cap", clip: textClip("x", 0, 30) }]), "WRONG_TRACK_KIND", 0);
  });

  it("move_clip to a track of the wrong kind is WRONG_TRACK_KIND", () => {
    const { doc } = apply(doc0(), [{ op: "add_clip", trackId: "v1", clip: clip("c1", 0, 30) }]);
    failsWith(() => apply(doc, [{ op: "move_clip", clipId: "c1", start: 0, trackId: "t1" }]), "WRONG_TRACK_KIND", 0);
  });

  it("locked track rejects clip edits", () => {
    const { doc } = apply(doc0(), [
      { op: "add_clip", trackId: "v1", clip: clip("c1", 0, 30) },
      { op: "update_track", trackId: "v1", patch: { locked: true } },
    ]);
    failsWith(() => apply(doc, [{ op: "add_clip", trackId: "v1", clip: clip("c2", 30, 30) }]), "TRACK_LOCKED", 0);
    failsWith(() => apply(doc, [{ op: "remove_clip", clipId: "c1" }]), "TRACK_LOCKED", 0);
    failsWith(() => apply(doc, [{ op: "move_clip", clipId: "c1", start: 10 }]), "TRACK_LOCKED", 0);
  });

  it("a locked destination track rejects a cross-track move", () => {
    const { doc } = apply(doc0(), [
      { op: "add_track", track: overlayTrack },
      { op: "add_clip", trackId: "v1", clip: clip("c1", 0, 30) },
      { op: "update_track", trackId: "o1", patch: { locked: true } },
    ]);
    failsWith(() => apply(doc, [{ op: "move_clip", clipId: "c1", start: 0, trackId: "o1" }]), "TRACK_LOCKED", 0);
  });

  it("duplicate clip id is rejected", () => {
    const { doc } = apply(doc0(), [
      { op: "add_track", track: overlayTrack },
      { op: "add_clip", trackId: "v1", clip: clip("c1", 0, 30) },
    ]);
    failsWith(() => apply(doc, [{ op: "add_clip", trackId: "o1", clip: clip("c1", 0, 30) }]), "DUPLICATE_ID", 0);
    failsWith(() => apply(doc, [{ op: "add_clip", trackId: "v1", clip: clip("c1", 40, 30) }]), "DUPLICATE_ID", 0);
  });

  it("move_clip across tracks; inverse restores both tracks", () => {
    const { doc: base } = apply(doc0(), [
      { op: "add_track", track: overlayTrack },
      { op: "add_clip", trackId: "v1", clip: clip("c1", 0, 30) },
    ]);
    const { doc, inverse } = apply(base, [{ op: "move_clip", clipId: "c1", start: 10, trackId: "o1" }]);
    expect(doc.tracks.find((t) => t.id === "v1")!.clips).toHaveLength(0);
    const moved = doc.tracks.find((t) => t.id === "o1")!.clips;
    expect(moved.map((c) => [c.id, c.start])).toEqual([["c1", 10]]);
    expect(apply(doc, inverse).doc).toEqual(base);
    expect(base.tracks.find((t) => t.id === "v1")!.clips).toHaveLength(1); // input untouched
  });

  it("move_clip on the same track changes start and inverse restores", () => {
    const { doc: base } = apply(doc0(), [{ op: "add_clip", trackId: "v1", clip: clip("c1", 0, 30) }]);
    const { doc, inverse } = apply(base, [{ op: "move_clip", clipId: "c1", start: 100 }]);
    expect(doc.tracks[0].clips[0].start).toBe(100);
    expect(apply(doc, inverse).doc).toEqual(base);
  });

  it("remove_clip ripple shifts later clips left", () => {
    const { doc: base } = apply(doc0(), [
      { op: "add_clip", trackId: "v1", clip: clip("c1", 0, 30) },
      { op: "add_clip", trackId: "v1", clip: clip("c2", 30, 30) },
      { op: "add_clip", trackId: "v1", clip: clip("c3", 90, 30) },
    ]);
    const { doc, inverse } = apply(base, [{ op: "remove_clip", clipId: "c1", ripple: true }]);
    expect(doc.tracks[0].clips.map((c) => [c.id, c.start])).toEqual([
      ["c2", 0],
      ["c3", 60],
    ]);
    expect(apply(doc, inverse).doc).toEqual(base);
  });

  it("remove_clip without ripple leaves later clips alone", () => {
    const { doc: base } = apply(doc0(), [
      { op: "add_clip", trackId: "v1", clip: clip("c1", 0, 30) },
      { op: "add_clip", trackId: "v1", clip: clip("c2", 30, 30) },
    ]);
    const { doc, inverse } = apply(base, [{ op: "remove_clip", clipId: "c1" }]);
    expect(doc.tracks[0].clips.map((c) => [c.id, c.start])).toEqual([["c2", 30]]);
    expect(apply(doc, inverse).doc).toEqual(base);
  });

  it("a multi-op batch undoes in reverse order", () => {
    const d = doc0();
    const { doc, inverse } = apply(d, [
      { op: "add_track", track: overlayTrack },
      { op: "add_clip", trackId: "v1", clip: clip("c1", 0, 30) },
      { op: "move_clip", clipId: "c1", start: 5, trackId: "o1" },
      { op: "update_track", trackId: "o1", patch: { name: "Renamed" } },
      { op: "remove_track", trackId: "t1" },
    ]);
    expect(doc.tracks.map((t) => t.id)).toEqual(["v1", "cap", "a1", "o1"]);
    expect(apply(doc, inverse).doc).toEqual(d);
  });

  it("the result does not alias the input doc or the op payloads", () => {
    const d = doc0();
    const c = clip("c1", 0, 30);
    const op: Op = { op: "add_clip", trackId: "v1", clip: { ...c, transform: { ...DEFAULT_TRANSFORM } } };
    const { doc } = apply(d, [op]);
    if (op.op === "add_clip") op.clip.transform.x = 0.9;
    expect(doc.tracks[0].clips[0].transform).toEqual(DEFAULT_TRANSFORM);
    expect(DEFAULT_TRANSFORM.x).toBe(0.5);
  });
});

describe("applyOps: tracks", () => {
  it("add_track appends by default, inverse removes it", () => {
    const d = doc0();
    const { doc, inverse } = apply(d, [{ op: "add_track", track: overlayTrack }]);
    expect(doc.tracks.map((t) => t.id)).toEqual(["v1", "t1", "cap", "a1", "o1"]);
    expect(doc.tracks[4]).toEqual({
      id: "o1",
      kind: "overlay",
      name: "Overlay 1",
      muted: false,
      hidden: false,
      locked: false,
      clips: [],
    });
    expect(inverse).toEqual([{ op: "remove_track", trackId: "o1" }]);
    expect(apply(doc, inverse).doc).toEqual(d);
  });

  it("add_track honours index and rejects one out of range", () => {
    const { doc } = apply(doc0(), [{ op: "add_track", track: overlayTrack, index: 1 }]);
    expect(doc.tracks.map((t) => t.id)).toEqual(["v1", "o1", "t1", "cap", "a1"]);
    failsWith(() => apply(doc0(), [{ op: "add_track", track: overlayTrack, index: 5 }]), "INVALID", 0);
    expect(apply(doc0(), [{ op: "add_track", track: overlayTrack, index: 4 }]).doc.tracks).toHaveLength(5);
  });

  it("duplicate track id is rejected", () => {
    failsWith(
      () => apply(doc0(), [{ op: "add_track", track: { id: "v1", kind: "video", name: "Again" } }]),
      "DUPLICATE_ID",
      0,
    );
  });

  it("remove_track inverse reinserts at the same index", () => {
    const { doc: base } = apply(doc0(), [{ op: "add_clip", trackId: "t1", clip: textClip("x", 0, 30) }]);
    const { doc, inverse } = apply(base, [{ op: "remove_track", trackId: "t1" }]);
    expect(doc.tracks.map((t) => t.id)).toEqual(["v1", "cap", "a1"]);
    const undone = apply(doc, inverse).doc;
    expect(undone.tracks.map((t) => t.id)).toEqual(["v1", "t1", "cap", "a1"]);
    expect(undone).toEqual(base);
  });

  it("remove_track of a missing track is NOT_FOUND", () => {
    failsWith(() => apply(doc0(), [{ op: "remove_track", trackId: "zz" }]), "NOT_FOUND", 0);
    failsWith(() => apply(doc0(), [{ op: "update_track", trackId: "zz", patch: { name: "x" } }]), "NOT_FOUND", 0);
  });

  it("update_track patches fields and the inverse restores them", () => {
    const d = doc0();
    const { doc, inverse } = apply(d, [
      { op: "update_track", trackId: "v1", patch: { name: "Main", muted: true, hidden: true } },
    ]);
    expect(doc.tracks[0]).toMatchObject({ name: "Main", muted: true, hidden: true, locked: false });
    expect(apply(doc, inverse).doc).toEqual(d);
  });

  it("update_track locked:false works on a locked track", () => {
    const { doc: locked } = apply(doc0(), [{ op: "update_track", trackId: "v1", patch: { locked: true } }]);
    const { doc } = apply(locked, [{ op: "update_track", trackId: "v1", patch: { locked: false } }]);
    expect(doc.tracks[0].locked).toBe(false);
  });

  it("track ops work on a locked track (remove_track, undo of lock)", () => {
    const d = doc0();
    const { doc, inverse } = apply(d, [
      { op: "update_track", trackId: "v1", patch: { locked: true } },
      { op: "remove_track", trackId: "v1" },
    ]);
    expect(doc.tracks.map((t) => t.id)).toEqual(["t1", "cap", "a1"]);
    expect(apply(doc, inverse).doc).toEqual(d);
  });

  it("replace_track replaces an existing track and inverts to the old snapshot", () => {
    const { doc: base } = apply(doc0(), [{ op: "add_clip", trackId: "v1", clip: clip("c1", 0, 30) }]);
    const replacement = { ...base.tracks[0], clips: [clip("c9", 5, 10)] };
    const { doc, inverse } = apply(base, [{ op: "replace_track", track: replacement, index: 0 }]);
    expect(doc.tracks[0].clips.map((c) => c.id)).toEqual(["c9"]);
    expect(apply(doc, inverse).doc).toEqual(base);
  });

  it("replace_track inserts an absent track at index and inverts to remove_track", () => {
    const d = doc0();
    const track = { ...overlayTrack, muted: false, hidden: false, locked: false, clips: [] };
    const { doc, inverse } = apply(d, [{ op: "replace_track", track, index: 2 }]);
    expect(doc.tracks.map((t) => t.id)).toEqual(["v1", "t1", "o1", "cap", "a1"]);
    expect(inverse).toEqual([{ op: "remove_track", trackId: "o1" }]);
    expect(apply(doc, inverse).doc).toEqual(d);
    failsWith(() => apply(d, [{ op: "replace_track", track, index: 9 }]), "INVALID", 0);
  });

  it("replace_track validates the incoming track", () => {
    const { doc: base } = apply(doc0(), [
      { op: "add_clip", trackId: "t1", clip: textClip("x", 0, 30) },
      { op: "add_clip", trackId: "v1", clip: clip("c1", 0, 30) },
    ]);
    const v1 = base.tracks[0];
    failsWith(
      () => apply(base, [{ op: "replace_track", track: { ...v1, clips: [textClip("y", 0, 5)] }, index: 0 }]),
      "WRONG_TRACK_KIND",
      0,
    );
    failsWith(
      () => apply(base, [{ op: "replace_track", track: { ...v1, clips: [clip("a", 0, 30), clip("b", 29, 5)] }, index: 0 }]),
      "OVERLAP",
      0,
    );
    failsWith(
      () => apply(base, [{ op: "replace_track", track: { ...v1, clips: [clip("x", 0, 5)] }, index: 0 }]),
      "DUPLICATE_ID",
      0,
    );
    failsWith(
      () => apply(base, [{ op: "replace_track", track: { ...v1, clips: [clip("a", 0, 5), clip("a", 5, 5)] }, index: 0 }]),
      "DUPLICATE_ID",
      0,
    );
  });
});

describe("OpError", () => {
  it("carries a readable message naming the op and the id", () => {
    let caught: unknown;
    try {
      applyOps(doc0(), [{ op: "remove_clip", clipId: "nope" }]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OpError);
    const err = caught as OpError;
    expect(err.code).toBe("NOT_FOUND");
    expect(err.opIndex).toBe(0);
    expect(err.message).toContain("remove_clip");
    expect(err.message).toContain("nope");
  });
});

describe("prepareOps", () => {
  it("fills missing ids deterministically with the given generator", () => {
    let n = 0;
    const ops = prepareOps(
      [{ op: "add_clip", trackId: "v1", clip: { ...clip("x", 0, 1), id: undefined } }],
      () => `id${n++}`,
    );
    expect(clipIdOf(ops[0])).toBe("id0");
  });

  it("fills track ids, keeps given ids, and generates default ids when no generator is given", () => {
    let n = 0;
    const ops = prepareOps(
      [
        { op: "add_track", track: { kind: "overlay", name: "O" } },
        { op: "add_track", track: { id: "mine", kind: "audio", name: "A" } },
        { op: "add_clip", trackId: "v1", clip: { ...clip("keep", 0, 1) } },
      ],
      () => `g${n++}`,
    );
    expect(trackIdOf(ops[0])).toBe("g0");
    expect(trackIdOf(ops[1])).toBe("mine");
    expect(clipIdOf(ops[2])).toBe("keep");
    expect(n).toBe(1);

    const [op] = prepareOps([{ op: "add_clip", trackId: "v1", clip: { ...clip("x", 0, 1), id: undefined } }]);
    expect(clipIdOf(op)).toMatch(/^[A-Za-z0-9_-]{10}$/);
  });

  it("rejects an invalid op with INVALID and its index", () => {
    failsWith(
      () => prepareOps([{ op: "remove_track", trackId: "v1" }, { op: "move_clip", clipId: "c", start: -1 }]),
      "INVALID",
      1,
    );
    failsWith(() => prepareOps([{ op: "bogus" } as unknown as OpInput]), "INVALID", 0);
  });

  it("returns copies, not the caller's objects", () => {
    const input = clip("c1", 0, 1);
    const [op] = prepareOps([{ op: "add_clip", trackId: "v1", clip: input }]);
    expect((op as Extract<Op, { op: "add_clip" }>).clip.transform).not.toBe(input.transform);
  });
});
