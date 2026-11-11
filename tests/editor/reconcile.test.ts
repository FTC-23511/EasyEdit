import { describe, expect, it } from "vitest";
import { foldQueue, sameOps } from "@/lib/editor/reconcile";
import type { PendingEdit } from "@/lib/editor/types";
import type { Op } from "@/lib/timeline";
import { sampleDoc, text } from "./fixtures";

const pending = (id: string, ops: Op[]): PendingEdit => ({ id, kind: "edit", label: "edit", ops, inverse: [], sent: false });

describe("sameOps", () => {
  it("matches ops read back through JSON, which drops keys whose value is undefined", () => {
    const ops = [
      { op: "move_clip", clipId: "x2", start: 120, trackId: undefined },
      { op: "add_clip", trackId: "t1", ripple: undefined, clip: { ...text("n1", 200, 30), name: undefined } },
    ] as unknown as Op[];
    expect(sameOps(ops, JSON.parse(JSON.stringify(ops)))).toBe(true);
    expect(sameOps(JSON.parse(JSON.stringify(ops)), ops)).toBe(true);
  });

  it("still tells different ops apart", () => {
    const moveTo = (start: number, trackId?: string) => [{ op: "move_clip", clipId: "x2", start, trackId }] as Op[];
    expect(sameOps(moveTo(120), moveTo(150))).toBe(false);
    expect(sameOps(moveTo(120), moveTo(120, "t1"))).toBe(false);
    expect(sameOps(moveTo(120, "t1"), moveTo(120))).toBe(false);
  });
});

describe("foldQueue", () => {
  it("drops an edit that no longer applies and keeps the rest", () => {
    const gone = pending("e1", [{ op: "remove_clip", clipId: "ghost" }]);
    const ok = pending("e2", [{ op: "remove_clip", clipId: "x1" }]);
    const { kept, dropped } = foldQueue(sampleDoc(), [gone, ok]);
    expect(kept).toEqual([ok]);
    expect(dropped).toEqual([gone]);
  });

  it("lets an error that is not an op error through", () => {
    expect(() => foldQueue(sampleDoc(), [pending("e1", null as unknown as Op[])])).toThrow(TypeError);
  });
});
