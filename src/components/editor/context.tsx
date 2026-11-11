"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import type { ApiFailure, ProjectApi } from "@/lib/editor/api";
import { createClipboard, type ClipboardStore } from "@/lib/editor/clipboard";
import type { EditorState, EditorStore } from "@/lib/editor/store";

type EditorContextValue = { store: EditorStore; api: ProjectApi; clipboard: ClipboardStore };

const EditorContext = createContext<EditorContextValue | null>(null);

const NETWORK: ApiFailure = { ok: false, kind: "network" };

// Used when no API is given, as in tests: every request fails as if the network were down.
const OFFLINE_API: ProjectApi = {
  postOps: async () => NETWORK,
  getVersion: async () => NETWORK,
  getOpsSince: async () => NETWORK,
  getProject: async () => NETWORK,
};

type EditorProviderProps = { store: EditorStore; api?: ProjectApi; clipboard?: ClipboardStore; children: ReactNode };

// Without a clipboard, as in tests, copied clips are kept in memory.
export function EditorProvider({ store, api, clipboard, children }: EditorProviderProps) {
  const [memoryClipboard] = useState(createClipboard);
  const value = useMemo(
    () => ({ store, api: api ?? OFFLINE_API, clipboard: clipboard ?? memoryClipboard }),
    [store, api, clipboard, memoryClipboard],
  );
  return <EditorContext value={value}>{children}</EditorContext>;
}

function useEditorContext(): EditorContextValue {
  const value = useContext(EditorContext);
  if (!value) throw new Error("Editor components must be inside an EditorProvider.");
  return value;
}

// Reads from the editor store and re-renders when the selected value changes. The selector must
// return a primitive or an existing reference; wrap derived arrays and objects in useShallow.
export function useEditor<T>(selector: (state: EditorState) => T): T {
  return useStore(useEditorContext().store, selector);
}

export function useEditorStore(): EditorStore {
  return useEditorContext().store;
}

export function useEditorApi(): ProjectApi {
  return useEditorContext().api;
}

export function useClipboard(): ClipboardStore {
  return useEditorContext().clipboard;
}
