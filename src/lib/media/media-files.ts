import { LIMITS } from "@/lib/limits";
import { pickEvictions, type CacheEntry } from "./cache-plan";
import { readDriveFile, type ReadProblem, type ReadTokens } from "./read-tokens";

// The playback files this browser keeps, so that a file is read from Drive once and not each time it is wanted.

// Where the files are kept.
export type FileStore = {
  read(fileId: string): Promise<Blob | null>;
  // Resolves once the whole body is stored. If the body fails part way, or the page goes away part way, it rejects (where it still can), and read() gives null and entries() leaves the file out, then and after a reload.
  write(fileId: string, body: Blob | ReadableStream<Uint8Array>): Promise<Blob>;
  remove(fileId: string): Promise<void>;
  entries(): Promise<CacheEntry[]>;
  touch(fileId: string, at: number): Promise<void>;
};

// A store that lasts as long as the page does. A file that was never touched counts as used longest ago.
export function createMemoryStore(): FileStore {
  const files = new Map<string, { blob: Blob; usedAt: number }>();
  return {
    async read(fileId) {
      return files.get(fileId)?.blob ?? null;
    },
    async write(fileId, body) {
      const blob = body instanceof Blob ? body : await new Response(body).blob();
      files.set(fileId, { blob, usedAt: 0 });
      return blob;
    },
    async remove(fileId) {
      files.delete(fileId);
    },
    async entries() {
      return [...files].map(([fileId, { blob, usedAt }]) => ({ fileId, bytes: blob.size, usedAt }));
    },
    async touch(fileId, at) {
      const file = files.get(fileId);
      if (file) file.usedAt = at;
    },
  };
}

export type MediaFiles = {
  get(fileId: string): Promise<{ ok: true; blob: Blob } | { ok: false; problem: ReadProblem }>;
  put(fileId: string, blob: Blob): Promise<void>; // a file this browser made itself
};

type Got = Awaited<ReturnType<MediaFiles["get"]>>;

// How long Drive says the file is, when it says so.
function declaredLength(response: Response): number | null {
  const header = response.headers.get("content-length");
  return header !== null && /^\d+$/.test(header) ? Number(header) : null;
}

// The same body, and whether it broke on the way. A store that fails to take a body that did not break has itself to blame.
function watched(body: ReadableStream<Uint8Array>): { body: ReadableStream<Uint8Array>; broke: () => boolean } {
  const reader = body.getReader();
  let broke = false;
  let stopped = false; // the store gave up on the body: what the download does after that is not the body breaking
  const passedOn = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let read;
      try {
        read = await reader.read();
      } catch (error) {
        if (stopped) return;
        broke = true;
        controller.error(error);
        return;
      }
      if (stopped) return; // a chunk that was on its way when the store gave up has nowhere to go
      if (read.done) controller.close();
      else controller.enqueue(read.value);
    },
    // A store that gives up on the body stops the download.
    cancel: (reason) => {
      stopped = true;
      return reader.cancel(reason);
    },
  });
  return { body: passedOn, broke: () => broke };
}

export function createMediaFiles(deps: { tokens: ReadTokens; store: FileStore; fetch?: typeof fetch; now?: () => number; capBytes?: number }): MediaFiles {
  const { tokens, store } = deps;
  const now = deps.now ?? Date.now;
  const capBytes = deps.capBytes ?? LIMITS.mediaCacheBytes;
  const handedOut = new Set<string>(); // stored files a caller holds: a blob from the store is only good while its file is there
  const arriving = new Map<string, number>(); // files being written, and their bytes: room is held for them, and the store may not list them yet
  const wanted = new Map<string, Promise<Got>>(); // the reads under way, shared by everyone who asks for the same file meanwhile
  const making = new Map<string, Blob>(); // files this browser made that are on their way into the store: Drive need not be asked for them
  let storing = true; // false once the store has lost a file it was being given as it arrived: it is offered no more files
  let turn: Promise<unknown> = Promise.resolve();

  // Looking a file up and making room take turns, so that no file is dropped while it is being handed out.
  function inTurn<T>(work: () => Promise<T>): Promise<T> {
    const done = turn.then(work);
    turn = done.catch(() => undefined);
    return done;
  }

  // Notes that a file was used now. A store that cannot note it still has the file, so the file is no worse for it.
  async function touch(fileId: string): Promise<void> {
    try {
      await store.touch(fileId, now());
    } catch {
      // It counts as used longer ago than it was.
    }
  }

  const fromStore = (fileId: string) =>
    inTurn(async () => {
      const blob = await store.read(fileId);
      if (blob) {
        handedOut.add(fileId);
        await touch(fileId);
      }
      return blob;
    });

  // Makes room for a file of `bytes` and holds it until write() is done. False: the store has the file or is
  // being given it, or it has no room for it without dropping a file in use; nothing was dropped then.
  const makeRoom = (fileId: string, bytes: number) =>
    inTurn(async () => {
      const entries = await store.entries();
      if (arriving.has(fileId) || entries.some((entry) => entry.fileId === fileId)) return false;
      const coming = bytes + [...arriving.values()].reduce((sum, size) => sum + size, 0);
      const drop = pickEvictions(entries, coming, capBytes, new Set([...handedOut, ...arriving.keys()]));
      const left = entries.reduce((sum, entry) => (drop.includes(entry.fileId) ? sum : sum + entry.bytes), 0);
      if (left + coming > capBytes) return false;
      for (const dropped of drop) await store.remove(dropped);
      arriving.set(fileId, bytes);
      return true;
    });

  // Stores a file that room was made for.
  async function write(fileId: string, body: Blob | ReadableStream<Uint8Array>, handOut: boolean): Promise<Blob> {
    try {
      const blob = await store.write(fileId, body);
      if (handOut) handedOut.add(fileId);
      await touch(fileId);
      return blob;
    } finally {
      arriving.delete(fileId);
    }
  }

  // The bytes of an answer from Drive, stored when there is room for them. It throws when the body fails part way.
  // Null: the store was given the bytes as they arrived and lost them, so they have to be read again.
  async function take(fileId: string, response: Response): Promise<Blob | null> {
    if (!storing) return response.blob();
    const declared = declaredLength(response);
    if (declared !== null && response.body) {
      // The length is known before the bytes are here, so they can go to the store as they arrive.
      const room = await makeRoom(fileId, declared).catch(() => false);
      if (!room) return response.blob();
      const arrivingBody = watched(response.body);
      try {
        return await write(fileId, arrivingBody.body, true);
      } catch (error) {
        if (arrivingBody.broke()) throw error;
        // The download was sound and the store failed (a full disk does this). It would fail the next file the
        // same way, and each one would be read twice, so from here on files are only read.
        storing = false;
        return null;
      }
    }
    const whole = await response.blob();
    const room = await makeRoom(fileId, whole.size).catch(() => false);
    // A store that cannot take the file costs nothing here: the bytes have all arrived.
    return room ? write(fileId, whole, true).catch(() => whole) : whole;
  }

  async function load(fileId: string): Promise<Got> {
    // A store that cannot be read is a store without the file.
    const kept = await fromStore(fileId).catch(() => null);
    if (kept) return { ok: true, blob: kept };
    const read = await readDriveFile(fileId, { tokens, fetch: deps.fetch });
    if (!read.ok) return read;
    try {
      const blob = await take(fileId, read.response);
      if (blob) return { ok: true, blob };
      // The store lost the bytes, and Drive still has them: one more read, which the store has no part in.
      const again = await readDriveFile(fileId, { tokens, fetch: deps.fetch });
      if (!again.ok) return again;
      return { ok: true, blob: await again.response.blob() };
    } catch {
      return { ok: false, problem: "offline" }; // the body did not all arrive; nothing of it is kept
    }
  }

  return {
    get(fileId) {
      const made = making.get(fileId);
      if (made) return Promise.resolve({ ok: true, blob: made });
      const under = wanted.get(fileId);
      if (under) return under;
      const reading = load(fileId).finally(() => wanted.delete(fileId)); // a failure is not remembered either
      wanted.set(fileId, reading);
      return reading;
    },
    // Kept when there is room. The caller has the bytes either way, so a store that cannot take them is no failure.
    async put(fileId, blob) {
      if (!storing) return;
      making.set(fileId, blob);
      try {
        if (await makeRoom(fileId, blob.size)) await write(fileId, blob, false);
      } catch {
        // Not kept.
      } finally {
        making.delete(fileId);
      }
    },
  };
}
