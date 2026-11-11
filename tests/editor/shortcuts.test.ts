import { describe, expect, it, vi } from "vitest";
import { createClipboard } from "@/lib/editor/clipboard";
import { runCommand } from "@/lib/editor/run-command";
import { SHORTCUTS, keyLabel, matchShortcut, shortcutFor, shouldIgnoreKey, type CommandId, type KeyLike } from "@/lib/editor/shortcuts";
import { makeStore, sampleDoc } from "./fixtures";

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });
const MAC = true;
const PC = false;

describe("matching keys", () => {
  it.each<[string, KeyLike, boolean, CommandId | null]>([
    ["Cmd+Z on a Mac", key("z", { metaKey: true }), MAC, "undo"],
    ["Ctrl+Z elsewhere", key("z", { ctrlKey: true }), PC, "undo"],
    ["Ctrl+Z on a Mac", key("z", { ctrlKey: true }), MAC, null],
    ["Shift+Cmd+Z", key("Z", { metaKey: true, shiftKey: true }), MAC, "redo"],
    ["Ctrl+Y", key("y", { ctrlKey: true }), PC, "redo"],
    ["Space", key(" "), MAC, "play-pause"],
    ["S", key("s"), MAC, "split"],
    ["Cmd+S is left to the browser", key("s", { metaKey: true }), MAC, null],
    ["Shift+Z", key("Z", { shiftKey: true }), MAC, "zoom-fit"],
    ["Delete", key("Delete"), MAC, "delete"],
    ["Backspace", key("Backspace"), MAC, "delete"],
    ["Shift+Delete", key("Delete", { shiftKey: true }), MAC, "ripple-delete"],
    ["ArrowLeft", key("ArrowLeft"), MAC, "frame-back"],
    ["Shift+ArrowRight", key("ArrowRight", { shiftKey: true }), MAC, "second-forward"],
    ["Alt+ArrowLeft", key("ArrowLeft", { altKey: true }), MAC, "nudge-left"],
    ["Alt+Shift+ArrowRight", key("ArrowRight", { altKey: true, shiftKey: true }), MAC, "nudge-right-second"],
    ["ArrowUp", key("ArrowUp"), MAC, "prev-edge"],
    ["End", key("End"), MAC, "go-end"],
    ["J", key("j"), MAC, "play-reverse"],
    ["K", key("k"), MAC, "pause"],
    ["L", key("l"), MAC, "play-forward"],
    ["Cmd+C", key("c", { metaKey: true }), MAC, "copy"],
    ["Ctrl+V", key("v", { ctrlKey: true }), PC, "paste"],
    ["Ctrl+A", key("a", { ctrlKey: true }), PC, "select-all"],
    ["Escape", key("Escape"), MAC, "clear-selection"],
    ["=", key("="), MAC, "zoom-in"],
    ["+ typed with Shift", key("+", { shiftKey: true }), MAC, "zoom-in"],
    ["-", key("-"), MAC, "zoom-out"],
    ["N", key("n"), MAC, "toggle-snapping"],
    ["? typed with Shift", key("?", { shiftKey: true }), MAC, "show-shortcuts"],
    ["a key with no command", key("q"), MAC, null],
  ])("%s", (_name, event, isMac, command) => {
    expect(matchShortcut(event, isMac)).toBe(command);
  });

  it("the table has no clashing keys, and marks exactly the editing commands", () => {
    const keys = SHORTCUTS.flatMap((s) => s.keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(SHORTCUTS.every((s) => s.label.length > 0 && s.keys.length > 0)).toBe(true);
    expect(SHORTCUTS.filter((s) => s.edits).map((s) => s.command).sort()).toEqual([
      "cut", "delete", "nudge-left", "nudge-left-second", "nudge-right", "nudge-right-second", "paste", "redo", "ripple-delete", "split", "undo",
    ]);
  });

  it("stays out of the way while typing, and lets a focused button take the space bar", () => {
    expect(shouldIgnoreKey(key("s"), { tagName: "INPUT" })).toBe(true);
    expect(shouldIgnoreKey(key("s"), { tagName: "TEXTAREA" })).toBe(true);
    expect(shouldIgnoreKey(key("s"), { tagName: "SELECT" })).toBe(true);
    expect(shouldIgnoreKey(key("s"), { tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(shouldIgnoreKey(key(" "), { tagName: "BUTTON" })).toBe(true);
    expect(shouldIgnoreKey(key("s"), { tagName: "BUTTON" })).toBe(false);
    expect(shouldIgnoreKey(key("s"), { tagName: "DIV" })).toBe(false);
    expect(shouldIgnoreKey(key("s"), null)).toBe(false);
  });

  it("writes keys the way each platform shows them", () => {
    expect([keyLabel("Mod+Shift+Z", MAC), keyLabel("Mod+Shift+Z", PC)]).toEqual(["⌘⇧Z", "Ctrl+Shift+Z"]);
    expect([keyLabel("Alt+ArrowLeft", MAC), keyLabel("Alt+ArrowLeft", PC)]).toEqual(["⌥←", "Alt+←"]);
    expect(keyLabel("Space", MAC)).toBe("Space");
  });

  it("holds exactly the brief's keys and labels", () => {
    expect(SHORTCUTS.map((s) => [s.command, s.keys.join(" "), s.label])).toEqual([
      ["play-pause", "Space", "Play or pause"],
      ["play-forward", "L", "Play forward; press again to go faster"],
      ["pause", "K", "Pause"],
      ["play-reverse", "J", "Play backward; press again to go faster"],
      ["frame-back", "ArrowLeft", "Back one frame"],
      ["frame-forward", "ArrowRight", "Forward one frame"],
      ["second-back", "Shift+ArrowLeft", "Back one second"],
      ["second-forward", "Shift+ArrowRight", "Forward one second"],
      ["prev-edge", "ArrowUp", "Previous clip edge"],
      ["next-edge", "ArrowDown", "Next clip edge"],
      ["go-start", "Home", "Go to start"],
      ["go-end", "End", "Go to end"],
      ["undo", "Mod+Z", "Undo"],
      ["redo", "Mod+Shift+Z Mod+Y", "Redo"],
      ["split", "S", "Split at the playhead"],
      ["delete", "Delete Backspace", "Delete"],
      ["ripple-delete", "Shift+Delete Shift+Backspace", "Delete and close the gap"],
      ["copy", "Mod+C", "Copy"],
      ["cut", "Mod+X", "Cut"],
      ["paste", "Mod+V", "Paste"],
      ["nudge-left", "Alt+ArrowLeft", "Nudge one frame left"],
      ["nudge-right", "Alt+ArrowRight", "Nudge one frame right"],
      ["nudge-left-second", "Alt+Shift+ArrowLeft", "Nudge one second left"],
      ["nudge-right-second", "Alt+Shift+ArrowRight", "Nudge one second right"],
      ["select-all", "Mod+A", "Select all clips"],
      ["clear-selection", "Escape", "Clear the selection"],
      ["zoom-in", "= +", "Zoom in"],
      ["zoom-out", "-", "Zoom out"],
      ["zoom-fit", "Shift+Z", "Fit the timeline"],
      ["toggle-snapping", "N", "Snapping on or off"],
      ["show-shortcuts", "?", "Show shortcuts"],
    ]);
  });

  it("repeats only the commands where holding the key should keep going", () => {
    expect(SHORTCUTS.filter((s) => s.repeats).map((s) => s.command).sort()).toEqual([
      "frame-back", "frame-forward", "next-edge", "nudge-left", "nudge-left-second", "nudge-right", "nudge-right-second",
      "prev-edge", "redo", "second-back", "second-forward", "undo", "zoom-in", "zoom-out",
    ]);
  });

  it("lists the commands in the table's order, with their groups", () => {
    expect(SHORTCUTS.map((s) => `${s.group}:${s.command}`)).toEqual([
      "Playback:play-pause", "Playback:play-forward", "Playback:pause", "Playback:play-reverse",
      "Playback:frame-back", "Playback:frame-forward", "Playback:second-back", "Playback:second-forward",
      "Playback:prev-edge", "Playback:next-edge", "Playback:go-start", "Playback:go-end",
      "Editing:undo", "Editing:redo", "Editing:split", "Editing:delete", "Editing:ripple-delete",
      "Editing:copy", "Editing:cut", "Editing:paste",
      "Editing:nudge-left", "Editing:nudge-right", "Editing:nudge-left-second", "Editing:nudge-right-second",
      "Timeline:select-all", "Timeline:clear-selection", "Timeline:zoom-in", "Timeline:zoom-out", "Timeline:zoom-fit",
      "Timeline:toggle-snapping", "General:show-shortcuts",
    ]);
  });

  it("matches the other keys of a command, Enter on links and summaries, and leaves Ctrl+Cmd alone", () => {
    expect(matchShortcut(key("Backspace", { shiftKey: true }), MAC)).toBe("ripple-delete");
    expect(matchShortcut(key("ArrowDown"), MAC)).toBe("next-edge");
    expect(matchShortcut(key("Home"), MAC)).toBe("go-start");
    expect(matchShortcut(key("ArrowLeft", { altKey: true, shiftKey: true }), MAC)).toBe("nudge-left-second");
    expect(matchShortcut(key("z", { metaKey: true, ctrlKey: true }), MAC)).toBeNull();
    expect(matchShortcut(key("z", { metaKey: true, ctrlKey: true }), PC)).toBeNull();
    expect(matchShortcut(key("s", { altKey: true }), MAC)).toBeNull();
    expect(matchShortcut(key("S", { shiftKey: true }), MAC)).toBeNull();
    expect(shouldIgnoreKey(key("Enter"), { tagName: "A" })).toBe(true);
    expect(shouldIgnoreKey(key(" "), { tagName: "SUMMARY" })).toBe(true);
    expect(shouldIgnoreKey(key("Delete"), { tagName: "A" })).toBe(false);
  });

  it("reads a key string that ends in + as the + key", () => {
    expect([keyLabel("+", MAC), keyLabel("+", PC)]).toEqual(["+", "+"]);
    expect([keyLabel("Mod++", MAC), keyLabel("Mod++", PC)]).toEqual(["⌘+", "Ctrl++"]);
    expect([keyLabel("ArrowUp", PC), keyLabel("ArrowDown", PC), keyLabel("Shift+ArrowRight", PC)]).toEqual(["↑", "↓", "Shift+→"]);
  });

  it("gives a command's first key as its hint, and Backspace for deleting on a Mac", () => {
    expect([shortcutFor("undo", MAC), shortcutFor("undo", PC)]).toEqual(["⌘Z", "Ctrl+Z"]);
    expect([shortcutFor("redo", MAC), shortcutFor("redo", PC)]).toEqual(["⌘⇧Z", "Ctrl+Shift+Z"]);
    expect([shortcutFor("delete", PC), shortcutFor("zoom-in", PC), shortcutFor("play-pause", PC)]).toEqual(["Del", "=", "Space"]);
    expect([shortcutFor("delete", MAC), shortcutFor("ripple-delete", MAC), shortcutFor("ripple-delete", PC)]).toEqual(["⌫", "⇧⌫", "Shift+Del"]);
  });

  it("writes Delete and Backspace the way each platform marks them", () => {
    expect([keyLabel("Delete", MAC), keyLabel("Backspace", MAC)]).toEqual(["⌦", "⌫"]);
    expect([keyLabel("Delete", PC), keyLabel("Backspace", PC)]).toEqual(["Del", "Backspace"]);
  });
});

describe("running commands", () => {
  function setup(canEdit = true) {
    const store = makeStore({ canEdit });
    return { st: () => store.getState(), ctx: { store, clipboard: createClipboard(), openShortcuts: vi.fn() } };
  }

  it("runs each command against the store", () => {
    const { st, ctx } = setup();
    st().seek(45);
    runCommand("split", ctx);
    expect(st().queue.map((e) => e.label)).toEqual(["split"]);
    runCommand("second-forward", ctx);
    expect(st().playhead).toBe(75);
    runCommand("go-end", ctx);
    expect(st().playhead).toBe(120);
    runCommand("undo", ctx);
    expect(st().queue.map((e) => e.kind)).toEqual(["edit", "undo"]);
    runCommand("toggle-snapping", ctx);
    expect(st().snapping).toBe(false);
    runCommand("play-pause", ctx);
    expect(st().playing).toBe(true);
    runCommand("show-shortcuts", ctx);
    expect(ctx.openShortcuts).toHaveBeenCalledTimes(1);
  });

  it("a viewer's editing commands do nothing; the rest still work", () => {
    const { st, ctx } = setup(false);
    st().select(["x1"]);
    st().seek(45);
    for (const shortcut of SHORTCUTS.filter((s) => s.edits)) runCommand(shortcut.command, ctx);
    expect(st().doc).toEqual(sampleDoc());
    expect(st().notice).toBeNull();
    runCommand("frame-forward", ctx);
    expect(st().playhead).toBe(46);
    runCommand("select-all", ctx);
    expect(st().selection.clipIds).toHaveLength(4);
  });

  it("runs the rest of the table", () => {
    const { st, ctx } = setup();
    const fps = st().doc.fps;
    st().seek(2 * fps);
    runCommand("frame-back", ctx);
    runCommand("frame-back", ctx);
    expect(st().playhead).toBe(2 * fps - 2);
    runCommand("second-back", ctx);
    expect(st().playhead).toBe(fps - 2);
    runCommand("frame-forward", ctx);
    expect(st().playhead).toBe(fps - 1);
    runCommand("next-edge", ctx); // clip edges: 0, 30, 60, 90, 120
    expect(st().playhead).toBe(30);
    runCommand("next-edge", ctx);
    expect(st().playhead).toBe(60);
    runCommand("prev-edge", ctx);
    expect(st().playhead).toBe(30);
    runCommand("go-start", ctx);
    expect(st().playhead).toBe(0);

    runCommand("play-forward", ctx);
    expect([st().playing, st().rate]).toEqual([true, 1]);
    runCommand("play-forward", ctx);
    expect(st().rate).toBe(2);
    runCommand("pause", ctx);
    expect(st().playing).toBe(false);
    runCommand("play-reverse", ctx);
    expect([st().playing, st().rate]).toEqual([true, -1]);
    runCommand("play-pause", ctx);
    expect(st().playing).toBe(false);

    st().select(["x2"]);
    const x2 = () => st().doc.tracks[1].clips.find((c) => c.id === "x2")?.start;
    runCommand("nudge-left", ctx);
    expect(x2()).toBe(89);
    runCommand("nudge-right-second", ctx);
    expect(x2()).toBe(89 + fps);
    runCommand("nudge-left-second", ctx);
    expect(x2()).toBe(89);
    runCommand("nudge-right", ctx);
    expect(x2()).toBe(90);
    expect(st().queue.map((e) => e.label)).toEqual(["nudge", "nudge", "nudge", "nudge"]);
    runCommand("redo", ctx);
    expect(st().queue).toHaveLength(4);
    runCommand("undo", ctx);
    runCommand("redo", ctx);
    expect(st().queue.map((e) => e.kind).slice(-2)).toEqual(["undo", "redo"]);

    const edits = st().queue.length;
    runCommand("copy", ctx);
    expect(ctx.clipboard.read()?.clips.map((c) => c.clip.id)).toEqual(["x2"]);
    expect(st().queue).toHaveLength(edits);
    expect(x2()).toBe(90);
    runCommand("cut", ctx);
    expect(st().queue).toHaveLength(edits + 1);
    expect(st().queue.at(-1)?.label).toBe("cut");
    expect(x2()).toBeUndefined();
    runCommand("paste", ctx);
    expect(st().queue.at(-1)?.label).toBe("paste");
    expect(st().selection.clipIds).toHaveLength(1);
    runCommand("delete", ctx);
    expect(st().queue.at(-1)?.label).toBe("delete");
    st().select(["c1"]);
    runCommand("ripple-delete", ctx);
    expect(st().queue.at(-1)?.label).toBe("ripple delete");

    runCommand("select-all", ctx);
    expect(st().selection.clipIds.length).toBeGreaterThan(0);
    runCommand("clear-selection", ctx);
    expect(st().selection).toEqual({ clipIds: [], trackId: null });
    st().selectTrack(st().doc.tracks[0].id);
    runCommand("clear-selection", ctx);
    expect(st().selection).toEqual({ clipIds: [], trackId: null });

    const zoom = st().zoom;
    runCommand("zoom-in", ctx);
    expect(st().zoom).toBeCloseTo(zoom * 1.25);
    runCommand("zoom-out", ctx);
    expect(st().zoom).toBeCloseTo(zoom);
    const fits = st().fitRequest;
    runCommand("zoom-fit", ctx);
    expect(st().fitRequest).toBe(fits + 1);
  });

  it("editing commands wait while a drag or a typed field is live; playback and zoom do not", () => {
    const { st, ctx } = setup();
    st().edit([{ op: "remove_clip", clipId: "c1" }], "delete");
    st().select(["x2"]);
    expect(st().setGesture([{ op: "move_clip", clipId: "x2", start: 100 }])).toBe(true);
    for (const shortcut of SHORTCUTS.filter((s) => s.edits)) runCommand(shortcut.command, ctx);
    expect(st().queue.map((e) => e.label)).toEqual(["delete"]);
    expect(st().gesture?.ops).toHaveLength(1);
    const zoom = st().zoom;
    runCommand("zoom-in", ctx);
    expect(st().zoom).toBeGreaterThan(zoom);
    runCommand("frame-forward", ctx);
    expect(st().playhead).toBe(1);
    runCommand("copy", ctx);
    expect(ctx.clipboard.read()?.clips.map((c) => c.clip.id)).toEqual(["x2"]);
  });

  it("never asks the store to edit, undo or redo for a viewer", () => {
    const { st, ctx } = setup(false);
    const edit = vi.fn();
    const undo = vi.fn();
    const redo = vi.fn();
    ctx.store.setState({ edit, undo, redo });
    st().select(["x1"]);
    for (const shortcut of SHORTCUTS.filter((s) => s.edits)) runCommand(shortcut.command, ctx);
    expect([edit.mock.calls, undo.mock.calls, redo.mock.calls]).toEqual([[], [], []]);
  });

  it("steps and nudges by the project's own frame rate", () => {
    const doc = { ...sampleDoc(), fps: 24 };
    const store = makeStore({ doc });
    const ctx = { store, clipboard: createClipboard(), openShortcuts: vi.fn() };
    store.getState().seek(50);
    runCommand("second-forward", ctx);
    expect(store.getState().playhead).toBe(74);
    runCommand("second-back", ctx);
    runCommand("second-back", ctx);
    expect(store.getState().playhead).toBe(26);
    store.getState().select(["x2"]);
    runCommand("nudge-right-second", ctx);
    expect(store.getState().doc.tracks[1].clips.find((c) => c.id === "x2")?.start).toBe(114);
  });

  it("editing goes on while signed out, and stops once the project is deleted, like the top bar's buttons", () => {
    const { st, ctx } = setup();
    st().select(["x1"]);
    runCommand("delete", ctx);
    st().setStatus("signed-out"); // the edits wait until the person signs in again
    runCommand("undo", ctx);
    runCommand("redo", ctx);
    expect(st().queue.map((e) => e.kind)).toEqual(["edit", "undo", "redo"]);
    st().setStatus("deleted");
    runCommand("undo", ctx);
    st().select(["x2"]);
    runCommand("delete", ctx);
    runCommand("split", ctx);
    expect(st().queue.map((e) => e.kind)).toEqual(["edit", "undo", "redo"]);
  });
});
