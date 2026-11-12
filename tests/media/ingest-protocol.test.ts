import { describe, expect, it, vi } from "vitest";
import { createIngest, type IngestEvent, type IngestRequest, type WorkerLike } from "@/lib/media/ingest-protocol";
import type { AssetProbe } from "@/lib/media/types";

const VIDEO: AssetProbe = { kind: "video", durationMs: 12_500, width: 1080, height: 1920, fps: 30, hasAudio: true, videoCodec: "hevc" };
const IMAGE: AssetProbe = { kind: "image", durationMs: null, width: 4032, height: 3024, fps: null, hasAudio: false, videoCodec: null };

// A worker that only writes down what it is sent; the test delivers its answers.
function pretendWorker() {
  const posted: IngestRequest[] = [];
  const listeners: ((event: { data: IngestEvent }) => void)[] = [];
  let terminated = false;
  const worker: WorkerLike = {
    postMessage: (message) => void posted.push(message),
    addEventListener: (_type, listener) => void listeners.push(listener),
    terminate: () => void (terminated = true),
  };
  const deliver = (event: IngestEvent) => listeners.forEach((listener) => listener({ data: event }));
  return { worker, posted, deliver, terminated: () => terminated };
}

// One ingest on pretend workers: `workers` holds each one started, in order; ids are r1, r2, …
function setup() {
  const workers: ReturnType<typeof pretendWorker>[] = [];
  const start = vi.fn(() => {
    const pretend = pretendWorker();
    workers.push(pretend);
    return pretend.worker;
  });
  let n = 0;
  const ingest = createIngest(start, () => `r${++n}`);
  return { ingest, start, workers };
}

const file = (text: string) => new Blob([text]);
// The promise's outcome so far, without waiting for it to settle: "pending" until it does.
// It looks after a full turn of the event loop, so a promise that has already settled is seen as settled.
async function outcome(promise: Promise<unknown>): Promise<unknown> {
  let seen: unknown = "pending";
  promise.then((value) => (seen = { value }), (error: unknown) => (seen = { error }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return seen;
}

describe("talking to the ingest worker", () => {
  it("starts the worker only when first used", async () => {
    const { ingest, start, workers } = setup();
    expect(start).toHaveBeenCalledTimes(0);

    const first = ingest.probe(file("a"), "a.mp4");
    expect(start).toHaveBeenCalledTimes(1);
    const second = ingest.probe(file("b"), "b.jpg");
    const derived = ingest.derive(file("a"), VIDEO, () => {}, new AbortController().signal);
    expect(start).toHaveBeenCalledTimes(1);
    expect(workers[0].posted.map((m) => m.type)).toEqual(["probe", "probe", "derive"]);

    workers[0].deliver({ type: "probed", id: "r1", probe: VIDEO });
    workers[0].deliver({ type: "probed", id: "r2", probe: IMAGE });
    workers[0].deliver({ type: "derived", id: "r3", preview: null, poster: null, previewProblem: null });
    await Promise.all([first, second, derived]);
  });

  it("sends the file and what is known about it with each request", () => {
    const { ingest, workers } = setup();
    const a = file("a");
    void ingest.probe(a, "IMG_4821.MOV");
    void ingest.derive(a, VIDEO, () => {}, new AbortController().signal);
    expect(workers[0].posted).toEqual([
      { type: "probe", id: "r1", file: a, fileName: "IMG_4821.MOV" },
      { type: "derive", id: "r2", file: a, probe: VIDEO },
    ]);
    // The very file, not a copy: toEqual above cannot tell two Blobs apart.
    for (const request of workers[0].posted) expect(request.type !== "cancel" && request.file).toBe(a);
  });

  it("pairs answers with requests by id", async () => {
    const { ingest, workers } = setup();
    const first = ingest.probe(file("a"), "a.mp4");
    const second = ingest.probe(file("b"), "b.jpg");

    workers[0].deliver({ type: "probed", id: "r2", probe: IMAGE });
    expect(await outcome(first)).toBe("pending");
    expect(await second).toEqual(IMAGE);

    workers[0].deliver({ type: "probed", id: "r1", probe: VIDEO });
    expect(await first).toEqual(VIDEO);
  });

  it("an unreadable file is null, not an error", async () => {
    const { ingest, workers } = setup();
    const probe = ingest.probe(file("?"), "a.mp4");
    workers[0].deliver({ type: "unreadable", id: "r1" });
    expect(await probe).toBeNull();
  });

  it("reports progress and then the files", async () => {
    const { ingest, workers } = setup();
    const onProgress = vi.fn();
    const derived = ingest.derive(file("a"), VIDEO, onProgress, new AbortController().signal);

    workers[0].deliver({ type: "progress", id: "r1", fraction: 0.25 });
    workers[0].deliver({ type: "progress", id: "r1", fraction: 0.5 });
    expect(onProgress.mock.calls).toEqual([[0.25], [0.5]]);
    expect(await outcome(derived)).toBe("pending");

    const preview = file("preview");
    const poster = file("poster");
    workers[0].deliver({ type: "derived", id: "r1", preview, poster, previewProblem: null });
    const result = await derived;
    expect(result).toEqual({ preview, poster, previewProblem: null });
    expect(result.preview).toBe(preview);
    expect(result.poster).toBe(poster);

    // The request is over: what still arrives for it reaches nobody.
    workers[0].deliver({ type: "progress", id: "r1", fraction: 1 });
    expect(onProgress).toHaveBeenCalledTimes(2);
  });

  it("passes on why there is no preview copy", async () => {
    const { ingest, workers } = setup();
    const derived = ingest.derive(file("a"), VIDEO, () => {}, new AbortController().signal);
    const poster = file("poster");
    workers[0].deliver({ type: "derived", id: "r1", preview: null, poster, previewProblem: "cannot-decode" });
    expect(await derived).toEqual({ preview: null, poster, previewProblem: "cannot-decode" });
  });

  it("gives progress only to the request it belongs to", async () => {
    const { ingest, workers } = setup();
    const firstProgress = vi.fn();
    const secondProgress = vi.fn();
    const first = ingest.derive(file("a"), VIDEO, firstProgress, new AbortController().signal);
    const second = ingest.derive(file("b"), VIDEO, secondProgress, new AbortController().signal);

    workers[0].deliver({ type: "progress", id: "r2", fraction: 0.75 });
    expect(firstProgress).not.toHaveBeenCalled();
    expect(secondProgress.mock.calls).toEqual([[0.75]]);

    workers[0].deliver({ type: "derived", id: "r2", preview: null, poster: null, previewProblem: "failed" });
    expect(await second).toEqual({ preview: null, poster: null, previewProblem: "failed" });
    expect(await outcome(first)).toBe("pending");
  });

  it("cancel tells the worker and rejects", async () => {
    const { ingest, workers } = setup();
    const controller = new AbortController();
    const onProgress = vi.fn();
    const derived = ingest.derive(file("a"), VIDEO, onProgress, controller.signal);

    controller.abort();
    expect(workers[0].posted.at(-1)).toEqual({ type: "cancel", id: "r1" });
    await expect(derived).rejects.toMatchObject({ name: "AbortError" });

    // What the worker still sends for that request is ignored.
    workers[0].deliver({ type: "progress", id: "r1", fraction: 0.9 });
    workers[0].deliver({ type: "derived", id: "r1", preview: file("late"), poster: null, previewProblem: null });
    expect(onProgress).not.toHaveBeenCalled();
    await expect(derived).rejects.toMatchObject({ name: "AbortError" });
    expect(workers[0].posted).toHaveLength(2);
  });

  it("rejects with an AbortError whatever reason the signal was aborted with", async () => {
    const { ingest } = setup();
    const controller = new AbortController();
    const derived = ingest.derive(file("a"), VIDEO, () => {}, controller.signal);
    controller.abort(new Error("left the editor"));
    await expect(derived).rejects.toMatchObject({ name: "AbortError" });
  });

  it("sends nothing for a signal that was aborted before the call", async () => {
    const { ingest, start } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(ingest.derive(file("a"), VIDEO, () => {}, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(start).not.toHaveBeenCalled();
  });

  it("an abort after the files arrived tells the worker nothing", async () => {
    const { ingest, workers } = setup();
    const controller = new AbortController();
    const listened = vi.spyOn(controller.signal, "addEventListener");
    const unlistened = vi.spyOn(controller.signal, "removeEventListener");
    const derived = ingest.derive(file("a"), VIDEO, () => {}, controller.signal);
    workers[0].deliver({ type: "derived", id: "r1", preview: null, poster: null, previewProblem: null });
    await derived;

    // It no longer listens to the signal, which may live much longer than this one request.
    expect(listened).toHaveBeenCalledTimes(1);
    expect(unlistened).toHaveBeenCalledWith("abort", listened.mock.calls[0][1]);
    controller.abort();
    expect(workers[0].posted.map((m) => m.type)).toEqual(["derive"]);
  });

  it("dispose terminates the worker, and the next call starts a new one", async () => {
    const { ingest, start, workers } = setup();
    ingest.dispose(); // nothing started yet: nothing to terminate
    expect(start).not.toHaveBeenCalled();

    const lost = ingest.probe(file("a"), "a.mp4");
    expect(workers[0].terminated()).toBe(false);
    ingest.dispose();
    expect(workers[0].terminated()).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);

    const probe = ingest.probe(file("b"), "b.mp4");
    expect(start).toHaveBeenCalledTimes(2);
    expect(workers[1].posted).toEqual([{ type: "probe", id: "r2", file: expect.any(Blob), fileName: "b.mp4" }]);
    expect(workers[0].posted).toHaveLength(1);

    workers[1].deliver({ type: "probed", id: "r2", probe: VIDEO });
    expect(await probe).toEqual(VIDEO);
    // The request the terminated worker held can never be answered, so its caller is told: it is not left waiting.
    expect(await outcome(lost)).toMatchObject({ error: { name: "AbortError" } });
  });

  it("dispose rejects every request still waiting, and no other", async () => {
    const { ingest, workers } = setup();
    const onProgress = vi.fn();
    const answered = ingest.probe(file("a"), "a.mp4");
    const probe = ingest.probe(file("b"), "b.mp4");
    const derived = ingest.derive(file("b"), VIDEO, onProgress, new AbortController().signal); // a signal nobody aborts
    workers[0].deliver({ type: "probed", id: "r1", probe: VIDEO });
    expect(await outcome(probe)).toBe("pending");
    expect(await outcome(derived)).toBe("pending");

    ingest.dispose();
    expect(await outcome(answered)).toEqual({ value: VIDEO });
    expect(await outcome(probe)).toMatchObject({ error: { name: "AbortError" } });
    expect(await outcome(derived)).toMatchObject({ error: { name: "AbortError" } });

    // Those requests are over: the next worker cannot reach them, whatever id it names.
    const next = ingest.probe(file("c"), "c.mp4");
    workers[1].deliver({ type: "progress", id: "r3", fraction: 0.5 });
    expect(onProgress).not.toHaveBeenCalled();
    workers[1].deliver({ type: "unreadable", id: "r4" });
    expect(await next).toBeNull();
  });

  it("after dispose a derive no longer listens to its signal, and an abort tells nobody", async () => {
    const { ingest, start, workers } = setup();
    const controller = new AbortController();
    const listened = vi.spyOn(controller.signal, "addEventListener");
    const unlistened = vi.spyOn(controller.signal, "removeEventListener");
    const derived = ingest.derive(file("a"), VIDEO, () => {}, controller.signal);

    ingest.dispose();
    expect(listened).toHaveBeenCalledTimes(1);
    expect(unlistened).toHaveBeenCalledWith("abort", listened.mock.calls[0][1]);
    expect(await outcome(derived)).toMatchObject({ error: { name: "AbortError" } });

    controller.abort();
    expect(start).toHaveBeenCalledTimes(1);
    expect(workers[0].posted.map((m) => m.type)).toEqual(["derive"]);
  });

  it("gives each request its own id when none are supplied", () => {
    const pretend = pretendWorker();
    const ingest = createIngest(() => pretend.worker);
    for (let i = 0; i < 50; i++) void ingest.probe(file("a"), "a.mp4");
    const ids = pretend.posted.map((m) => m.id);
    expect(new Set(ids).size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[\w-]{10,}$/);
  });
});
