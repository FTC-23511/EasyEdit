import { describe, expect, it } from "vitest";
import { assets } from "@/db/schema";
import { createMediaApi, type MediaApi, type MediaFailure } from "@/lib/media/api";
import type { Derived, Ingest } from "@/lib/media/ingest-protocol";
import { listAssets } from "@/lib/media/service";
import type { AssetProbe, AssetView, UploadItem, UploadStage } from "@/lib/media/types";
import { createUploadQueue, type QueueDeps, type UploadQueue } from "@/lib/media/upload-queue";
import { PieceError, createDriveTransport, type UploadTransport } from "@/lib/media/uploader";
import { AUDIO, IMAGE, VIDEO, handlersFetch, mediaContext, type MediaContext } from "./context";

const MiB = 1024 * 1024;
const SMALL = 1_000_000; // a file that goes in one piece

const SENTENCES = {
  stopped: "Upload stopped. Check your connection, then retry.",
  expired: "This upload expired. Retry to start it again.",
  refused: "Google Drive refused this upload. Tell an admin.",
  storageDown: "Google Drive didn't answer. Try again.",
  signedOut: "You're signed out. Sign in again, then retry.",
  lostAccess: "You no longer have edit access.",
  noPreviewHere: "No preview: this browser can't read this video. It can still be used in projects.",
  noPreview: "The preview couldn't be made. The file can still be used in projects.",
  unreadable: "This file couldn't be read. It may be damaged.",
};

const videoFile = (name = "IMG_4821.MOV", sizeBytes = 20_000_000) => new File([new Uint8Array(sizeBytes)], name, { type: "video/quicktime", lastModified: 1_762_800_000_000 });
const imageFile = () => new File([new Uint8Array(IMAGE.sizeBytes)], IMAGE.fileName, { type: IMAGE.mimeType, lastModified: IMAGE.lastModifiedMs });
const audioFile = () => new File([new Uint8Array(AUDIO.sizeBytes)], AUDIO.fileName, { type: AUDIO.mimeType, lastModified: AUDIO.lastModifiedMs });

// What the worker reads from each kind of file, by its extension.
const probeOf = (fileName: string): AssetProbe => (/\.jpg$/i.test(fileName) ? IMAGE.probe : /\.mp3$/i.test(fileName) ? AUDIO.probe : VIDEO.probe);
// What the worker makes: a preview copy for a video only, and a still picture.
const madeFrom = (probe: AssetProbe): Derived => ({
  preview: probe.kind === "video" ? new Blob([new Uint8Array(3_000_000)]) : null,
  poster: new Blob([new Uint8Array(20_000)]),
  previewProblem: null,
});

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let turn = 0; turn < 4000; turn++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Waited too long for ${what}.`);
}
const settled = (queue: UploadQueue) => until(() => queue.active() === 0, "the queue to settle");
const aWhile = () => new Promise((resolve) => setTimeout(resolve, 30)); // long enough for anything still running to show itself

function gate<T = void>() {
  let open!: (value: T) => void;
  let fail!: (error: unknown) => void;
  const opened = new Promise<T>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { opened, open, fail };
}

type Options = {
  ctx?: MediaContext;
  derive?: Derived | Ingest["derive"];
  stopAfterPieces?: number;
  probe?: (fileName: string) => Promise<AssetProbe | null>;
  api?: (real: MediaApi) => Partial<MediaApi>; // calls answered by the test and not by the server
  beforePiece?: (nth: number) => void | Promise<void>; // waited for before the nth piece of this tab is sent, counted from 1
  event?: () => string | undefined;
  options?: Pick<QueueDeps, "chunkBytes" | "parallel" | "genKey">;
};

async function harness(options: Options = {}) {
  const ctx = options.ctx ?? (await mediaContext());
  const changes: UploadItem[][] = [];
  const seen: AssetView[] = []; // every onAsset call
  const previewFiles: [string, Blob][] = [];
  const calls: [keyof MediaApi, ...unknown[]][] = []; // every API call, in order
  const probed: string[] = [];
  const derives: { fileName: string; signal: AbortSignal }[] = [];
  const sleeps: number[] = [];
  const net = { down: false }; // true: no piece gets through
  const halted = gate();
  let pieces = 0;

  const real = createMediaApi(handlersFetch(ctx, ctx.ada));
  const answering = { ...real, ...options.api?.(real) };
  const api = Object.fromEntries(
    Object.entries(answering).map(([name, call]) => [
      name,
      (...args: unknown[]) => {
        calls.push([name as keyof MediaApi, ...args]);
        return (call as (...input: unknown[]) => unknown)(...args);
      },
    ]),
  ) as MediaApi;

  const drive = createDriveTransport(ctx.fake.fetch);
  const transport: UploadTransport = {
    async sendPiece(input) {
      if (options.stopAfterPieces !== undefined && pieces >= options.stopAfterPieces) {
        halted.open();
        // Silence, as from a tab that is gone. An abort ends the request, as it ends a fetch.
        return new Promise((_, reject) => input.signal.addEventListener("abort", () => reject(input.signal.reason)));
      }
      pieces += 1;
      await options.beforePiece?.(pieces);
      if (net.down) throw new PieceError("network");
      return drive.sendPiece(input);
    },
  };

  const ingest: Ingest = {
    async probe(_file, fileName) {
      probed.push(fileName);
      return options.probe ? options.probe(fileName) : probeOf(fileName);
    },
    async derive(file, probe, onProgress, signal) {
      derives.push({ fileName: (file as File).name, signal });
      if (typeof options.derive === "function") return options.derive(file, probe, onProgress, signal);
      return options.derive ?? madeFrom(probe);
    },
    dispose() {},
  };

  const queue = createUploadQueue({
    api,
    ingest,
    transport,
    sleep: async (ms) => void sleeps.push(ms),
    onChange: (items) => void changes.push(items),
    onAsset: (asset) => void seen.push(asset),
    onPreviewFile: (fileId, blob) => void previewFiles.push([fileId, blob]),
    event: options.event ?? (() => undefined),
    ...options.options,
  });

  const firstKey = () => changes.find((items) => items.length > 0)?.[0].key;
  const shown = <T>(pick: (item: UploadItem) => T): T[] => {
    const values = changes.flatMap((items) => items.filter((item) => item.key === firstKey()).map(pick));
    return [...new Set(values)];
  };

  return {
    ctx,
    queue,
    stages: (): UploadStage[] => shown((item) => item.stage),
    sentBytes: (): number[] => shown((item) => item.sentBytes).filter((sent) => sent > 0),
    previewFiles,
    stopped: halted.opened,
    changes,
    seen,
    calls,
    probed,
    derives,
    net,
    called: (name: keyof MediaApi) => calls.filter((call) => call[0] === name),
    sleeps,
    sentPieces: () => pieces, // the pieces this tab handed to its connection
    originals: () => [...ctx.fake.sessions.values()].filter((session) => !/\.(preview\.mp4|poster\.jpg)$/.test(session.name)).length,
    assetCount: () => ctx.db.$count(assets),
    stageOf: (index = 0) => queue.items()[index]?.stage,
  };
}

const outcome = ({ stage, message, canRetry }: UploadItem) => ({ stage, message, canRetry });
const failure = (kind: MediaFailure["kind"], message = ""): MediaFailure => ({ ok: false, kind, message });

describe("one upload, start to finish", () => {
  it("reads, uploads, completes, then sends the preview copy and the still picture", async () => {
    const h = await harness();
    h.queue.add([videoFile()]);
    await settled(h.queue);
    expect(h.stages()).toEqual(["waiting", "reading", "uploading", "finishing", "preview", "done"]); // each stage once, in order
    const [asset] = (await listAssets(h.ctx.db, h.ctx.grace));
    expect(asset).toMatchObject({ status: "ready", name: "IMG_4821", previewStatus: "ready" });
    expect(asset.previewFileId).not.toBeNull();
    expect(asset.posterFileId).not.toBeNull();
    expect(h.previewFiles.map(([fileId]) => fileId)).toEqual([asset.previewFileId, asset.posterFileId]);
    expect(h.queue.items()[0]).toMatchObject({ stage: "done", sentBytes: 20_000_000, message: null, assetId: asset.id });
  });

  it("a video this browser cannot read is still uploaded, and says so", async () => {
    const h = await harness({ derive: { preview: null, poster: null, previewProblem: "cannot-decode" } });
    h.queue.add([videoFile()]);
    await settled(h.queue);
    const [asset] = await listAssets(h.ctx.db, h.ctx.grace);
    expect(asset).toMatchObject({ status: "ready", previewStatus: "failed", previewFileId: null });
    expect(h.queue.items()[0]).toMatchObject({ stage: "done", message: "No preview: this browser can't read this video. It can still be used in projects." });
  });

  it("a reloaded tab resumes instead of starting again", async () => {
    const first = await harness({ stopAfterPieces: 1 }); // this tab goes silent after one piece, as a closed tab does
    first.queue.add([videoFile()]);
    await first.stopped;
    const second = await harness({ ctx: first.ctx }); // a new tab: a new queue, the same server and Drive
    second.queue.add([videoFile()]);
    await settled(second.queue);
    expect(second.sentBytes().slice(0, 2)).toEqual([8 * 1024 * 1024, 16 * 1024 * 1024]); // the row starts at the 8 MiB Drive already holds; its first piece is the file's second
    expect((await listAssets(second.ctx.db, second.ctx.ada)).filter((a) => a.status === "ready")).toHaveLength(1);
    expect(second.ctx.fake.sessions.size).toBe(3); // one original, one preview copy, one still picture: no second original
  });

  it("tells the editor each newer state of the asset, and hands over the files this browser made", async () => {
    const h = await harness();
    h.queue.add([videoFile()]);
    await settled(h.queue);
    // After complete, after the preview copy, after the still picture.
    expect(h.seen.map(({ status, previewStatus, posterFileId }) => ({ status, previewStatus, poster: posterFileId !== null }))).toEqual([
      { status: "ready", previewStatus: "pending", poster: false },
      { status: "ready", previewStatus: "ready", poster: false },
      { status: "ready", previewStatus: "ready", poster: true },
    ]);
    expect(h.previewFiles.map(([, blob]) => blob.size)).toEqual([3_000_000, 20_000]);
    expect(h.calls.map(([name]) => name)).toEqual(["open", "complete", "openFile", "completeFile", "openFile", "completeFile"]);
    expect(h.called("open")[0][1]).toEqual({ fileName: "IMG_4821.MOV", sizeBytes: 20_000_000, mimeType: "video/quicktime", lastModifiedMs: 1_762_800_000_000, probe: VIDEO.probe });
    expect(h.called("openFile").map(([, , role, size]) => [role, size])).toEqual([["preview", 3_000_000], ["poster", 20_000]]);
  });

  it("shows how far the upload and the preview copy have come", async () => {
    const h = await harness({
      derive: async (_file, probe, onProgress) => {
        onProgress(0.3);
        onProgress(0.3);
        return madeFrom(probe);
      },
      options: { chunkBytes: 4 * MiB },
    });
    h.queue.add([videoFile()]);
    await settled(h.queue);
    expect(h.sentBytes()).toEqual([4 * MiB, 8 * MiB, 12 * MiB, 16 * MiB, 20_000_000]); // pieces of the size it was given
    const fractions = [...new Set(h.changes.flat().map((item) => item.previewFraction))];
    expect(fractions).toEqual([0, 0.3, 1]); // nothing yet, what the worker said, made
    const repeats = h.changes.filter((items, index) => index > 0 && JSON.stringify(items) === JSON.stringify(h.changes[index - 1]));
    expect(repeats).toEqual([]); // told only when something changed
  });

  it("gives onChange a new array, and never changes an item it handed out", async () => {
    const h = await harness();
    h.queue.add([videoFile()]);
    await settled(h.queue);
    expect(new Set(h.changes).size).toBe(h.changes.length);
    expect(h.changes[0]).toEqual([
      { key: expect.any(String), fileName: "IMG_4821.MOV", sizeBytes: 20_000_000, stage: "waiting", sentBytes: 0, previewFraction: 0, assetId: null, message: null, canRetry: false },
    ]);
    expect(h.changes.at(-1)).toEqual(h.queue.items());
    expect(h.queue.items()).not.toBe(h.queue.items());
  });

  it("counts the bytes as sent when the answer to the last piece was lost", async () => {
    const h = await harness({
      beforePiece: (nth) => {
        if (nth === 3) h.ctx.fake.dropNextPieceAfter(20_000_000 - 16 * MiB); // Drive takes all of it, and the answer never comes
      },
    });
    h.queue.add([videoFile()]);
    await settled(h.queue);
    expect(h.queue.items()[0]).toMatchObject({ stage: "done", sentBytes: 20_000_000 });
    expect(h.originals()).toBe(1);
  });

  it("an image gets a still picture and no preview copy", async () => {
    const h = await harness();
    h.queue.add([imageFile()]);
    await settled(h.queue);
    const [asset] = await listAssets(h.ctx.db, h.ctx.grace);
    expect(asset).toMatchObject({ kind: "image", status: "ready", previewStatus: "none", previewFileId: null });
    expect(asset.posterFileId).not.toBeNull();
    expect(h.derives).toHaveLength(1);
    expect(h.called("previewFailed")).toEqual([]);
    expect(h.previewFiles.map(([fileId]) => fileId)).toEqual([asset.posterFileId]);
    expect(h.queue.items()[0]).toMatchObject({ stage: "done", message: null });
  });

  it("audio gets neither", async () => {
    const h = await harness();
    h.queue.add([audioFile()]);
    await settled(h.queue);
    expect(h.derives).toEqual([]);
    expect(h.queue.items()[0]).toMatchObject({ stage: "done", message: null });
    expect(h.stages()).toEqual(["waiting", "reading", "uploading", "finishing", "done"]);
    expect(h.calls.map(([name]) => name)).toEqual(["open", "complete"]);
    expect((await listAssets(h.ctx.db, h.ctx.grace))[0]).toMatchObject({ kind: "audio", status: "ready", previewStatus: "none", posterFileId: null });
  });

  it("the event is sent with the upload", async () => {
    const h = await harness({ event: () => "Qualifier 2026-11-08" });
    h.queue.add([videoFile()]);
    await settled(h.queue);
    expect((await listAssets(h.ctx.db, h.ctx.grace))[0].event).toBe("Qualifier 2026-11-08");
  });

  it("takes its keys from genKey", async () => {
    let made = 0;
    const h = await harness({ options: { genKey: () => `key-${++made}` } });
    h.queue.add([videoFile("a.mov", SMALL), videoFile("b.mov", SMALL)]);
    expect(h.queue.items().map((item) => item.key)).toEqual(["key-1", "key-2"]);
    await settled(h.queue);
    const own = await harness();
    own.queue.add([videoFile("a.mov", SMALL), videoFile("b.mov", SMALL)]);
    const [one, two] = own.queue.items().map((item) => item.key);
    expect(one).not.toBe(two);
    await settled(own.queue);
  });
});

describe("a file that is not taken", () => {
  it("refuses a file before anything is sent", async () => {
    const h = await harness();
    h.queue.add([new File([], "empty.mp4"), new File([new Uint8Array(10)], "a.gif"), new File([new Uint8Array(10)], "IMG_1.HEIC")]);
    await settled(h.queue);
    expect(h.queue.items().map(outcome)).toEqual([
      { stage: "failed", message: "This file is empty.", canRetry: false },
      { stage: "failed", message: "This file type isn't supported. Use MP4, MOV, WebM, JPEG, PNG, WebP, MP3, M4A, WAV or AAC.", canRetry: false },
      { stage: "failed", message: "HEIC photos aren't supported yet. Save the photo as JPEG first.", canRetry: false },
    ]);
    await aWhile();
    expect(h.ctx.fake.calls).toEqual([]);
    expect(h.probed).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it("a file that cannot be read fails with that sentence", async () => {
    const h = await harness({ probe: async () => null });
    h.queue.add([videoFile()]);
    await settled(h.queue);
    expect(outcome(h.queue.items()[0])).toEqual({ stage: "failed", message: SENTENCES.unreadable, canRetry: false });
    expect(h.stages()).toEqual(["waiting", "reading", "failed"]);
    expect(h.called("open")).toEqual([]);
  });

  it("a file that is not what its name says fails the same way", async () => {
    const h = await harness({ probe: async () => AUDIO.probe }); // sound, in a file named as a video
    h.queue.add([videoFile()]);
    await settled(h.queue);
    expect(outcome(h.queue.items()[0])).toEqual({ stage: "failed", message: SENTENCES.unreadable, canRetry: false });
    expect(h.calls).toEqual([]);
  });

  it("the same file added twice is one upload", async () => {
    const h = await harness();
    h.queue.add([videoFile()]);
    const told = h.changes.length;
    h.queue.add([videoFile()]);
    h.queue.add([videoFile(), videoFile()]);
    expect(h.queue.items()).toHaveLength(1);
    expect(h.changes).toHaveLength(told); // nothing changed, so nothing was said
    await settled(h.queue);
    expect(h.called("open")).toHaveLength(1);
    expect(await h.assetCount()).toBe(1);
  });

  it("a file that differs in name, size or time is another upload, and so is one whose upload is done", async () => {
    const h = await harness();
    const named = (name: string, size: number, lastModified: number) => new File([new Uint8Array(size)], name, { type: "video/quicktime", lastModified });
    h.queue.add([named("a.mov", SMALL, 1), named("b.mov", SMALL, 1), named("a.mov", SMALL + 1, 1), named("a.mov", SMALL, 2)]);
    expect(h.queue.items()).toHaveLength(4);
    await settled(h.queue);
    h.queue.add([named("a.mov", SMALL, 1)]); // done before: uploaded again
    expect(h.queue.items()).toHaveLength(5);
    await settled(h.queue);
    expect(await h.assetCount()).toBe(5);
  });

  it("a file whose upload failed is not taken again while its row is there", async () => {
    const h = await harness();
    h.net.down = true;
    h.queue.add([videoFile()]);
    await settled(h.queue);
    h.queue.add([videoFile()]);
    expect(h.queue.items()).toHaveLength(1);
    h.queue.dismiss(h.queue.items()[0].key);
    h.queue.add([videoFile()]);
    expect(h.queue.items().map((item) => item.stage)).toEqual(["reading"]);
    h.queue.stop();
  });
});

describe("several uploads", () => {
  const busy = (items: UploadItem[]) => items.filter((item) => item.stage === "reading" || item.stage === "uploading" || item.stage === "finishing").length;

  it("uploads two at a time and keeps the rest waiting", async () => {
    const h = await harness();
    const names = ["a.mov", "b.mov", "c.mov", "d.mov", "e.mov"];
    h.queue.add(names.map((name) => videoFile(name, SMALL)));
    expect(h.queue.items().map((item) => item.stage)).toEqual(["reading", "reading", "waiting", "waiting", "waiting"]);
    await settled(h.queue);
    expect(Math.max(...h.changes.map(busy))).toBe(2);
    expect(h.queue.items().map((item) => item.stage)).toEqual(["done", "done", "done", "done", "done"]);
    expect(h.probed).toEqual(names); // they start in the order given
    expect(await h.assetCount()).toBe(5);
  });

  it("runs as many at once as it is told", async () => {
    const h = await harness({ options: { parallel: 1 } });
    h.queue.add([videoFile("a.mov", SMALL), videoFile("b.mov", SMALL), videoFile("c.mov", SMALL)]);
    await settled(h.queue);
    expect(Math.max(...h.changes.map(busy))).toBe(1);
    expect(h.queue.items().map((item) => item.stage)).toEqual(["done", "done", "done"]);
  });

  it("a failure makes room for the next upload", async () => {
    const h = await harness({ options: { parallel: 1 }, probe: async (fileName) => (fileName === "a.mov" ? null : VIDEO.probe) });
    h.queue.add([videoFile("a.mov", SMALL), videoFile("b.mov", SMALL)]);
    await settled(h.queue);
    expect(h.queue.items().map((item) => item.stage)).toEqual(["failed", "done"]);
  });

  it("a preview copy being made holds no place", async () => {
    const held = gate();
    const h = await harness({
      options: { parallel: 1 },
      derive: async (_file, probe) => {
        await held.opened;
        return madeFrom(probe);
      },
    });
    h.queue.add([videoFile("a.mov", SMALL), videoFile("b.mov", SMALL), videoFile("c.mov", SMALL)]);
    await until(() => h.queue.items().every((item) => item.stage === "preview"), "every original to be in"); // while the first copy is still being made
    expect(h.derives).toHaveLength(1);
    held.open();
    await settled(h.queue);
    expect(h.queue.items().map((item) => item.stage)).toEqual(["done", "done", "done"]);
  });

  it("makes one preview copy at a time", async () => {
    let running = 0;
    let most = 0;
    const h = await harness({
      derive: async (_file, probe) => {
        most = Math.max(most, ++running);
        await aWhile();
        running -= 1;
        return madeFrom(probe);
      },
    });
    h.queue.add([videoFile("a.mov", SMALL), videoFile("b.mov", SMALL), videoFile("c.mov", SMALL)]);
    await settled(h.queue);
    expect(most).toBe(1);
    expect(h.derives.map((derive) => derive.fileName)).toEqual(["a.mov", "b.mov", "c.mov"]);
  });

  it("a preview copy that was canceled does not keep the next one waiting", async () => {
    const never = new Promise<Derived>(() => {});
    const h = await harness({ derive: async (file, probe) => ((file as File).name === "a.mov" ? never : madeFrom(probe)) });
    h.queue.add([videoFile("a.mov", SMALL), videoFile("b.mov", SMALL)]);
    await until(() => h.queue.items().every((item) => item.stage === "preview"), "both originals to be in");
    h.queue.cancel(h.queue.items()[0].key);
    await settled(h.queue);
    expect(h.queue.items().map(outcome)).toEqual([{ stage: "done", message: null, canRetry: false }]);
    expect(h.derives.map((derive) => derive.signal.aborted)).toEqual([true, false]);
  });

  it("a preview copy given up while it waits its turn does not let the one behind it start early", async () => {
    const held = gate();
    let running = 0;
    let most = 0;
    const h = await harness({
      options: { parallel: 1 }, // so the copies are asked for in the order a, b, c
      derive: async (file, probe) => {
        most = Math.max(most, ++running);
        if ((file as File).name === "a.mov") await held.opened;
        running -= 1;
        return madeFrom(probe);
      },
    });
    h.queue.add([videoFile("a.mov", SMALL), videoFile("b.mov", SMALL), videoFile("c.mov", SMALL)]);
    await until(() => h.queue.items().every((item) => item.stage === "preview"), "every original to be in");
    h.queue.cancel(h.queue.items()[1].key); // b.mov, whose copy waits behind a.mov's
    await aWhile();
    expect(h.derives.map((derive) => derive.fileName)).toEqual(["a.mov"]); // the worker is still busy with a.mov
    held.open();
    await settled(h.queue);
    expect(h.derives.map((derive) => derive.fileName)).toEqual(["a.mov", "c.mov"]); // b.mov's is never started
    expect(most).toBe(1);
    expect(h.queue.items().map((item) => [item.fileName, item.stage])).toEqual([["a.mov", "done"], ["c.mov", "done"]]);
  });
});

describe("an upload that fails", () => {
  it("a network failure can be retried, and the retry resumes", async () => {
    const h = await harness();
    h.net.down = true;
    h.queue.add([videoFile()]);
    await settled(h.queue);
    expect(outcome(h.queue.items()[0])).toEqual({ stage: "failed", message: SENTENCES.stopped, canRetry: true });
    expect(h.queue.items()[0].assetId).not.toBeNull();
    h.net.down = false;
    h.queue.retry(h.queue.items()[0].key);
    expect(outcome(h.queue.items()[0])).toEqual({ stage: "uploading", message: null, canRetry: false }); // from step 3: the file is not read again
    await settled(h.queue);
    expect(h.queue.items()[0]).toMatchObject({ stage: "done", message: null, sentBytes: 20_000_000 });
    expect(h.originals()).toBe(1);
    expect(h.probed).toHaveLength(1);
    expect(h.derives).toHaveLength(1); // the copy made during the first try is the one sent
    expect((await listAssets(h.ctx.db, h.ctx.grace))[0]).toMatchObject({ status: "ready", previewStatus: "ready" });
  });

  it("an outage longer than the retries resumes when the connection returns", async () => {
    const h = await harness();
    h.net.down = true;
    h.queue.add([videoFile("a.mov"), videoFile("b.mov"), new File([], "empty.mp4")]);
    await settled(h.queue);
    expect(h.queue.items().map(outcome)).toEqual([
      { stage: "failed", message: SENTENCES.stopped, canRetry: true },
      { stage: "failed", message: SENTENCES.stopped, canRetry: true },
      { stage: "failed", message: "This file is empty.", canRetry: false },
    ]);
    h.net.down = false;
    h.queue.resume();
    await settled(h.queue);
    expect(h.queue.items().map((item) => item.stage)).toEqual(["done", "done", "failed"]);
    expect(h.originals()).toBe(2); // one for each video
    const told = h.changes.length;
    h.queue.resume(); // nothing is failed for the network any more
    expect(h.changes).toHaveLength(told);
    expect(h.called("open").map(([, input]) => (input as { fileName: string }).fileName)).toEqual(["a.mov", "b.mov", "a.mov", "b.mov"]); // in the order they were added
  });

  it("retry is only for a failed item that can be retried", async () => {
    const h = await harness({ stopAfterPieces: 0 });
    h.queue.add([new File([], "empty.mp4"), videoFile()]);
    await h.stopped;
    const [empty, running] = h.queue.items();
    const before = h.changes.length;
    h.queue.retry(empty.key);
    h.queue.retry(running.key);
    h.queue.retry("no such key");
    h.queue.resume();
    expect(h.changes).toHaveLength(before);
    expect(h.queue.items().map((item) => item.stage)).toEqual(["failed", "uploading"]);
    expect(h.called("open")).toHaveLength(1);
    h.queue.stop();
  });

  // What each failure of our own server makes of the item, whichever call it answers.
  const API_FAILURES: { answer: MediaFailure; message: string; canRetry: boolean; resumed: boolean }[] = [
    { answer: failure("network"), message: SENTENCES.stopped, canRetry: true, resumed: true },
    { answer: failure("storage", SENTENCES.storageDown), message: SENTENCES.storageDown, canRetry: true, resumed: true },
    { answer: failure("signed-out", "Sign in to continue."), message: SENTENCES.signedOut, canRetry: true, resumed: false },
    { answer: failure("forbidden", "You don't have access."), message: SENTENCES.lostAccess, canRetry: true, resumed: false },
    { answer: failure("refused", "You have 20 unfinished uploads. Finish or cancel one first."), message: "You have 20 unfinished uploads. Finish or cancel one first.", canRetry: false, resumed: false },
    { answer: failure("not-set-up", "Uploads are not set up yet."), message: "Uploads are not set up yet.", canRetry: false, resumed: false },
    { answer: failure("refused"), message: SENTENCES.stopped, canRetry: true, resumed: true }, // a page from something in between: our server always gives a sentence
  ];

  for (const call of ["open", "complete"] as const) {
    for (const { answer, message, canRetry, resumed } of API_FAILURES) {
      it(`${call} answering ${answer.kind}${answer.message ? "" : " without a sentence"}: ${canRetry ? "can be retried" : "is final"}${resumed ? ", and resumes by itself" : ""}`, async () => {
        let failing = true;
        const h = await harness({
          api: (real) =>
            call === "open"
              ? { open: async (input) => (failing ? answer : real.open(input)) }
              : { complete: async (assetId) => (failing ? answer : real.complete(assetId)) },
        });
        h.queue.add([videoFile("a.mov", SMALL)]);
        await settled(h.queue);
        expect(outcome(h.queue.items()[0])).toEqual({ stage: "failed", message, canRetry });
        expect(h.called("complete")).toHaveLength(call === "complete" ? 1 : 0);

        failing = false;
        h.queue.resume();
        expect(h.stageOf()).toBe(resumed ? "uploading" : "failed");
        if (!resumed) h.queue.retry(h.queue.items()[0].key);
        expect(h.stageOf()).toBe(canRetry ? "uploading" : "failed");
        await settled(h.queue);
        expect(h.stageOf()).toBe(canRetry ? "done" : "failed");
        expect(h.originals()).toBe(call === "complete" || canRetry ? 1 : 0); // a retry after the last byte takes up the upload that is whole
      });
    }
  }

  it("a session that expired can be retried, and the retry opens a new upload", async () => {
    const h = await harness({
      beforePiece: (nth) => {
        if (nth === 2) h.ctx.fake.expireSessions();
      },
    });
    h.queue.add([videoFile()]);
    await settled(h.queue);
    expect(outcome(h.queue.items()[0])).toEqual({ stage: "failed", message: SENTENCES.expired, canRetry: true });
    h.queue.resume(); // not a failure of the network
    expect(h.stageOf()).toBe("failed");
    h.queue.retry(h.queue.items()[0].key);
    await settled(h.queue);
    expect(h.queue.items()[0]).toMatchObject({ stage: "done", sentBytes: 20_000_000 });
    expect(h.sentBytes()).toEqual([8 * MiB, 16 * MiB, 20_000_000]); // back to 0 for the new upload, and no value shown twice
    expect(h.originals()).toBe(2);
    expect(await h.assetCount()).toBe(1);
  });

  // The offset question is asked after a piece failed. What our server answers it ends the upload at once.
  const OFFSET_ANSWERS: { answer: MediaFailure; message: string; canRetry: boolean }[] = [
    { answer: failure("refused", "This upload expired. Choose the file again."), message: SENTENCES.expired, canRetry: true },
    { answer: failure("signed-out", "Sign in to continue."), message: SENTENCES.signedOut, canRetry: true },
    { answer: failure("forbidden", "You don't have access."), message: SENTENCES.lostAccess, canRetry: true },
  ];

  for (const { answer, message, canRetry } of OFFSET_ANSWERS) {
    it(`the offset question answered ${answer.kind} ends the upload at once`, async () => {
      const h = await harness({ api: (real) => ({ offset: async (assetId) => (h.net.down ? answer : real.offset(assetId)) }) });
      h.net.down = true;
      h.queue.add([videoFile()]);
      await settled(h.queue);
      expect(outcome(h.queue.items()[0])).toEqual({ stage: "failed", message, canRetry });
      expect(h.called("offset")).toHaveLength(1); // not asked five more times
      expect(h.sleeps).toEqual([1000]);
      h.queue.resume();
      expect(h.stageOf()).toBe("failed");
      h.net.down = false;
      h.queue.retry(h.queue.items()[0].key); // the try that was ended does not end the next one
      await settled(h.queue);
      expect(h.queue.items()[0]).toMatchObject({ stage: "done", message: null });
    });
  }

  for (const answer of [failure("network"), failure("storage", SENTENCES.storageDown)]) {
    it(`an offset question answered ${answer.kind} is asked again, like a piece that failed`, async () => {
      const h = await harness({ api: () => ({ offset: async () => answer }) });
      h.net.down = true;
      h.queue.add([videoFile()]);
      await settled(h.queue);
      expect(outcome(h.queue.items()[0])).toEqual({ stage: "failed", message: SENTENCES.stopped, canRetry: true });
      expect(h.called("offset")).toHaveLength(5);
      expect(h.sleeps).toEqual([1000, 2000, 4000, 8000, 16000]);
    });
  }

  it("after a dropped piece it goes on from where Drive says it is", async () => {
    const h = await harness({
      beforePiece: (nth) => {
        if (nth === 2) h.ctx.fake.dropNextPieceAfter(3 * MiB); // the second piece dies after 3 MiB reached Drive
      },
    });
    h.queue.add([videoFile()]);
    await settled(h.queue);
    expect(h.sentBytes()).toEqual([8 * MiB, 19 * MiB, 20_000_000]); // from 11 MiB on, not from 8 and not from 0
    expect(h.sleeps).toEqual([1000]);
    expect(h.queue.items()[0]).toMatchObject({ stage: "done", message: null });
  });

  it("a retry sends only what Drive does not hold yet", async () => {
    const h = await harness({
      beforePiece: (nth) => {
        if (nth === 2) h.net.down = true; // the connection goes after the first piece
      },
    });
    h.queue.add([videoFile()]);
    await settled(h.queue);
    expect(h.queue.items()[0]).toMatchObject({ stage: "failed", sentBytes: 8 * MiB });
    expect(h.sentPieces()).toBe(7); // one that arrived, and six that did not
    h.net.down = false;
    h.queue.retry(h.queue.items()[0].key);
    await settled(h.queue);
    expect(h.queue.items()[0]).toMatchObject({ stage: "done", sentBytes: 20_000_000 });
    expect(h.sentPieces()).toBe(11); // four more: the file's second and third piece, the preview copy, the still picture
    expect(h.originals()).toBe(1);
  });

  it("a piece Drive refuses fails with its own sentence and no Retry", async () => {
    const h = await harness();
    h.ctx.fake.failNext(/^PUT .*upload_id=/, 403);
    h.queue.add([videoFile()]);
    await settled(h.queue);
    expect(h.queue.items()[0]).toMatchObject({ stage: "failed", message: SENTENCES.refused, canRetry: false, assetId: null });
    expect(await h.assetCount()).toBe(0); // gone by the time the row says so
    expect(h.called("remove")).toHaveLength(1);
    expect(h.derives[0].signal.aborted).toBe(true);
    await aWhile();
    expect(h.sentPieces()).toBe(1);
    h.queue.retry(h.queue.items()[0].key);
    h.queue.resume();
    expect(h.stageOf()).toBe("failed");
  });

  it("a refused upload that could not be removed keeps its asset, so that a cancel removes it", async () => {
    let reachable = false;
    const h = await harness({ api: (real) => ({ remove: async (assetId) => (reachable ? real.remove(assetId) : failure("network")) }) });
    h.ctx.fake.failNext(/^PUT .*upload_id=/, 403);
    h.queue.add([videoFile()]);
    await settled(h.queue);
    expect(h.queue.items()[0]).toMatchObject({ stage: "failed", message: SENTENCES.refused, canRetry: false });
    expect(h.queue.items()[0].assetId).not.toBeNull();
    expect(await h.assetCount()).toBe(1);
    reachable = true;
    h.queue.cancel(h.queue.items()[0].key);
    await until(async () => (await h.assetCount()) === 0, "the asset to be removed");
  });

  it("a file that fails once on its way to the previews is tried once more", async () => {
    let posterFailed = false;
    const h = await harness({
      derive: async (_file, probe) => {
        h.ctx.fake.failNext(/^POST \/upload\/drive\/v3\/files\?/, 403); // the preview copy's first session: the original's is open by now
        return madeFrom(probe);
      },
      api: (real) => ({
        completeFile: async (assetId, role) => {
          if (role !== "poster" || posterFailed) return real.completeFile(assetId, role);
          posterFailed = true; // the still picture's first try
          return failure("network");
        },
      }),
    });
    h.queue.add([videoFile("a.mov", SMALL)]);
    await settled(h.queue);
    const [asset] = await listAssets(h.ctx.db, h.ctx.grace);
    expect(asset).toMatchObject({ previewStatus: "ready" });
    expect(asset.posterFileId).not.toBeNull();
    expect(h.queue.items()[0]).toMatchObject({ stage: "done", message: null });
    expect(h.called("openFile").map(([, , role]) => role)).toEqual(["preview", "preview", "poster", "poster"]);
    expect(h.called("previewFailed")).toEqual([]);
    expect(h.previewFiles.map(([fileId]) => fileId)).toEqual([asset.previewFileId, asset.posterFileId]);
  });

  it("a preview copy that cannot be sent twice is recorded as failed", async () => {
    const h = await harness({
      derive: async (_file, probe) => {
        for (let session = 0; session < 2; session++) h.ctx.fake.failNext(/^POST \/upload\/drive\/v3\/files\?/, 403); // both of the preview copy's sessions
        return madeFrom(probe);
      },
    });
    h.queue.add([videoFile()]);
    await settled(h.queue);
    const [asset] = await listAssets(h.ctx.db, h.ctx.grace);
    expect(asset).toMatchObject({ status: "ready", previewStatus: "failed", previewFileId: null });
    expect(asset.posterFileId).not.toBeNull(); // the still picture is still sent
    expect(h.queue.items()[0]).toMatchObject({ stage: "done", message: SENTENCES.noPreview });
    expect(h.called("openFile").map(([, , role]) => role)).toEqual(["preview", "preview", "poster"]);
    expect(h.previewFiles.map(([fileId]) => fileId)).toEqual([asset.posterFileId]);
    expect(h.seen.at(-2)).toMatchObject({ previewStatus: "failed" }); // the editor is told
  });

  it("a still picture that cannot be sent twice is left out, and the upload is done", async () => {
    const h = await harness({ api: () => ({ completeFile: async () => failure("network") }) });
    h.queue.add([imageFile()]);
    await settled(h.queue);
    expect(h.queue.items()[0]).toMatchObject({ stage: "done", message: null });
    expect(h.called("openFile")).toHaveLength(2);
    expect(h.previewFiles).toEqual([]);
    expect(h.called("previewFailed")).toEqual([]);
  });

  it("says why there is no preview copy", async () => {
    const reasons = [
      { derive: { preview: null, poster: null, previewProblem: "cannot-encode" }, message: SENTENCES.noPreviewHere },
      { derive: { preview: null, poster: null, previewProblem: "failed" }, message: SENTENCES.noPreview },
      { derive: async () => Promise.reject(new DOMException("The request was canceled.", "AbortError")), message: SENTENCES.noPreview }, // the worker is gone
    ] satisfies { derive: Options["derive"]; message: string }[];
    for (const { derive, message } of reasons) {
      const h = await harness({ derive });
      h.queue.add([videoFile("a.mov", SMALL)]);
      await settled(h.queue);
      expect(h.queue.items()[0]).toMatchObject({ stage: "done", message });
      expect((await listAssets(h.ctx.db, h.ctx.grace))[0]).toMatchObject({ status: "ready", previewStatus: "failed" });
    }
  });

  it("the files of a preview copy do not resume: a dropped piece is waited out, then the file is sent again from its start", async () => {
    const h = await harness({
      beforePiece: (nth) => {
        if (nth === 2) h.net.down = true; // the preview copy's piece is dropped
        if (nth === 3) h.net.down = false; // and its second try gets through
      },
    });
    h.queue.add([videoFile("a.mov", SMALL)]);
    await settled(h.queue);
    expect(h.sleeps).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(h.called("offset")).toEqual([]); // the offset route answers only for the original
    expect(h.called("openFile").map(([, , role]) => role)).toEqual(["preview", "preview", "poster"]);
    expect(h.called("completeFile").map(([, , role]) => role)).toEqual(["preview", "poster"]); // a file that did not arrive is not reported as in
    expect(h.sentPieces()).toBe(4); // the original, the copy twice, the still picture
    expect((await listAssets(h.ctx.db, h.ctx.grace))[0]).toMatchObject({ previewStatus: "ready" });
    expect(h.queue.items()[0]).toMatchObject({ stage: "done", message: null });
  });
});

describe("cancel, dismiss and stop", () => {
  it("cancel removes the unfinished asset", async () => {
    const h = await harness({ stopAfterPieces: 1 });
    h.queue.add([videoFile()]);
    await h.stopped;
    expect(h.stageOf()).toBe("uploading");
    h.queue.cancel(h.queue.items()[0].key);
    expect(h.queue.items()).toEqual([]);
    expect(h.changes.at(-1)).toEqual([]);
    expect(h.queue.active()).toBe(0);
    await until(async () => (await h.assetCount()) === 0, "the asset to be removed");
    await aWhile();
    expect(h.sentPieces()).toBe(1);
    expect(h.called("remove")).toHaveLength(1);
    expect(h.called("previewFailed")).toEqual([]);
    expect(h.derives[0].signal.aborted).toBe(true);
    expect(h.calls.at(-1)?.[0]).toBe("remove"); // nothing was asked afterwards
  });

  it("cancel while the upload is being opened removes the asset once it is there", async () => {
    const opening = gate();
    const h = await harness({
      api: (real) => ({
        open: async (input) => {
          const opened = await real.open(input);
          await opening.opened;
          return opened;
        },
      }),
    });
    h.queue.add([videoFile()]);
    await until(async () => (await h.assetCount()) === 1, "the upload to be opened");
    h.queue.cancel(h.queue.items()[0].key);
    expect(h.called("remove")).toEqual([]); // no asset is known yet
    opening.open();
    await until(async () => (await h.assetCount()) === 0, "the asset to be removed");
    await aWhile();
    expect(h.sentPieces()).toBe(0);
    expect(h.derives).toEqual([]);
    expect(h.calls.map(([name]) => name)).toEqual(["open", "remove"]);
  });

  it("cancel after the original is ready keeps the asset and records that it has no preview", async () => {
    const h = await harness({ derive: () => new Promise<Derived>(() => {}) }); // the copy is never made
    h.queue.add([videoFile()]);
    await until(() => h.stageOf() === "preview", "the original to be in");
    h.queue.cancel(h.queue.items()[0].key);
    expect(h.queue.items()).toEqual([]);
    await until(() => h.seen.length === 2, "the editor to be told");
    const [asset] = await listAssets(h.ctx.db, h.ctx.grace);
    expect(asset).toMatchObject({ status: "ready", previewStatus: "failed" });
    expect(h.seen[1]).toEqual(asset);
    expect(h.derives[0].signal.aborted).toBe(true);
    expect(h.originals()).toBe(1);
    expect(h.called("remove")).toEqual([]);
    expect(await h.assetCount()).toBe(1);
  });

  it("cancel makes room for the next upload", async () => {
    const h = await harness({ stopAfterPieces: 0, options: { parallel: 1 } });
    h.queue.add([videoFile("a.mov", SMALL), videoFile("b.mov", SMALL)]);
    await h.stopped;
    expect(h.queue.items().map((item) => item.stage)).toEqual(["uploading", "waiting"]);
    h.queue.cancel(h.queue.items()[0].key);
    expect(h.queue.items().map((item) => [item.fileName, item.stage])).toEqual([["b.mov", "reading"]]);
    h.queue.stop();
  });

  it("cancel of a failed upload removes what the server holds of it", async () => {
    const h = await harness();
    h.net.down = true;
    h.queue.add([videoFile()]);
    await settled(h.queue);
    expect(await h.assetCount()).toBe(1);
    h.queue.cancel(h.queue.items()[0].key);
    expect(h.queue.items()).toEqual([]);
    await until(async () => (await h.assetCount()) === 0, "the asset to be removed");
  });

  it("dismiss removes a finished or failed row, and asks the server for nothing", async () => {
    const h = await harness({ derive: () => new Promise<Derived>(() => {}) }); // the video stays at its preview copy
    h.queue.add([new File([], "empty.mp4"), audioFile(), videoFile("a.mov", SMALL)]);
    await until(() => h.stageOf(1) === "done" && h.stageOf(2) === "preview", "the audio to be done and the video's original to be in");
    const [failed, done, running] = h.queue.items();
    const asked = h.calls.length;
    h.queue.dismiss(running.key); // not finished: not dismissed
    h.queue.dismiss("no such key");
    expect(h.queue.items()).toHaveLength(3);
    h.queue.dismiss(failed.key);
    h.queue.dismiss(done.key);
    expect(h.queue.items().map((item) => item.key)).toEqual([running.key]);
    expect(h.changes.at(-1)).toEqual(h.queue.items());
    await aWhile();
    expect(h.calls).toHaveLength(asked);
    expect(await h.assetCount()).toBe(2);
    h.queue.stop();
  });

  it("dismissing a failed upload ends the preview copy that was being made for its retry", async () => {
    const h = await harness({ derive: () => new Promise<Derived>(() => {}) });
    h.net.down = true;
    h.queue.add([videoFile()]);
    await settled(h.queue);
    expect(h.derives[0].signal.aborted).toBe(false); // kept for the retry
    h.queue.dismiss(h.queue.items()[0].key);
    expect(h.derives[0].signal.aborted).toBe(true);
    expect(await h.assetCount()).toBe(1); // the unfinished upload stays, to be taken up
  });

  it("stop aborts running uploads and removes nothing", async () => {
    const h = await harness({ stopAfterPieces: 1, derive: () => new Promise<Derived>(() => {}) });
    h.queue.add([videoFile()]);
    await h.stopped;
    expect(h.stageOf()).toBe("uploading");
    const asked = h.calls.length;
    h.queue.stop();
    expect(h.queue.items()).toEqual([]);
    expect(h.queue.active()).toBe(0);
    expect(h.changes.at(-1)).toEqual([]);
    expect(h.derives.map((derive) => derive.signal.aborted)).toEqual([true]);
    await aWhile();
    expect(h.sentPieces()).toBe(1);
    expect(h.calls).toHaveLength(asked); // no request for it afterwards
    expect(await h.ctx.db.select({ status: assets.status }).from(assets)).toEqual([{ status: "uploading" }]);

    h.queue.add([videoFile()]); // a file added after the stop is taken, and the server takes up what it holds
    expect(h.queue.items().map((item) => item.stage)).toEqual(["reading"]);
    await until(() => h.stageOf() === "uploading" && h.queue.items()[0].sentBytes === 8 * MiB, "the upload to be taken up");
    expect(h.queue.active()).toBe(1);
    expect(await h.assetCount()).toBe(1);
    h.queue.stop();
  });

  it("stop ends a preview copy being made, and one waiting its turn never starts", async () => {
    const h = await harness({ derive: () => new Promise<Derived>(() => {}) });
    h.queue.add([videoFile("a.mov", SMALL), videoFile("b.mov", SMALL)]);
    await until(() => h.queue.items().every((item) => item.stage === "preview"), "both originals to be in");
    const asked = h.calls.length;
    h.queue.stop();
    await aWhile();
    expect(h.derives.map((derive) => [derive.fileName, derive.signal.aborted])).toEqual([["a.mov", true]]);
    expect(h.calls).toHaveLength(asked);
    expect((await listAssets(h.ctx.db, h.ctx.grace)).map((asset) => asset.previewStatus)).toEqual(["pending", "pending"]); // nothing was recorded as failed
  });

  // Everything the queue waits for while one video goes from its first piece to its still picture. Leaving the
  // editor during any of them must be the end: no request, no piece, and nothing told to the editor afterwards.
  // In pieces of 1 MiB the original is one piece, the preview copy three and the still picture one.
  type Wait = "piece 1" | "piece 2" | "piece 5" | "complete" | "derive" | "openFile preview" | "completeFile preview" | "previewFailed" | "openFile poster" | "completeFile poster";
  const WAITS: { wait: Wait; derive?: Derived }[] = [
    { wait: "piece 1" }, // the original, which is whole when it is answered
    { wait: "complete" },
    { wait: "derive" },
    { wait: "openFile preview" },
    { wait: "piece 2" }, // the first of the preview copy: its other two are never sent
    { wait: "completeFile preview" },
    { wait: "previewFailed", derive: { preview: null, poster: new Blob([new Uint8Array(20_000)]), previewProblem: "cannot-decode" } },
    { wait: "openFile poster" },
    { wait: "piece 5" }, // the still picture
    { wait: "completeFile poster" },
  ];

  for (const { wait, derive } of WAITS) {
    it(`stop during ${wait}: what was on its way is the last thing that happens`, async () => {
      const reached = gate();
      const held = gate();
      const hold = async (name: string) => {
        if (name !== wait) return;
        reached.open();
        await held.opened;
      };
      const h = await harness({
        options: { chunkBytes: MiB },
        beforePiece: (nth) => hold(`piece ${nth}`),
        derive: async (_file, probe) => {
          await hold("derive");
          return derive ?? madeFrom(probe);
        },
        api: (real) => ({
          // The server answers first, and the answer is then held back on its way to the page.
          complete: async (assetId) => {
            const answer = await real.complete(assetId);
            await hold("complete");
            return answer;
          },
          openFile: async (assetId, role, sizeBytes) => {
            const answer = await real.openFile(assetId, role, sizeBytes);
            await hold(`openFile ${role}`);
            return answer;
          },
          completeFile: async (assetId, role) => {
            const answer = await real.completeFile(assetId, role);
            await hold(`completeFile ${role}`);
            return answer;
          },
          previewFailed: async (assetId) => {
            const answer = await real.previewFailed(assetId);
            await hold("previewFailed");
            return answer;
          },
        }),
      });
      h.queue.add([videoFile("a.mov", SMALL)]);
      await reached.opened;
      if (wait === "derive") await until(() => h.stageOf() === "preview", "the original to be in"); // the worker starts with the first piece
      const before = { calls: h.calls.length, pieces: h.sentPieces(), seen: h.seen.length, files: h.previewFiles.length };
      h.queue.stop();
      const told = h.changes.length;
      held.open();
      await aWhile();
      expect({ calls: h.calls.length, pieces: h.sentPieces(), seen: h.seen.length, files: h.previewFiles.length }).toEqual(before);
      expect(h.changes).toHaveLength(told);
    });
  }

  it("stop while the preview copy's session is being opened: when that fails, it is not opened again", async () => {
    const reached = gate();
    const held = gate();
    const h = await harness({
      api: () => ({
        openFile: async () => {
          reached.open();
          await held.opened;
          return failure("network");
        },
      }),
    });
    h.queue.add([videoFile("a.mov", SMALL)]);
    await reached.opened;
    h.queue.stop();
    held.open();
    await aWhile();
    expect(h.called("openFile")).toHaveLength(1);
    expect(h.called("previewFailed")).toEqual([]);
  });

  it("stop while the still picture is on its way: the piece that was being sent is its last", async () => {
    const reached = gate();
    const held = gate();
    const h = await harness({
      options: { chunkBytes: 256 * 1024 }, // the image is twelve pieces, its still picture three
      derive: { preview: null, poster: new Blob([new Uint8Array(600_000)]), previewProblem: null },
      beforePiece: async (nth) => {
        if (nth !== 13) return;
        reached.open();
        await held.opened;
      },
    });
    h.queue.add([imageFile()]);
    await reached.opened;
    h.queue.stop();
    held.open();
    await aWhile();
    expect(h.sentPieces()).toBe(13);
  });

  it("a piece that was on its way when the upload was canceled is the last one sent", async () => {
    const held = gate();
    const h = await harness({ beforePiece: (nth) => (nth === 1 ? held.opened : undefined) });
    h.queue.add([videoFile()]);
    await until(() => h.sentPieces() === 1, "the first piece to be on its way");
    h.queue.cancel(h.queue.items()[0].key);
    const told = h.changes.length;
    held.open();
    await until(async () => (await h.assetCount()) === 0, "the asset to be removed");
    await aWhile();
    expect(h.sentPieces()).toBe(1);
    expect(h.calls.map(([name]) => name)).toEqual(["open", "remove"]);
    expect(h.changes).toHaveLength(told);
  });

  it("stop always ends with one empty list", async () => {
    const h = await harness();
    h.queue.stop();
    expect(h.changes).toEqual([[]]);
  });

  it("stop while a file is being read or an upload is being opened asks for nothing more", async () => {
    const reading = gate<AssetProbe | null>();
    const opening = gate();
    const h = await harness({
      probe: (fileName) => (fileName === "b.mov" ? reading.opened : Promise.resolve(VIDEO.probe)),
      api: (real) => ({
        open: async (input) => {
          const opened = await real.open(input);
          await opening.opened;
          return opened;
        },
      }),
    });
    h.queue.add([videoFile("a.mov", SMALL), videoFile("b.mov", SMALL)]);
    await until(async () => (await h.assetCount()) === 1, "the first upload to be opened");
    h.queue.stop();
    opening.open();
    reading.fail(new DOMException("The request was canceled.", "AbortError")); // what the worker's end does to a file being read
    await aWhile();
    expect(h.calls.map(([name]) => name)).toEqual(["open"]);
    expect(h.sentPieces()).toBe(0);
    expect(h.derives).toEqual([]);
    expect(h.changes.at(-1)).toEqual([]);
    expect(await h.assetCount()).toBe(1);
  });

  it("stop while a file is being read: what was read opens nothing", async () => {
    const reading = gate<AssetProbe | null>();
    const h = await harness({ probe: () => reading.opened });
    h.queue.add([videoFile()]);
    expect(h.stageOf()).toBe("reading");
    h.queue.stop();
    reading.open(VIDEO.probe);
    await aWhile();
    expect(h.calls).toEqual([]);
    expect(h.changes.at(-1)).toEqual([]);
  });

  it("cancel of a finished upload takes its row away and asks the server for nothing", async () => {
    const h = await harness();
    h.queue.add([videoFile("a.mov", SMALL)]);
    await settled(h.queue);
    const asked = h.calls.length;
    h.queue.cancel(h.queue.items()[0].key);
    expect(h.queue.items()).toEqual([]);
    await aWhile();
    expect(h.calls).toHaveLength(asked);
    expect((await listAssets(h.ctx.db, h.ctx.grace))[0]).toMatchObject({ status: "ready", previewStatus: "ready", removed: false });
  });

  it("an upload that held no place makes no extra room when it leaves", async () => {
    const h = await harness({ options: { parallel: 1 }, derive: () => new Promise<Derived>(() => {}) });
    h.queue.add([videoFile("a.mov", SMALL), new File([], "empty.mp4")]);
    await until(() => h.stageOf() === "preview", "the original to be in");
    const [first, empty] = h.queue.items();
    h.queue.cancel(first.key); // in step 5
    h.queue.dismiss(empty.key); // failed
    h.queue.add([videoFile("b.mov", SMALL), videoFile("c.mov", SMALL)]);
    expect(h.queue.items().map((item) => item.stage)).toEqual(["reading", "waiting"]);
    h.queue.stop();
  });

  it("a file being read when the worker ends, with the upload still wanted, fails as one that cannot be read", async () => {
    const h = await harness({ probe: () => Promise.reject(new DOMException("The request was canceled.", "AbortError")) });
    h.queue.add([videoFile()]);
    await settled(h.queue);
    expect(outcome(h.queue.items()[0])).toEqual({ stage: "failed", message: SENTENCES.unreadable, canRetry: false });
  });
});
