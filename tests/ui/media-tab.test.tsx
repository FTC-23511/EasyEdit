// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorProvider } from "@/components/editor/context";
import { LeftPanel } from "@/components/editor/left-panel";
import { MediaProvider, useMedia, type MediaServices } from "@/components/editor/media/media-context";
import type { MediaApi, MediaFailure, MediaResult } from "@/lib/media/api";
import { createLibraryStore } from "@/lib/media/library-store";
import type { MediaFiles } from "@/lib/media/media-files";
import { MEDIA_MESSAGES, formatLength } from "@/lib/media/messages";
import { PLACEHOLDER_LABELS } from "@/lib/media/playback";
import type { AssetView, UploadItem } from "@/lib/media/types";
import type { UploadQueue } from "@/lib/media/upload-queue";
import { makeStore } from "../editor/fixtures";
import { act, fireEvent, render, renderHook, screen, within } from "../helpers/dom";

const asset = (over: Partial<AssetView>): AssetView => ({
  id: "x",
  kind: "video",
  name: "x",
  fileName: "x.mp4",
  sizeBytes: 1000,
  status: "ready",
  removed: false,
  durationMs: null,
  width: 1920,
  height: 1080,
  fps: 30,
  hasAudio: true,
  originalFileId: "orig-x",
  previewStatus: "ready",
  previewFileId: "prev-x",
  posterFileId: "post-x",
  event: null,
  uploadedBy: "u1",
  uploadedByName: "Ada Lovelace",
  createdAt: "2026-11-01T10:00:00.000Z",
  ...over,
});

const FIELD = asset({ id: "v1", name: "field", fileName: "field.mp4", durationMs: 12_500, posterFileId: "post-v1", createdAt: "2026-11-10T10:00:00.000Z" });
const PHOTO = asset({
  id: "i1", kind: "image", name: "IMG_4821", fileName: "IMG_4821.jpg", durationMs: null, fps: null, hasAudio: false,
  previewStatus: "none", previewFileId: null, posterFileId: "post-i1", event: "Qualifier 2026-11-08",
  uploadedBy: "u2", uploadedByName: "Grace Hopper", createdAt: "2026-11-09T10:00:00.000Z",
});

const notCalled = () => vi.fn(async (): Promise<never> => {
  throw new Error("not called in these tests");
});

// The media routes as the library store sees them. Each test may change what they answer.
function pretendApi(listed: AssetView[], setUp = true) {
  const answers = {
    listed,
    setUp,
    list: null as MediaFailure | null,
    update: null as MediaFailure | null,
    remove: null as MediaFailure | null,
  };
  const api = {
    list: vi.fn(async (ids?: string[]): Promise<MediaResult<{ assets: AssetView[]; setUp: boolean }>> =>
      answers.list ?? { ok: true, assets: answers.listed.filter((a) => !ids || ids.includes(a.id)), setUp: answers.setUp }),
    update: vi.fn(async (id: string, patch: { name?: string; event?: string | null }): Promise<MediaResult<{ asset: AssetView }>> =>
      answers.update ?? { ok: true, asset: { ...answers.listed.find((a) => a.id === id)!, ...patch } }),
    remove: vi.fn(async (): Promise<MediaResult<object>> => answers.remove ?? { ok: true }),
    open: notCalled(),
    offset: notCalled(),
    complete: notCalled(),
    openFile: notCalled(),
    completeFile: notCalled(),
    previewFailed: notCalled(),
    readToken: notCalled(),
  } satisfies MediaApi;
  return { api, answers };
}

function pretendQueue() {
  return {
    add: vi.fn<(files: File[]) => void>(),
    cancel: vi.fn<(key: string) => void>(),
    retry: vi.fn<(key: string) => void>(),
    resume: vi.fn<() => void>(),
    dismiss: vi.fn<(key: string) => void>(),
    stop: vi.fn<() => void>(),
    items: () => [],
    active: () => 0,
  } satisfies UploadQueue;
}

const never = <T,>() => new Promise<T>(() => {});

function setup(options: { canEdit?: boolean; listed?: AssetView[]; setUp?: boolean; files?: MediaFiles } = {}) {
  const { api, answers } = pretendApi(options.listed ?? [FIELD, PHOTO], options.setUp);
  const library = createLibraryStore({ api });
  const queue = pretendQueue();
  const files: MediaFiles = options.files ?? { get: vi.fn<MediaFiles["get"]>(() => never()), put: vi.fn(async () => {}) };
  const services: MediaServices = { library, queue, files, dispose: vi.fn() };
  const store = makeStore({ canEdit: options.canEdit ?? true });
  const view = render(
    <EditorProvider store={store}>
      <MediaProvider services={services}>
        <LeftPanel />
      </MediaProvider>
    </EditorProvider>,
  );
  return { api, answers, library, queue, files, store, view };
}

const flush = () => act(async () => {});

async function openMedia() {
  fireEvent.click(screen.getByRole("tab", { name: "Media" }));
  await flush();
}

const row = (name: string) => screen.getByRole("button", { name: `Add ${name} to the timeline` }) as HTMLButtonElement;
const rowNames = () => screen.queryAllByRole("button", { name: /^Add .* to the timeline$/ }).map((b) => b.getAttribute("aria-label"));
const fileInput = (container: HTMLElement) => container.querySelector<HTMLInputElement>('input[type="file"]')!;
const filesOf = (...names: string[]) => names.map((name) => new File(["x"], name, { lastModified: 1 }));

const upload = (over: Partial<UploadItem>): UploadItem => ({
  key: "k1", fileName: "climb.mov", sizeBytes: 20_000_000, stage: "waiting", sentBytes: 0, previewFraction: 0,
  assetId: null, message: null, canRetry: false, ...over,
});

async function choose(menuFor: string, item: string) {
  fireEvent.click(screen.getByRole("button", { name: `More for ${menuFor}` }));
  fireEvent.click(screen.getByRole("menuitem", { name: item }));
  await flush();
  return screen.getByRole("dialog");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the list", () => {
  it("shows the library, newest first, with length and uploader", async () => {
    const { api } = setup();
    await openMedia();
    expect(rowNames()).toEqual(["Add field to the timeline", "Add IMG_4821 to the timeline"]);
    expect(row("field").textContent).toContain("0:12");
    expect(row("field").textContent).toContain("Ada");
    expect(row("field").textContent).not.toContain("Lovelace");
    expect(row("IMG_4821").textContent).toContain("Image");
    expect(row("IMG_4821").textContent).toContain("Grace");
    expect(api.list).toHaveBeenCalledTimes(1); // refresh("tab"): always fetches
    expect(api.list).toHaveBeenCalledWith();
  });

  it("asks for the library each time the tab is opened", async () => {
    const { api } = setup();
    await openMedia();
    fireEvent.click(screen.getByRole("tab", { name: "Text" }));
    await openMedia();
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it("names a former member in full, and says which videos have no preview yet", async () => {
    const PENDING = asset({ id: "v2", name: "pit", previewStatus: "pending", previewFileId: null, createdAt: "2026-11-08T10:00:00.000Z" });
    const NONE = asset({ id: "v3", name: "drive", previewStatus: "failed", previewFileId: null, sizeBytes: 900 * 1024 * 1024, createdAt: "2026-11-07T10:00:00.000Z" });
    const SMALL = asset({ id: "v4", name: "short", previewStatus: "failed", previewFileId: null, createdAt: "2026-11-06T10:00:00.000Z" });
    const GONE = asset({ id: "a1", kind: "audio", name: "theme", durationMs: 95_000, uploadedByName: MEDIA_MESSAGES.formerMember, posterFileId: null, previewStatus: "none", createdAt: "2026-11-05T10:00:00.000Z" });
    setup({ listed: [PENDING, NONE, SMALL, GONE] });
    await openMedia();
    expect(row("pit").textContent).toContain(PLACEHOLDER_LABELS.preparing);
    expect(row("drive").textContent).toContain(PLACEHOLDER_LABELS["no-preview"]);
    expect(row("short").textContent).not.toContain(PLACEHOLDER_LABELS["no-preview"]); // its original plays
    expect(row("theme").textContent).toContain("1:35");
    expect(row("theme").textContent).toContain(MEDIA_MESSAGES.formerMember);
  });

  it("rows that are off screen do not ask for their picture", async () => {
    const watched: Element[] = [];
    let report: IntersectionObserverCallback = () => {};
    const roots: (Element | Document | null | undefined)[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback, init?: IntersectionObserverInit) {
          report = callback;
          roots.push(init?.root);
        }
        observe(element: Element) {
          watched.push(element);
        }
        unobserve() {}
        disconnect() {}
      },
    );
    const many = Array.from({ length: 40 }, (_, i) =>
      asset({ id: `i${i}`, kind: "image", name: `photo ${i}`, posterFileId: `post-${i}`, previewStatus: "none", durationMs: null, createdAt: `2026-11-01T10:00:${String(59 - i).padStart(2, "0")}.000Z` }),
    );
    const get = vi.fn<MediaFiles["get"]>(() => never());
    setup({ listed: many, files: { get, put: async () => {} } });
    await openMedia();
    expect(get).not.toHaveBeenCalled();
    expect(roots).toHaveLength(1); // one observer for the tab
    const root = roots[0] as HTMLElement; // the tab's scrolling panel, which holds the rows
    expect(screen.getByRole("tabpanel").contains(root)).toBe(true);
    expect(root.contains(row("photo 0"))).toBe(true);
    expect(watched).toHaveLength(40);

    const seen = (elements: Element[]) =>
      act(() => report(elements.map((target) => ({ target, isIntersecting: true }) as unknown as IntersectionObserverEntry), {} as IntersectionObserver));
    await seen(watched.slice(0, 10));
    expect(get.mock.calls.map(([id]) => id)).toEqual(many.slice(0, 10).map((a) => a.posterFileId));
    await seen(watched.slice(0, 10));
    expect(get).toHaveBeenCalledTimes(10);
    // Scrolled away and back: the rows asked once, and keep what they asked for.
    await act(() => report(watched.slice(0, 10).map((target) => ({ target, isIntersecting: false }) as unknown as IntersectionObserverEntry), {} as IntersectionObserver));
    await seen(watched.slice(0, 10));
    expect(get).toHaveBeenCalledTimes(10);

    // The tab opened again over a library it already has: its new observer watches the rows that were there first.
    fireEvent.click(screen.getByRole("tab", { name: "Text" }));
    await openMedia();
    expect(roots).toHaveLength(2);
    expect(watched).toHaveLength(80);
    expect(watched.slice(40).every((element) => element.isConnected)).toBe(true);
  });

  it("shows a still picture once it is read, and lets it go when the row goes", async () => {
    vi.stubGlobal("IntersectionObserver", undefined); // a browser without one: every row counts as in view
    const made = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:poster-v1");
    const revoked = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const get = vi.fn(async (fileId: string) => (fileId === "post-v1" ? { ok: true as const, blob: new Blob(["jpeg"]) } : never<never>()));
    const { answers, store } = setup({ files: { get, put: async () => {} } });
    await openMedia();
    expect(row("field").querySelector("img")?.getAttribute("src")).toBe("blob:poster-v1");
    expect(made).toHaveBeenCalledTimes(1);
    expect(revoked).not.toHaveBeenCalled();
    answers.listed = [PHOTO];
    await act(async () => store.getState().notify("error", "That change couldn't be made."));
    await flush();
    expect(revoked).toHaveBeenCalledWith("blob:poster-v1");
  });

  it("filters by kind and by search", async () => {
    setup();
    await openMedia();
    fireEvent.click(screen.getByRole("radio", { name: "Video" }));
    expect(rowNames()).toEqual(["Add field to the timeline"]);
    fireEvent.click(screen.getByRole("radio", { name: "All" }));
    fireEvent.change(screen.getByLabelText("Search media"), { target: { value: "qualifier" } });
    expect(rowNames()).toEqual(["Add IMG_4821 to the timeline"]);
    fireEvent.change(screen.getByLabelText("Search media"), { target: { value: "zzz" } });
    expect(rowNames()).toEqual([]);
    expect(screen.getByText(MEDIA_MESSAGES.noMatch)).toBeTruthy();
    expect(MEDIA_MESSAGES.noMatch).toBe("Nothing matches.");
  });

  it("says what there is before and when there is nothing", async () => {
    const { answers } = setup({ listed: [] });
    expect(MEDIA_MESSAGES.loading).toBe("Loading media");
    answers.list = null;
    fireEvent.click(screen.getByRole("tab", { name: "Media" }));
    expect(screen.getByText("Loading media")).toBeTruthy();
    await flush();
    expect(screen.getByText("No media yet. Upload video, images or audio to use them in projects.")).toBeTruthy();
    expect(MEDIA_MESSAGES.emptyEditor).toBe("No media yet. Upload video, images or audio to use them in projects.");
  });

  it("tells a viewer only that there is no media", async () => {
    setup({ canEdit: false, listed: [] });
    await openMedia();
    expect(screen.getByText("No media yet.")).toBeTruthy();
    expect(MEDIA_MESSAGES.emptyViewer).toBe("No media yet.");
  });

  it("says when the library could not be loaded, and tries again", async () => {
    const { api, answers } = setup();
    answers.list = { ok: false, kind: "network", message: "" };
    await openMedia();
    expect(screen.getByText("Couldn't load the library.")).toBeTruthy();
    expect(MEDIA_MESSAGES.loadFailed).toBe("Couldn't load the library.");
    expect(screen.queryByText("Loading media")).toBeNull();
    expect(rowNames()).toEqual([]);
    answers.list = null;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await flush();
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Couldn't load the library.")).toBeNull();
    expect(rowNames()).toHaveLength(2);
  });

  it("says when the member is signed out", async () => {
    const { answers } = setup();
    answers.list = { ok: false, kind: "signed-out", message: "Sign in again." };
    await openMedia();
    expect(screen.getByText("You're signed out. Sign in again to see media.")).toBeTruthy();
    expect(MEDIA_MESSAGES.signedOutLibrary).toBe("You're signed out. Sign in again to see media.");
    expect(screen.queryByText("Couldn't load the library.")).toBeNull();
  });

  it("an error notice refreshes the library, and a removed asset's row goes", async () => {
    const { api, answers, store } = setup();
    await openMedia();
    expect(api.list).toHaveBeenCalledTimes(1);
    answers.listed = [PHOTO];
    await act(async () => store.getState().notify("error", "That change couldn't be made."));
    await flush();
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Add field to the timeline" })).toBeNull();
    await act(async () => store.getState().seek(10)); // the error notice still stands; nothing new
    await flush();
    expect(api.list).toHaveBeenCalledTimes(2);
    await act(async () => store.getState().notify("info", "Nothing to paste."));
    await flush();
    expect(api.list).toHaveBeenCalledTimes(2);
    await act(async () => store.getState().notify("error", "That change couldn't be made."));
    await flush();
    expect(api.list).toHaveBeenCalledTimes(3); // the same text, a new notice
  });

  it("an error notice while another tab is open asks for nothing", async () => {
    const { api, store } = setup();
    await openMedia();
    fireEvent.click(screen.getByRole("tab", { name: "Text" }));
    await act(async () => store.getState().notify("error", "That change couldn't be made."));
    await flush();
    expect(api.list).toHaveBeenCalledTimes(1);
  });
});

describe("uploading", () => {
  it("choosing files hands them to the queue", async () => {
    const { queue, view } = setup();
    await openMedia();
    const input = fileInput(view.container);
    expect(input.multiple).toBe(true);
    expect(input.accept).toBe(".mp4,.m4v,.mov,.webm,.jpg,.jpeg,.png,.webp,.mp3,.m4a,.wav,.aac");
    const chosen = filesOf("a.mov", "b.jpg");
    fireEvent.change(input, { target: { files: chosen } });
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(chosen);
  });

  it("the Upload button opens the file picker", async () => {
    const { view } = setup();
    await openMedia();
    const picked = vi.spyOn(fileInput(view.container), "click");
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    expect(picked).toHaveBeenCalledTimes(1);
  });

  it("dropping files hands them to the queue", async () => {
    const { queue } = setup();
    await openMedia();
    const panel = screen.getByRole("tabpanel");
    const dropped = filesOf("a.mov", "b.jpg");
    const dataTransfer = { types: ["Files"], files: dropped, dropEffect: "none" };
    expect(screen.queryByText("Drop to upload")).toBeNull();
    expect(fireEvent.dragOver(panel, { dataTransfer })).toBe(false); // prevented: the file does not open in the window
    expect(screen.getByText("Drop to upload")).toBeTruthy();
    fireEvent.drop(panel, { dataTransfer });
    expect(queue.add).toHaveBeenCalledWith(dropped);
    expect(screen.queryByText("Drop to upload")).toBeNull();
  });

  it("dragging something that is not a file does nothing", async () => {
    const { queue } = setup();
    await openMedia();
    const panel = screen.getByRole("tabpanel");
    const dataTransfer = { types: ["text/plain"], files: [] };
    expect(fireEvent.dragOver(panel, { dataTransfer })).toBe(true);
    expect(screen.queryByText("Drop to upload")).toBeNull();
    expect(fireEvent.drop(panel, { dataTransfer })).toBe(true);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("the event field is the library's event for new uploads", async () => {
    const { library } = setup();
    await openMedia();
    const field = screen.getByLabelText("Event for new uploads") as HTMLInputElement;
    expect(field.placeholder).toBe("Qualifier 2026-11-08");
    fireEvent.change(field, { target: { value: "Scrimmage" } });
    expect(library.getState().uploadEvent).toBe("Scrimmage");
  });

  it("shows each upload with its stage and progress", async () => {
    const { library } = setup();
    await openMedia();
    const show = (item: Partial<UploadItem>) => act(() => library.getState().setUploads([upload(item)]));
    const bar = () => screen.getByRole("progressbar").getAttribute("aria-valuenow");

    await show({ stage: "uploading", sentBytes: 8_400_000 });
    expect(screen.getByText("climb.mov")).toBeTruthy();
    expect(screen.getByText("Uploading 42%")).toBeTruthy();
    expect(bar()).toBe("42");
    await show({ stage: "preview", sentBytes: 20_000_000, previewFraction: 0.3 });
    expect(screen.getByText("Making preview 30%")).toBeTruthy();
    expect(bar()).toBe("30");
    await show({ stage: "uploading", sentBytes: 19_990_000 });
    expect(screen.getByText("Uploading 99%")).toBeTruthy(); // never 100 before it is done
    await show({ stage: "preview", sentBytes: 20_000_000, previewFraction: 0.29 });
    expect(screen.getByText("Making preview 29%")).toBeTruthy();
    await show({ stage: "waiting" });
    expect(screen.getByText("Waiting")).toBeTruthy();
    await show({ stage: "reading" });
    expect(screen.getByText("Reading file")).toBeTruthy();
    await show({ stage: "finishing", sentBytes: 20_000_000 });
    expect(screen.getByText("Finishing")).toBeTruthy();
  });

  it("cancel, retry and dismiss go to the queue", async () => {
    const { library, queue } = setup();
    await openMedia();
    await act(() =>
      library.getState().setUploads([
        upload({ key: "k1", stage: "uploading", sentBytes: 1 }),
        upload({ key: "k2", fileName: "pit.mov", stage: "failed", message: MEDIA_MESSAGES.uploadStopped, canRetry: true }),
        upload({ key: "k3", fileName: "big.mov", stage: "failed", message: "You have 20 unfinished uploads. Finish or cancel one first.", canRetry: false }),
      ]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel upload of climb.mov" }));
    expect(queue.cancel).toHaveBeenCalledWith("k1");

    const failed = screen.getByText(MEDIA_MESSAGES.uploadStopped).closest("li")!;
    fireEvent.click(within(failed).getByRole("button", { name: "Retry" }));
    expect(queue.retry).toHaveBeenCalledWith("k2");
    fireEvent.click(within(failed).getByRole("button", { name: "Dismiss" }));
    expect(queue.dismiss).toHaveBeenCalledWith("k2");
    fireEvent.click(within(failed).getByRole("button", { name: "Cancel upload of pit.mov" }));
    expect(queue.cancel).toHaveBeenCalledWith("k2");

    const final = screen.getByText("You have 20 unfinished uploads. Finish or cancel one first.").closest("li")!;
    expect(within(final).queryByRole("button", { name: "Retry" })).toBeNull();
    fireEvent.click(within(final).getByRole("button", { name: "Dismiss" }));
    expect(queue.dismiss).toHaveBeenCalledWith("k3");
    expect(queue.retry).toHaveBeenCalledTimes(1);
  });

  it("leaves out a finished upload with nothing to say, and lets one with a message be dismissed", async () => {
    const { library, queue } = setup();
    await openMedia();
    await act(() =>
      library.getState().setUploads([
        upload({ key: "k1", fileName: "quiet.mov", stage: "done", sentBytes: 20_000_000 }),
        upload({ key: "k2", fileName: "loud.mov", stage: "done", message: MEDIA_MESSAGES.noPreview }),
      ]),
    );
    expect(screen.queryByText("quiet.mov")).toBeNull();
    const done = screen.getByText(MEDIA_MESSAGES.noPreview).closest("li")!;
    expect(within(done).getByText("loud.mov")).toBeTruthy();
    expect(within(done).queryByRole("progressbar")).toBeNull();
    expect(within(done).queryByRole("button", { name: /^Cancel/ })).toBeNull();
    fireEvent.click(within(done).getByRole("button", { name: "Dismiss" }));
    expect(queue.dismiss).toHaveBeenCalledWith("k2");
    expect(queue.dismiss).toHaveBeenCalledTimes(1);
  });
});

describe("who may change what", () => {
  it("a viewer can look and search, and cannot change anything", async () => {
    const { queue, view, library } = setup({ canEdit: false });
    await openMedia();
    // A member made a viewer while uploading still sees the rows, and cannot cancel or retry them.
    await act(() => library.getState().setUploads([upload({ stage: "failed", message: MEDIA_MESSAGES.uploadStopped, canRetry: true })]));
    expect((screen.getByRole("button", { name: "Cancel upload of climb.mov" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Upload" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Event for new uploads") as HTMLInputElement).disabled).toBe(true);
    expect(row("field").disabled).toBe(true);
    expect(row("IMG_4821").disabled).toBe(true);
    for (const name of ["field", "IMG_4821"]) expect((screen.getByRole("button", { name: `More for ${name}` }) as HTMLButtonElement).disabled).toBe(true);
    expect(fileInput(view.container).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Search media"), { target: { value: "img" } });
    expect(rowNames()).toEqual(["Add IMG_4821 to the timeline"]);

    const panel = screen.getByRole("tabpanel");
    const dataTransfer = { types: ["Files"], files: filesOf("a.mov") };
    expect(fireEvent.dragOver(panel, { dataTransfer })).toBe(false); // the file still does not open in the window
    expect(screen.queryByText("Drop to upload")).toBeNull();
    expect(fireEvent.drop(panel, { dataTransfer })).toBe(false);
    fireEvent.change(fileInput(view.container), { target: { files: filesOf("b.mov") } });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("says when uploads are not set up", async () => {
    const { queue, view } = setup({ setUp: false });
    await openMedia();
    expect(screen.getByText('Uploads are not set up yet. See "Set up media storage" in the README.')).toBeTruthy();
    expect(MEDIA_MESSAGES.notSetUp).toBe('Uploads are not set up yet. See "Set up media storage" in the README.');
    expect((screen.getByRole("button", { name: "Upload" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Event for new uploads") as HTMLInputElement).disabled).toBe(true);
    expect(rowNames()).toEqual(["Add field to the timeline", "Add IMG_4821 to the timeline"]);
    expect(row("field").disabled).toBe(false);
    fireEvent.drop(screen.getByRole("tabpanel"), { dataTransfer: { types: ["Files"], files: filesOf("a.mov") } });
    expect(queue.add).not.toHaveBeenCalled();
    expect(fileInput(view.container).disabled).toBe(true);
  });

  it("every control that changes something is marked", async () => {
    const { library } = setup();
    await openMedia();
    await act(() => library.getState().setUploads([upload({ stage: "failed", message: MEDIA_MESSAGES.uploadStopped, canRetry: true })]));
    const marked = (element: Element) => element.hasAttribute("data-edit-control");
    expect(marked(screen.getByRole("button", { name: "Upload" }))).toBe(true);
    expect(marked(screen.getByLabelText("Event for new uploads"))).toBe(true);
    for (const name of ["field", "IMG_4821"]) {
      expect(marked(row(name))).toBe(true);
      expect(marked(screen.getByRole("button", { name: `More for ${name}` }))).toBe(true);
    }
    expect(marked(screen.getByRole("button", { name: "Cancel upload of climb.mov" }))).toBe(true);
    expect(marked(screen.getByRole("button", { name: "Retry" }))).toBe(true);
    expect(marked(screen.getByLabelText("Search media"))).toBe(false);
  });

  it("clicking a row adds the asset to the timeline", async () => {
    const { store } = setup();
    await openMedia();
    act(() => store.getState().seek(200));
    const clipsBefore = store.getState().doc.tracks.flatMap((t) => t.clips.map((c) => c.id));
    fireEvent.click(row("IMG_4821"));
    const added = store.getState().doc.tracks.flatMap((t) => t.clips).filter((c) => !clipsBefore.includes(c.id));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ type: "image", assetId: "i1", start: 200 });
    expect(store.getState().selection.clipIds).toEqual([added[0].id]);
    expect(store.getState().queue).toMatchObject([{ label: "add media" }]);
  });
});

describe("changing an asset", () => {
  it("renames an asset", async () => {
    const { api } = setup();
    await openMedia();
    const dialog = await choose("field", "Rename");
    expect(within(dialog).getByRole("heading", { name: "Rename" })).toBeTruthy();
    const name = within(dialog).getByLabelText("Name") as HTMLInputElement;
    expect(name.value).toBe("field");
    fireEvent.change(name, { target: { value: "Climb, take 2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await flush();
    expect(api.update).toHaveBeenCalledWith("v1", { name: "Climb, take 2" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(row("Climb, take 2")).toBeTruthy();
  });

  it("a rename the server refuses shows its sentence under the field", async () => {
    const { answers } = setup();
    await openMedia();
    answers.update = { ok: false, kind: "refused", message: MEDIA_MESSAGES.badName };
    const dialog = await choose("field", "Rename");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await flush();
    expect(within(screen.getByRole("dialog")).getByText(MEDIA_MESSAGES.badName)).toBeTruthy();
    expect(row("field")).toBeTruthy();
  });

  it("a rename with no answer says to check the connection", async () => {
    const { answers } = setup();
    await openMedia();
    answers.update = { ok: false, kind: "network", message: "" };
    const dialog = await choose("field", "Rename");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await flush();
    expect(within(screen.getByRole("dialog")).getByText("Couldn't reach EasyEdit. Check your connection, then try again.")).toBeTruthy();
    expect(MEDIA_MESSAGES.noAnswer).toBe("Couldn't reach EasyEdit. Check your connection, then try again.");
  });

  it("a rename refused with no sentence says to try again", async () => {
    const { answers } = setup();
    await openMedia();
    answers.update = { ok: false, kind: "refused", message: "" };
    const dialog = await choose("field", "Rename");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await flush();
    expect(within(screen.getByRole("dialog")).getByText("That didn't go through. Try again.")).toBeTruthy();
    expect(MEDIA_MESSAGES.tryAgain).toBe("That didn't go through. Try again.");
  });

  it("cancel closes a dialog and changes nothing", async () => {
    const { api } = setup();
    await openMedia();
    const dialog = await choose("field", "Rename");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.update).not.toHaveBeenCalled();
  });

  it("sets an event, and saving it empty clears it", async () => {
    const { api } = setup();
    await openMedia();
    let dialog = await choose("field", "Set event");
    expect(within(dialog).getByRole("heading", { name: "Set event" })).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Event"), { target: { value: "Qualifier 2026-11-08" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await flush();
    expect(api.update).toHaveBeenLastCalledWith("v1", { event: "Qualifier 2026-11-08" });
    expect(screen.queryByRole("dialog")).toBeNull();

    dialog = await choose("IMG_4821", "Set event");
    const field = within(dialog).getByLabelText("Event") as HTMLInputElement;
    expect(field.value).toBe("Qualifier 2026-11-08");
    fireEvent.change(field, { target: { value: "  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await flush();
    expect(api.update).toHaveBeenLastCalledWith("i1", { event: null });
  });

  it("removal that is refused shows why", async () => {
    const { api, answers } = setup();
    await openMedia();
    const refusal = 'Used in 1 project: "Recap". Remove it from that project first.';
    answers.remove = { ok: false, kind: "refused", message: refusal };
    const dialog = await choose("field", "Remove");
    expect(within(dialog).getByRole("heading", { name: 'Remove "field"?' })).toBeTruthy();
    expect(within(dialog).getByText("The file moves to the Drive trash for 30 days.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await flush();
    const after = screen.getByRole("dialog");
    expect(within(after).getByText(refusal)).toBeTruthy();
    expect(within(after).queryByText("The file moves to the Drive trash for 30 days.")).toBeNull();
    expect(within(after).queryByRole("button", { name: "Remove" })).toBeNull();
    expect(within(after).queryByRole("button", { name: "Cancel" })).toBeNull();
    const closers = within(after).getAllByRole("button", { name: "Close" });
    fireEvent.click(closers[closers.length - 1]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(row("field")).toBeTruthy();
    expect(api.remove).toHaveBeenCalledTimes(1);
  });

  it("removal that succeeds takes the row away", async () => {
    const { api } = setup();
    await openMedia();
    const dialog = await choose("field", "Remove");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await flush();
    expect(api.remove).toHaveBeenCalledTimes(1);
    expect(api.remove).toHaveBeenCalledWith("v1");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add field to the timeline" })).toBeNull();
  });
});

it("formats lengths", () => {
  expect(formatLength(12_500)).toBe("0:12");
  expect(formatLength(95_000)).toBe("1:35");
  expect(formatLength(3_723_000)).toBe("1:02:03");
  expect(formatLength(0)).toBe("0:00");
  expect(formatLength(59_999)).toBe("0:59");
  expect(formatLength(3_600_000)).toBe("1:00:00");
});

it("without a provider the services do nothing: no library, no uploads, no files", async () => {
  const { result } = renderHook(() => useMedia());
  const { library, queue, files } = result.current;
  void library.getState().refresh("tab");
  await flush();
  expect(library.getState().loaded).toBe(false);
  expect(queue.active()).toBe(0);
  expect(queue.items()).toEqual([]);
  expect(await files.get("f1")).toEqual({ ok: false, problem: "offline" });
  expect(() => result.current.dispose()).not.toThrow();
});
