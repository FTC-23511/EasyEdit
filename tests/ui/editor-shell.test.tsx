// @vitest-environment happy-dom
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorShell } from "@/components/editor/editor-shell";
import { createMediaServices, type MediaServices } from "@/components/editor/media/media-context";
import type { EditorInit } from "@/lib/editor/types";
import type { MediaApi } from "@/lib/media/api";
import { createLibraryStore, type RefreshReason } from "@/lib/media/library-store";
import type { UploadItem } from "@/lib/media/types";
import type { UploadQueue } from "@/lib/media/upload-queue";
import { sampleDoc } from "../editor/fixtures";
import { act, fireEvent, render, screen } from "../helpers/dom";

// The existing tests get the real services; a test of the media wiring hands the shell its own for one render.
vi.mock("@/components/editor/media/media-context", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/editor/media/media-context")>();
  return { ...real, createMediaServices: vi.fn(real.createMediaServices) };
});

const initial = (): EditorInit => ({ projectId: "p1", name: "Qual recap", doc: sampleDoc(), version: 5, me: { id: "u1", name: "Ada" }, canEdit: true });

// The projects API as the shell's fetch sees it. While `hold` is on, each post waits for release().
function stubServer() {
  const requests: string[] = [];
  const waiting: (() => void)[] = [];
  let version = 5;
  const server = {
    requests,
    hold: false,
    posts: () => requests.filter((r) => r.startsWith("POST")).length,
    versionChecks: () => requests.filter((r) => r.endsWith("/version")).length,
    release() {
      server.hold = false;
      waiting.splice(0).forEach((answer) => answer());
    },
  };
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url}`);
    if (method === "POST") {
      const answer = () => Response.json({ version: ++version, ops: [], inverse: [] });
      return server.hold ? new Promise<Response>((resolve) => waiting.push(() => resolve(answer()))) : answer();
    }
    if (url.endsWith("/version")) return Response.json({ version });
    return Response.json({ version, entries: [], hasMore: false });
  });
  return server;
}

const flush = () => act(() => vi.advanceTimersByTimeAsync(0));
const after = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const addTitle = (name = "Add title") => act(() => fireEvent.click(screen.getByRole("button", { name })));
const unloadListeners = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter(([type]) => type === "beforeunload").length;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("asks before the page unloads only while edits are unsent", async () => {
  const server = stubServer();
  const added = vi.spyOn(window, "addEventListener");
  const removed = vi.spyOn(window, "removeEventListener");
  render(<EditorShell initial={initial()} />);
  expect(unloadListeners(added)).toBe(0);

  server.hold = true;
  await addTitle();
  expect(unloadListeners(added)).toBe(1);
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);

  server.release();
  await flush();
  expect(server.posts()).toBe(1);
  expect(unloadListeners(removed)).toBe(1);
  const later = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(later);
  expect(later.defaultPrevented).toBe(false);
});

it("leaving the editor with edits still queued sends them all, then stops", async () => {
  const server = stubServer();
  const { unmount } = render(<EditorShell initial={initial()} />);
  server.hold = true;
  await addTitle();
  await addTitle("Add subtitle");
  expect(server.posts()).toBe(1); // the first is in flight, the second waits
  unmount(); // "Projects" or the Back button: a navigation inside the app
  server.release();
  await flush();
  expect(server.posts()).toBe(2);
  const sent = server.requests.length;
  await after(120_000);
  expect(server.requests).toHaveLength(sent); // and no more polling
});

it("under strict mode one sync runs", async () => {
  const server = stubServer();
  render(
    <StrictMode>
      <EditorShell initial={initial()} />
    </StrictMode>,
  );
  await addTitle();
  await flush();
  expect(server.posts()).toBe(1);
  await after(2000);
  expect(server.versionChecks()).toBe(1);
});

// Media services that write down what the shell asks of them: a real library store over routes that answer an
// empty library, with its refresh and ensure wrapped, a queue that records calls, and files that never arrive.
// A promise that has failed, and writes down whether anyone took its failure.
const handled: boolean[] = [];
function failed(): Promise<void> {
  const promise = Promise.reject(new Error("broke"));
  const at = handled.push(false) - 1;
  const then = promise.then.bind(promise);
  promise.then = ((onFulfilled, onRejected) => {
    if (onRejected) handled[at] = true;
    return then(onFulfilled, onRejected);
  }) as typeof promise.then;
  return promise;
}

function pretendMedia(options: { refreshFails?: boolean } = {}) {
  const fails = async (): Promise<never> => {
    throw new Error("not called in these tests");
  };
  const api: MediaApi = {
    list: vi.fn(async () => ({ ok: true as const, assets: [], setUp: true })),
    open: fails, offset: fails, complete: fails, openFile: fails, completeFile: fails, previewFailed: fails,
    update: fails, remove: fails, readToken: fails,
  };
  const library = createLibraryStore({ api });
  const { refresh: realRefresh, ensure: realEnsure } = library.getState();
  // The spies only write calls down. The promise goes back from a plain function: a spy would itself handle a rejection.
  const refresh = vi.fn<(reason: RefreshReason) => void>();
  const ensure = vi.fn<(ids: string[]) => void>();
  library.setState({
    refresh: (reason) => (refresh(reason), options.refreshFails ? failed() : realRefresh(reason)),
    ensure: (ids) => (ensure(ids), options.refreshFails ? failed() : realEnsure(ids)),
  });
  let active = 0;
  const queue = {
    add: vi.fn(), cancel: vi.fn(), retry: vi.fn(), resume: vi.fn(), dismiss: vi.fn(), stop: vi.fn(),
    items: () => [],
    active: vi.fn(() => active),
  } satisfies UploadQueue;
  const services: MediaServices = { library, queue, files: { get: () => new Promise(() => {}), put: async () => {} }, dispose: vi.fn() };
  vi.mocked(createMediaServices).mockReturnValueOnce(services);
  return { api, library, refresh, ensure, queue, services, setActive: (n: number) => void (active = n) };
}

const reasons = (refresh: { mock: { calls: [RefreshReason][] } }) => refresh.mock.calls.map(([reason]) => reason);
const uploading: UploadItem = {
  key: "k1", fileName: "climb.mov", sizeBytes: 20_000_000, stage: "uploading", sentBytes: 8_000_000, previewFraction: 0,
  assetId: "x1", message: null, canRetry: false,
};

it("loads the library when the editor opens, on focus and on the timer", async () => {
  stubServer();
  const media = pretendMedia();
  const { unmount } = render(<EditorShell initial={initial()} />);
  await flush();
  expect(reasons(media.refresh)).toEqual(["open"]);
  await act(() => void window.dispatchEvent(new Event("focus")));
  expect(reasons(media.refresh)).toEqual(["open", "focus"]);
  await after(30_000);
  expect(reasons(media.refresh)).toEqual(["open", "focus", "timer"]);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await after(30_000);
  expect(reasons(media.refresh)).toEqual(["open", "focus", "timer"]);
  visibility.mockReturnValue("visible");
  await after(30_000);
  expect(reasons(media.refresh)).toEqual(["open", "focus", "timer", "timer"]);
  unmount();
  window.dispatchEvent(new Event("focus"));
  window.dispatchEvent(new Event("online"));
  await after(60_000);
  expect(reasons(media.refresh)).toEqual(["open", "focus", "timer", "timer"]);
  expect(media.queue.resume).toHaveBeenCalledTimes(1); // the focus before unmount
  expect(media.ensure).toHaveBeenCalledTimes(1);
});

it("the Media tab uses the editor's own services", async () => {
  stubServer();
  const media = pretendMedia();
  render(<EditorShell initial={initial()} />);
  await flush();
  await act(() => void fireEvent.click(screen.getByRole("tab", { name: "Media" })));
  await flush();
  expect(reasons(media.refresh)).toEqual(["open", "tab"]);
});

it("takes up stopped uploads when the connection returns and on focus", async () => {
  stubServer();
  const media = pretendMedia();
  render(<EditorShell initial={initial()} />);
  await flush();
  expect(media.queue.resume).not.toHaveBeenCalled();
  await act(() => void window.dispatchEvent(new Event("online")));
  expect(media.queue.resume).toHaveBeenCalledTimes(1);
  await act(() => void window.dispatchEvent(new Event("focus")));
  expect(media.queue.resume).toHaveBeenCalledTimes(2);
});

it("asks the library for the assets the project names", async () => {
  stubServer();
  const media = pretendMedia();
  render(<EditorShell initial={initial()} />);
  await flush();
  expect(media.ensure.mock.calls).toEqual([[["a"]]]);
  await addTitle();
  expect(media.ensure.mock.calls.length).toBeGreaterThan(1);
  expect(media.ensure).toHaveBeenLastCalledWith(["a"]);
  const calls = media.ensure.mock.calls.length;
  await act(() => void media.library.getState().setQuery("x")); // not a change of the document
  await act(() => void fireEvent.keyDown(document.body, { key: "ArrowRight" })); // the playhead moves; the document does not
  await flush();
  expect(media.ensure).toHaveBeenCalledTimes(calls);
});

it("asks before the page unloads while an upload is running", async () => {
  stubServer();
  const media = pretendMedia();
  render(<EditorShell initial={initial()} />);
  await flush();
  media.setActive(1);
  await act(() => void media.library.getState().setUploads([uploading]));
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);

  media.setActive(0);
  await act(() => void media.library.getState().setUploads([]));
  const later = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(later);
  expect(later.defaultPrevented).toBe(false);
});

it("leaving the editor stops uploads and removes nothing", async () => {
  stubServer();
  const media = pretendMedia();
  const { unmount } = render(<EditorShell initial={initial()} />);
  await flush();
  expect(media.services.dispose).not.toHaveBeenCalled();
  unmount();
  expect(media.services.dispose).toHaveBeenCalledTimes(1);
  expect(media.queue.cancel).not.toHaveBeenCalled();
  // The shell listens to the library no longer: an upload list told now adds no guard to the page.
  media.setActive(1);
  media.library.getState().setUploads([uploading]);
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(false);
});

it("a file dropped outside the Media tab does nothing; on the tab it is uploaded", async () => {
  stubServer();
  const media = pretendMedia();
  render(<EditorShell initial={initial()} />);
  await flush();
  const timeline = screen.getByRole("region", { name: "Timeline" });
  const files = [new File(["x"], "a.mov", { lastModified: 1 })];
  const carryingFiles = { dataTransfer: { types: ["Files"], files } };
  // false: the default is prevented, so the browser does not open the file in place of the editor
  expect(fireEvent.dragOver(timeline, carryingFiles)).toBe(false);
  expect(fireEvent.drop(timeline, carryingFiles)).toBe(false);
  expect(media.queue.add).not.toHaveBeenCalled();
  // A drag of text or of something on the page is left to the browser.
  const carryingText = { dataTransfer: { types: ["text/plain"], files: [] } };
  expect(fireEvent.dragOver(timeline, carryingText)).toBe(true);
  expect(fireEvent.drop(timeline, carryingText)).toBe(true);

  await act(() => void fireEvent.click(screen.getByRole("tab", { name: "Media" })));
  await flush();
  expect(fireEvent.drop(screen.getByRole("tabpanel", { name: "Media" }), carryingFiles)).toBe(false);
  expect(media.queue.add).toHaveBeenCalledTimes(1);
  expect(media.queue.add).toHaveBeenCalledWith(files);
});

it("a refresh or ensure that fails leaves no rejection unhandled", async () => {
  stubServer();
  handled.length = 0;
  const media = pretendMedia({ refreshFails: true });
  const { unmount } = render(<EditorShell initial={initial()} />);
  await flush();
  await act(() => void window.dispatchEvent(new Event("focus")));
  await after(30_000);
  await addTitle();
  await after(10);
  unmount();
  expect(reasons(media.refresh)).toEqual(["open", "focus", "timer"]);
  expect(media.ensure.mock.calls.length).toBeGreaterThan(1);
  expect(handled.length).toBe(media.refresh.mock.calls.length + media.ensure.mock.calls.length);
  expect(handled.every(Boolean)).toBe(true);
});

it("the real services ask the media routes once on open, and nothing after the editor is left", async () => {
  const server = stubServer();
  const { unmount } = render(<EditorShell initial={initial()} />);
  await flush();
  const media = () => server.requests.filter((r) => r.includes("/api/media"));
  expect(media()).toEqual(["GET /api/media", "GET /api/media?ids=a"]);
  unmount();
  window.dispatchEvent(new Event("focus"));
  window.dispatchEvent(new Event("online"));
  await after(120_000);
  expect(media()).toEqual(["GET /api/media", "GET /api/media?ids=a"]);
});
