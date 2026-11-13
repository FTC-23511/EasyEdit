import { createStore, type StoreApi } from "zustand/vanilla";
import { LIMITS } from "@/lib/limits";
import type { TimelineDoc } from "@/lib/timeline";
import type { MediaApi, MediaFailure, MediaResult } from "./api";
import type { AssetKind, AssetView, UploadItem } from "./types";

export type RefreshReason = "open" | "tab" | "focus" | "timer";

export type LibraryState = {
  assets: Record<string, AssetView>; // every asset this editor knows, removed ones included
  loaded: boolean; // the server has sent the library at least once
  setUp: boolean; // false once the server has said uploads are not set up
  problem: MediaFailure["kind"] | null; // why the last fetch of the library failed
  uploads: UploadItem[];
  query: string;
  kind: AssetKind | "all";
  uploadEvent: string;
  refresh(reason: RefreshReason): Promise<void>;
  ensure(ids: string[]): Promise<void>; // fetches the ids it has not seen
  put(asset: AssetView): void;
  // Each calls the API once and returns its answer. On success the store takes the change; on failure the store is unchanged.
  rename(id: string, name: string): Promise<MediaResult<{ asset: AssetView }>>;
  setEvent(id: string, event: string | null): Promise<MediaResult<{ asset: AssetView }>>;
  remove(id: string): Promise<MediaResult<object>>;
  setUploads(items: UploadItem[]): void;
  setQuery(query: string): void;
  setKind(kind: AssetKind | "all"): void;
  setUploadEvent(event: string): void;
};

export type LibraryStore = StoreApi<LibraryState>;

export const FOCUS_REFRESH_MS = 10_000;
export const PENDING_REFRESH_MS = 30_000;

// What one open editor knows of the media library.
export function createLibraryStore(deps: { api: MediaApi; now?: () => number }): LibraryStore {
  const { api } = deps;
  const now = deps.now ?? Date.now;

  let fetching: Promise<void> | null = null; // the fetch of the library that is in flight
  let fetchBegan: number | null = null; // when the last one began
  const asked = new Set<string>(); // ids asked for one by one since the last fetch, answered or not
  // Ids of assets that came from `ensure`, `put` or a removal and that no fetch has listed since. A fetch keeps
  // them: the list has only what is ready and not removed, and a clip may name an asset that is neither.
  const learned = new Set<string>();
  let changes = 0; // how many changes this editor has taken
  const changedAt = new Map<string, number>(); // the count at each asset's last change

  return createStore<LibraryState>()((set, get) => {
    function take(assets: AssetView[], learn: boolean) {
      if (assets.length === 0) return;
      changes += 1;
      for (const asset of assets) {
        changedAt.set(asset.id, changes);
        if (learn) learned.add(asset.id);
      }
      set((state) => ({ assets: { ...state.assets, ...Object.fromEntries(assets.map((asset) => [asset.id, asset])) } }));
    }

    async function fetchLibrary() {
      const began = changes;
      const answer = await api.list();
      if (!answer.ok) return set({ problem: answer.kind }); // what was there is kept
      asked.clear();
      // An asset that changed here while the list was on its way keeps that change: the server read its rows before.
      const newer = (id: string) => (changedAt.get(id) ?? 0) > began;
      const kept = Object.entries(get().assets).filter(([id]) => learned.has(id) || newer(id));
      const listed = answer.assets.filter((asset) => !newer(asset.id));
      for (const asset of listed) learned.delete(asset.id); // from here on the list says whether it is still there
      set({ assets: Object.fromEntries([...kept, ...listed.map((asset) => [asset.id, asset] as const)]), loaded: true, setUp: answer.setUp, problem: null });
      // A kept asset shown as ready may have been removed since this editor learned it. A removed one is never listed
      // again, so it is asked for by id, and comes back removed.
      const held = new Set(answer.assets.map((asset) => asset.id));
      const unsure = [...learned].filter((id) => {
        const stored = get().assets[id];
        return !held.has(id) && stored?.status === "ready" && !stored.removed;
      });
      for (let from = 0; from < unsure.length; from += LIMITS.mediaIdsPerRequest) {
        const again = await api.list(unsure.slice(from, from + LIMITS.mediaIdsPerRequest));
        if (again.ok) take(again.assets, true);
      }
    }

    async function update(id: string, patch: { name?: string; event?: string | null }) {
      const answer = await api.update(id, patch);
      if (answer.ok) take([answer.asset], false); // a new name or event does not change where the asset is known from
      return answer;
    }

    return {
      assets: {},
      loaded: false,
      setUp: true,
      problem: null,
      uploads: [],
      query: "",
      kind: "all",
      uploadEvent: "",

      refresh(reason) {
        if (fetching) return fetching;
        const sinceLast = fetchBegan === null ? Infinity : now() - fetchBegan;
        if (reason === "focus" && sinceLast < FOCUS_REFRESH_MS) return Promise.resolve();
        if (reason === "timer") {
          const awaited = visibleAssets(get()).some((asset) => asset.previewStatus === "pending");
          if (!awaited || sinceLast < PENDING_REFRESH_MS) return Promise.resolve();
        }
        fetchBegan = now();
        fetching = fetchLibrary().finally(() => void (fetching = null));
        return fetching;
      },

      async ensure(ids) {
        const known = get().assets;
        const wanted = [...new Set(ids)].filter((id) => !Object.hasOwn(known, id) && !asked.has(id));
        for (const id of wanted) asked.add(id); // an id the server does not return stays here, and is not asked for again
        for (let from = 0; from < wanted.length; from += LIMITS.mediaIdsPerRequest) {
          const some = wanted.slice(from, from + LIMITS.mediaIdsPerRequest);
          const answer = await api.list(some);
          if (answer.ok) take(answer.assets, true);
          else for (const id of some) asked.delete(id); // no answer says nothing about them
        }
      },

      put: (asset) => take([asset], true),
      rename: (id, name) => update(id, { name }),
      setEvent: (id, event) => update(id, { event }),

      async remove(id) {
        const answer = await api.remove(id);
        const asset = get().assets[id];
        if (answer.ok && asset) take([{ ...asset, removed: true }], true); // kept, for a clip that still names it
        return answer;
      },

      setUploads: (uploads) => set({ uploads }),
      setQuery: (query) => set({ query }),
      setKind: (kind) => set({ kind }),
      setUploadEvent: (uploadEvent) => set({ uploadEvent }),
    };
  });
}

// Ready, not removed, of the chosen kind, whose name or event holds the query (any case), newest first.
export function visibleAssets(state: LibraryState): AssetView[] {
  const query = state.query.trim().toLowerCase();
  const holds = (text: string | null) => text !== null && text.toLowerCase().includes(query);
  return Object.values(state.assets)
    .filter((asset) => asset.status === "ready" && !asset.removed)
    .filter((asset) => state.kind === "all" || asset.kind === state.kind)
    .filter((asset) => holds(asset.name) || holds(asset.event))
    .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? 1 : -1)); // the server's order
}

// Each asset id once, in document order.
export function docAssetIds(doc: TimelineDoc): string[] {
  const ids = doc.tracks.flatMap((track) => track.clips.flatMap((clip) => (clip.type === "text" ? [] : [clip.assetId])));
  return [...new Set(ids)];
}
