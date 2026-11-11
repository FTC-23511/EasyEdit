import { describe, expect, it } from "vitest";
import { MESSAGES, explainOpError } from "@/lib/editor/messages";
import { findClip, viewDoc } from "@/lib/editor/store";
import { applyOps, type Op, type OpInput, type TimelineDoc } from "@/lib/timeline";
import { entry, makeStore, sampleDoc, text } from "./fixtures";

const startOf = (doc: TimelineDoc, id: string) => findClip(doc, id)!.clip.start;
const move = (start: number): OpInput[] => [{ op: "move_clip", clipId: "x2", start }];
const retext = (value: string): Op[] => [{ op: "update_clip", clipId: "x1", patch: { text: value } }];
function fresh() {
  const store = makeStore();
  return { store, st: () => store.getState() };
}

describe("local edits", () => {
  it("applies an edit at once, queues it, and leaves the server copy alone", () => {
    const { st } = fresh();
    expect(st().edit(move(120), "move")).toEqual({ ok: true });
    expect(startOf(st().doc, "x2")).toBe(120);
    expect(startOf(st().server.doc, "x2")).toBe(90);
    expect(st().queue).toMatchObject([{ kind: "edit", label: "move", sent: false, ops: [{ op: "move_clip", clipId: "x2", start: 120 }] }]);
  });

  it("fills in missing ids on the client, so the screen and the server agree", () => {
    const { st } = fresh();
    st().edit([{ op: "add_clip", trackId: "t1", clip: { ...text("x", 200, 30), id: undefined } }], "add text");
    const sent = st().queue[0].ops[0] as Extract<Op, { op: "add_clip" }>;
    expect(sent.clip.id).toEqual(expect.any(String));
    expect(findClip(st().doc, sent.clip.id)).not.toBeNull();
  });

  it("refuses an edit that does not apply, changes nothing, and says why", () => {
    const { st } = fresh();
    expect(st().edit(move(30), "move")).toEqual({ ok: false, code: "OVERLAP", message: "There's another clip in the way." });
    expect(st().queue).toEqual([]);
    expect(st().doc).toEqual(sampleDoc());
    expect(st().notice).toMatchObject({ tone: "error", text: "There's another clip in the way." });
  });

  it("queues nothing for an edit that changes nothing", () => {
    const { st } = fresh();
    expect(st().edit(retext("hi"), "text edit")).toEqual({ ok: true });
    expect(st().queue).toEqual([]);
  });

  it("refuses more than 500 ops in one edit", () => {
    const { st } = fresh();
    const ops = Array.from({ length: 501 }, (_, i): OpInput => ({ op: "update_track", trackId: "v1", patch: { name: `V${i}` } }));
    expect(st().edit(ops, "rename")).toEqual({ ok: false, code: "LIMIT_EXCEEDED", message: MESSAGES.tooManyOps });
    expect(st().queue).toEqual([]);
  });

  it("a viewer's store refuses every edit", () => {
    const store = makeStore({ canEdit: false });
    expect(store.getState().edit([{ op: "remove_clip", clipId: "x1" }], "delete")).toEqual({ ok: false, code: "READ_ONLY", message: MESSAGES.readOnly });
    expect(store.getState().setGesture([{ op: "remove_clip", clipId: "x1" }])).toBe(false);
    expect(store.getState().doc).toEqual(sampleDoc());
    expect(store.getState().queue).toEqual([]);
  });

  it("explains every op error in plain words", () => {
    expect((["OVERLAP", "TRACK_LOCKED", "WRONG_TRACK_KIND", "TRIM_OUT_OF_RANGE", "NOT_FOUND", "LIMIT_EXCEEDED", "STALE", "INVALID", "DUPLICATE_ID"] as const).map(explainOpError)).toEqual([
      "There's another clip in the way.", "That track is locked.", "That clip can't go on this track.", "The clip can't be trimmed that far.",
      "That clip or track no longer exists.", "This project has reached a size limit.", "Can't undo. This was changed afterwards.",
      "That change couldn't be made.", "That change couldn't be made.",
    ]);
  });
});

describe("server answers", () => {
  it("ack moves the server copy forward and empties the queue", () => {
    const { st } = fresh();
    st().edit(move(120), "move");
    const head = st().queue[0];
    st().ack(head.id, 6, applyOps(sampleDoc(), head.ops).inverse);
    expect(st().server.version).toBe(6);
    expect(st().server.doc).toEqual(st().doc);
    expect(st().queue).toEqual([]);
  });

  it("ack for an answer the server copy already holds drops the head and leaves the server copy alone", () => {
    const { st } = fresh();
    st().edit(move(120), "move");
    st().edit(retext("GO"), "text edit");
    const [head, second] = st().queue;
    const landed = applyOps(sampleDoc(), head.ops).doc;
    st().replaceServer(landed, 6); // a reload that already contains the head
    const server = st().server;
    st().ack(head.id, 6, applyOps(sampleDoc(), head.ops).inverse);
    expect(st().server).toBe(server);
    expect(st().queue).toEqual([second]);
    expect(st().doc).toEqual(applyOps(landed, second.ops).doc);
    st().ack(second.id, 4, []); // an older replayed answer for the head works the same way
    expect(st().server).toBe(server);
    expect(st().queue).toEqual([]);
    expect(st().doc).toEqual(landed);
  });

  it("ack ignores an edit that is not the head and a version that skips ahead", () => {
    const { st } = fresh();
    st().edit(move(120), "move");
    st().edit(retext("GO"), "text edit");
    const [head, second] = st().queue;
    st().ack(second.id, 5, []);
    st().ack(head.id, 7, []);
    expect(st().queue).toEqual([head, second]);
    expect(st().server).toEqual({ doc: sampleDoc(), version: 5 });
  });

  it("refuse rolls the edit back and says why", () => {
    const { st } = fresh();
    st().edit(move(120), "move");
    st().refuse(st().queue[0].id, "NOT_FOUND");
    expect(st().doc).toEqual(sampleDoc());
    expect(st().queue).toEqual([]);
    expect(st().notice).toMatchObject({ tone: "error", text: "That clip or track no longer exists." });
  });

  it("refusing an edit also drops a later edit that depended on it", () => {
    const { st } = fresh();
    st().edit([{ op: "add_clip", trackId: "t1", clip: text("n1", 200, 30) }], "add text");
    st().edit([{ op: "move_clip", clipId: "n1", start: 300 }], "move");
    st().refuse(st().queue[0].id, "DUPLICATE_ID");
    expect(st().queue).toEqual([]);
    expect(st().doc).toEqual(sampleDoc());
    expect(st().notice).toMatchObject({ text: "That change couldn't be made." });
  });
});

describe("remote edits", () => {
  it("a teammate's edit arrives under a pending local edit, and both show", () => {
    const { st } = fresh();
    st().edit(move(120), "move");
    expect(st().applyRemote([entry(6, retext("GO"))])).toBe(true);
    expect(st().server.version).toBe(6);
    expect(findClip(st().doc, "x1")!.clip).toMatchObject({ text: "GO" });
    expect(startOf(st().doc, "x2")).toBe(120);
    expect(st().queue).toHaveLength(1);
  });

  it("a pending local edit that no longer fits is dropped with a message", () => {
    const { st } = fresh();
    st().edit(move(120), "move");
    st().applyRemote([entry(6, [{ op: "remove_clip", clipId: "x2" }])]);
    expect(st().queue).toEqual([]);
    expect(findClip(st().doc, "x2")).toBeNull();
    expect(st().notice).toMatchObject({ tone: "error", text: MESSAGES.rebaseDropped });
  });

  it("my own edit coming back in the log confirms the sent edit and is not applied twice", () => {
    const { st } = fresh();
    st().edit([{ op: "add_clip", trackId: "t1", clip: text("n1", 200, 30) }], "add text");
    const head = st().queue[0];
    st().markSent(head.id, true);
    // The same ops with every object's keys in the opposite order, as a server might store them.
    const reorder = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(reorder)
      : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reorder(x)]))
      : v;
    expect(st().applyRemote([entry(6, reorder(head.ops) as Op[], "u1", "Ada")])).toBe(true);
    expect(st().queue).toEqual([]);
    expect(st().server.version).toBe(6);
    expect(st().doc.tracks[1].clips.filter((c) => c.id === "n1")).toHaveLength(1);
  });

  it("my own edit with an undefined key comes back through JSON and is confirmed once", () => {
    const { st } = fresh();
    st().edit([{ op: "add_clip", trackId: "t1", clip: text("n1", 200, 30), ripple: undefined }], "add text");
    const head = st().queue[0];
    st().markSent(head.id, true);
    expect(st().applyRemote([entry(6, JSON.parse(JSON.stringify(head.ops)), "u1", "Ada")])).toBe(true);
    expect(st().queue).toEqual([]);
    expect(st().notice).toBeNull();
    expect(st().server.version).toBe(6);
    expect(st().doc.tracks[1].clips.filter((c) => c.id === "n1")).toHaveLength(1);
  });

  it("an entry carrying my head edit's request id confirms it, even before it is marked sent", () => {
    const { st } = fresh();
    st().edit([{ op: "add_clip", trackId: "t1", clip: text("n1", 200, 30) }], "add text");
    const head = st().queue[0];
    expect(st().applyRemote([{ ...entry(6, head.ops, "u1", "Ada"), requestId: head.id }])).toBe(true);
    expect(st().queue).toEqual([]);
    expect(st().notice).toBeNull();
    expect(st().doc.tracks[1].clips.filter((c) => c.id === "n1")).toHaveLength(1);
  });

  it("an entry with another request id is a remote edit, even with my id and the same ops", () => {
    const { st } = fresh();
    st().edit(move(120), "move");
    const head = st().queue[0];
    st().markSent(head.id, true);
    expect(st().applyRemote([{ ...entry(6, head.ops, "u1", "Ada"), requestId: "other-tab-1" }])).toBe(true);
    expect(st().server.version).toBe(6);
    expect(startOf(st().server.doc, "x2")).toBe(120);
    expect(st().queue.map((e) => e.id)).toEqual([head.id]);
  });

  it("an entry that breaks with an error other than an op error is not taken for a gap", () => {
    const { st } = fresh();
    expect(() => st().applyRemote([entry(6, null as unknown as Op[])])).toThrow(TypeError);
  });

  it("skips entries it already has, and reports a gap or a bad entry", () => {
    const { st } = fresh();
    expect(st().applyRemote([entry(5, [{ op: "remove_clip", clipId: "x1" }])])).toBe(true);
    expect(findClip(st().doc, "x1")).not.toBeNull();
    expect(st().applyRemote([entry(7, [{ op: "remove_clip", clipId: "x1" }])])).toBe(false);
    expect(st().applyRemote([entry(6, [{ op: "remove_clip", clipId: "ghost" }])])).toBe(false);
    expect(st().server.version).toBe(5);
  });

  it("replaceServer swaps in a fresh copy and re-applies what is pending", () => {
    const { st } = fresh();
    st().edit(move(120), "move");
    const newer = applyOps(sampleDoc(), retext("GO")).doc;
    st().replaceServer(newer, 9);
    expect(st().server).toEqual({ doc: newer, version: 9 });
    expect(startOf(st().doc, "x2")).toBe(120);
    expect(findClip(st().doc, "x1")!.clip).toMatchObject({ text: "GO" });
    st().replaceServer(sampleDoc(), 8);
    expect(st().server.version).toBe(9);
  });

  it("drops selected clips that a remote edit removed", () => {
    const { st } = fresh();
    st().select(["x1", "x2"]);
    st().applyRemote([entry(6, [{ op: "remove_clip", clipId: "x2" }])]);
    expect(st().selection).toEqual({ clipIds: ["x1"], trackId: null });
  });

  it("revokeEditing drops pending edits and makes the store read-only", () => {
    const { st } = fresh();
    st().edit(move(120), "move");
    st().revokeEditing();
    expect(st()).toMatchObject({ canEdit: false, queue: [], gesture: null });
    expect(st().doc).toEqual(sampleDoc());
    expect(st().notice).toMatchObject({ text: MESSAGES.lostAccess });
  });
});

describe("a gesture in progress", () => {
  it("previews without queueing, and commits as one edit", () => {
    const { st } = fresh();
    expect(st().setGesture(move(150))).toBe(true);
    expect(startOf(viewDoc(st()), "x2")).toBe(150);
    expect(startOf(st().doc, "x2")).toBe(90);
    expect(st().queue).toEqual([]);
    expect(st().commitGesture("move")).toEqual({ ok: true });
    expect(st().gesture).toBeNull();
    expect(st().queue).toMatchObject([{ label: "move" }]);
  });

  it("an invalid gesture shows the current document and commits nothing", () => {
    const { st } = fresh();
    expect(st().setGesture(move(30))).toBe(false);
    expect(viewDoc(st())).toBe(st().doc);
    expect(st().notice).toBeNull();
    expect(st().commitGesture("move")).toMatchObject({ ok: false, code: "OVERLAP" });
    expect(st().queue).toEqual([]);
  });

  it("a remote edit elsewhere keeps the gesture; one that takes the spot makes it invalid; one that removes the clip ends it", () => {
    const { st } = fresh();
    st().setGesture(move(150));
    st().applyRemote([entry(6, retext("GO"))]);
    expect(startOf(viewDoc(st()), "x2")).toBe(150);
    expect(findClip(viewDoc(st()), "x1")!.clip).toMatchObject({ text: "GO" });

    st().applyRemote([entry(7, [{ op: "add_clip", trackId: "t1", clip: text("r1", 150, 30) }])]);
    expect(st().gesture).toMatchObject({ doc: null });
    expect(st().commitGesture("move")).toMatchObject({ ok: false, code: "OVERLAP" });

    st().setGesture(move(200));
    st().applyRemote([entry(8, [{ op: "remove_clip", clipId: "x2" }])]);
    expect(st().gesture).toBeNull();
    expect(st().notice).toMatchObject({ tone: "error", text: MESSAGES.clipGone });
    expect(st().queue).toEqual([]);
  });
});

describe("selection and playhead", () => {
  it("replaces, toggles and adds; clips and a track are never selected together", () => {
    const { st } = fresh();
    st().select(["x1"]);
    st().select(["x2"], "toggle");
    expect(st().selection).toEqual({ clipIds: ["x1", "x2"], trackId: null });
    st().select(["x1"], "toggle");
    st().select(["c1", "x2", "ghost"], "add");
    expect(st().selection.clipIds).toEqual(["x2", "c1"]);
    st().selectTrack("t1");
    expect(st().selection).toEqual({ clipIds: [], trackId: "t1" });
    st().select(["x1"]);
    expect(st().selection).toEqual({ clipIds: ["x1"], trackId: null });
  });

  it("seek rounds to a whole frame and never goes below 0", () => {
    const { st } = fresh();
    st().seek(12.6);
    expect(st().playhead).toBe(13);
    st().seek(-4);
    expect(st().playhead).toBe(0);
  });
});
