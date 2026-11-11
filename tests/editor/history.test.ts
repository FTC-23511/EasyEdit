import { describe, expect, it } from "vitest";
import { MESSAGES } from "@/lib/editor/messages";
import { findClip, type EditorStore } from "@/lib/editor/store";
import { applyOps, type Op, type OpInput } from "@/lib/timeline";
import { entry, makeStore, text } from "./fixtures";

const move = (start: number): OpInput[] => [{ op: "move_clip", clipId: "x2", start }];
const retext = (value: string): Op[] => [{ op: "update_clip", clipId: "x1", patch: { text: value } }];
function fresh() {
  const store = makeStore();
  return { store, st: () => store.getState(), x2: () => findClip(store.getState().doc, "x2")!.clip.start };
}
// Confirms the head edit the way the server would.
function confirm(store: EditorStore, version: number) {
  const head = store.getState().queue[0];
  store.getState().ack(head.id, version, applyOps(store.getState().server.doc, head.ops).inverse);
}

describe("undo and redo", () => {
  it("undo works before the server has answered, and redo brings the edit back", () => {
    const { st, x2 } = fresh();
    st().edit(move(120), "move");
    st().undo();
    expect(x2()).toBe(90);
    st().redo();
    expect(x2()).toBe(120);
    expect(st().queue.map((e) => [e.kind, e.label])).toEqual([["edit", "move"], ["undo", "move"], ["redo", "move"]]);
  });

  it("keeps the server's inverse once the edit is confirmed", () => {
    const { st } = fresh();
    st().edit(move(120), "move");
    const head = st().queue[0];
    const fromServer: Op[] = [{ op: "move_clip", clipId: "x2", start: 91, expect: { start: 120 } }];
    st().ack(head.id, 6, fromServer);
    expect(st().undoStack).toEqual([{ editId: head.id, label: "move", ops: fromServer }]);
  });

  it("a new edit empties redo; undo and redo walk back and forth", () => {
    const { st, x2 } = fresh();
    st().edit(move(120), "move");
    st().edit(move(150), "move");
    st().undo();
    st().undo();
    expect(x2()).toBe(90);
    st().redo();
    expect(x2()).toBe(120);
    expect(st().redoStack).toHaveLength(1);
    st().edit(move(200), "move");
    expect(st().redoStack).toEqual([]);
    expect(st().undoStack).toHaveLength(2);
  });

  it("holds at most 100 changes", () => {
    const { st } = fresh();
    for (let i = 0; i <= 100; i++) st().edit(move(200 + i), "move");
    expect(st().undoStack).toHaveLength(100);
  });

  it("does nothing when there is nothing to undo or redo", () => {
    const { st } = fresh();
    st().undo();
    st().redo();
    expect(st().queue).toEqual([]);
    expect(st().notice).toBeNull();
  });
});

describe("undo after a teammate's change", () => {
  it("to the same thing: refused, dropped, and their change stays", () => {
    const { store, st, x2 } = fresh();
    st().edit(move(120), "move");
    confirm(store, 6);
    st().applyRemote([entry(7, [{ op: "move_clip", clipId: "x2", start: 200 }])]);
    st().undo();
    expect(x2()).toBe(200);
    expect(st().queue).toEqual([]);
    expect(st().undoStack).toEqual([]);
    expect(st().notice).toMatchObject({ tone: "error", text: "Can't undo. This was changed afterwards." });
  });

  it("to something else: the undo works and their change stays", () => {
    const { store, st } = fresh();
    st().edit(retext("GO"), "text edit");
    confirm(store, 6);
    st().applyRemote([entry(7, [{ op: "update_clip", clipId: "x1", patch: { style: { color: "#ff0000" } } }])]);
    st().undo();
    expect(findClip(st().doc, "x1")!.clip).toMatchObject({ text: "hi", style: { color: "#ff0000" } });
    expect(st().queue).toMatchObject([{ kind: "undo" }]);
  });

  it("refused by the server: rolled back, dropped, and it cannot be redone", () => {
    const { store, st, x2 } = fresh();
    st().edit(move(120), "move");
    confirm(store, 6);
    st().undo();
    expect(x2()).toBe(90);
    st().refuse(st().queue[0].id, "STALE");
    expect(x2()).toBe(120);
    expect(st().undoStack).toEqual([]);
    expect(st().redoStack).toEqual([]);
    expect(st().notice).toMatchObject({ text: MESSAGES.undoRefused });
  });

  it("a refused redo says so", () => {
    const { store, st } = fresh();
    st().edit(move(120), "move");
    confirm(store, 6);
    st().undo();
    confirm(store, 7);
    st().redo();
    st().refuse(st().queue[0].id, "STALE");
    expect(st().notice).toMatchObject({ text: "Can't redo. This was changed afterwards." });
    expect(st().undoStack).toEqual([]);
  });
});

describe("confirmation and lost edits", () => {
  const fromServer: Op[] = [{ op: "move_clip", clipId: "x2", start: 90, expect: { start: 120 }, trackId: "t1" }];

  it("a replayed answer confirms the edit the same way, so undo sends the server's inverse", () => {
    const { st } = fresh();
    st().edit(move(120), "move");
    const head = st().queue[0];
    st().replaceServer(applyOps(st().server.doc, head.ops).doc, 6); // a reload that already holds the edit
    st().ack(head.id, 6, fromServer);
    expect(st().undoStack).toEqual([{ editId: head.id, label: "move", ops: fromServer }]);
    expect(st().activity).toMatchObject([{ version: 6, actor: "u1", requestId: head.id, inverse: fromServer }]);
  });

  it("my own edit confirmed from the log by its request id takes the logged inverse", () => {
    const { st } = fresh();
    st().edit(move(120), "move");
    const head = st().queue[0];
    st().applyRemote([{ ...entry(6, head.ops, "u1", "Ada"), requestId: head.id, inverse: fromServer }]);
    expect(st().queue).toEqual([]);
    expect(st().undoStack).toEqual([{ editId: head.id, label: "move", ops: fromServer }]);
    expect(st().activity.map((e) => e.version)).toEqual([6]);
    expect(st().remote).toBeNull();
  });

  it("an edit dropped because it no longer fits leaves the undo history", () => {
    const { st } = fresh();
    st().edit(move(120), "move");
    st().applyRemote([entry(6, [{ op: "remove_clip", clipId: "x2" }])]);
    expect(st().queue).toEqual([]);
    expect(st().undoStack).toEqual([]);
    expect(st().notice).toMatchObject({ text: MESSAGES.rebaseDropped });
  });

  it("a queued undo that a teammate's change makes stale is dropped with the undo message", () => {
    const { store, st, x2 } = fresh();
    st().edit(move(120), "move");
    confirm(store, 6);
    st().undo();
    st().applyRemote([entry(7, [{ op: "move_clip", clipId: "x2", start: 200 }])]);
    expect(x2()).toBe(200);
    expect(st().queue).toEqual([]);
    expect(st().redoStack).toEqual([]);
    expect(st().notice).toMatchObject({ text: MESSAGES.undoRefused });
  });

  it("a queued redo that a teammate's change makes stale is dropped with the redo message", () => {
    const { store, st, x2 } = fresh();
    st().edit(move(120), "move");
    confirm(store, 6);
    st().undo();
    confirm(store, 7);
    st().redo();
    st().applyRemote([entry(8, [{ op: "move_clip", clipId: "x2", start: 200 }])]);
    expect(x2()).toBe(200);
    expect(st().queue).toEqual([]);
    expect(st().undoStack).toEqual([]);
    expect(st().notice).toMatchObject({ text: MESSAGES.redoRefused });
  });

  it("a queued undo dropped by a reload also clears its redo entry", () => {
    const { store, st } = fresh();
    st().edit(move(120), "move");
    confirm(store, 6);
    st().undo();
    expect(st().redoStack).toHaveLength(1);
    st().replaceServer(applyOps(st().server.doc, [{ op: "move_clip", clipId: "x2", start: 200 }]).doc, 7);
    expect(st().queue).toEqual([]);
    expect(st().redoStack).toEqual([]);
    expect(st().undoStack).toEqual([]);
  });

  it("undo of an edit the server then refuses is dropped with it", () => {
    const { st, x2 } = fresh();
    st().edit(move(120), "move");
    st().undo();
    st().refuse(st().queue[0].id, "OVERLAP");
    expect(x2()).toBe(90);
    expect(st().doc).toEqual(st().server.doc);
    expect(st().queue).toEqual([]);
    expect(st().undoStack).toEqual([]);
    expect(st().redoStack).toEqual([]);
  });

  it("a confirmed version shows once in the log, however often it comes back", () => {
    const { store, st } = fresh();
    st().edit(move(120), "move");
    const ops = st().queue[0].ops;
    confirm(store, 6);
    st().loadActivity([entry(6, ops, "u1", "Ada")]);
    st().applyRemote([entry(6, ops, "u1", "Ada")]);
    expect(st().activity.map((e) => e.version)).toEqual([6]);
  });

  it("undoing an added track is refused once a teammate put a clip on it", () => {
    const { store, st } = fresh();
    st().edit([{ op: "add_track", track: { id: "t9", kind: "text", name: "Text 2" } }], "add track");
    confirm(store, 6);
    st().applyRemote([entry(7, [{ op: "add_clip", trackId: "t9", clip: text("r1", 0, 30) }])]);
    st().undo();
    expect(findClip(st().doc, "r1")?.track.id).toBe("t9");
    expect(st().queue).toEqual([]);
    expect(st().notice).toMatchObject({ text: MESSAGES.undoRefused });
  });
});

describe("undoing a listed change", () => {
  const byClaude = () => {
    const change = applyOps(makeStore().getState().doc, retext("ROBOT"));
    return { ...entry(6, retext("ROBOT"), "claude:u2", "Claude (for Grace)"), inverse: change.inverse };
  };

  it("reverts it as an ordinary edit that Cmd+Z can take back", () => {
    const { st } = fresh();
    st().applyRemote([byClaude()]);
    st().undoChange(st().activity[0]);
    expect(findClip(st().doc, "x1")!.clip).toMatchObject({ text: "hi" });
    // The top bar's button then reads "Undo revert".
    expect(st().queue).toMatchObject([{ kind: "edit", label: "revert" }]);
    expect(st().undoStack.at(-1)?.label).toBe("revert");
    st().undo();
    expect(findClip(st().doc, "x1")!.clip).toMatchObject({ text: "ROBOT" });
    expect(st().redoStack.at(-1)?.label).toBe("revert");
  });

  it("is refused with the same message when the thing was changed again", () => {
    const { st } = fresh();
    st().applyRemote([byClaude(), entry(7, retext("ROBOTS"))]);
    st().undoChange(st().activity[0]);
    expect(findClip(st().doc, "x1")!.clip).toMatchObject({ text: "ROBOTS" });
    expect(st().queue).toEqual([]);
    expect(st().notice).toMatchObject({ text: MESSAGES.undoRefused });
  });
});

describe("the activity log", () => {
  it("lists my confirmed edits and remote edits, oldest first, and notes who else is editing", () => {
    const { store, st } = fresh();
    st().edit(move(120), "move");
    confirm(store, 6);
    expect(st().activity).toMatchObject([{ version: 6, actor: "u1", actorName: "Ada", createdAt: "1970-01-01T00:00:01.000Z" }]);
    expect(st().remote).toBeNull();
    st().applyRemote([entry(7, retext("GO")), entry(8, retext("GO!"), "u3", "Katherine")]);
    expect(st().activity.map((e) => e.version)).toEqual([6, 7, 8]);
    expect(st().remote).toEqual({ names: ["Grace", "Katherine"], at: 1_000 });
  });

  it("merges loaded pages without duplicates and keeps the newest 200", () => {
    const { st } = fresh();
    st().loadActivity([entry(4, retext("d")), entry(3, retext("c"))]);
    st().loadActivity([entry(4, retext("d")), entry(2, retext("b"))]);
    expect(st().activity.map((e) => e.version)).toEqual([2, 3, 4]);
    st().loadActivity(Array.from({ length: 250 }, (_, i) => entry(100 + i, retext(`t${i}`))));
    expect(st().activity).toHaveLength(200);
    expect(st().activity[199].version).toBe(349);
  });
});
