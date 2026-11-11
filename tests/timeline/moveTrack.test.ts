import { describe, expect, it } from "vitest";
import { applyOps, createEmptyDoc, prepareOps, type TimelineDoc } from "@/lib/timeline";

const order = (d: TimelineDoc) => d.tracks.map((t) => t.id);
const base = () => createEmptyDoc("short_9x16"); // v1, t1, cap, a1

describe("move_track", () => {
  it("puts the track at the given final index and inverts with a guard", () => {
    const { doc, inverse } = applyOps(base(), [{ op: "move_track", trackId: "v1", index: 2 }]);
    expect(order(doc)).toEqual(["t1", "cap", "v1", "a1"]);
    expect(inverse).toEqual([{ op: "move_track", trackId: "v1", index: 0, expect: { index: 2 } }]);
    expect(applyOps(doc, inverse).doc).toEqual(base());
  });

  it("clamps an index past the end, and changes nothing when the track is already there", () => {
    expect(order(applyOps(base(), [{ op: "move_track", trackId: "t1", index: 99 }]).doc)).toEqual(["v1", "cap", "a1", "t1"]);
    const same = applyOps(base(), [{ op: "move_track", trackId: "cap", index: 2 }]);
    expect(same.doc).toEqual(base());
    expect(same.inverse).toEqual([]);
  });

  it("moves a locked track with its clips, and fails NOT_FOUND for an unknown track", () => {
    const d = base();
    d.tracks[1].locked = true;
    const moved = applyOps(d, [{ op: "move_track", trackId: "t1", index: 0 }]).doc;
    expect(order(moved)).toEqual(["t1", "v1", "cap", "a1"]);
    expect(moved.tracks[0]).toEqual(d.tracks[1]);
    expect(() => applyOps(d, [{ op: "move_track", trackId: "ghost", index: 0 }]))
      .toThrow(expect.objectContaining({ name: "OpError", code: "NOT_FOUND", opIndex: 0 }));
  });

  it("a guarded move is refused STALE when the track is no longer where the edit left it", () => {
    const a = applyOps(base(), [{ op: "move_track", trackId: "v1", index: 2 }]);
    const b = applyOps(a.doc, [{ op: "move_track", trackId: "v1", index: 3 }]);
    expect(() => applyOps(b.doc, a.inverse)).toThrow(expect.objectContaining({ name: "OpError", code: "STALE", opIndex: 0 }));
  });

  it("is accepted by prepareOps, and a negative index is INVALID", () => {
    expect(prepareOps([{ op: "move_track", trackId: "v1", index: 1 }])).toHaveLength(1);
    expect(() => prepareOps([{ op: "move_track", trackId: "v1", index: -1 }])).toThrow(expect.objectContaining({ code: "INVALID" }));
  });
});
