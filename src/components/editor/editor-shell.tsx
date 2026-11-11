"use client";

import { useEffect, useState } from "react";
import { createProjectApi } from "@/lib/editor/api";
import { createClipboard } from "@/lib/editor/clipboard";
import { createEditorStore } from "@/lib/editor/store";
import { createSync } from "@/lib/editor/sync";
import type { EditorInit } from "@/lib/editor/types";
import { EditorProvider } from "./context";
import { EditorScreen } from "./editor-screen";

const ACTIVITY_THROTTLE_MS = 1000;

// The browser's local storage, looked up on each use: the shell also renders on the server, and
// reaching localStorage can throw where storage is blocked. The clipboard copes with a throw.
const localStore = {
  getItem: (key: string) => window.localStorage.getItem(key),
  setItem: (key: string, value: string) => window.localStorage.setItem(key, value),
};

// Owns the store, the API client and the sync for one open project, and ties the sync to the page:
// tab visibility, coming back online, the user's clicks and keys, and leaving with unsent changes.
export function EditorShell({ initial }: { initial: EditorInit }) {
  const [{ store, api, sync, clipboard }] = useState(() => {
    const store = createEditorStore(initial);
    const api = createProjectApi(initial.projectId);
    const sync = createSync({ store, api, isVisible: () => document.visibilityState === "visible" });
    return { store, api, sync, clipboard: createClipboard(localStore) };
  });

  useEffect(() => {
    let lastActivity = 0;
    const onVisibilityChange = () => sync.visibilityChanged();
    const onOnline = () => sync.retryNow();
    const onActivity = () => {
      const now = Date.now();
      if (now - lastActivity < ACTIVITY_THROTTLE_MS) return;
      lastActivity = now;
      sync.noteActivity();
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (store.getState().queue.length > 0) event.preventDefault();
    };
    // Listened for only while changes are unsent: a beforeunload listener keeps the browser from
    // caching the page for back and forward, which an idle editor should not cost.
    let guarding = false;
    const guardUnload = (unsent: boolean) => {
      if (unsent === guarding) return;
      guarding = unsent;
      if (unsent) window.addEventListener("beforeunload", onBeforeUnload);
      else window.removeEventListener("beforeunload", onBeforeUnload);
    };
    const capture = { capture: true, passive: true };

    sync.start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("online", onOnline);
    window.addEventListener("pointerdown", onActivity, capture);
    window.addEventListener("keydown", onActivity, capture);
    guardUnload(store.getState().queue.length > 0);
    const unsubscribe = store.subscribe((state) => guardUnload(state.queue.length > 0));
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pointerdown", onActivity, capture);
      window.removeEventListener("keydown", onActivity, capture);
      unsubscribe();
      guardUnload(false);
      // Leaving inside the app (a link, the Back button) unmounts the editor without unloading
      // the page, so the edits still queued are sent first.
      sync.stopWhenSent();
    };
  }, [store, sync]);

  return (
    <EditorProvider store={store} api={api} clipboard={clipboard}>
      <EditorScreen />
    </EditorProvider>
  );
}
