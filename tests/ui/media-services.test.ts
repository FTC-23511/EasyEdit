import { afterEach, expect, it, vi } from "vitest";
import { createMediaServices } from "@/components/editor/media/media-context";
import { createIngest, type Ingest } from "@/lib/media/ingest-protocol";
import { createUploadQueue, type QueueDeps, type UploadQueue } from "@/lib/media/upload-queue";
import type { AssetView, UploadItem } from "@/lib/media/types";

// The queue and the worker are stood in for, so that what createMediaServices hands them can be looked at.
const order: string[] = [];
vi.mock("@/lib/media/upload-queue", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/media/upload-queue")>();
  return {
    ...real,
    createUploadQueue: vi.fn((): UploadQueue => ({
      add() {}, cancel() {}, retry() {}, resume() {}, dismiss() {}, items: () => [], active: () => 0,
      stop: () => void order.push("queue.stop"),
    })),
  };
});
vi.mock("@/lib/media/ingest-protocol", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/media/ingest-protocol")>();
  return {
    ...real,
    createIngest: vi.fn((): Ingest => ({
      probe: async () => null,
      derive: async () => ({ preview: null, poster: null, previewProblem: null }),
      dispose: () => void order.push("ingest.dispose"),
    })),
  };
});

const queueDeps = (): QueueDeps => vi.mocked(createUploadQueue).mock.lastCall![0];

afterEach(() => {
  order.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ASSET = { id: "v1", name: "field", status: "ready", removed: false } as AssetView;
const ITEM = { key: "k1", fileName: "field.mp4", stage: "uploading" } as UploadItem;

it("the queue tells the library and the local files what it learns, and takes the library's event", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "X", message: "No network in this test." }, { status: 400 })));
  const services = createMediaServices();
  const deps = queueDeps();
  deps.onChange([ITEM]);
  expect(services.library.getState().uploads).toEqual([ITEM]);
  deps.onAsset(ASSET);
  expect(services.library.getState().assets.v1).toEqual(ASSET);
  services.library.getState().setUploadEvent("Qualifier 2026-11-08");
  expect(deps.event()).toBe("Qualifier 2026-11-08");
  const poster = new Blob(["jpeg"]);
  deps.onPreviewFile("post-v1", poster);
  const got = await services.files.get("post-v1"); // from this browser, with no request to Drive
  expect(got.ok && (await got.blob.text())).toBe("jpeg");
  expect(fetch).not.toHaveBeenCalled();
});

it("waits between tries with a sleep that resolves", async () => {
  vi.useFakeTimers();
  createMediaServices();
  let slept = false;
  void queueDeps().sleep(1000).then(() => (slept = true));
  await vi.advanceTimersByTimeAsync(999);
  expect(slept).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(slept).toBe(true);
});

it("dispose stops the uploads first, then ends the worker", () => {
  const services = createMediaServices();
  services.dispose();
  expect(order).toEqual(["queue.stop", "ingest.dispose"]);
});

it("starts the ingest worker from its module file", () => {
  const started: { url: URL; options: WorkerOptions }[] = [];
  vi.stubGlobal(
    "Worker",
    class {
      constructor(url: URL, options: WorkerOptions) {
        started.push({ url, options });
      }
    },
  );
  createMediaServices();
  const startWorker = vi.mocked(createIngest).mock.lastCall![0];
  startWorker();
  expect(started).toHaveLength(1);
  expect(started[0].url.href).toMatch(/\/src\/workers\/ingest\.worker\.ts$/);
  expect(started[0].options).toEqual({ type: "module" });
});
