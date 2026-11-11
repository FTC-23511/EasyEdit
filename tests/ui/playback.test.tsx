// @vitest-environment happy-dom
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorProvider } from "@/components/editor/context";
import { Preview } from "@/components/editor/preview";
import { usePlayback } from "@/components/editor/use-playback";
import { viewDoc, type EditorStore } from "@/lib/editor/store";
import { drawFrame } from "@/lib/render/compositor";
import { makeStore } from "../editor/fixtures";
import { act, render } from "../helpers/dom";

vi.mock("@/lib/render/compositor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/render/compositor")>();
  return { ...actual, drawFrame: vi.fn() };
});

// A hand-run animation-frame queue and clock.
let frames: Map<number, FrameRequestCallback>;
let lastId: number;
let now: number;

beforeEach(() => {
  frames = new Map();
  lastId = 0;
  now = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.set(++lastId, cb);
    return lastId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
  vi.spyOn(performance, "now").mockImplementation(() => now);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(drawFrame).mockClear();
});

// Runs every pending animation frame at time `at`.
function runFrame(at: number) {
  now = at;
  const due = [...frames.values()];
  frames.clear();
  act(() => {
    for (const cb of due) cb(at);
  });
}

function Loop() {
  usePlayback();
  return null;
}

function mountLoop(store: EditorStore) {
  return render(
    <StrictMode>
      <EditorProvider store={store}>
        <Loop />
      </EditorProvider>
    </StrictMode>,
  );
}

describe("the playback loop", () => {
  it("runs one loop, plays doc.fps frames a second, and stops at the end", () => {
    const store = makeStore(); // 120 frames long
    mountLoop(store);
    act(() => store.getState().play());
    expect(frames.size).toBe(1);
    runFrame(1000);
    expect(store.getState().playhead).toBe(store.getState().doc.fps);
    expect(frames.size).toBe(1);
    runFrame(10_000);
    expect(store.getState()).toMatchObject({ playing: false, playhead: 120 });
    expect(frames.size).toBe(0);
  });

  it("continues from a frame sought during playback", () => {
    const store = makeStore();
    mountLoop(store);
    act(() => store.getState().play());
    runFrame(1000);
    act(() => store.getState().seek(60));
    runFrame(1500);
    expect(store.getState().playhead).toBe(75);
  });

  it("pauses when the tab is hidden", () => {
    const store = makeStore();
    mountLoop(store);
    act(() => store.getState().play());
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(store.getState().playing).toBe(false);
    expect(frames.size).toBe(0);
  });

  it("leaves no pending frame after unmount", () => {
    const store = makeStore();
    const { unmount } = mountLoop(store);
    act(() => store.getState().play());
    unmount();
    expect(frames.size).toBe(0);
  });
});

describe("the preview canvas", () => {
  function mountPreview(store: EditorStore) {
    const ctx = { setTransform: vi.fn() };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
    render(
      <EditorProvider store={store}>
        <Preview />
      </EditorProvider>,
    );
    vi.mocked(drawFrame).mockClear();
    return ctx;
  }

  it("draws once for a playhead change, with the shown document and frame, and not for a selection change", () => {
    const store = makeStore();
    const ctx = mountPreview(store);
    act(() => {
      store.getState().seek(10);
      store.getState().seek(12);
    });
    runFrame(16);
    expect(vi.mocked(drawFrame).mock.calls).toEqual([[ctx, viewDoc(store.getState()), 12, expect.anything()]]);
    act(() => store.getState().select(["x1"]));
    runFrame(32);
    expect(drawFrame).toHaveBeenCalledTimes(1);
  });

  it("draws a played frame in the same animation frame that moved the playhead", () => {
    const store = makeStore();
    mountPreview(store);
    act(() => store.getState().play());
    runFrame(1000);
    expect(vi.mocked(drawFrame).mock.calls.map((c) => c[2])).toEqual([30]);
    expect(frames.size).toBe(1); // only the loop's next frame, no second draw queued
  });
});
