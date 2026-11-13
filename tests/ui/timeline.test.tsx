// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorProvider } from "@/components/editor/context";
import { LANE_GUTTER } from "@/components/editor/timeline/playhead";
import { MediaProvider, type MediaServices } from "@/components/editor/media/media-context";
import { Timeline } from "@/components/editor/timeline/timeline";
import { HEADER_WIDTH, MAX_CONTENT_PX, formatTimecode } from "@/lib/editor/geometry";
import { createEmptyDoc } from "@/lib/timeline";
import { act, fireEvent, render, screen, within } from "../helpers/dom";
import { assetView, pretendMediaServices } from "../helpers/media-services";
import { makeStore, sampleDoc, video } from "../editor/fixtures";

// happy-dom does no layout: every element is 1400 px wide, so the lanes measure 1400 − HEADER_WIDTH px. The scroller's
// left edge is at 0 on screen, so the ruler's lane starts at HEADER_WIDTH − scrollLeft.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1400);
});
afterEach(() => vi.restoreAllMocks());

function setup(store = makeStore(), media?: MediaServices) {
  const view = render(
    <EditorProvider store={store}>
      {media ? (
        <MediaProvider services={media}>
          <Timeline />
        </MediaProvider>
      ) : (
        <Timeline />
      )}
    </EditorProvider>,
  );
  const head = screen.getByRole("slider", { name: "Playhead" });
  const scroller = head.closest<HTMLElement>(".overflow-auto")!;
  const ruler = head.parentElement!;
  const rect = (left: number) => ({ left, x: left, top: 0, y: 0, width: 1000, height: 24, right: left + 1000, bottom: 24, toJSON() {} }) as DOMRect;
  scroller.getBoundingClientRect = () => rect(0);
  ruler.getBoundingClientRect = () => rect(HEADER_WIDTH);
  ruler.setPointerCapture = () => {};
  ruler.hasPointerCapture = () => true;
  const clip = (id: string) => view.container.querySelector<HTMLElement>(`[data-clip-id="${id}"]`)!;
  const scrollTo = (px: number) => {
    scroller.scrollLeft = px;
    fireEvent.scroll(scroller);
    ruler.getBoundingClientRect = () => rect(HEADER_WIDTH - px);
  };
  const pressRuler = (clientX: number) => {
    fireEvent.pointerDown(ruler, { button: 0, pointerId: 1, clientX });
    fireEvent.lostPointerCapture(ruler, { pointerId: 1 });
  };
  return { store, st: () => store.getState(), head, scroller, ruler, clip, scrollTo, pressRuler, container: view.container, unmount: view.unmount };
}

it("selects on press: one clip, toggles with a modifier, keeps a pressed selection until a click", () => {
  const { st, clip } = setup();
  const press = (id: string, over: object = {}) => fireEvent.pointerDown(clip(id), { button: 0, pointerId: 1, clientX: 100, clientY: 10, ...over });
  const release = (id: string, clientX: number) => fireEvent.pointerUp(clip(id), { button: 0, pointerId: 1, clientX, clientY: 10 });

  press("c1");
  expect(st().selection.clipIds).toEqual(["c1"]);
  press("c2", { shiftKey: true });
  press("x1", { metaKey: true });
  press("x2", { ctrlKey: true });
  expect(st().selection.clipIds).toEqual(["c1", "c2", "x1", "x2"]);
  press("x2", { ctrlKey: true });
  expect(st().selection.clipIds).toEqual(["c1", "c2", "x1"]);

  press("c2"); // already selected: the selection stays, so a drag could take all of it
  expect(st().selection.clipIds).toEqual(["c1", "c2", "x1"]);
  release("c2", 110); // moved 10 px: not a click
  expect(st().selection.clipIds).toEqual(["c1", "c2", "x1"]);
  press("c2");
  release("c2", 102); // within 3 px: a click
  expect(st().selection.clipIds).toEqual(["c2"]);

  fireEvent.pointerDown(clip("c2").parentElement!, { button: 0 });
  expect(st().selection.clipIds).toEqual([]);
});

it("Fit always returns to the start, and zooming out to the minimum keeps the left edge", () => {
  const { st, scroller, scrollTo, unmount } = setup();
  expect(st().fitRequest).toBe(1); // the first measurement fits
  const fitted = st().zoom;
  scrollTo(500);
  fireEvent.click(screen.getByRole("button", { name: "Fit" }));
  expect(st().zoom).toBe(fitted);
  expect(scroller.scrollLeft).toBe(0);
  unmount();

  const threeHours = 3 * 60 * 60 * 30;
  const doc = sampleDoc();
  doc.tracks[0].clips = [video("long", 0, threeHours)];
  const long = setup(makeStore({ doc }));
  act(() => long.st().setZoom(1));
  long.scrollTo(100_000); // the playhead at 0 is out of view, so the left edge is kept
  const leftFrame = () => (long.scroller.scrollLeft - LANE_GUTTER) / long.st().zoom;
  const before = leftFrame();
  const zoomOut = screen.getByRole("button", { name: "Zoom out" }) as HTMLButtonElement;
  for (let i = 0; i < 100 && !zoomOut.disabled; i++) fireEvent.click(zoomOut);
  expect(zoomOut.disabled).toBe(true);
  expect(long.st().zoom).toBe(0.02);
  expect(leftFrame()).toBeCloseTo(before, -1);
});

it("renders only the clips in view out of 1,000 and keeps the content within the limit", () => {
  const doc = sampleDoc();
  doc.tracks[0].clips = Array.from({ length: 1000 }, (_, i) => video(`k${i}`, i * 30, 30));
  const { st, scrollTo, container, scroller } = setup(makeStore({ doc }));
  act(() => st().setZoom(2));
  scrollTo(30_000);
  const rendered = [...container.querySelectorAll<HTMLElement>("[data-clip-id]")].map((el) => el.dataset.clipId);
  expect(rendered).toContain("k500");
  expect(rendered.length).toBeGreaterThan(10);
  expect(rendered.length).toBeLessThan(60);
  const width = parseFloat((scroller.firstElementChild as HTMLElement).style.width);
  expect(width).toBeGreaterThan(60_000);
  expect(width).toBeLessThanOrEqual(MAX_CONTENT_PX);
});

const hourLong = () => {
  const doc = sampleDoc();
  doc.tracks[0].clips = [video("long", 0, 60 * 60 * 30)];
  return makeStore({ doc });
};

it("a ruler press seeks to the frame under the pointer, and a press in the gutter before frame 0 seeks to 0", () => {
  for (const zoom of [0.5, 2]) {
    for (const scroll of [0, 333]) {
      const { st, scrollTo, pressRuler, unmount } = setup(hourLong());
      act(() => st().setZoom(zoom));
      scrollTo(scroll);
      const frame = Math.round((scroll + 400) / zoom);
      pressRuler(HEADER_WIDTH - scroll + LANE_GUTTER + frame * zoom);
      expect(st().playhead, `zoom ${zoom}, scroll ${scroll}`).toBe(frame);
      unmount();
    }
  }
  const { st, scrollTo, pressRuler } = setup();
  scrollTo(0);
  act(() => st().seek(50));
  pressRuler(HEADER_WIDTH + 3);
  expect(st().playhead).toBe(0);
});

it("the playhead's head, its line across the rows, a clip's left edge and the ruler tick share one x", () => {
  const doc = sampleDoc();
  doc.tracks[0].clips = [video("z0", 0, 30), video("z60", 60, 30)];
  const { st, head, ruler, container } = setup(makeStore({ doc }));
  act(() => st().setZoom(2));
  const translateX = (el: HTMLElement) => parseFloat(/translateX\(([-\d.]+)px\)/.exec(el.style.transform)![1]);
  const rowLine = container.querySelector<HTMLElement>("div.pointer-events-none.w-px")!;
  for (const frame of [0, 60]) {
    act(() => st().seek(frame));
    const headX = HEADER_WIDTH + translateX(head) + parseFloat(head.style.width) / 2; // the line is in the middle of the grab area
    const rowLineX = parseFloat(rowLine.style.left) + translateX(rowLine);
    const clip = container.querySelector<HTMLElement>(`[data-clip-id="z${frame}"]`)!;
    const clipX = HEADER_WIDTH + (parseFloat(clip.parentElement!.style.marginLeft) || 0) + parseFloat(clip.style.left);
    const ticks = [...ruler.querySelectorAll<HTMLElement>("span.bottom-0.w-px")].map((t) => HEADER_WIDTH + parseFloat(t.style.left));
    expect(headX, `frame ${frame}`).toBe(HEADER_WIDTH + LANE_GUTTER + frame * 2);
    expect(rowLineX, `frame ${frame}`).toBe(headX);
    expect(clipX, `frame ${frame}`).toBe(headX);
    expect(ticks, `frame ${frame}`).toContain(headX);
  }
});

it("a seek that leaves the view scrolls the playhead to 10% of the lane width from the left", () => {
  const { st, scroller, scrollTo } = setup(hourLong());
  act(() => st().setZoom(2));
  scrollTo(0);
  act(() => st().seek(3000));
  expect(LANE_GUTTER + 3000 * 2 - scroller.scrollLeft).toBe((1400 - HEADER_WIDTH) * 0.1);
});

it("pressing a row's gutter before frame 0 clears the selection without seeking", () => {
  const { st, clip } = setup();
  act(() => st().select(["c1"]));
  act(() => st().seek(40));
  const row = clip("c1").parentElement!.parentElement!;
  fireEvent.pointerDown(row, { button: 0 });
  expect(st().selection.clipIds).toEqual([]);
  expect(st().playhead).toBe(40);
});

it("a 3-hour project at the maximum zoom fills exactly the widest allowed scroll area", () => {
  const doc = sampleDoc();
  doc.tracks[0].clips = [video("long", 0, 3 * 60 * 60 * 30)];
  const { st, scroller } = setup(makeStore({ doc }));
  act(() => st().setZoom(40)); // too wide for 3 hours: the timeline draws and stores the allowed zoom
  expect(st().zoom).toBeLessThan(40);
  expect(parseFloat((scroller.firstElementChild as HTMLElement).style.width)).toBe(MAX_CONTENT_PX);
});

it("a media clip carries its asset's name", () => {
  const range = `${formatTimecode(0, 30)} to ${formatTimecode(30, 30)}`;
  const media = pretendMediaServices([]);
  const store = makeStore();
  const { clip, unmount } = setup(store, media);
  act(() => store.getState().setZoom(2)); // c1 is 60 px wide: its label fits
  // Before the library knows the asset, as today.
  expect(clip("c1").getAttribute("aria-label")).toBe(`Video clip, ${range}`);
  expect(within(clip("c1")).getByText("Video")).toBeTruthy();
  act(() => media.library.getState().put(assetView({ name: "intake" })));
  expect(screen.getByRole("button", { name: `Video clip "intake", ${range}` })).toBe(clip("c1"));
  expect(within(clip("c1")).getByText("intake")).toBeTruthy();
  // Pointed at another asset, the clip takes that asset's name.
  act(() => media.library.getState().put(assetView({ id: "b", name: "climb" })));
  act(() => void store.getState().edit([{ op: "update_clip", clipId: "c1", patch: { assetId: "b" } }], "swap"));
  expect(clip("c1").getAttribute("aria-label")).toBe(`Video clip "climb", ${range}`);
  unmount();

  const bare = setup();
  act(() => bare.store.getState().setZoom(2));
  expect(bare.clip("c1").getAttribute("aria-label")).toBe(`Video clip, ${range}`);
  expect(within(bare.clip("c1")).getByText("Video")).toBeTruthy();
});

it("an empty timeline says where clips come from, and only an editor is told to add them", () => {
  const { unmount } = setup(makeStore({ doc: createEmptyDoc("short_9x16") }));
  expect(screen.getByText("Nothing on the timeline yet. Add text or media from the panel on the left.")).toBeTruthy();
  unmount();
  setup(makeStore({ doc: createEmptyDoc("short_9x16"), canEdit: false }));
  expect(screen.getByText("Nothing on the timeline yet.")).toBeTruthy();
});
