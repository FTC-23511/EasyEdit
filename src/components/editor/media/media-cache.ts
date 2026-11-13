import { nanoid } from "nanoid";
import type { CacheEntry } from "@/lib/media/cache-plan";
import type { FileStore } from "@/lib/media/media-files";

// Where this browser keeps the playback files it read from Drive: a folder of the Origin Private File System.
const FOLDER = "media-cache";
// The ingest worker's temporary files (src/workers/ingest.worker.ts, TEMP_FOLDER).
const INGEST_FOLDER = "ingest";
// A file still being written is named `<file id>.<random>.part`, and takes the file id as its name only once it is
// whole. A name without the suffix is therefore always a whole file.
const PART = ".part";
// An unfinished file this old was left by a page that went away; a newer one may belong to another open tab.
export const STALE_MS = 24 * 60 * 60 * 1000;

// The parts of the File System Access API this uses. TypeScript's DOM types have no `move` and no async iteration.
type FileHandle = {
  kind: "file";
  getFile(): Promise<File>;
  createWritable(): Promise<FileSystemWritableFileStream>;
  move(folder: Folder, name: string): Promise<void>;
};
type Folder = {
  kind: "directory";
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandle>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<Folder>;
  removeEntry(name: string): Promise<void>;
  entries(): AsyncIterable<[string, FileHandle | Folder]>;
};

async function filesIn(folder: Folder): Promise<[string, FileHandle][]> {
  const found: [string, FileHandle][] = [];
  for await (const [name, handle] of folder.entries()) if (handle.kind === "file") found.push([name, handle]);
  return found;
}

// Deletes the files that `unfinished` picks and that were last changed before `before`. A file that cannot be read
// or deleted is skipped.
async function clearOld(folder: Folder, unfinished: (name: string) => boolean, before: number): Promise<void> {
  for (const [name, handle] of await filesIn(folder)) {
    if (!unfinished(name)) continue;
    try {
      if ((await handle.getFile()).lastModified < before) await folder.removeEntry(name);
    } catch {
      // Left for the next time.
    }
  }
}

async function wholeFile(folder: Folder, fileId: string): Promise<File | null> {
  try {
    return await (await folder.getFileHandle(fileId)).getFile();
  } catch {
    return null; // not there, or not a name a file can have
  }
}

async function removeQuietly(folder: Folder, name: string): Promise<void> {
  try {
    await folder.removeEntry(name);
  } catch {
    // Already gone, or left for the clearing when a page next opens.
  }
}

// The browser's private file storage as a FileStore. Null where the browser has no such storage, or cannot write a
// file whole before it is named (`createWritable` and `move`): the caller then keeps files in memory.
export async function createOpfsStore(): Promise<FileStore | null> {
  const storage = typeof navigator === "undefined" ? undefined : navigator.storage;
  const handleType = (globalThis as { FileSystemFileHandle?: { prototype: object } }).FileSystemFileHandle;
  if (!storage?.getDirectory || !handleType || !("createWritable" in handleType.prototype) || !("move" in handleType.prototype)) return null;

  let folder: Folder;
  try {
    const root = (await storage.getDirectory()) as unknown as Folder;
    folder = await root.getDirectoryHandle(FOLDER, { create: true });
    const before = Date.now() - STALE_MS;
    await clearOld(folder, (name) => name.endsWith(PART), before);
    const ingest = await root.getDirectoryHandle(INGEST_FOLDER).catch(() => null);
    if (ingest) await clearOld(ingest, () => true, before);
  } catch {
    return null;
  }

  // When each file was last used. Kept in memory: after a reload a file counts as used when it was written.
  const usedAt = new Map<string, number>();

  return {
    read: (fileId) => wholeFile(folder, fileId),

    async write(fileId, body) {
      const partName = `${fileId}.${nanoid(8)}${PART}`;
      try {
        const part = await folder.getFileHandle(partName, { create: true });
        const out = await part.createWritable(); // the file's bytes change only when this is closed
        if (body instanceof Blob) {
          await out.write(body); // a write that fails errors the writable, and nothing reaches the file
          await out.close();
        } else {
          await body.pipeTo(out); // closes it when the body is whole; aborts it, or cancels the body, when either fails
        }
        // Another tab may have stored the same file meanwhile. Its copy is as good as this one.
        const there = await wholeFile(folder, fileId);
        if (there) {
          await removeQuietly(folder, partName);
          return there;
        }
        await part.move(folder, fileId);
        return await part.getFile();
      } catch (error) {
        if (!(body instanceof Blob)) await body.cancel(error).catch(() => {}); // a body never piped still holds its download open
        await removeQuietly(folder, partName);
        throw error;
      }
    },

    async remove(fileId) {
      usedAt.delete(fileId);
      await removeQuietly(folder, fileId);
    },

    async entries() {
      const listed: CacheEntry[] = [];
      try {
        for (const [name, handle] of await filesIn(folder)) {
          if (name.endsWith(PART)) continue;
          try {
            const file = await handle.getFile();
            listed.push({ fileId: name, bytes: file.size, usedAt: usedAt.get(name) ?? file.lastModified });
          } catch {
            // Removed meanwhile.
          }
        }
      } catch {
        // The folder could not be listed: what was found so far.
      }
      return listed;
    },

    async touch(fileId, at) {
      usedAt.set(fileId, at);
    },
  };
}

// A FileStore that is found when it is first used: each method waits for `open` and then calls the store it gave.
// So a FileStore can be handed over at once though finding the browser's storage takes a moment.
export function createSettledStore(open: () => Promise<FileStore>): FileStore {
  let opening: Promise<FileStore> | null = null;
  const settled = () => (opening ??= open());
  return {
    read: async (fileId) => (await settled()).read(fileId),
    write: async (fileId, body) => (await settled()).write(fileId, body),
    remove: async (fileId) => (await settled()).remove(fileId),
    entries: async () => (await settled()).entries(),
    touch: async (fileId, at) => (await settled()).touch(fileId, at),
  };
}
