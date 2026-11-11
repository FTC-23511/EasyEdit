// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorProvider } from "@/components/editor/context";
import { EditorScreen } from "@/components/editor/editor-screen";
import { createClipboard } from "@/lib/editor/clipboard";
import { shortcutFor } from "@/lib/editor/shortcuts";
import { makeStore } from "../editor/fixtures";
import { act, fireEvent, render, screen } from "../helpers/dom";

const isMac = () => navigator.platform.startsWith("Mac");
const MOD = () => (isMac() ? { metaKey: true } : { ctrlKey: true });

// Playback is started by a key in some tests; its animation frames never run here.
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.getSelection()?.removeAllRanges();
});

function show(canEdit = true) {
  const store = makeStore({ canEdit });
  const clipboard = createClipboard();
  store.getState().select(["x1"]);
  render(
    <EditorProvider store={store} clipboard={clipboard}>
      <EditorScreen />
    </EditorProvider>,
  );
  return { store, clipboard, st: () => store.getState() };
}

const press = (target: Element, key: string, mods: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(target, { key, ...mods });

it("keys typed in a field stay with the field, Cmd/Ctrl+Z included", () => {
  const { st } = show();
  act(() => {
    st().edit([{ op: "remove_clip", clipId: "c1" }], "delete");
  });
  const text = screen.getByRole("textbox", { name: "Text" });
  // true: nothing called preventDefault, so the browser types, deletes and undoes text as usual
  expect(press(text, "Delete")).toBe(true);
  expect(press(text, "s")).toBe(true);
  expect(press(text, "z", MOD())).toBe(true);
  expect(press(screen.getByLabelText("Size"), " ")).toBe(true);
  expect(st().queue.map((e) => e.kind)).toEqual(["edit"]);
  expect(st().playing).toBe(false);
});

it("a viewer's editing keys do nothing, and playback keys still work", () => {
  const { st } = show(false);
  press(document.body, "Delete");
  press(document.body, "s");
  press(document.body, "x", MOD());
  expect(st().queue).toEqual([]);
  press(document.body, " ");
  expect(st().playing).toBe(true);
  press(document.body, "k");
  expect(st().playing).toBe(false);
  press(document.body, "ArrowRight");
  expect(st().playhead).toBe(1);
  press(document.body, "c", MOD());
  press(document.body, "a", MOD());
  expect(st().selection.clipIds).toHaveLength(4);
});

it("editing keys wait while a gesture is live; playback and zoom keys do not", () => {
  const { st } = show();
  act(() => {
    expect(st().setGesture([{ op: "move_clip", clipId: "x2", start: 100 }])).toBe(true);
  });
  press(document.body, "Delete");
  press(document.body, "s");
  press(document.body, "z", MOD());
  expect(st().queue).toEqual([]);
  expect(st().gesture).not.toBeNull();
  const zoom = st().zoom;
  press(document.body, "=");
  expect(st().zoom).toBeGreaterThan(zoom);
  press(document.body, "ArrowRight");
  expect(st().playhead).toBe(1);
});

it("a key a control already handled is not run again as a shortcut", () => {
  const { st } = show();
  // The playhead moves one frame for its own arrow key, not two.
  expect(press(screen.getByRole("slider", { name: "Playhead" }), "ArrowRight")).toBe(false);
  expect(st().playhead).toBe(1);
  // The arrow moves to the next tab and leaves the playhead alone.
  press(screen.getByRole("tab", { name: "Text" }), "ArrowRight");
  expect(screen.getByRole("tab", { name: "Media" }).getAttribute("aria-selected")).toBe("true");
  expect(st().playhead).toBe(1);
  // ArrowDown opens a menu instead of going to the next clip edge.
  press(screen.getByRole("button", { name: "Add track" }), "ArrowDown");
  expect(screen.getByRole("menu", { name: "Add track" })).toBeTruthy();
  expect(st().playhead).toBe(1);
  // Escape closes the menu and keeps the selection.
  press(screen.getByRole("menu", { name: "Add track" }), "Escape");
  expect(screen.queryByRole("menu")).toBeNull();
  // Enter on a clip selects it and runs nothing else.
  const clip = screen.getByRole("button", { name: /^Text clip "hi", 0:03:00/ });
  press(clip, "Enter");
  expect(st().selection.clipIds).toEqual(["x2"]);
  expect(st().playing).toBe(false);
});

it("Space plays even when a clip has focus", () => {
  const { st } = show();
  const clip = screen.getByRole("button", { name: /^Text clip "hi", 0:03:00/ });
  press(clip, "Enter");
  // A clip does not take Space for itself, so the selection stays and playback starts.
  expect(press(clip, " ")).toBe(false);
  expect(st().selection.clipIds).toEqual(["x2"]);
  expect(st().playing).toBe(true);
});

it("? opens the list of shortcuts, and Escape closes it without clearing the selection", () => {
  const { st } = show();
  expect(screen.queryByText("Keyboard shortcuts")).toBeNull();
  press(document.body, "?", { shiftKey: true });
  const title = screen.getByText("Keyboard shortcuts");
  const dialog = title.closest("dialog");
  expect(dialog?.open).toBe(true);
  for (const group of ["Playback", "Editing", "Timeline", "General"]) expect(screen.getByRole("heading", { name: group })).toBeTruthy();
  expect(screen.getByText("Delete and close the gap")).toBeTruthy();
  expect(dialog?.querySelectorAll("kbd").length).toBeGreaterThan(30);
  // While it is open, keys are not shortcuts.
  press(document.body, "Delete");
  expect(st().queue).toEqual([]);
  // Escape, pressed where focus is inside the dialog, closes it and nothing else.
  press(title, "Escape");
  expect(screen.queryByText("Keyboard shortcuts")).toBeNull();
  expect(dialog?.open).toBe(false);
  expect(st().selection.clipIds).toEqual(["x1"]);
});

it("the top bar opens the list of shortcuts too", () => {
  show(false);
  fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
  expect(screen.getByText("Keyboard shortcuts").closest("dialog")?.open).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByText("Keyboard shortcuts")).toBeNull();
});

// Focuses a control the way a mouse click does (a pointer goes down, then focus arrives) or the way
// the Tab key does (focus arrives with no pointer). The hook tells the two apart by that order,
// because a browser switches :focus-visible on as soon as any key goes down.
function focusByClick(element: HTMLElement) {
  fireEvent.pointerDown(element);
  element.focus();
}

it("the space bar and Enter press a button reached with the keyboard and do not toggle playback", () => {
  const { st } = show();
  const button = screen.getByRole("button", { name: "Safe zones" });
  button.focus();
  expect(press(button, " ")).toBe(true);
  expect(press(button, "Enter")).toBe(true);
  expect(st().playing).toBe(false);
  expect(document.activeElement).toBe(button);
});

it("Space after clicking a button plays or pauses and does not press the button again; Enter still does", () => {
  const { st } = show();
  const title = screen.getByRole("button", { name: "Add title" });
  focusByClick(title);
  fireEvent.click(title);
  expect(st().queue).toHaveLength(1);
  expect(press(title, "Enter")).toBe(true); // Enter stays with the button
  expect(press(title, " ")).toBe(false);
  expect(st().playing).toBe(true);
  expect(document.activeElement).not.toBe(title); // let go, so releasing Space cannot press it
  press(document.body, " ");
  expect(st().playing).toBe(false);
  expect(st().queue).toHaveLength(1);
});

it("a button that was already focused by the keyboard and is then clicked gives Space up too", () => {
  const { st } = show();
  const button = screen.getByRole("button", { name: "Safe zones" });
  button.focus();
  fireEvent.pointerDown(button); // focus does not move, so no focus event follows
  expect(press(button, " ")).toBe(false);
  expect(st().playing).toBe(true);
});

it("a clicked button reached again with the keyboard takes Space back", () => {
  const { st } = show();
  const title = screen.getByRole("button", { name: "Add title" });
  const other = screen.getByRole("button", { name: "Safe zones" });
  focusByClick(title);
  // Long after the click, focus moves away and back with no pointer, as Tab and Shift+Tab do.
  vi.spyOn(performance, "now").mockReturnValue(performance.now() + 60_000);
  other.focus();
  title.focus();
  expect(press(title, " ")).toBe(true);
  expect(st().playing).toBe(false);
});

it("buttons that have a key show it in their tooltip", () => {
  show();
  const hint = (name: string | RegExp) => screen.getByRole("button", { name }).getAttribute("title");
  const mac = isMac();
  expect(hint(/^Undo/)).toBe(`Undo (${shortcutFor("undo", mac)})`);
  expect(hint(/^Redo/)).toBe(`Redo (${shortcutFor("redo", mac)})`);
  expect(hint("Split")).toBe("Split (S)");
  expect(hint("Delete")).toBe(`Delete (${shortcutFor("delete", mac)})`);
  expect(shortcutFor("delete", mac)).toBe(mac ? "⌫" : "Del");
  expect(hint("Ripple delete")).toBe(`Ripple delete (${shortcutFor("ripple-delete", mac)})`);
  expect(hint("Snap")).toBe("Snap (N)");
  expect(hint("Zoom in")).toBe("Zoom in (=)");
  expect(hint("Zoom out")).toBe("Zoom out (-)");
  expect(hint("Fit")).toBe(`Fit (${shortcutFor("zoom-fit", mac)})`);
  expect(hint("Play")).toBe("Play (Space)");
  expect([hint("Go to start"), hint("Back one frame"), hint("Forward one frame"), hint("Go to end")]).toEqual([
    "Go to start (Home)", "Back one frame (←)", "Forward one frame (→)", "Go to end (End)",
  ]);
  expect(hint("Keyboard shortcuts")).toBe("Keyboard shortcuts (?)");
});

it("holding a key repeats steps, nudges, zoom, undo and redo, and nothing else", () => {
  const { st, clipboard } = show();
  press(document.body, "c", MOD());
  expect(clipboard.read()?.clips.map((c) => c.clip.id)).toEqual(["x1"]);
  act(() => st().seek(200)); // past every clip, so a split finds nothing
  // A held key is still taken from the browser, but only the first press runs.
  expect(press(document.body, "v", { ...MOD(), repeat: true })).toBe(false);
  press(document.body, " ", { repeat: true });
  press(document.body, "l", { repeat: true });
  press(document.body, "n", { repeat: true });
  press(document.body, "s", { repeat: true });
  expect(st().queue).toEqual([]);
  expect([st().playing, st().snapping, st().notice]).toEqual([false, true, null]);

  act(() => st().seek(0));
  press(document.body, "ArrowRight", { repeat: true });
  press(document.body, "ArrowRight", { repeat: true });
  expect(st().playhead).toBe(2);
  act(() => st().select(["x2"]));
  press(document.body, "ArrowRight", { altKey: true, repeat: true });
  press(document.body, "ArrowRight", { altKey: true, repeat: true });
  expect(st().queue.map((e) => e.label)).toEqual(["nudge", "nudge"]);
  expect(st().doc.tracks[1].clips.find((c) => c.id === "x2")?.start).toBe(92);
});

it("takes only the keys it uses from the browser", () => {
  const { st } = show();
  act(() => st().seek(30)); // inside x1, so S splits it
  expect(press(document.body, "r", MOD())).toBe(true);
  expect(press(document.body, "Tab")).toBe(true);
  expect(press(document.body, "q")).toBe(true);
  expect(press(document.body, "s")).toBe(false);
  expect(st().queue.map((e) => e.label)).toEqual(["split"]);
});

it("does nothing while the window is too narrow for the editor", () => {
  const { st } = show();
  const wide = window.matchMedia("(min-width: 64rem)");
  const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ ...wide, media: query, matches: false }));
  for (const [key, mods] of [["Delete", {}], ["s", {}], ["v", MOD()], ["z", MOD()], [" ", {}], ["ArrowRight", {}], ["?", { shiftKey: true }]] as const) {
    expect(press(document.body, key, mods)).toBe(true);
  }
  expect(matchMedia).toHaveBeenCalledWith("(min-width: 64rem)");
  expect([st().queue, st().playhead, st().playing]).toEqual([[], 0, false]);
  expect(screen.queryByText("Keyboard shortcuts")).toBeNull();
});

it("leaves copy and cut to the browser with no clip selected, or with text selected on the page", () => {
  const { st, clipboard } = show();
  act(() => st().select([]));
  expect(press(document.body, "c", MOD())).toBe(true);
  expect(press(document.body, "x", MOD())).toBe(true);
  expect(clipboard.read()).toBeNull();

  act(() => st().select(["x1"]));
  const range = document.createRange();
  range.selectNodeContents(screen.getByRole("heading", { name: "Qual recap" }));
  window.getSelection()?.addRange(range);
  expect(press(document.body, "c", MOD())).toBe(true);
  expect(press(document.body, "x", MOD())).toBe(true);
  expect(clipboard.read()).toBeNull();
  expect(st().queue).toEqual([]);

  window.getSelection()?.removeAllRanges();
  expect(press(document.body, "c", MOD())).toBe(false);
  expect(clipboard.read()?.clips.map((c) => c.clip.id)).toEqual(["x1"]);
  expect(press(document.body, "x", MOD())).toBe(false);
  expect(st().queue.map((e) => e.label)).toEqual(["cut"]);
});

it("keys go to an open menu, not to the editor", () => {
  const { st } = show();
  fireEvent.click(screen.getAllByRole("button", { name: "Track options" })[0]);
  const item = screen.getByRole("menuitem", { name: "Rename" });
  press(item, "s");
  press(item, "Delete");
  press(item, "ArrowRight");
  expect(screen.getByRole("menu", { name: "Track options" })).toBeTruthy();
  expect([st().queue, st().playhead, st().selection.clipIds]).toEqual([[], 0, ["x1"]]);
});
