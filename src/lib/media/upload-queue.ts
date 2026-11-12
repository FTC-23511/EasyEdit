import { nanoid } from "nanoid";
import { LIMITS } from "@/lib/limits";
import type { MediaApi, MediaFailure } from "./api";
import type { Derived, Ingest } from "./ingest-protocol";
import { FILE_REFUSALS, MEDIA_MESSAGES } from "./messages";
import { checkFile, probeFits } from "./rules";
import type { AssetKind, AssetProbe, AssetView, UploadItem } from "./types";
import { sendFile, type UploadTransport } from "./uploader";

export type QueueDeps = {
  api: MediaApi;
  ingest: Ingest;
  transport: UploadTransport;
  sleep(ms: number): Promise<void>;
  onChange(items: UploadItem[]): void; // after every change, with a new array
  onAsset(asset: AssetView): void; // whenever the server returns the asset's newer state
  onPreviewFile(fileId: string, blob: Blob): void; // the finished preview copy or still picture, so this browser need not download its own file
  event(): string | undefined; // the event to give new uploads
  chunkBytes?: number;
  parallel?: number;
  genKey?: () => string;
};

export type UploadQueue = {
  add(files: File[]): void;
  cancel(key: string): void; // stops it and removes the row; an unfinished asset is removed on the server
  retry(key: string): void; // only a failed item that can be retried
  resume(): void; // retries every item that failed for the network; called when the connection returns
  dismiss(key: string): void; // removes a finished or failed row
  stop(): void; // for leaving the editor: aborts everything running and empties the list; removes nothing on the server
  items(): UploadItem[];
  active(): number; // items not yet done or failed
};

// How a failed upload reads, and what can be done about it. network: resume() tries it again.
type Failure = { message: string; canRetry: boolean; network: boolean };

const final = (message: string): Failure => ({ message, canRetry: false, network: false });
const STOPPED: Failure = { message: MEDIA_MESSAGES.uploadStopped, canRetry: true, network: true };
const EXPIRED: Failure = { message: MEDIA_MESSAGES.uploadExpired, canRetry: true, network: false };

// What a call that our server did not answer with success makes of the upload.
function failureOf(answer: MediaFailure): Failure {
  switch (answer.kind) {
    case "network":
      return STOPPED;
    case "storage":
      return { message: MEDIA_MESSAGES.storageDown, canRetry: true, network: true };
    case "signed-out":
      return { message: MEDIA_MESSAGES.signedOut, canRetry: true, network: false };
    case "forbidden":
      return { message: MEDIA_MESSAGES.lostAccess, canRetry: true, network: false };
    case "refused":
    case "not-set-up":
      // Our server always says why. A refusal with no sentence came from something in between, so it is the network's.
      return answer.message === "" ? STOPPED : final(answer.message);
  }
}

// What a derive that ended without its answer has made: the worker was ended under it.
const NOTHING_MADE: Derived = { preview: null, poster: null, previewProblem: "failed" };

type Entry = {
  item: UploadItem; // replaced, never changed, so one that was handed out stays as it was
  file: File;
  kind: AssetKind | null; // null: not a file the library takes
  probe: AssetProbe | null; // what was read from the file, once it has been
  holdsPlace: boolean; // in steps 2 to 4
  ready: boolean; // the server has said the original is in
  network: boolean; // it is failed, and for the network
  left: "canceled" | "dropped" | null; // out of the list: canceled, or dismissed or stopped
  sends: AbortController; // ends the requests of the try that is running
  derive: { made: Promise<Derived>; stop: AbortController } | null; // started once and kept for a retry; null again when its files are sent, or never will be
};

// The uploads of one open editor. Each file goes through these steps:
//   1 waiting    the name and the size are checked
//   2 reading    the worker reads what the file holds
//   3 uploading  the server opens the upload, and the file goes to Drive in pieces
//   4 finishing  the server is told the file is whole
//   5 preview    the preview copy and the still picture the worker made are sent
// At most `parallel` files are in steps 2 to 4 at once, and the worker makes one file's copies at a time.
export function createUploadQueue(deps: QueueDeps): UploadQueue {
  const { api, ingest, transport, sleep } = deps;
  const chunkBytes = deps.chunkBytes ?? LIMITS.mediaChunkBytes;
  const parallel = deps.parallel ?? LIMITS.mediaParallelUploads;
  const genKey = deps.genKey ?? (() => nanoid(10));

  let entries: Entry[] = [];
  let placesTaken = 0;
  let deriveTurn: Promise<void> = Promise.resolve(); // settles when the worker is free for the next file

  const items = () => entries.map((entry) => entry.item);
  const emit = () => deps.onChange(items());
  const find = (key: string) => entries.find((entry) => entry.item.key === key);
  const drop = (entry: Entry) => void (entries = entries.filter((other) => other !== entry));

  function change(entry: Entry, patch: Partial<UploadItem>) {
    if (entry.left) return;
    const keys = Object.keys(patch) as (keyof UploadItem)[];
    if (keys.every((key) => entry.item[key] === patch[key])) return;
    entry.item = { ...entry.item, ...patch };
    emit();
  }

  function release(entry: Entry) {
    if (!entry.holdsPlace) return;
    entry.holdsPlace = false;
    placesTaken -= 1;
  }

  // Takes an entry out of the list's work: nothing is sent or asked for it from here on.
  function leave(entry: Entry, how: "canceled" | "dropped") {
    entry.left = how;
    entry.sends.abort();
    entry.derive?.stop.abort();
    release(entry);
  }

  function fail(entry: Entry, failure: Failure) {
    if (!failure.canRetry) {
      // Nothing will send what the worker makes, or has made.
      entry.derive?.stop.abort();
      entry.derive = null;
    }
    release(entry);
    entry.network = failure.network;
    change(entry, { stage: "failed", message: failure.message, canRetry: failure.canRetry });
    startWaiting();
  }

  // Has the worker make the preview copy and the still picture, once it is done with the file before.
  function startDerive(entry: Entry, probe: AssetProbe) {
    const stop = new AbortController();
    const before = deriveTurn;
    const made = before
      .then(() => (stop.signal.aborted ? NOTHING_MADE : ingest.derive(entry.file, probe, (fraction) => change(entry, { previewFraction: fraction }), stop.signal)))
      .catch(() => NOTHING_MADE);
    // This one is over when it has its answer, or is given up.
    const over = new Promise<void>((next) => {
      void made.then(() => next());
      stop.signal.addEventListener("abort", () => next(), { once: true });
    });
    // The next file's turn comes then, and not before this one's own turn has come: one that is given up while it
    // waits leaves the worker busy with the file before it.
    deriveTurn = before.then(() => over);
    entry.derive = { made, stop };
  }

  // Sends the preview copy or the still picture to a session of its own. One that fails is tried once more, from
  // its first byte: the offset route answers only for the original, so nothing is asked and nothing is resumed.
  async function sendMade(entry: Entry, assetId: string, role: "preview" | "poster", blob: Blob, signal: AbortSignal): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const opened = await api.openFile(assetId, role, blob.size);
      if (entry.left) return false;
      if (!opened.ok) continue;
      const sent = await sendFile(blob, { uploadUrl: opened.uploadUrl, offset: 0 }, { transport, sleep, chunkBytes, signal, askOffset: async () => null, onProgress: () => {} });
      if (entry.left) return false;
      if (!sent.ok) continue;
      const completed = await api.completeFile(assetId, role);
      if (entry.left) return false;
      if (!completed.ok) continue;
      deps.onAsset(completed.asset);
      const fileId = role === "preview" ? completed.asset.previewFileId : completed.asset.posterFileId;
      if (fileId !== null) deps.onPreviewFile(fileId, blob);
      return true;
    }
    return false;
  }

  // Steps 2 to 5 for an entry that has a place. After every wait it looks whether the entry is still in the list.
  async function run(entry: Entry, kind: AssetKind) {
    const { file } = entry;

    let probe = entry.probe;
    if (!probe) {
      change(entry, { stage: "reading" });
      const read = await ingest.probe(file, file.name).catch(() => null); // it rejects only when the worker is ended
      if (entry.left) return;
      if (!read || !probeFits(kind, read)) return fail(entry, final(FILE_REFUSALS.unreadable));
      probe = entry.probe = read;
    }

    const sends = (entry.sends = new AbortController());
    change(entry, { stage: "uploading" });
    const opened = await api.open({ fileName: file.name, sizeBytes: file.size, mimeType: file.type, lastModifiedMs: file.lastModified, probe, event: deps.event() });
    if (entry.left) {
      // Canceled while the upload was being opened: only now is there an asset to remove.
      if (entry.left === "canceled" && opened.ok) void api.remove(opened.asset.id);
      return;
    }
    if (!opened.ok) return fail(entry, failureOf(opened));
    const assetId = opened.asset.id;
    change(entry, { assetId, sentBytes: opened.offset }); // a resumed row starts where the upload stopped
    if (kind !== "audio" && !entry.derive) startDerive(entry, probe);

    // An answer of our server to the offset question that is not about the network ends the upload at once.
    const end: { answer: MediaFailure | null } = { answer: null };
    const sent = await sendFile(file, opened, {
      transport,
      sleep,
      chunkBytes,
      signal: sends.signal,
      onProgress: (sentBytes) => change(entry, { sentBytes }),
      askOffset: async () => {
        const held = await api.offset(assetId);
        if (held.ok) return { offset: held.offset, done: held.done };
        if (held.kind !== "network" && held.kind !== "storage") {
          end.answer = held;
          sends.abort();
        }
        return null;
      },
    });
    if (entry.left) return;
    // Refused: the server no longer has this upload (its session expired, or it was removed), so a retry opens a new one.
    if (end.answer) return fail(entry, end.answer.kind === "refused" ? EXPIRED : failureOf(end.answer));
    if (!sent.ok && sent.reason === "refused") {
      // Drive will not take this file in this session. The asset goes, as for a cancel, before the row says so:
      // choosing the file again then opens a new upload and does not go back to that session.
      const removed = await api.remove(assetId);
      if (removed.ok) change(entry, { assetId: null });
      return fail(entry, final(MEDIA_MESSAGES.uploadRefused));
    }
    if (!sent.ok) return fail(entry, sent.reason === "expired" ? EXPIRED : STOPPED);

    change(entry, { stage: "finishing", sentBytes: file.size }); // the answer to the last piece may have been lost
    const completed = await api.complete(assetId);
    if (entry.left) return;
    if (!completed.ok) return fail(entry, failureOf(completed));
    entry.ready = true;
    deps.onAsset(completed.asset);

    // The original is in. What follows holds no place, so the next file starts while the copies are made and sent.
    release(entry);
    const { derive } = entry;
    change(entry, { stage: derive ? "preview" : "done" });
    startWaiting();
    if (!derive) return;

    const made = await derive.made;
    if (entry.left) return;
    change(entry, { previewFraction: 1 });
    let message: string | null = null;
    const previewIn = made.preview !== null && (await sendMade(entry, assetId, "preview", made.preview, sends.signal));
    if (entry.left) return;
    if (kind === "video" && !previewIn) {
      const failed = await api.previewFailed(assetId);
      if (entry.left) return;
      if (failed.ok) deps.onAsset(failed.asset);
      // Another browser may manage a video this one cannot read or cannot write.
      const notHere = made.previewProblem === "cannot-decode" || made.previewProblem === "cannot-encode";
      message = notHere ? MEDIA_MESSAGES.noPreviewHere : MEDIA_MESSAGES.noPreview;
    }
    if (made.poster) await sendMade(entry, assetId, "poster", made.poster, sends.signal);
    entry.derive = null; // the row stays in the list, and should not hold the files that were made
    change(entry, { stage: "done", message });
  }

  // Starts the items that wait, in the order they were added, while there is a place.
  function startWaiting() {
    for (const entry of entries) {
      if (placesTaken >= parallel) return;
      if (entry.item.stage !== "waiting" || !entry.kind) continue;
      entry.holdsPlace = true;
      placesTaken += 1;
      void run(entry, entry.kind);
    }
  }

  // Back in line, to start again at step 3: the server takes up the unfinished upload.
  function again(entry: Entry) {
    entry.network = false;
    change(entry, { stage: "waiting", message: null, canRetry: false });
  }

  return {
    add(files) {
      const before = entries.length;
      for (const file of files) {
        const sameFile = (entry: Entry) => entry.file.name === file.name && entry.file.size === file.size && entry.file.lastModified === file.lastModified;
        if (entries.some((entry) => entry.item.stage !== "done" && sameFile(entry))) continue;
        const checked = checkFile({ name: file.name, sizeBytes: file.size });
        const item: UploadItem = {
          key: genKey(),
          fileName: file.name,
          sizeBytes: file.size,
          stage: checked.ok ? "waiting" : "failed",
          sentBytes: 0,
          previewFraction: 0,
          assetId: null,
          message: checked.ok ? null : FILE_REFUSALS[checked.reason],
          canRetry: false,
        };
        entries = [...entries, { item, file, kind: checked.ok ? checked.kind : null, probe: null, holdsPlace: false, ready: false, network: false, left: null, sends: new AbortController(), derive: null }];
      }
      if (entries.length === before) return;
      emit();
      startWaiting();
    },

    cancel(key) {
      const entry = find(key);
      if (!entry) return;
      const { assetId, stage } = entry.item;
      leave(entry, "canceled");
      drop(entry);
      emit();
      if (assetId !== null) {
        if (!entry.ready) void api.remove(assetId);
        // The server changes nothing unless the preview copy is still awaited.
        else if (stage === "preview") void api.previewFailed(assetId).then((failed) => failed.ok && deps.onAsset(failed.asset));
      }
      startWaiting();
    },

    retry(key) {
      const entry = find(key);
      if (!entry?.item.canRetry) return; // set only on a failed item
      again(entry);
      startWaiting();
    },

    resume() {
      for (const entry of entries) {
        if (entry.network) again(entry);
      }
      startWaiting();
    },

    dismiss(key) {
      const entry = find(key);
      if (!entry || (entry.item.stage !== "done" && entry.item.stage !== "failed")) return;
      leave(entry, "dropped");
      drop(entry);
      emit();
    },

    stop() {
      for (const entry of entries) leave(entry, "dropped");
      entries = [];
      emit();
    },

    items,
    active: () => entries.filter((entry) => entry.item.stage !== "done" && entry.item.stage !== "failed").length,
  };
}
