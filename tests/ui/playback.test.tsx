// @vitest-environment happy-dom
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorProvider } from "@/components/editor/context";
import { MediaProvider, type MediaServices } from "@/components/editor/media/media-context";
import { upcomingWants } from "@/components/editor/media/media-pool";
import { Preview } from "@/components/editor/preview";
import { usePlayback } from "@/components/editor/use-playback";
import { mediaWants } from "@/lib/editor/media-plan";
import { viewDoc, type EditorStore } from "@/lib/editor/store";
import { drawFrame } from "@/lib/render/compositor";
import { makeStore } from "../editor/fixtures";
import { act, render } from "../helpers/dom";
import { assetView, pretendMediaServices } from "../helpers/media-services";

vi.mock("@/lib/render/compositor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/render/compositor")>();
  return { ...actual, drawFrame: vi.fn() };
});

// A pool that plays nothing and writes down what it was asked to play.
const { sync, pool } = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const pool = {
    sync: vi.fn(),
    preload: vi.fn(),
    resolveSource: () => null,
    label: () => "",
    onChange: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    dispose: vi.fn(),
    listeners,
  };
  return { sync: pool.sync, pool };
});
vi.mock("@/components/editor/media/media-pool", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/editor/media/media-pool")>()),
  createMediaPool: () => pool,
}));

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
  for (const fn of [pool.sync, pool.preload, pool.onChange, pool.dispose]) fn.mockClear();
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
  function mountPreview(store: EditorStore, media?: MediaServices) {
    const ctx = { setTransform: vi.fn() };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
    const preview = <Preview />;
    const view = render(<EditorProvider store={store}>{media ? <MediaProvider services={media}>{preview}</MediaProvider> : preview}</EditorProvider>);
    vi.mocked(drawFrame).mockClear();
    pool.sync.mockClear();
    pool.preload.mockClear();
    return Object.assign(ctx, { unmount: view.unmount });
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

  it("a draw asked for just before a play waits for the loop's frame, so the frame is drawn once", () => {
    const store = makeStore();
    mountPreview(store);
    act(() => {
      store.getState().seek(10);
      store.getState().play();
    });
    runFrame(1000);
    expect(vi.mocked(drawFrame).mock.calls.map((c) => c[2])).toEqual([40]);
  });

  it("pausing settles the media at once, without waiting for an animation frame", () => {
    const store = makeStore();
    mountPreview(store);
    act(() => store.getState().play());
    runFrame(1000);
    sync.mockClear();
    act(() => store.getState().pause()); // a hidden tab runs no animation frame after this
    expect(sync).toHaveBeenCalledTimes(1);
    const doc = viewDoc(store.getState());
    expect(sync).toHaveBeenCalledWith(mediaWants(doc, 30, { playing: false, rate: 1 }), upcomingWants(doc, 30));
  });

  it("draws once when it appears, and asks for no second frame", () => {
    mountPreview(makeStore());
    expect(frames.size).toBe(0);
  });

  it("each draw makes the media match the frame, then draws from the pool", () => {
    const store = makeStore(); // v1 holds c1 (0 to 30) and c2 (30 to 60), both of asset a
    const ctx = mountPreview(store);
    act(() => store.getState().seek(10));
    runFrame(16);
    const doc = viewDoc(store.getState());
    expect(pool.preload.mock.calls).toEqual([[["a"]]]);
    expect(pool.sync.mock.calls).toEqual([[mediaWants(doc, 10, { playing: false, rate: 1 }), upcomingWants(doc, 10)]]);
    expect(upcomingWants(doc, 10).map((want) => want.clipId)).toEqual(["c2"]); // starts within the window: readied now
    expect(pool.preload.mock.invocationCallOrder[0]).toBeLessThan(pool.sync.mock.invocationCallOrder[0]);
    expect(pool.sync.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(drawFrame).mock.invocationCallOrder[0]);
    expect(vi.mocked(drawFrame).mock.calls).toEqual([[ctx, doc, 10, expect.objectContaining({ resolveSource: pool.resolveSource, placeholderLabel: pool.label })]]);
  });

  it("draws a play and a new rate, so the media starts and changes speed", () => {
    const store = makeStore();
    mountPreview(store);
    act(() => store.getState().play());
    runFrame(10); // too soon for the loop to move the playhead
    const doc = viewDoc(store.getState());
    expect(pool.sync.mock.calls).toEqual([[mediaWants(doc, 0, { playing: true, rate: 1 }), upcomingWants(doc, 0)]]);
    act(() => store.getState().shuttle("l"));
    runFrame(20);
    expect(pool.sync.mock.calls.at(-1)).toEqual([mediaWants(doc, 0, { playing: true, rate: 2 }), upcomingWants(doc, 0)]);
    expect(drawFrame).toHaveBeenCalledTimes(2);
  });

  it("draws again when the library learns something, or the pool has something new to show", () => {
    const store = makeStore();
    const media = pretendMediaServices([], { loaded: false });
    mountPreview(store, media);
    act(() => media.library.setState({ loaded: true }));
    runFrame(16);
    expect(drawFrame).toHaveBeenCalledTimes(1);
    act(() => media.library.getState().put(assetView()));
    runFrame(32);
    expect(drawFrame).toHaveBeenCalledTimes(2);
    act(() => media.library.getState().setQuery("intake"));
    runFrame(48);
    expect(drawFrame).toHaveBeenCalledTimes(2);
    act(() => {
      for (const listener of pool.listeners) listener();
    });
    runFrame(64);
    expect(drawFrame).toHaveBeenCalledTimes(3);
  });

  it("lets go of the media when it goes", () => {
    const store = makeStore();
    const media = pretendMediaServices([]);
    const subscribe = media.library.subscribe;
    const stops: ReturnType<typeof vi.fn>[] = [];
    media.library.subscribe = (listener) => {
      const stop = vi.fn(subscribe(listener));
      stops.push(stop);
      return stop;
    };
    const { unmount } = mountPreview(store, media);
    expect(pool.listeners.size).toBe(1);
    expect(stops.length).toBeGreaterThan(0);
    unmount();
    expect(pool.dispose).toHaveBeenCalledTimes(1);
    expect(pool.listeners.size).toBe(0);
    for (const stop of stops) expect(stop).toHaveBeenCalled();
  });
});
