import { describe, expect, it } from "vitest";
import {
  activityRows,
  canUndoChange,
  editingLabel,
  hasOlderActivity,
  loadOlderActivity,
  loadRecentActivity,
  olderRange,
  recentRange,
  summarizeOps,
  whoLabel,
} from "@/lib/editor/activity";
import { ACTIVITY_LIMIT } from "@/lib/editor/store";
import type { Op } from "@/lib/timeline";
import { makeFakeServer } from "./fake-server";
import { entry, makeStore, sampleDoc, text, video } from "./fixtures";

const track = sampleDoc().tracks[1];
const rm = (clipId: string): Op => ({ op: "remove_clip", clipId });

describe("summarizeOps", () => {
  it.each<[Op[], string]>([
    [[{ op: "add_clip", trackId: "t1", clip: text("n", 0, 30) }], "Added text"],
    [[{ op: "add_clip", trackId: "v1", clip: video("n", 0, 30) }], "Added a clip"],
    [[{ op: "add_track", track: { id: "t2", kind: "text", name: "Text 2" } }, { op: "add_clip", trackId: "t2", clip: text("n", 0, 30) }], "Added text"],
    [[{ op: "add_clip", trackId: "t1", clip: text("n", 0, 30) }, { op: "add_clip", trackId: "v1", clip: video("m", 0, 30) }], "Added 2 clips"],
    [[rm("a")], "Deleted a clip"],
    [[rm("a"), rm("b"), rm("c")], "Deleted 3 clips"],
    [[{ op: "move_clip", clipId: "a", start: 3 }], "Moved a clip"],
    [[{ op: "trim_clip", clipId: "a", edge: "end", to: 9 }], "Trimmed a clip"],
    [[{ op: "split_clip", clipId: "a", at: 5, newClipId: "b" }, { op: "split_clip", clipId: "c", at: 5, newClipId: "d" }], "Split 2 clips"],
    [[{ op: "update_clip", clipId: "a", patch: { text: "x" } }], "Edited a clip"],
    [[{ op: "update_track", trackId: "v1", patch: { name: "Main" } }], "Renamed a track"],
    [[{ op: "update_track", trackId: "v1", patch: { locked: true } }], "Locked a track"],
    [[{ op: "update_track", trackId: "v1", patch: { hidden: false } }], "Showed a track"],
    [[{ op: "update_track", trackId: "v1", patch: { muted: true } }], "Muted a track"],
    [[{ op: "update_track", trackId: "v1", patch: { name: "Main", muted: true } }], "Changed a track"],
    [[{ op: "add_track", track: { id: "t2", kind: "text", name: "Text 2" } }], "Added a track"],
    [[{ op: "remove_track", trackId: "t1" }], "Removed a track"],
    [[{ op: "move_track", trackId: "t1", index: 0 }], "Reordered tracks"],
    [[{ op: "replace_track", track, index: 1, restore: true }], "Restored a track"],
    [[{ op: "set_format", format: "long_16x9" }], "Changed the format to Long 16:9"],
    [[{ op: "move_clip", clipId: "a", start: 3 }, rm("b")], "Deleted a clip and moved a clip"],
    [[rm("a"), { op: "add_clip", trackId: "t1", clip: text("n", 0, 30) }, { op: "add_clip", trackId: "t1", clip: text("m", 30, 30) }, { op: "update_clip", clipId: "b", patch: { text: "x" } }],
      "Added 2 clips, deleted a clip and edited a clip"],
    [[{ op: "set_format", format: "long_16x9" }, { op: "update_track", trackId: "v1", patch: { locked: true } }, { op: "move_clip", clipId: "a", start: 3 }, { op: "trim_clip", clipId: "a", edge: "end", to: 9 }, { op: "split_clip", clipId: "a", at: 5, newClipId: "b" }],
      "Moved a clip, trimmed a clip, split a clip and more"],
    [[{ op: "add_track", track: { id: "t2", kind: "text", name: "Text 2" } }, { op: "move_track", trackId: "t2", index: 0 }], "Changed tracks"],
    [[{ op: "add_track", track: { id: "t2", kind: "text", name: "Text 2" } }, { op: "add_clip", trackId: "t2", clip: text("n", 0, 30) }, rm("a")], "Added a clip, deleted a clip and changed tracks"],
  ])("%#", (ops, summary) => {
    expect(summarizeOps(ops)).toBe(summary);
  });
});

describe("activity helpers", () => {
  it("only entries with a stored, non-empty inverse can be undone", () => {
    expect(canUndoChange(entry(6, [rm("a")]))).toBe(false);
    expect(canUndoChange({ ...entry(6, [rm("a")]), inverse: [] })).toBe(false);
    expect(canUndoChange({ ...entry(6, [rm("a")]), inverse: [rm("b")] })).toBe(true);
  });

  it("names me as You, and Claude as Claude", () => {
    expect(whoLabel(entry(6, [], "u1", "Ada"), "u1")).toBe("You");
    expect(whoLabel(entry(6, [], "claude:u1", "Claude (for Ada)"), "u1")).toBe("Claude (for Ada)");
    expect(whoLabel(entry(6, [], "u2", "Grace"), "u1")).toBe("Grace");
  });

  it("labels who is editing", () => {
    expect(editingLabel([])).toBeNull();
    expect(editingLabel(["Grace", "Grace"])).toBe("Grace is editing…");
    expect(editingLabel(["Claude (for Ada)"])).toBe("Claude is editing…");
    expect(editingLabel(["Grace", "Claude"])).toBe("2 people are editing…");
    expect(editingLabel(["Claudette"])).toBe("Claudette is editing…");
    expect(editingLabel(["Claudette", "Claude (for Ada)"])).toBe("2 people are editing…");
  });

  it("pages the log 50 changes at a time", () => {
    expect(recentRange(0)).toBeNull();
    expect(recentRange(12)).toEqual({ since: 0, limit: 12 });
    expect(recentRange(120)).toEqual({ since: 70, limit: 50 });
    expect(olderRange(71)).toEqual({ since: 20, limit: 50 });
    expect(olderRange(21)).toEqual({ since: 0, limit: 20 });
    expect(olderRange(1)).toBeNull();
  });
});

describe("the activity list", () => {
  it("rows are newest first, with who, what, when and whether they can be undone", () => {
    const rows = activityRows([
      { ...entry(6, [rm("a")], "u1", "Ada"), inverse: [rm("b")] },
      entry(7, [{ op: "set_format", format: "long_16x9" }], "claude:u2", "Claude (for Grace)"),
    ], "u1", new Date("2026-11-11T10:05:00.000Z"));
    expect(rows).toEqual([
      { version: 7, who: "Claude (for Grace)", summary: "Changed the format to Long 16:9", when: "5 minutes ago", canUndo: false },
      { version: 6, who: "You", summary: "Deleted a clip", when: "5 minutes ago", canUndo: true },
    ]);
  });

  it("loads the last 50 changes, then earlier ones on request", async () => {
    const server = makeFakeServer(sampleDoc(), 0);
    for (let i = 0; i < 120; i++) server.remote([{ op: "update_track", trackId: "v1", patch: { name: `V${i}` } }]);
    const store = makeStore({ doc: server.doc(), version: 120 });
    expect(await loadRecentActivity(server.api, store)).toBe(true);
    expect(store.getState().activity.map((e) => e.version)).toEqual(Array.from({ length: 50 }, (_, i) => 71 + i));
    expect(hasOlderActivity(store.getState().activity)).toBe(true);
    expect(await loadOlderActivity(server.api, store)).toBe(true);
    expect(store.getState().activity[0].version).toBe(21);
    server.fail("network");
    expect(await loadOlderActivity(server.api, store)).toBe(false);
    expect(hasOlderActivity([entry(1, [])])).toBe(false);
  });

  it("keeps asking while a page is cut short, and loads the whole range", async () => {
    const server = makeFakeServer(sampleDoc(), 0);
    for (let i = 0; i < 12; i++) server.remote([{ op: "update_track", trackId: "v1", patch: { name: `V${i}` } }]);
    const store = makeStore({ doc: server.doc(), version: 12 });
    const short: typeof server.api = {
      ...server.api,
      getOpsSince: async (since, limit) => server.api.getOpsSince(since, Math.min(limit ?? 100, 5)),
    };
    expect(await loadRecentActivity(short, store)).toBe(true);
    expect(store.getState().activity.map((e) => e.version)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  it("makes no request when there is nothing to ask for", async () => {
    const server = makeFakeServer(sampleDoc(), 0);
    const store = makeStore({ doc: server.doc(), version: 0 });
    expect(await loadRecentActivity(server.api, store)).toBe(true);
    expect(await loadOlderActivity(server.api, store)).toBe(true);
    expect(server.calls).toEqual([]);
  });

  it("stops offering earlier changes once the list holds the most it keeps", () => {
    const full = Array.from({ length: ACTIVITY_LIMIT }, (_, i) => entry(500 + i, []));
    expect(hasOlderActivity(full)).toBe(false);
    expect(hasOlderActivity(full.slice(1))).toBe(true);
  });
});
