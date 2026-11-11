import { describe, expect, it } from "vitest";
import {
  addTrack, copySelection, cutSelection, deleteSelection, goToEdge, nudgeSelection, paste, removeTrack, renameTrack, reorderTrack,
  selectAll, splitAtPlayhead, toggleTrack,
} from "@/lib/editor/actions";
import { CLIPBOARD_KEY, copyClips, createClipboard, pasteItems } from "@/lib/editor/clipboard";
import {
  addTrackOps, deleteOps, edgeFrames, moveOps, nearestEdge, removeTrackOps, renameTrackOps, reorderTrackOps, splitOps, toggleTrackOps,
} from "@/lib/editor/commands";
import { displayRows } from "@/lib/editor/geometry";
import { MESSAGES } from "@/lib/editor/messages";
import { findClip } from "@/lib/editor/store";
import { applyOps, prepareOps, type OpInput, type TimelineDoc, type Track } from "@/lib/timeline";
import { makeStore, sampleDoc, text, video } from "./fixtures";

const ids = (doc: TimelineDoc) => doc.tracks.map((t) => t.id);
const rowIds = (doc: TimelineDoc) => displayRows(doc).map((t) => t.id);
const emptyTrack = (id: string, kind: Track["kind"]): Track => ({ id, kind, name: id, muted: false, hidden: false, locked: false, clips: [] });

describe("clip commands", () => {
  it("orders moves so clips travelling together never collide, and stops at frame 0", () => {
    const pair = [{ clipId: "c1", start: 0 }, { clipId: "c2", start: 30 }];
    expect(moveOps(pair, 10)).toEqual([{ op: "move_clip", clipId: "c2", start: 40 }, { op: "move_clip", clipId: "c1", start: 10 }]);
    expect(() => applyOps(sampleDoc(), prepareOps(moveOps(pair, 10)))).not.toThrow();
    expect(moveOps([{ clipId: "x2", start: 90 }, { clipId: "c2", start: 30 }], -50)).toEqual([
      { op: "move_clip", clipId: "c2", start: 0 }, { op: "move_clip", clipId: "x2", start: 60 },
    ]);
    expect(moveOps(pair, -10)).toEqual([]);
    expect(moveOps([{ clipId: "x2", start: 90 }], 0, "t2")).toEqual([{ op: "move_clip", clipId: "x2", start: 90, trackId: "t2" }]);
  });

  it("moves adjacent clips left without them colliding on the way", () => {
    const d = sampleDoc();
    d.tracks[0].clips = [video("c1", 30, 30), video("c2", 60, 30)];
    const ops = moveOps([{ clipId: "c2", start: 60 }, { clipId: "c1", start: 30 }], -10);
    expect(applyOps(d, prepareOps(ops)).doc.tracks[0].clips.map((c) => [c.id, c.start])).toEqual([["c1", 20], ["c2", 50]]);
  });

  it("splits what the playhead crosses: the selection, or every unlocked track", () => {
    const d = sampleDoc();
    expect(splitOps(d, 45, [])).toEqual([{ op: "split_clip", clipId: "c2", at: 45 }, { op: "split_clip", clipId: "x1", at: 45 }]);
    expect(splitOps(d, 45, ["x1", "x2"])).toEqual([{ op: "split_clip", clipId: "x1", at: 45 }]);
    expect(splitOps(d, 30, [])).toEqual([{ op: "split_clip", clipId: "x1", at: 30 }]); // c1 ends and c2 starts at 30
    expect(splitOps(d, 45, ["x2"])).toEqual([]);
    d.tracks[1].locked = true;
    expect(splitOps(d, 45, [])).toEqual([{ op: "split_clip", clipId: "c2", at: 45 }]);
  });

  it("deletes, with or without closing the gap", () => {
    expect(deleteOps(["x1", "c2"], false)).toEqual([{ op: "remove_clip", clipId: "x1" }, { op: "remove_clip", clipId: "c2" }]);
    expect(applyOps(sampleDoc(), prepareOps(deleteOps(["c1"], true))).doc.tracks[0].clips).toMatchObject([{ id: "c2", start: 0 }]);
  });

  it("finds the clip edges around the playhead", () => {
    const edges = edgeFrames(sampleDoc());
    expect(edges).toEqual([0, 30, 60, 90, 120]);
    expect([nearestEdge(edges, 45, "prev"), nearestEdge(edges, 45, "next"), nearestEdge(edges, 0, "prev"), nearestEdge(edges, 120, "next")]).toEqual([30, 60, 0, 120]);
  });
});

describe("track commands", () => {
  it("adds a track with the next free name, and only one caption track", () => {
    expect(addTrackOps(sampleDoc(), "video")).toEqual([{ op: "add_track", track: { kind: "video", name: "Video 2" }, index: 1 }]);
    expect(addTrackOps(sampleDoc(), "caption")).toEqual([]);
  });

  it("puts a new track just in front of its own kind, or at the end when there is none", () => {
    const after = (kind: Track["kind"]) => applyOps(sampleDoc(), prepareOps(addTrackOps(sampleDoc(), kind), () => "new")).doc;
    expect(rowIds(after("text"))).toEqual(["cap", "new", "t1", "v1", "a1"]); // between Text 1 and Captions
    expect(ids(after("video"))).toEqual(["v1", "new", "t1", "cap", "a1"]);
    expect(ids(after("overlay"))).toEqual(["v1", "t1", "cap", "a1", "new"]);
    expect(ids(after("audio"))).toEqual(["v1", "t1", "cap", "a1", "new"]);
  });

  it("moves a track one row up or down inside its group", () => {
    const d = sampleDoc(); // rows: cap, t1, v1, then audio a1
    const rowsAfter = (ops: OpInput[]) => displayRows(applyOps(d, prepareOps(ops)).doc).map((t) => t.id);
    expect(reorderTrackOps(d, "t1", "up")).toEqual([{ op: "move_track", trackId: "t1", index: 2 }]);
    expect(rowsAfter(reorderTrackOps(d, "t1", "up"))).toEqual(["t1", "cap", "v1", "a1"]);
    expect(rowsAfter(reorderTrackOps(d, "t1", "down"))).toEqual(["cap", "v1", "t1", "a1"]);
    expect([reorderTrackOps(d, "cap", "up"), reorderTrackOps(d, "v1", "down"), reorderTrackOps(d, "a1", "up")]).toEqual([[], [], []]);
  });

  it("swaps exactly one pair of rows when document order and row order are not mirror images", () => {
    const d = sampleDoc();
    d.tracks = [emptyTrack("v1", "video"), emptyTrack("a1", "audio"), emptyTrack("t1", "text"), emptyTrack("cap", "caption"), emptyTrack("a2", "audio"), emptyTrack("o1", "overlay")];
    const rows = rowIds(d);
    expect(rows).toEqual(["o1", "cap", "t1", "v1", "a1", "a2"]);
    const isAudio = (id: string) => id.startsWith("a");
    let moves = 0;
    for (const id of rows) {
      for (const direction of ["up", "down"] as const) {
        const i = rows.indexOf(id);
        const j = direction === "up" ? i - 1 : i + 1;
        const ops = reorderTrackOps(d, id, direction);
        if (j < 0 || j >= rows.length || isAudio(rows[j]) !== isAudio(id)) {
          expect(ops, `${id} ${direction}`).toEqual([]);
          continue;
        }
        const swapped = [...rows];
        [swapped[i], swapped[j]] = [swapped[j], swapped[i]];
        expect(rowIds(applyOps(d, prepareOps(ops)).doc), `${id} ${direction}`).toEqual(swapped);
        moves++;
      }
    }
    expect(moves).toBe(8);
  });

  it("renames a track, keeping the old name when the new one is empty", () => {
    const d = sampleDoc();
    expect(renameTrackOps(d, "t1", "  Titles ")).toEqual([{ op: "update_track", trackId: "t1", patch: { name: "Titles" } }]);
    expect([renameTrackOps(d, "t1", "   "), renameTrackOps(d, "t1", "Text 1"), renameTrackOps(d, "gone", "Titles")]).toEqual([[], [], []]);
  });

  it("switches lock, and only the switches a track of that kind offers", () => {
    const d = sampleDoc();
    expect(toggleTrackOps(d, "a1", "locked")).toEqual([{ op: "update_track", trackId: "a1", patch: { locked: true } }]);
    expect(toggleTrackOps(d, "v1", "muted")).toEqual([{ op: "update_track", trackId: "v1", patch: { muted: true } }]);
    expect([toggleTrackOps(d, "a1", "hidden"), toggleTrackOps(d, "t1", "muted"), toggleTrackOps(d, "gone", "locked")]).toEqual([[], [], []]);
    d.tracks[1].hidden = true;
    expect(toggleTrackOps(d, "t1", "hidden")).toEqual([{ op: "update_track", trackId: "t1", patch: { hidden: false } }]);
  });

  it("removes a track only while it is unlocked", () => {
    const d = sampleDoc();
    expect(removeTrackOps(d, "t1")).toEqual([{ op: "remove_track", trackId: "t1" }]);
    d.tracks[1].locked = true;
    expect([removeTrackOps(d, "t1"), removeTrackOps(d, "gone")]).toEqual([[], []]);
  });
});

describe("copy and paste", () => {
  it("copies clips with their tracks and pastes them at the playhead, keeping their spacing", () => {
    const copied = copyClips(sampleDoc(), ["x2", "c1"])!;
    expect(copied.clips.map((c) => [c.clip.id, c.trackId])).toEqual([["c1", "v1"], ["x2", "t1"]]);
    expect(pasteItems(copied, 300).map((item) => [item.clip.start, item.trackId])).toEqual([[300, "v1"], [390, "t1"]]);
    expect(copyClips(sampleDoc(), [])).toBeNull();
  });

  it("copies by start, then in document order, whatever the order of the selection", () => {
    expect(copyClips(sampleDoc(), ["c2", "x1", "c1"])!.clips.map((c) => c.clip.id)).toEqual(["c1", "x1", "c2"]);
  });

  it("reads a stored clipboard with no clips as nothing to paste", () => {
    const store = makeStore();
    const board = createClipboard({ getItem: () => '{"clips":[]}', setItem: () => {} });
    expect(board.read()).toBeNull();
    paste(store, board);
    expect(store.getState().notice).toMatchObject({ tone: "info", text: MESSAGES.nothingToPaste });
  });

  it("keeps the clipboard in storage, and reads garbage as empty", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    const copied = copyClips(sampleDoc(), ["x1"])!;
    expect(createClipboard(storage).read()).toBeNull();
    createClipboard(storage).write(copied);
    expect(createClipboard(storage).read()).toEqual(copied);
    data.set(CLIPBOARD_KEY, '{"clips":[{"clip":{"id":"x"},"trackId":"t1"}]}');
    expect(createClipboard(storage).read()).toBeNull();
    const memory = createClipboard();
    memory.write(copied);
    expect(memory.read()).toEqual(copied);
  });

  it("never throws when storage does, and keeps what this tab copied", () => {
    const fail = () => { throw new Error("storage is off"); };
    const copied = copyClips(sampleDoc(), ["x1"])!;
    const broken = createClipboard({ getItem: fail, setItem: fail });
    expect(broken.read()).toBeNull();
    expect(() => broken.write(copied)).not.toThrow();
    expect(broken.read()).toEqual(copied);
    const data = new Map<string, string>([[CLIPBOARD_KEY, "{not json"]]);
    expect(createClipboard({ getItem: (k) => data.get(k) ?? null, setItem: fail }).read()).toBeNull();
  });
});

describe("runners", () => {
  it("edit through the store, one labeled change each", () => {
    const store = makeStore();
    const st = () => store.getState();
    st().seek(45);
    splitAtPlayhead(store);
    st().select(["x2"]);
    nudgeSelection(store, 5);
    deleteSelection(store, false);
    expect(st().queue.map((e) => e.label)).toEqual(["split", "nudge", "delete"]);
    selectAll(store);
    expect(st().selection.clipIds).toHaveLength(5); // c1, both halves of c2, both halves of x1
    st().edit([{ op: "update_track", trackId: "t1", patch: { locked: true } }], "track change");
    selectAll(store);
    expect(st().selection.clipIds).toHaveLength(3); // the clips on the locked track are left out
    goToEdge(store, "next");
    expect(st().playhead).toBe(60);
  });

  it("paste adds new clips and selects them; cut removes the originals", () => {
    const store = makeStore();
    const st = () => store.getState();
    const board = createClipboard();
    st().select(["x2"]);
    copySelection(store, board);
    st().seek(300);
    paste(store, board);
    const pasted = st().doc.tracks[1].clips.find((c) => c.start === 300)!;
    expect(pasted.id).not.toBe("x2");
    expect(st().selection.clipIds).toEqual([pasted.id]);
    st().select(["x1"]);
    cutSelection(store, board);
    expect(findClip(st().doc, "x1")).toBeNull();
    expect(board.read()!.clips[0].clip.id).toBe("x1");
    expect(st().queue.map((e) => e.label)).toEqual(["paste", "cut"]);
  });

  it("a refused cut leaves the clipboard and the clip alone", () => {
    const d = sampleDoc();
    d.tracks[0].locked = true;
    const store = makeStore({ doc: d });
    const st = () => store.getState();
    const board = createClipboard();
    st().select(["x2"]);
    copySelection(store, board);
    st().select(["c1"]);
    cutSelection(store, board);
    expect(st().notice).toMatchObject({ tone: "error", text: "That track is locked." });
    expect(findClip(st().doc, "c1")).not.toBeNull();
    expect(board.read()!.clips.map((c) => c.clip.id)).toEqual(["x2"]);
  });

  it("a paste the store refuses leaves the selection as it was", () => {
    const store = makeStore();
    const st = () => store.getState();
    const broken = { clips: [{ clip: { ...text("z", 0, 30), duration: 0 }, trackId: "t1" }] };
    st().select(["x1"]);
    st().seek(200);
    paste(store, { read: () => broken, write: () => {} });
    expect(st().notice).toMatchObject({ tone: "error" });
    expect(st().selection.clipIds).toEqual(["x1"]);
    expect(st().queue).toEqual([]);
  });

  it("each command is undone in one step, back to the document before it", () => {
    const withThird = () => { const d = sampleDoc(); d.tracks[0].clips.push(video("c3", 90, 30)); return d; };
    const roundTrip = (name: string, run: (store: ReturnType<typeof makeStore>) => void) => {
      const store = makeStore({ doc: withThird() });
      const before = structuredClone(store.getState().doc);
      run(store);
      expect(store.getState().doc, name).not.toEqual(before);
      expect(store.getState().undoStack, name).toHaveLength(1);
      store.getState().undo();
      expect(store.getState().doc, name).toEqual(before);
    };
    const board = createClipboard();
    roundTrip("split", (s) => { s.getState().seek(45); splitAtPlayhead(s); });
    roundTrip("delete", (s) => { s.getState().select(["x1"]); deleteSelection(s, false); });
    roundTrip("ripple delete", (s) => { s.getState().select(["c1", "c3"]); deleteSelection(s, true); });
    roundTrip("nudge", (s) => { s.getState().select(["x2", "c3"]); nudgeSelection(s, 5); });
    roundTrip("cut", (s) => { s.getState().select(["x1", "c2"]); cutSelection(s, board); });
    roundTrip("paste", (s) => { s.getState().seek(300); paste(s, board); });
    roundTrip("add track", (s) => addTrack(s, "video"));
    roundTrip("rename", (s) => renameTrack(s, "t1", "Titles"));
    roundTrip("toggle", (s) => toggleTrack(s, "v1", "hidden"));
    roundTrip("reorder", (s) => reorderTrack(s, "t1", "up"));
    roundTrip("remove track", (s) => removeTrack(s, "t1"));
  });

  it("say so when there is nothing to paste or split", () => {
    const store = makeStore();
    paste(store, createClipboard());
    expect(store.getState().notice).toMatchObject({ tone: "info", text: MESSAGES.nothingToPaste });
    store.getState().seek(500);
    splitAtPlayhead(store);
    expect(store.getState().notice).toMatchObject({ tone: "info", text: MESSAGES.nothingToSplit });
    expect(store.getState().queue).toEqual([]);
  });

  it("change tracks through the store, one labeled change each", () => {
    const store = makeStore();
    const st = () => store.getState();
    const track = (id: string) => st().doc.tracks.find((t) => t.id === id);
    addTrack(store, "overlay");
    renameTrack(store, "t1", "Titles");
    toggleTrack(store, "t1", "locked");
    reorderTrack(store, "t1", "up");
    removeTrack(store, "t1"); // locked: nothing happens
    expect(track("t1")).toMatchObject({ name: "Titles", locked: true });
    toggleTrack(store, "t1", "locked");
    removeTrack(store, "t1");
    expect(track("t1")).toBeUndefined();
    expect(st().doc.tracks.map((t) => t.name)).toEqual(["Video 1", "Captions", "Audio 1", "Overlay 1"]);
    expect(st().queue.map((e) => e.label)).toEqual(["add track", "rename track", "track change", "reorder tracks", "track change", "remove track"]);
  });

  it("do nothing for a viewer, with no message", () => {
    const store = makeStore({ canEdit: false });
    const st = () => store.getState();
    st().seek(45);
    st().select(["x1"]);
    splitAtPlayhead(store);
    deleteSelection(store, true);
    nudgeSelection(store, 5);
    cutSelection(store, createClipboard());
    paste(store, createClipboard());
    st().seek(500);
    splitAtPlayhead(store);
    expect(st()).toMatchObject({ queue: [], notice: null });
  });
});
