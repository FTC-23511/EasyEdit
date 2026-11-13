"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useStore } from "zustand";
import { createMediaApi, type MediaApi } from "@/lib/media/api";
import { createIngest } from "@/lib/media/ingest-protocol";
import { createLibraryStore, type LibraryState, type LibraryStore } from "@/lib/media/library-store";
import { createMediaFiles, createMemoryStore, type MediaFiles } from "@/lib/media/media-files";
import { createReadTokens } from "@/lib/media/read-tokens";
import { createUploadQueue, type UploadQueue } from "@/lib/media/upload-queue";
import { createDriveTransport } from "@/lib/media/uploader";
import { createOpfsStore, createSettledStore } from "./media-cache";

// What one open editor uses of the media library. dispose: for leaving the editor; it stops the uploads that run
// (removing nothing on the server) and ends the worker. The services stay usable afterwards.
export type MediaServices = { library: LibraryStore; queue: UploadQueue; files: MediaFiles; dispose(): void };

// A wait between tries of an upload's piece. It always resolves.
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// The real ones for one open editor: the API client, the worker, the token source and the browser's file storage.
// Nothing is asked of the server, the worker or the storage until it is first used.
export function createMediaServices(): MediaServices {
  const api = createMediaApi();
  const library = createLibraryStore({ api });
  const files = createMediaFiles({
    tokens: createReadTokens({ api }),
    store: createSettledStore(async () => (await createOpfsStore().catch(() => null)) ?? createMemoryStore()),
  });
  const ingest = createIngest(() => new Worker(new URL("../../../workers/ingest.worker.ts", import.meta.url), { type: "module" }));
  const queue = createUploadQueue({
    api,
    ingest,
    transport: createDriveTransport(),
    sleep,
    onChange: (items) => library.getState().setUploads(items),
    onAsset: (asset) => library.getState().put(asset), // the member's own uploads need no fetch of the library
    onPreviewFile: (fileId, blob) => void files.put(fileId, blob),
    event: () => library.getState().uploadEvent,
  });
  return {
    library,
    queue,
    files,
    dispose() {
      queue.stop();
      ingest.dispose();
    },
  };
}

// Without a provider, as in tests of other parts of the editor: a library that never loads, a queue that takes
// nothing, and files that cannot be read.
function idleServices(): MediaServices {
  const never = () => new Promise<never>(() => {});
  const api: MediaApi = {
    list: never,
    open: never,
    offset: never,
    complete: never,
    openFile: never,
    completeFile: never,
    previewFailed: never,
    update: never,
    remove: never,
    readToken: never,
  };
  const queue: UploadQueue = {
    add() {},
    cancel() {},
    retry() {},
    resume() {},
    dismiss() {},
    stop() {},
    items: () => [],
    active: () => 0,
  };
  const files: MediaFiles = { get: async () => ({ ok: false, problem: "offline" }), put: async () => {} };
  return { library: createLibraryStore({ api }), queue, files, dispose() {} };
}

const MediaContext = createContext<MediaServices | null>(null);
const IDLE = idleServices();

export function MediaProvider({ services, children }: { services: MediaServices; children: ReactNode }): ReactNode {
  return <MediaContext value={services}>{children}</MediaContext>;
}

export function useMedia(): MediaServices {
  return useContext(MediaContext) ?? IDLE;
}

// Reads from the library store and re-renders when the selected value changes. As with useEditor, the selector must
// return a primitive or an existing reference; wrap derived arrays and objects (visibleAssets) in useShallow.
export function useLibrary<T>(selector: (state: LibraryState) => T): T {
  return useStore(useMedia().library, selector);
}
