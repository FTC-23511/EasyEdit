// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorProvider } from "@/components/editor/context";
import { cx } from "@/components/ui/cx";
import { LANE_GUTTER } from "@/components/editor/timeline/playhead";
import { Timeline } from "@/components/editor/timeline/timeline";
import { HEADER_WIDTH, ROW_HEIGHT, RULER_HEIGHT } from "@/lib/editor/geometry";
import { resolveDrag } from "@/lib/editor/drag";
import { MESSAGES, explainOpError } from "@/lib/editor/messages";
import { findClip, viewDoc, type EditorStore } from "@/lib/editor/store";
import { act, fireEvent, render, screen } from "../helpers/dom";
import { entry, makeStore, sampleDoc, text } from "../editor/fixtures";

// Both stay the real functions; the spies only count calls. ClipView calls cx once per render with
// its fill class, which nothing else on the timeline uses.
vi.mock("@/lib/editor/drag", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/editor/drag")>();
  return { ...real, resolveDrag: vi.fn(real.resolveDrag) };
});
vi.mock("@/components/ui/cx", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/ui/cx")>();
  return { ...real, cx: vi.fn(real.cx) };
});

// happy-dom does no layout. Every element is 1400 px wide, the scroller's left edge is at 0 on screen
// and nothing is scrolled, so frame 0 of every lane is at HEADER_WIDTH + LANE_GUTTER and the rows
// start under the ruler. Rows top to bottom: cap, t1, v1, a1. Animation frames run when frame() says.
const ZOOM = 2;
const LANE_LEFT = HEADER_WIDTH + LANE_GUTTER;
const x = (frame: number) => LANE_LEFT + frame * ZOOM;
const y = (row: number) => RULER_HEIGHT + row * ROW_HEIGHT + ROW_HEIGHT / 2;
const T1 = y(1);
const V1 = y(2);

let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1400);
  frames = new Map();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.set(++nextFrame, cb);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, x: left, top, y: top, width, height, right: left + width, bottom: top + height, toJSON() {} }) as DOMRect;

function setup(store = makeStore()) {
  const view = render(
    <EditorProvider store={store}>
      <Timeline />
    </EditorProvider>,
  );
  act(() => store.getState().setZoom(ZOOM));
  const scroller = screen.getByRole("slider", { name: "Playhead" }).closest<HTMLElement>(".overflow-auto")!;
  scroller.getBoundingClientRect = () => rect(0, 0, 1400, 400);
  const lanes = [...view.container.querySelectorAll<HTMLElement>("[data-lane]")];
  for (const lane of lanes) lane.getBoundingClientRect = () => rect(LANE_LEFT, 0, 1400 - LANE_LEFT, ROW_HEIGHT);
  const rows = lanes[0].parentElement!.parentElement!;
  rows.getBoundingClientRect = () => rect(0, RULER_HEIGHT, 1400, 4 * ROW_HEIGHT);
  const st = () => store.getState();
  const clip = (id: string) => view.container.querySelector<HTMLElement>(`[data-clip-id="${id}"]`)!;
  const at = (clientX: number, clientY: number) => ({ button: 0, pointerId: 1, clientX, clientY });
  const press = (el: HTMLElement, clientX: number, clientY: number, over: object = {}) => fireEvent.pointerDown(el, { ...at(clientX, clientY), ...over });
  const move = (clientX: number, clientY: number) => fireEvent.pointerMove(scroller, at(clientX, clientY));
  const release = (clientX: number, clientY: number) => fireEvent.pointerUp(scroller, at(clientX, clientY));
  const frame = () =>
    act(() => {
      const due = [...frames.values()];
      frames.clear();
      for (const cb of due) cb(performance.now());
    });
  const startOf = (id: string) => findClip(st().doc, id)!.clip.start;
  const shownStart = (id: string) => findClip(viewDoc(st()), id)!.clip.start;
  return { store, st, view, scroller, lanes, rows, clip, press, move, release, frame, startOf, shownStart };
}

// Every notice the store shows from now on, in order.
function noticesOf(store: EditorStore): string[] {
  const texts: string[] = [];
  store.subscribe((s, prev) => {
    if (s.notice && s.notice !== prev.notice) texts.push(s.notice.text);
  });
  return texts;
}

it("dragging a clip more than 3 px moves it and saves one edit", () => {
  const { st, clip, press, move, release, frame, startOf } = setup();
  expect(clip("x2").className).toContain("touch-none"); // a touch drag moves the clip, not the timeline
  press(clip("x2"), x(94), T1);
  move(x(114), T1);
  frame();
  expect(findClip(viewDoc(st()), "x2")!.clip.start).toBe(110); // shown while dragging, not saved yet
  expect(st().queue).toHaveLength(0);
  release(x(114), T1);
  expect(startOf("x2")).toBe(110);
  expect(st().gesture).toBeNull();
  expect(st().queue).toHaveLength(1);
  expect(st().undoStack.map((e) => e.label)).toEqual(["move"]);
});

it("dragging one clip of a two-clip selection moves both", () => {
  const { st, clip, press, move, release, frame, startOf } = setup();
  act(() => st().select(["x1", "x2"]));
  press(clip("x2"), x(94), T1);
  expect(st().selection.clipIds).toEqual(["x1", "x2"]);
  move(x(114), T1);
  frame();
  release(x(114), T1);
  expect(startOf("x1")).toBe(20);
  expect(startOf("x2")).toBe(110);
  expect(st().undoStack).toHaveLength(1);
});

it("a press and release within 3 px makes no edit and selects the clip alone", () => {
  const { st, clip, press, move, release, frame, startOf } = setup();
  act(() => st().select(["x1", "x2"]));
  press(clip("x2"), x(94), T1);
  move(x(94) + 2, T1);
  frame();
  release(x(94) + 2, T1);
  expect(startOf("x2")).toBe(90);
  expect(st().queue).toHaveLength(0);
  expect(st().selection.clipIds).toEqual(["x2"]);
});

it("Escape during a drag cancels it, makes no edit and keeps the selection", () => {
  const { st, clip, press, move, release, frame, startOf } = setup();
  act(() => st().select(["x1", "x2"]));
  press(clip("x2"), x(94), T1);
  move(x(114), T1);
  frame();
  expect(st().gesture).not.toBeNull();
  const later = vi.fn();
  window.addEventListener("keydown", later);
  const escape = fireEvent.keyDown(document.body, { key: "Escape" });
  window.removeEventListener("keydown", later);
  expect(escape).toBe(false); // handled: the default was prevented
  expect(later).not.toHaveBeenCalled();
  expect(st().gesture).toBeNull();
  move(x(130), T1);
  frame();
  release(x(130), T1);
  expect(startOf("x2")).toBe(90);
  expect(st().queue).toHaveLength(0);
  expect(st().selection.clipIds).toEqual(["x1", "x2"]);
});

it("a drop onto an occupied spot shows the attempted place, makes no edit and shows the store's message", () => {
  const { st, view, scroller, clip, press, move, release, frame, startOf } = setup();
  press(clip("x2"), x(94), T1);
  move(x(114), T1); // a free place: x2 is shown at 110
  frame();
  expect(view.container.querySelector("[data-drag-ghost]")).toBeNull();
  move(x(34), T1); // x2 would start at 30, over x1
  frame();
  const ghost = view.container.querySelector<HTMLElement>("[data-drag-ghost]")!;
  expect(ghost.className).toContain("border-ed-danger");
  expect(parseFloat(ghost.style.left)).toBe(LANE_LEFT + 30 * ZOOM);
  expect(parseFloat(ghost.style.top)).toBe(1 * ROW_HEIGHT + parseFloat(clip("x1").style.top)); // row t1, level with its clips
  expect(ghost.style.height).toBe(clip("x1").style.height);
  expect(scroller.dataset.drag).toBe("refused");
  expect(findClip(viewDoc(st()), "x2")!.clip.start).toBe(110); // the clip stays at the last place that fit
  expect(startOf("x2")).toBe(90);
  release(x(34), T1);
  expect(startOf("x2")).toBe(90);
  expect(st().queue).toHaveLength(0);
  expect(st().notice?.text).toBe(explainOpError("OVERLAP"));
  expect(view.container.querySelector("[data-drag-ghost]")).toBeNull();
  expect(scroller.dataset.drag).toBeUndefined();
});

it("a viewer cannot drag and sees no trim handles", () => {
  const { st, view, clip, press, move, release, frame, startOf } = setup(makeStore({ canEdit: false }));
  expect(view.container.querySelector("[data-trim-handle]")).toBeNull();
  press(clip("x2"), x(94), T1);
  move(x(114), T1);
  frame();
  release(x(114), T1);
  expect(startOf("x2")).toBe(90);
  expect(st().gesture).toBeNull();
  expect(st().queue).toHaveLength(0);
  expect(st().selection.clipIds).toEqual(["x2"]);
});

it("a trim by the right handle changes the duration in one edit", () => {
  const { st, clip, press, move, release, frame } = setup();
  const handle = clip("x2").querySelector<HTMLElement>('[data-trim-handle="end"]')!;
  press(handle, x(119), T1);
  move(x(129), T1);
  frame();
  release(x(129), T1);
  const x2 = findClip(st().doc, "x2")!.clip;
  expect([x2.start, x2.duration]).toEqual([90, 40]);
  expect(st().undoStack.map((e) => e.label)).toEqual(["trim"]);
});

it("box selection from empty row space selects the clips it covers", () => {
  const { st, view, lanes, press, move, release, frame } = setup();
  act(() => st().select(["x2"]));
  press(lanes[1], x(70), T1); // t1's lane, between x1 and x2
  expect(st().selection.clipIds).toEqual([]);
  move(x(10), V1);
  frame();
  expect(st().selection.clipIds).toEqual(["x1", "c1", "c2"]);
  expect(view.container.querySelector("[data-select-box]")).not.toBeNull();
  release(x(10), V1);
  expect(view.container.querySelector("[data-select-box]")).toBeNull();
  expect(st().selection.clipIds).toEqual(["x1", "c1", "c2"]);
  expect(st().queue).toHaveLength(0);
});

it("a viewer can box-select too", () => {
  const { st, lanes, press, move, release, frame } = setup(makeStore({ canEdit: false }));
  press(lanes[2], x(70), V1); // v1's lane, after c2
  move(x(40), V1);
  frame();
  release(x(40), V1);
  expect(st().selection.clipIds).toEqual(["c2"]);
});

it("a teammate's edit elsewhere keeps the drag going, and removing the dragged clip ends it", () => {
  const { store, st, scroller, clip, press, move, release, frame, startOf } = setup();
  press(clip("x2"), x(94), T1);
  move(x(114), T1);
  frame();
  act(() => void st().applyRemote([entry(6, [{ op: "move_clip", clipId: "c1", start: 200 }])]));
  frame();
  expect(findClip(viewDoc(st()), "x2")!.clip.start).toBe(110);
  const notices = noticesOf(store);
  act(() => void st().applyRemote([entry(7, [{ op: "remove_clip", clipId: "x2" }])]));
  frame();
  expect(st().gesture).toBeNull();
  expect(notices).toEqual([MESSAGES.clipGone]); // the store's message, once
  expect(scroller.dataset.drag).toBeUndefined();
  release(x(114), T1);
  expect(st().queue).toHaveLength(0);
  expect(startOf("c1")).toBe(200);
});

it("a drag with nothing to save yet still says so when its clip is removed", () => {
  const { st, clip, press, move, release, frame } = setup();
  press(clip("x2"), x(94), T1);
  move(x(94), T1 + 5); // a drag, but still on the same frame and row
  frame();
  expect(st().gesture).toBeNull();
  act(() => void st().applyRemote([entry(6, [{ op: "remove_clip", clipId: "x2" }])]));
  expect(st().notice).toBeNull();
  frame();
  expect(st().notice?.text).toBe(MESSAGES.clipGone);
  release(x(94), T1 + 5);
  expect(st().queue).toHaveLength(0);
});

it("a teammate taking the spot mid-drag shows the attempt, refuses the drop and keeps the clip where it was", () => {
  const { st, view, scroller, clip, press, move, release, frame, startOf, shownStart } = setup();
  press(clip("x2"), x(94), T1);
  move(x(204), T1); // x2 to 200, a free place
  frame();
  expect(shownStart("x2")).toBe(200);
  act(() => void st().applyRemote([entry(6, [{ op: "move_clip", clipId: "x1", start: 190 }])])); // now 190 to 250
  frame();
  expect(scroller.dataset.drag).toBe("refused");
  expect(parseFloat(view.container.querySelector<HTMLElement>("[data-drag-ghost]")!.style.left)).toBe(LANE_LEFT + 200 * ZOOM);
  release(x(204), T1);
  expect(startOf("x2")).toBe(90);
  expect(st().queue).toHaveLength(0);
  expect(st().notice?.text).toBe(explainOpError("OVERLAP"));
});

it("a clip removed between the press and the start of the drag ends the press with one message", () => {
  const { store, st, clip, press, move, release, frame } = setup();
  press(clip("x2"), x(94), T1);
  const notices = noticesOf(store);
  act(() => void st().applyRemote([entry(6, [{ op: "remove_clip", clipId: "x2" }])]));
  expect(notices).toEqual([]);
  move(x(114), T1);
  move(x(120), T1);
  frame();
  release(x(120), T1);
  expect(notices).toEqual([MESSAGES.clipGone]);
  expect(st().queue).toHaveLength(0);
});

it("turning snapping off, moving the playhead or zooming during a drag updates it without a pointer move", () => {
  const { st, view, clip, press, move, frame, shownStart } = setup();
  const guide = () => view.container.querySelector<HTMLElement>("[data-snap-guide]");
  press(clip("x2"), x(94), T1);
  move(x(67), T1); // x2 to 63, snapped to the edge at 60
  frame();
  expect(shownStart("x2")).toBe(60);
  expect(guide()).not.toBeNull();
  act(() => st().setSnapping(false));
  frame();
  expect(shownStart("x2")).toBe(63);
  expect(guide()).toBeNull();
  act(() => st().setSnapping(true));
  frame();
  expect(shownStart("x2")).toBe(60);
  act(() => st().seek(65)); // closer than the edge at 60
  frame();
  expect(shownStart("x2")).toBe(65);
  expect(parseFloat(guide()!.style.left)).toBe(LANE_LEFT + 65 * ZOOM);
  act(() => st().setZoom(1)); // the pointer is now over frame 134, 40 frames after the grab
  frame();
  expect(shownStart("x2")).toBe(130);
});

it("works out several pointer moves in one animation frame once", () => {
  const { clip, press, move, frame } = setup();
  const resolve = vi.mocked(resolveDrag);
  press(clip("x2"), x(94), T1);
  resolve.mockClear();
  move(x(110), T1);
  move(x(114), T1);
  move(x(118), T1);
  expect(resolve).not.toHaveBeenCalled();
  frame();
  expect(resolve).toHaveBeenCalledTimes(1);
});

it("losing edit access mid-drag ends the drag and saves nothing", () => {
  const { st, scroller, clip, press, move, release, frame } = setup();
  press(clip("x2"), x(94), T1);
  move(x(114), T1);
  frame();
  act(() => st().revokeEditing());
  frame();
  expect(scroller.dataset.drag).toBeUndefined();
  expect(st().gesture).toBeNull();
  release(x(114), T1);
  expect(st().queue).toHaveLength(0);
});

it("pointercancel, lost capture and unmount each end the drag with nothing left behind", () => {
  for (const exit of ["pointercancel", "lostpointercapture", "unmount"] as const) {
    const { st, view, scroller, clip, press, move, frame } = setup();
    const spies = [scroller, window].map((target) => ({
      add: vi.spyOn(target, "addEventListener"),
      remove: vi.spyOn(target, "removeEventListener"),
    }));
    press(clip("x2"), x(94), T1);
    move(x(114), T1);
    frame();
    move(x(118), T1); // an animation frame is pending
    expect(st().gesture, exit).not.toBeNull();
    expect(frames.size, exit).toBe(1);
    if (exit === "pointercancel") fireEvent.pointerCancel(scroller, { pointerId: 1 });
    else if (exit === "lostpointercapture") fireEvent.lostPointerCapture(scroller, { pointerId: 1 });
    else view.unmount();
    expect(st().gesture, exit).toBeNull();
    expect(frames.size, exit).toBe(0);
    expect(st().queue, exit).toHaveLength(0);
    for (const { add, remove } of spies) {
      const left = add.mock.calls.filter(([type, fn]) => !remove.mock.calls.some(([t, f]) => t === type && f === fn));
      expect(left.map(([type]) => type), exit).toEqual([]);
    }
    expect(spies.reduce((n, { add }) => n + add.mock.calls.length, 0), exit).toBeGreaterThan(0);
    if (exit !== "unmount") view.unmount();
    vi.restoreAllMocks();
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1400);
  }
});

it("a Shift box keeps the selection held at the press, gives clips back as it shrinks, and Escape restores it", () => {
  const { st, lanes, press, move, release, frame } = setup();
  const selected = () => st().selection.clipIds;
  act(() => st().select(["c1"]));
  press(lanes[1], x(70), T1, { shiftKey: true }); // t1's lane, between x1 and x2
  expect(selected()).toEqual(["c1"]);
  move(x(50), T1);
  frame();
  expect(selected()).toEqual(["c1", "x1"]);
  move(x(40), V1);
  frame();
  expect(selected()).toEqual(["c1", "x1", "c2"]);
  move(x(65), T1);
  frame();
  expect(selected()).toEqual(["c1"]);
  move(x(50), T1);
  frame();
  expect(selected()).toEqual(["c1", "x1"]);
  expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(false);
  expect(selected()).toEqual(["c1"]);
  release(x(50), T1);
  expect(selected()).toEqual(["c1"]);
});

it("moving one clip re-renders only that clip, not the others on screen", () => {
  const doc = sampleDoc();
  doc.tracks[1].clips = Array.from({ length: 300 }, (_, i) => text(`k${i}`, i * 30, 20));
  const { st, view } = setup(makeStore({ doc }));
  act(() => st().setZoom(0.5));
  expect(view.container.querySelectorAll("[data-clip-id]").length).toBeGreaterThan(50);
  const clipRenders = () => vi.mocked(cx).mock.calls.filter((parts) => parts.some((p) => typeof p === "string" && p.startsWith("bg-ed-clip-"))).length;
  vi.mocked(cx).mockClear();
  act(() => void st().setGesture([{ op: "move_clip", clipId: "k5", start: 155 }]));
  expect(findClip(viewDoc(st()), "k5")!.clip.start).toBe(155);
  expect(clipRenders()).toBe(1);
});

it("a focused clip leaves Space to play and pause, and Enter selects it", () => {
  const { st, clip } = setup();
  act(() => st().select(["x1"]));
  clip("x2").focus();
  expect(fireEvent.keyDown(clip("x2"), { key: " " })).toBe(true); // not prevented: the window's play/pause shortcut gets it
  expect(st().selection.clipIds).toEqual(["x1"]);
  expect(fireEvent.keyDown(clip("x2"), { key: "Enter" })).toBe(false);
  expect(st().selection.clipIds).toEqual(["x2"]);
});
