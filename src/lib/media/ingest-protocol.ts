import { nanoid } from "nanoid";
import type { AssetProbe } from "./types";

// Why a video has no preview copy: the browser cannot read its video, cannot write H.264, or the conversion broke.
export type PreviewProblem = "cannot-decode" | "cannot-encode" | "failed";

// What the page sends the worker.
export type IngestRequest =
  | { type: "probe"; id: string; file: Blob; fileName: string }
  | { type: "derive"; id: string; file: Blob; probe: AssetProbe }
  | { type: "cancel"; id: string };

// What the worker sends back. Every event carries the id of the request it answers.
export type IngestEvent =
  | { type: "probed"; id: string; probe: AssetProbe }
  | { type: "unreadable"; id: string }
  | { type: "progress"; id: string; fraction: number }
  | { type: "derived"; id: string; preview: Blob | null; poster: Blob | null; previewProblem: PreviewProblem | null };

export type Derived = { preview: Blob | null; poster: Blob | null; previewProblem: PreviewProblem | null };

// A request that the worker cannot answer any more rejects: with an AbortError when it was given up (an abort, or
// dispose), and with an Error named "WorkerFailed" when the worker failed under it.
export type Ingest = {
  probe(file: Blob, fileName: string): Promise<AssetProbe | null>; // null: the file cannot be read
  derive(file: Blob, probe: AssetProbe, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<Derived>;
  dispose(): void; // terminates the worker; the next call starts a new one. What was still waiting rejects with an AbortError.
};

// The part of a Worker this uses, so a test can stand in for one.
export type WorkerLike = {
  postMessage(message: IngestRequest): void;
  addEventListener(type: "message", listener: (event: { data: IngestEvent }) => void): void;
  addEventListener(type: "error", listener: () => void): void;
  terminate(): void;
};

const aborted = () => new DOMException("The request was canceled.", "AbortError");

// What a request rejects with when the worker failed under it: its script did not load, or it broke.
function workerFailed(): Error {
  const error = new Error("The worker failed.");
  error.name = "WorkerFailed";
  return error;
}

// A request the worker has not answered yet: what to do with an answer, and what to do when none can come any more.
type Waiting = { answer(event: IngestEvent): void; giveUp(why: Error): void };

// Pairs each request with its answers by id. The worker is started on first use. An abort posts "cancel" and rejects
// with an AbortError. A worker that reports an error is ended, and what it had not answered rejects as WorkerFailed.
export function createIngest(startWorker: () => WorkerLike, genId: () => string = () => nanoid(10)): Ingest {
  let worker: WorkerLike | null = null;
  const waiting = new Map<string, Waiting>(); // by request id

  function running(): WorkerLike {
    if (worker) return worker;
    const started = startWorker();
    started.addEventListener("message", (event) => waiting.get(event.data.id)?.answer(event.data));
    started.addEventListener("error", () => {
      // A worker that was replaced holds none of the requests that wait now.
      if (worker !== started) return;
      started.terminate(); // an error can come from a worker that goes on running
      worker = null;
      giveUpAll(workerFailed);
    });
    worker = started;
    return started;
  }

  // The worker that held these requests is gone, so no answer will come: every caller is told, none is left waiting.
  function giveUpAll(why: () => Error) {
    const lost = [...waiting.values()];
    waiting.clear();
    for (const request of lost) request.giveUp(why());
  }

  return {
    probe(file, fileName) {
      return new Promise((resolve, reject) => {
        const to = running();
        const id = genId();
        waiting.set(id, {
          answer(event) {
            if (event.type !== "probed" && event.type !== "unreadable") return;
            waiting.delete(id);
            resolve(event.type === "probed" ? event.probe : null);
          },
          giveUp: reject,
        });
        to.postMessage({ type: "probe", id, file, fileName });
      });
    },

    derive(file, probe, onProgress, signal) {
      return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(aborted());
        const to = running();
        const id = genId();
        const onAbort = () => {
          // Tell the worker only while it still holds the request: not after its answer, and not once the worker is gone.
          if (waiting.delete(id)) to.postMessage({ type: "cancel", id });
          reject(aborted());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiting.set(id, {
          answer(event) {
            if (event.type === "progress") return onProgress(event.fraction);
            if (event.type !== "derived") return;
            waiting.delete(id);
            signal.removeEventListener("abort", onAbort);
            resolve({ preview: event.preview, poster: event.poster, previewProblem: event.previewProblem });
          },
          giveUp(why) {
            signal.removeEventListener("abort", onAbort);
            reject(why);
          },
        });
        to.postMessage({ type: "derive", id, file, probe });
      });
    },

    dispose() {
      worker?.terminate();
      worker = null;
      giveUpAll(aborted);
    },
  };
}
