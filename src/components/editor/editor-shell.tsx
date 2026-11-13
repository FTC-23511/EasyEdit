"use client";

import { useEffect, useState } from "react";
import { createProjectApi } from "@/lib/editor/api";
import { createClipboard } from "@/lib/editor/clipboard";
import { createEditorStore } from "@/lib/editor/store";
import { createSync } from "@/lib/editor/sync";
import type { EditorInit } from "@/lib/editor/types";
import { docAssetIds } from "@/lib/media/library-store";
import { EditorProvider } from "./context";
import { EditorScreen } from "./editor-screen";
import { MediaProvider, createMediaServices } from "./media/media-context";

const ACTIVITY_THROTTLE_MS = 1000;
const LIBRARY_TIMER_MS = 30_000; // the library store decides whether a tick fetches anything

// The browser's local storage, looked up on each use: the shell also renders on the server, and
// reaching localStorage can throw where storage is blocked. The clipboard copes with a throw.
const localStore = {
  getItem: (key: string) => window.localStorage.getItem(key),
  setItem: (key: string, value: string) => window.localStorage.setItem(key, value),
};

// A refresh or an ensure that fails has nothing to tell the shell: the library store keeps its own problem.
const quietly = (work: Promise<void>) => void work.catch(() => {});

// Owns the store, the API client, the sync and the media services for one open project, and ties them to the page:
// tab visibility, focus, coming back online, the user's clicks and keys, and leaving with unsent changes or running
// uploads.
export function EditorShell({ initial }: { initial: EditorInit }) {
  const [{ store, api, sync, clipboard, media }] = useState(() => {
    const store = createEditorStore(initial);
    const api = createProjectApi(initial.projectId);
    const sync = createSync({ store, api, isVisible: () => document.visibilityState === "visible" });
    return { store, api, sync, clipboard: createClipboard(localStore), media: createMediaServices() };
  });

  useEffect(() => {
    const { library, queue } = media;
    let lastActivity = 0;
    const onVisibilityChange = () => sync.visibilityChanged();
    const onOnline = () => {
      sync.retryNow();
      queue.resume();
    };
    const onFocus = () => {
      quietly(library.getState().refresh("focus"));
      queue.resume();
    };
    const onActivity = () => {
      const now = Date.now();
      if (now - lastActivity < ACTIVITY_THROTTLE_MS) return;
      lastActivity = now;
      sync.noteActivity();
    };
    // Closing the page now would lose edits not yet sent, or stop uploads part way.
    const unsaved = () => store.getState().queue.length > 0 || queue.active() > 0;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (unsaved()) event.preventDefault();
    };
    // Listened for only while something would be lost: a beforeunload listener keeps the browser from
    // caching the page for back and forward, which an idle editor should not cost.
    let guarding = false;
    const guardUnload = (unsent: boolean) => {
      if (unsent === guarding) return;
      guarding = unsent;
      if (unsent) window.addEventListener("beforeunload", onBeforeUnload);
      else window.removeEventListener("beforeunload", onBeforeUnload);
    };
    const capture = { capture: true, passive: true };
    // A file dropped anywhere but the Media tab does nothing; the browser would open it in place of the editor. The
    // tab handles its own drops first. A drag of text or of something on the page is left alone.
    const onFileDrag = (event: DragEvent) => {
      if (event.defaultPrevented || ![...(event.dataTransfer?.types ?? [])].includes("Files")) return;
      event.preventDefault();
    };

    sync.start();
    quietly(library.getState().refresh("open"));
    quietly(library.getState().ensure(docAssetIds(store.getState().doc)));
    // The library is fetched again while the tab is visible; it fetches only while a visible preview is being made.
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") quietly(library.getState().refresh("timer"));
    }, LIBRARY_TIMER_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("online", onOnline);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pointerdown", onActivity, capture);
    window.addEventListener("keydown", onActivity, capture);
    window.addEventListener("dragover", onFileDrag);
    window.addEventListener("drop", onFileDrag);
    guardUnload(unsaved());
    const unsubscribe = store.subscribe((state, before) => {
      guardUnload(unsaved());
      // Each clip's asset is fetched once, so the timeline and the preview know it.
      if (state.doc !== before.doc) quietly(library.getState().ensure(docAssetIds(state.doc)));
    });
    const unsubscribeLibrary = library.subscribe((state, before) => {
      if (state.uploads !== before.uploads) guardUnload(unsaved());
    });
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pointerdown", onActivity, capture);
      window.removeEventListener("keydown", onActivity, capture);
      window.removeEventListener("dragover", onFileDrag);
      window.removeEventListener("drop", onFileDrag);
      unsubscribe();
      unsubscribeLibrary();
      guardUnload(false);
      // Leaving inside the app (a link, the Back button) unmounts the editor without unloading
      // the page, so the edits still queued are sent first. Uploads stop where they are: an unfinished
      // one stays on the server, and is taken up when the same file is chosen again.
      sync.stopWhenSent();
      media.dispose();
    };
  }, [store, sync, media]);

  return (
    <EditorProvider store={store} api={api} clipboard={clipboard}>
      <MediaProvider services={media}>
        <EditorScreen />
      </MediaProvider>
    </EditorProvider>
  );
}
