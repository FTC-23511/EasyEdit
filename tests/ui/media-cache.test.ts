import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STALE_MS, createOpfsStore, createSettledStore } from "@/components/editor/media/media-cache";
import { createMemoryStore, type FileStore } from "@/lib/media/media-files";

const notFound = () => new DOMException("Not found.", "NotFoundError");
let clock = 0;

type Entry = { handle: FakeFileHandle; blob: Blob; lastModified: number };

// The browser's private file storage, as far as the store uses it. A writable's bytes reach the file only when it
// is closed, as with a real one, and a file handle can be moved to another name.
class FakeFolder {
  readonly kind = "directory";
  files = new Map<string, Entry>();
  folders = new Map<string, FakeFolder>();
  stuck = new Set<string>(); // names that cannot be removed
  failWrites = false; // a full disk

  async getFileHandle(name: string, options?: { create?: boolean }) {
    const entry = this.files.get(name);
    if (entry) return entry.handle;
    if (!options?.create) throw notFound();
    const handle = new FakeFileHandle(this, name);
    this.files.set(name, { handle, blob: new Blob([]), lastModified: clock });
    return handle;
  }
  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    let folder = this.folders.get(name);
    if (!folder) {
      if (!options?.create) throw notFound();
      folder = new FakeFolder();
      this.folders.set(name, folder);
    }
    return folder;
  }
  async removeEntry(name: string) {
    if (this.stuck.has(name)) throw new DOMException("In use.", "NoModificationAllowedError");
    if (!this.files.delete(name) && !this.folders.delete(name)) throw notFound();
  }
  async *entries(): AsyncGenerator<[string, FakeFileHandle | FakeFolder]> {
    for (const [name, entry] of [...this.files]) yield [name, entry.handle];
    for (const [name, folder] of [...this.folders]) yield [name, folder];
  }
  // A file as a page would have left it.
  put(name: string, text: string, lastModified: number) {
    this.files.set(name, { handle: new FakeFileHandle(this, name), blob: new Blob([text]), lastModified });
  }
}

class FakeFileHandle {
  readonly kind = "file";
  constructor(
    public folder: FakeFolder,
    public name: string,
  ) {}
  private entry(): Entry {
    const entry = this.folder.files.get(this.name);
    if (!entry || entry.handle !== this) throw notFound();
    return entry;
  }
  async getFile() {
    const { blob, lastModified } = this.entry();
    return new File([blob], this.name, { lastModified });
  }
  async createWritable() {
    const parts: BlobPart[] = [];
    const folder = this.folder;
    const stream = new WritableStream<BlobPart>({
      write: (chunk) => {
        if (folder.failWrites) throw new DOMException("The disk is full.", "QuotaExceededError");
        parts.push(chunk);
      },
      close: () => {
        const entry = this.entry();
        entry.blob = new Blob(parts);
        entry.lastModified = clock;
      },
    });
    return Object.assign(stream, {
      async write(data: BlobPart) {
        const writer = stream.getWriter();
        try {
          await writer.write(data);
        } finally {
          writer.releaseLock();
        }
      },
    });
  }
  async move(folder: FakeFolder, name: string) {
    const entry = this.entry();
    this.folder.files.delete(this.name);
    folder.files.set(name, entry);
    this.folder = folder;
    this.name = name;
  }
}

let root: FakeFolder;
const cache = () => root.folders.get("media-cache")!;
const names = (folder: FakeFolder) => [...folder.files.keys()].sort();
const text = async (blob: Blob | null) => (blob ? await blob.text() : null);

// A body that arrives when the test says so.
function arriving() {
  let control!: ReadableStreamDefaultController<Uint8Array>;
  const canceled: unknown[] = [];
  const body = new ReadableStream<Uint8Array>({
    start: (c) => void (control = c),
    cancel: (reason) => void canceled.push(reason),
  });
  const bytes = (s: string) => control.enqueue(new TextEncoder().encode(s));
  return { body, bytes, end: () => control.close(), fail: () => control.error(new TypeError("The network connection was lost.")), canceled };
}

beforeEach(() => {
  clock = 10 * STALE_MS;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  root = new FakeFolder();
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } });
  vi.stubGlobal("FileSystemFileHandle", FakeFileHandle);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createOpfsStore", () => {
  it("is null where the browser has no such storage, or cannot write a file whole before naming it", async () => {
    vi.stubGlobal("navigator", {});
    expect(await createOpfsStore()).toBeNull();
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } });
    vi.stubGlobal("FileSystemFileHandle", class { createWritable() {} });
    expect(await createOpfsStore()).toBeNull(); // no move
    vi.stubGlobal("FileSystemFileHandle", class { move() {} });
    expect(await createOpfsStore()).toBeNull(); // no createWritable
    vi.stubGlobal("FileSystemFileHandle", undefined);
    expect(await createOpfsStore()).toBeNull();
    vi.stubGlobal("FileSystemFileHandle", FakeFileHandle);
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => Promise.reject(new DOMException("Blocked.", "SecurityError")) } });
    expect(await createOpfsStore()).toBeNull();
  });

  it("a file arriving is neither read nor listed until it is whole", async () => {
    const store = (await createOpfsStore())!;
    const download = arriving();
    const written = store.write("f1", download.body);
    download.bytes("abc");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await store.read("f1")).toBeNull();
    expect(await store.entries()).toEqual([]);
    expect(names(cache())).toHaveLength(1); // the unfinished file, under a name of its own
    download.bytes("def");
    download.end();
    expect(await text(await written)).toBe("abcdef");
    expect(await text(await store.read("f1"))).toBe("abcdef");
    expect(names(cache())).toEqual(["f1"]);
    expect(await store.entries()).toEqual([{ fileId: "f1", bytes: 6, usedAt: clock }]);
    await store.touch("f1", clock + 5);
    expect(await store.entries()).toEqual([{ fileId: "f1", bytes: 6, usedAt: clock + 5 }]);
  });

  it("a download cut off part way leaves nothing", async () => {
    const store = (await createOpfsStore())!;
    const download = arriving();
    const written = store.write("f1", download.body);
    download.bytes("abc");
    download.fail();
    await expect(written).rejects.toThrow("The network connection was lost.");
    expect(await store.read("f1")).toBeNull();
    expect(await store.entries()).toEqual([]);
    expect(names(cache())).toEqual([]);
  });

  it("a disk that fills up stops the download and leaves nothing", async () => {
    const store = (await createOpfsStore())!;
    cache().failWrites = true;
    const download = arriving();
    const written = store.write("f1", download.body);
    download.bytes("abc");
    await expect(written).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect(download.canceled).toHaveLength(1);
    expect(names(cache())).toEqual([]);
    await expect(store.write("f2", new Blob(["xyz"]))).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect(names(cache())).toEqual([]);
  });

  it("a body that could not be written at all is given up, so its download stops", async () => {
    const store = (await createOpfsStore())!;
    vi.spyOn(cache(), "getFileHandle").mockRejectedValue(new DOMException("The disk is full.", "QuotaExceededError"));
    const download = arriving();
    await expect(store.write("f1", download.body)).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect(download.canceled).toHaveLength(1);
  });

  it("stores a blob, removes what it is told to, and keeps the copy it has", async () => {
    const store = (await createOpfsStore())!;
    expect(await text(await store.write("f1", new Blob(["poster"])))).toBe("poster");
    expect(await text(await store.read("f1"))).toBe("poster");
    expect(await text(await store.write("f1", new Blob(["other"])))).toBe("poster"); // another tab was first
    expect(names(cache())).toEqual(["f1"]);
    await expect(store.remove("nothing")).resolves.toBeUndefined();
    await store.remove("f1");
    expect(await store.read("f1")).toBeNull();
    expect(await store.entries()).toEqual([]);
  });

  it("when it opens, deletes the unfinished files and the worker's files that are more than a day old", async () => {
    const day = STALE_MS;
    const folder = await root.getDirectoryHandle("media-cache", { create: true });
    folder.put("old.abc.part", "x", clock - day - 1);
    folder.put("new.def.part", "x", clock - day + 60_000); // another tab may be writing it
    folder.put("whole", "x", clock - 3 * day); // a stored file stays, however old
    folder.put("stuck.ghi.part", "x", clock - 2 * day);
    folder.stuck.add("stuck.ghi.part");
    const ingest = await root.getDirectoryHandle("ingest", { create: true });
    ingest.put("a.mp4", "x", clock - 2 * day);
    ingest.put("b.mp4", "x", clock - 60_000);
    ingest.put("c.mp4", "x", clock - 2 * day);
    ingest.stuck.add("c.mp4");
    const store = await createOpfsStore();
    expect(store).not.toBeNull();
    expect(names(folder)).toEqual(["new.def.part", "stuck.ghi.part", "whole"]);
    expect(names(ingest)).toEqual(["b.mp4", "c.mp4"]);
    expect(await store!.entries()).toEqual([{ fileId: "whole", bytes: 1, usedAt: clock - 3 * day }]);
  });

  // Chromium lists a file it is writing as `<name>.crswap`, holding the bytes written so far, until the write is closed.
  it("a browser's swap file for an unfinished file is unfinished too: never listed, and cleared when it is old", async () => {
    const day = STALE_MS;
    const folder = await root.getDirectoryHandle("media-cache", { create: true });
    folder.put("old.abc.part.crswap", "x", clock - day - 1); // left by a page that went away
    folder.put("new.def.part.crswap", "xyz", clock - 60_000); // another tab is writing it
    folder.put("whole", "x", clock - 3 * day);
    const store = (await createOpfsStore())!;
    expect(names(folder)).toEqual(["new.def.part.crswap", "whole"]);
    expect(await store.entries()).toEqual([{ fileId: "whole", bytes: 1, usedAt: clock - 3 * day }]);
  });

  it("opens without a worker folder", async () => {
    const store = await createOpfsStore();
    expect(store).not.toBeNull();
    expect(root.folders.has("ingest")).toBe(false);
  });
});

describe("createSettledStore", () => {
  it("finds its store on first use, once, and each method waits for it", async () => {
    const real = createMemoryStore();
    let found!: (store: FileStore) => void;
    const open = vi.fn(() => new Promise<FileStore>((resolve) => (found = resolve)));
    const store = createSettledStore(open);
    expect(open).not.toHaveBeenCalled();
    const written = store.write("f1", new Blob(["abc"]));
    const read = store.read("f1");
    let settled = false;
    void read.then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    found(real);
    expect(await text(await written)).toBe("abc");
    expect(await text(await read)).toBe("abc");
    await store.touch("f1", 7);
    expect(await store.entries()).toEqual([{ fileId: "f1", bytes: 3, usedAt: 7 }]);
    await store.remove("f1");
    expect(await real.read("f1")).toBeNull();
    expect(open).toHaveBeenCalledTimes(1);
  });
});
