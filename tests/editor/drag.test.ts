import { describe, expect, it } from "vitest";
import { beginMove, beginTrim, resolveDrag, type DragInput } from "@/lib/editor/drag";
import { SECOND_SNAP_MIN_PX, clipEdges, snap } from "@/lib/editor/snap";
import { applyOps, prepareOps } from "@/lib/timeline";
import { sampleDoc, video } from "./fixtures";

// Zoom 2: the reach is 4 frames, and one second is 60 px wide.
const input = (over: Partial<DragInput>): DragInput => ({ frame: 0, rowTrackId: "t1", playhead: 500, zoom: 2, snapping: true, ...over });
const free = (over: Partial<DragInput>) => input({ snapping: false, ...over });

describe("snap", () => {
  const ctx = { edges: [0, 30, 60], playhead: 500, fps: 30, zoom: 2 };

  it("snaps to the nearest clip edge, playhead or whole second within 8 px", () => {
    expect(snap([63, 93], ctx)).toEqual({ delta: -3, guide: 60 });
    expect(snap([63], { ...ctx, playhead: 65 })).toEqual({ delta: 2, guide: 65 });
    expect(snap([148], ctx)).toEqual({ delta: 2, guide: 150 });
    expect(snap([75], ctx)).toBeNull();
  });

  it("prefers a clip edge on a tie, and ignores seconds when they are under 24 px wide", () => {
    expect(snap([62], { ...ctx, playhead: 64 })).toEqual({ delta: -2, guide: 60 });
    expect(snap([100], { edges: [0], playhead: 500, fps: 30, zoom: 0.5 })).toBeNull();
  });

  it("prefers the playhead to a whole second on a tie", () => {
    expect(snap([62], { edges: [0], playhead: 64, fps: 30, zoom: 2 })).toEqual({ delta: 2, guide: 64 });
  });

  it("snaps to whole seconds from exactly SECOND_SNAP_MIN_PX per second", () => {
    const fps = SECOND_SNAP_MIN_PX; // one frame per pixel at zoom 1: a second is exactly the minimum
    expect(snap([45], { edges: [0], playhead: 500, fps, zoom: 1 })).toEqual({ delta: 3, guide: 48 });
    expect(snap([45], { edges: [0], playhead: 500, fps, zoom: 0.99 })).toBeNull();
  });

  it("collects the edges of the other clips", () => {
    expect(clipEdges(sampleDoc(), ["x2"])).toEqual([0, 30, 60]);
  });
});

describe("moving", () => {
  it("moves by the pointer's travel and snaps the grabbed clip's edges", () => {
    const d = sampleDoc();
    const drag = beginMove(d, "x2", [], 100)!;
    expect(resolveDrag(d, drag, input({ frame: 73 }))).toEqual({
      label: "move",
      guide: 60,
      ops: [{ op: "move_clip", clipId: "x2", start: 60 }],
      ghost: [{ clipId: "x2", trackId: "t1", start: 60, duration: 30 }],
    });
    expect(resolveDrag(d, drag, free({ frame: 73 }))).toEqual({
      label: "move",
      guide: null,
      ops: [{ op: "move_clip", clipId: "x2", start: 63 }],
      ghost: [{ clipId: "x2", trackId: "t1", start: 63, duration: 30 }],
    });
    expect(resolveDrag(d, drag, free({ frame: 100 }))!.ops).toEqual([]);
  });

  it("carries the whole selection, and never moves a clip before frame 0", () => {
    const d = sampleDoc();
    const drag = beginMove(d, "x1", ["x1", "x2"], 10)!;
    expect(resolveDrag(d, drag, free({ frame: 40 }))!.ops).toEqual([{ op: "move_clip", clipId: "x2", start: 120 }, { op: "move_clip", clipId: "x1", start: 30 }]);
    const before = resolveDrag(d, drag, free({ frame: -500 }))!;
    expect(before.ops).toEqual([]);
    expect(before.ghost).toEqual([
      { clipId: "x1", trackId: "t1", start: 0, duration: 60 },
      { clipId: "x2", trackId: "t1", start: 90, duration: 30 },
    ]);
  });

  it("shows no guide when the clips cannot reach the snap target", () => {
    const d = sampleDoc();
    const drag = beginMove(d, "x2", ["x1", "x2"], 100)!;
    // x2 would snap its start to 60, but x1 already starts at 0, so nothing moves.
    expect(resolveDrag(d, drag, input({ frame: 72 }))).toMatchObject({ ops: [], guide: null });
  });

  it("does not snap the moving clips to their own edges", () => {
    const d = sampleDoc();
    d.tracks[1].clips = [];
    const drag = beginMove(d, "c2", ["c1", "c2"], 40)!;
    // Zoom 0.5: the reach is 16 frames. c2's own start was at 30, 5 frames from where it goes.
    expect(resolveDrag(d, drag, input({ frame: 45, zoom: 0.5 }))).toMatchObject({
      guide: null,
      ops: [{ op: "move_clip", clipId: "c2", start: 35 }, { op: "move_clip", clipId: "c1", start: 5 }],
    });
  });

  it("changes track only when every dragged clip is on one track", () => {
    const d = sampleDoc();
    d.tracks.push({ id: "t2", kind: "text", name: "Text 2", muted: false, hidden: false, locked: false, clips: [] });
    const one = beginMove(d, "x2", [], 100)!;
    const toT2 = resolveDrag(d, one, free({ frame: 100, rowTrackId: "t2" }))!;
    expect(toT2.ops).toEqual([{ op: "move_clip", clipId: "x2", start: 90, trackId: "t2" }]);
    expect(toT2.ghost).toEqual([{ clipId: "x2", trackId: "t2", start: 90, duration: 30 }]);
    const ontoVideo = resolveDrag(d, one, free({ frame: 100, rowTrackId: "v1" }))!.ops;
    expect(() => applyOps(d, prepareOps(ontoVideo))).toThrow(expect.objectContaining({ code: "WRONG_TRACK_KIND" }));
    const mixed = beginMove(d, "x2", ["x2", "c2"], 100)!;
    expect(resolveDrag(d, mixed, free({ frame: 110, rowTrackId: "t2" }))!.ops).toEqual([{ op: "move_clip", clipId: "x2", start: 100 }, { op: "move_clip", clipId: "c2", start: 40 }]);
  });

  it("a clip removed during the drag ends it, and a locked track cannot be dragged from", () => {
    const d = sampleDoc();
    const drag = beginMove(d, "x2", [], 100)!;
    const without = applyOps(d, [{ op: "remove_clip", clipId: "x2" }]).doc;
    expect(resolveDrag(without, drag, input({ frame: 73 }))).toBeNull();
    d.tracks[1].locked = true;
    expect(beginMove(d, "x2", [], 100)).toBeNull();
    expect(beginTrim(d, "x2", "end", 120)).toBeNull();
  });

  it("leaves clips on a locked track out of the moving selection", () => {
    const d = sampleDoc();
    d.tracks[0].locked = true;
    const drag = beginMove(d, "x2", ["c1", "x2"], 100)!;
    expect(drag.origins.map((o) => o.clipId)).toEqual(["x2"]);
  });

  it("places ops from where the drag began, even after a remote edit moved the clip", () => {
    const d = sampleDoc();
    const drag = beginMove(d, "x2", [], 100)!;
    const moved = applyOps(d, [{ op: "move_clip", clipId: "x2", start: 70 }]).doc;
    expect(resolveDrag(moved, drag, free({ frame: 110 }))!.ops).toEqual([{ op: "move_clip", clipId: "x2", start: 100 }]);
  });
});

describe("trimming", () => {
  it("moves one edge, snaps it, and always leaves at least one frame", () => {
    const d = sampleDoc();
    const left = beginTrim(d, "x2", "start", 90)!;
    expect(resolveDrag(d, left, free({ frame: 75 }))).toEqual({
      label: "trim",
      guide: null,
      ops: [{ op: "trim_clip", clipId: "x2", edge: "start", to: 75 }],
      ghost: [{ clipId: "x2", trackId: "t1", start: 75, duration: 45 }],
    });
    expect(resolveDrag(d, left, input({ frame: 62 }))).toEqual({
      label: "trim",
      guide: 60,
      ops: [{ op: "trim_clip", clipId: "x2", edge: "start", to: 60 }],
      ghost: [{ clipId: "x2", trackId: "t1", start: 60, duration: 60 }],
    });
    expect(resolveDrag(d, left, free({ frame: 900 }))!.ops).toEqual([{ op: "trim_clip", clipId: "x2", edge: "start", to: 119 }]);
    const right = beginTrim(d, "x1", "end", 60)!;
    const shortest = resolveDrag(d, right, free({ frame: -50 }))!;
    expect(shortest.ops).toEqual([{ op: "trim_clip", clipId: "x1", edge: "end", to: 1 }]);
    expect(shortest.ghost).toEqual([{ clipId: "x1", trackId: "t1", start: 0, duration: 1 }]);
    expect(resolveDrag(d, right, free({ frame: 60 }))!.ops).toEqual([]);
  });

  it("stops a start edge at frame 0, and hides a guide the clamped edge cannot reach", () => {
    const d = sampleDoc();
    const left = beginTrim(d, "x2", "start", 90)!;
    expect(resolveDrag(d, left, free({ frame: -500 }))!.ops).toEqual([{ op: "trim_clip", clipId: "x2", edge: "start", to: 0 }]);
    // The playhead at 122 is in reach, but the start edge stops at 119, one frame before the end.
    expect(resolveDrag(d, left, input({ frame: 121, playhead: 122 }))).toMatchObject({
      guide: null,
      ops: [{ op: "trim_clip", clipId: "x2", edge: "start", to: 119 }],
    });
  });

  // v1 holds m1, 90 frames at 100 from frame 60 of asset "a", which is 375 frames long, and m2 at 500.
  const mediaDoc = () => {
    const d = sampleDoc();
    d.tracks[0].clips = [video("m1", 100, 90, { in: 60 }), video("m2", 500, 30)];
    return d;
  };
  const lengthOf = (assetId: string) => (assetId === "a" ? 375 : undefined);
  const onV1 = (over: Partial<DragInput>) => free({ rowTrackId: "v1", playhead: 0, ...over });

  it("an end trim stops at the end of the media", () => {
    const d = mediaDoc();
    const right = beginTrim(d, "m1", "end", 190, lengthOf)!;
    expect(right.origins).toEqual([{ clipId: "m1", start: 100, duration: 90, trackId: "v1", minStart: 40, maxEnd: 415 }]);
    expect(resolveDrag(d, right, onV1({ frame: 600 }))).toMatchObject({
      ops: [{ op: "trim_clip", clipId: "m1", edge: "end", to: 415 }],
      ghost: [{ clipId: "m1", trackId: "v1", start: 100, duration: 315 }],
    });
    expect(resolveDrag(d, right, onV1({ frame: 300 }))!.ops).toEqual([{ op: "trim_clip", clipId: "m1", edge: "end", to: 300 }]);
  });

  it("a start trim stops at the start of the media", () => {
    const d = mediaDoc();
    const left = beginTrim(d, "m1", "start", 100, lengthOf)!;
    expect(resolveDrag(d, left, onV1({ frame: 0 }))).toMatchObject({
      ops: [{ op: "trim_clip", clipId: "m1", edge: "start", to: 40 }],
      ghost: [{ clipId: "m1", trackId: "v1", start: 40, duration: 150 }],
    });
    expect(resolveDrag(d, left, onV1({ frame: 60 }))!.ops).toEqual([{ op: "trim_clip", clipId: "m1", edge: "start", to: 60 }]);
  });

  it("a clip with unknown media trims as before", () => {
    const d = mediaDoc();
    const unknown = beginTrim(d, "m1", "end", 190)!;
    expect(unknown.origins[0]).toEqual({ clipId: "m1", start: 100, duration: 90, trackId: "v1" });
    expect(resolveDrag(d, unknown, onV1({ frame: 600 }))!.ops).toEqual([{ op: "trim_clip", clipId: "m1", edge: "end", to: 600 }]);
    const notKnown = beginTrim(d, "m1", "end", 190, () => undefined)!;
    expect(resolveDrag(d, notKnown, onV1({ frame: 600 }))!.ops).toEqual([{ op: "trim_clip", clipId: "m1", edge: "end", to: 600 }]);
    // A text clip has no media: lengthOf is not asked.
    const textTrim = beginTrim(d, "x2", "end", 120, () => 1)!;
    expect(resolveDrag(d, textTrim, free({ frame: 600 }))!.ops).toEqual([{ op: "trim_clip", clipId: "x2", edge: "end", to: 600 }]);
  });

  it("a snap target past the media is not shown", () => {
    const d = mediaDoc();
    const right = beginTrim(d, "m1", "end", 190, lengthOf)!;
    expect(resolveDrag(d, right, input({ rowTrackId: "v1", playhead: 0, frame: 498 }))).toMatchObject({
      guide: null,
      ops: [{ op: "trim_clip", clipId: "m1", edge: "end", to: 415 }],
    });
    // m1 is before m2's start at 500; a start trim towards x1's end at 60 snaps there, inside the media.
    const left = beginTrim(d, "m1", "start", 100, lengthOf)!;
    expect(resolveDrag(d, left, input({ rowTrackId: "v1", playhead: 0, frame: 62 }))).toMatchObject({ guide: 60 });
    expect(resolveDrag(d, left, input({ rowTrackId: "v1", playhead: 32, frame: 34 }))).toMatchObject({
      guide: null,
      ops: [{ op: "trim_clip", clipId: "m1", edge: "start", to: 40 }],
    });
  });
});
