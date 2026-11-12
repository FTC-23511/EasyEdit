import { describe, expect, it } from "vitest";
import { LIMITS } from "@/lib/limits";
import type { MediaApi, MediaFailure } from "@/lib/media/api";
import { FOCUS_REFRESH_MS, PENDING_REFRESH_MS, createLibraryStore, docAssetIds, visibleAssets } from "@/lib/media/library-store";
import type { AssetView, UploadItem } from "@/lib/media/types";
import type { Clip, TimelineDoc, Track } from "@/lib/timeline";

const asset = (id: string, over: Partial<AssetView> = {}): AssetView => ({
  id, kind: "video", name: "IMG_4821", fileName: "IMG_4821.MOV", sizeBytes: 20_000_000, status: "ready", removed: false,
  durationMs: 12_500, width: 1080, height: 1920, fps: 30, hasAudio: true, originalFileId: `o-${id}`, previewStatus: "ready",
  previewFileId: `p-${id}`, posterFileId: `s-${id}`, event: null, uploadedBy: "user-ada", uploadedByName: "Ada Lovelace", createdAt: "2026-11-10T18:40:00.000Z",
  ...over,
});

const REFUSED: MediaFailure = { ok: false, kind: "refused", message: 'Used in 1 project: "Recap". Remove it from that project first.' };

// A pretend server: `held` is every asset it has, removed ones too. Its list is what the real one sends: the
// assets that are not removed. `failing` makes every call answer that failure.
function setup(held: AssetView[] = []) {
  const server = { held, setUp: true, failing: null as MediaFailure | null, takes: 0 }; // takes: how long a list request is on its way, in ms
  const clock = { at: 1_762_900_000_000 };
  const calls: unknown[][] = [];
  const unused = async (): Promise<never> => {
    throw new Error("The library store does not make this call.");
  };
  const api: MediaApi = {
    async list(ids) {
      calls.push(ids ? ["list", ids] : ["list"]);
      clock.at += server.takes;
      if (server.failing) return server.failing;
      const assets = ids ? server.held.filter((one) => ids.includes(one.id)) : server.held.filter((one) => !one.removed);
      return { ok: true, assets, setUp: server.setUp };
    },
    async update(assetId, patch) {
      calls.push(["update", assetId, patch]);
      if (server.failing) return server.failing;
      const changed = { ...server.held.find((one) => one.id === assetId)!, ...patch };
      server.held = server.held.map((one) => (one.id === assetId ? changed : one));
      return { ok: true, asset: changed };
    },
    async remove(assetId) {
      calls.push(["remove", assetId]);
      if (server.failing) return server.failing;
      server.held = server.held.map((one) => (one.id === assetId ? { ...one, removed: true } : one));
      return { ok: true };
    },
    open: unused, offset: unused, complete: unused, openFile: unused, completeFile: unused, previewFailed: unused, readToken: unused,
  };
  const store = createLibraryStore({ api, now: () => clock.at });
  const state = () => store.getState();
  return { store, state, server, clock, calls, lists: () => calls.filter((call) => call[0] === "list") };
}

const ids = (assets: AssetView[]) => assets.map((one) => one.id);

describe("the library store", () => {
  it("starts empty, not loaded, and with nothing wrong", () => {
    const { state, calls } = setup([asset("a1")]);
    expect(state()).toMatchObject({ assets: {}, loaded: false, setUp: true, problem: null, uploads: [], query: "", kind: "all", uploadEvent: "" });
    expect(calls).toEqual([]);
    expect(FOCUS_REFRESH_MS).toBe(10_000);
    expect(PENDING_REFRESH_MS).toBe(30_000);
  });

  it("loads the library", async () => {
    const { state, calls } = setup([asset("a1"), asset("a2", { kind: "image" })]);
    await state().refresh("open");
    expect(state()).toMatchObject({ loaded: true, setUp: true, problem: null });
    expect(state().assets).toEqual({ a1: asset("a1"), a2: asset("a2", { kind: "image" }) });
    expect(calls).toEqual([["list"]]);
  });

  it("shows ready assets newest first, filtered by kind and by a word in the name or event", async () => {
    const { state } = setup([
      asset("video", { name: "IMG_4821", event: "Qualifier 2026-11-08", createdAt: "2026-11-10T18:40:00.000Z" }),
      asset("image", { kind: "image", name: "field", createdAt: "2026-11-10T18:41:00.000Z" }),
      asset("audio", { kind: "audio", name: "theme", createdAt: "2026-11-10T18:42:00.000Z" }),
      asset("mine", { name: "theme, still uploading", status: "uploading", createdAt: "2026-11-10T18:43:00.000Z" }),
      asset("twin", { kind: "audio", name: "kickoff", createdAt: "2026-11-10T18:42:00.000Z" }), // made in the same instant as "audio"
    ]);
    await state().refresh("open");
    state().put(asset("gone", { name: "theme, removed", removed: true, createdAt: "2026-11-10T18:44:00.000Z" }));
    expect(Object.keys(state().assets)).toHaveLength(6);

    expect(ids(visibleAssets(state()))).toEqual(["audio", "twin", "image", "video"]); // newest first, then by id
    state().setKind("video");
    expect(ids(visibleAssets(state()))).toEqual(["video"]);
    state().setKind("image");
    expect(ids(visibleAssets(state()))).toEqual(["image"]);
    state().setKind("all");
    state().setQuery("QUALI");
    expect(ids(visibleAssets(state()))).toEqual(["video"]);
    state().setQuery("the");
    expect(ids(visibleAssets(state()))).toEqual(["audio"]); // not the unfinished and the removed ones, which hold it too
    state().setQuery("  IMG_48 ");
    expect(ids(visibleAssets(state()))).toEqual(["video"]);
    state().setQuery("the");
    state().setKind("video");
    expect(visibleAssets(state())).toEqual([]);
  });

  it("refreshes on focus at most every 10 s", async () => {
    const { state, clock, lists } = setup();
    await state().refresh("focus");
    clock.at += 9_000;
    await state().refresh("focus");
    expect(lists()).toHaveLength(1);
    clock.at += 1_000;
    await state().refresh("focus");
    expect(lists()).toHaveLength(2);
  });

  it("counts the 10 s from when the last fetch began", async () => {
    const { state, server, clock, lists } = setup();
    server.takes = 4_000;
    await state().refresh("focus");
    clock.at += 5_999;
    await state().refresh("focus");
    expect(lists()).toHaveLength(1);
    clock.at += 1;
    await state().refresh("focus"); // 6 s after the answer, 10 s after the request
    expect(lists()).toHaveLength(2);
  });

  it("refreshes every time for the editor opening and for the tab", async () => {
    const { state, lists } = setup();
    await state().refresh("open");
    await state().refresh("tab");
    await state().refresh("open");
    expect(lists()).toHaveLength(3);
    await state().refresh("focus"); // measured from when the last fetch began, whatever it was for
    expect(lists()).toHaveLength(3);
  });

  it("the timer refreshes a library that was never fetched, when it holds a preview being made", async () => {
    const { state, lists } = setup();
    await state().refresh("timer");
    expect(lists()).toHaveLength(0);
    state().put(asset("a1", { previewStatus: "pending" }));
    await state().refresh("timer");
    expect(lists()).toHaveLength(1);
  });

  it("the timer refreshes only while a preview is being made", async () => {
    const { state, server, clock, lists } = setup([asset("a1")]);
    await state().refresh("open");
    clock.at += PENDING_REFRESH_MS;
    await state().refresh("timer");
    expect(lists()).toHaveLength(1); // no pending asset

    state().put(asset("gone", { previewStatus: "pending", removed: true })); // not one the member sees
    await state().refresh("timer");
    expect(lists()).toHaveLength(1);

    server.held = [asset("a1"), asset("a2", { previewStatus: "pending" })];
    state().put(asset("a2", { previewStatus: "pending" }));
    await state().refresh("timer");
    expect(lists()).toHaveLength(2);
    clock.at += PENDING_REFRESH_MS - 1;
    await state().refresh("timer");
    expect(lists()).toHaveLength(2); // not 30 s yet
    clock.at += 1;
    await state().refresh("timer");
    expect(lists()).toHaveLength(3);
  });

  it("calls made while a fetch is in flight share it", async () => {
    const { state, lists } = setup([asset("a1")]);
    const all = Promise.all([state().refresh("open"), state().refresh("tab"), state().refresh("focus")]);
    expect(lists()).toHaveLength(1);
    await all;
    expect(state().loaded).toBe(true);
    expect(lists()).toHaveLength(1);
    await state().refresh("tab"); // it is over: the next one fetches
    expect(lists()).toHaveLength(2);
  });

  it("fetches an asset the project names and the editor has not seen", async () => {
    const { state, server, calls } = setup([asset("a1"), asset("a2", { removed: true })]);
    await state().refresh("open");
    expect(Object.keys(state().assets)).toEqual(["a1"]);

    await state().ensure(["a1", "a2", "a2"]);
    expect(calls).toEqual([["list"], ["list", ["a2"]]]);
    expect(state().assets.a2).toEqual(asset("a2", { removed: true }));
    await state().ensure(["a2"]);
    await state().ensure([]);
    expect(calls).toHaveLength(2);

    const before = state().assets;
    await state().ensure(["made-up"]); // the server does not return it
    await state().ensure(["made-up", "a1"]);
    expect(state().assets).toBe(before); // nothing was learned, so nothing is said to have changed
    expect(calls).toEqual([["list"], ["list", ["a2"]], ["list", ["made-up"]]]);
    expect(Object.keys(state().assets)).toEqual(["a1", "a2"]);

    await state().refresh("tab"); // a full refresh: an id the server did not know may be asked for once more
    await state().ensure(["made-up"]);
    await state().ensure(["made-up"]);
    expect(calls.slice(3)).toEqual([["list"], ["list", ["made-up"]]]);

    server.held = [...server.held, asset("made-up")];
    await state().refresh("tab");
    await state().ensure(["made-up"]); // it came with the list
    expect(calls.slice(5)).toEqual([["list"]]);
  });

  it("an id asked for while its request is in flight is not asked for twice", async () => {
    const { state, calls } = setup([asset("a2", { removed: true })]);
    await Promise.all([state().ensure(["a2"]), state().ensure(["a2"])]);
    expect(calls).toEqual([["list", ["a2"]]]);
  });

  it("asks for at most 200 ids in one request", async () => {
    const { state, calls } = setup();
    const many = Array.from({ length: 450 }, (_, index) => `id-${index}`);
    await state().ensure(many.slice(0, LIMITS.mediaIdsPerRequest));
    expect(calls).toEqual([["list", many.slice(0, 200)]]); // one request when there are 200 or fewer
    await state().ensure(many);
    expect(calls.slice(1)).toEqual([["list", many.slice(200, 400)], ["list", many.slice(400)]]);
  });

  it("an id whose request failed is asked for again", async () => {
    const { state, server, calls } = setup([asset("a2", { removed: true })]);
    server.failing = { ok: false, kind: "network", message: "" };
    await state().ensure(["a2"]);
    expect(state()).toMatchObject({ assets: {}, problem: null }); // `problem` is for the library's own fetch
    server.failing = null;
    await state().ensure(["a2"]);
    expect(calls).toHaveLength(2);
    expect(state().assets.a2).toMatchObject({ removed: true });
  });

  it("keeps a removed asset it learned by id", async () => {
    const { state } = setup([asset("a1"), asset("a2", { removed: true })]);
    await state().ensure(["a2"]);
    await state().refresh("tab");
    expect(state().assets.a2).toEqual(asset("a2", { removed: true }));
    expect(ids(visibleAssets(state()))).toEqual(["a1"]);
  });

  it("a fetch takes the server's list for the assets it holds, and drops one that left the list", async () => {
    const { state, server } = setup([asset("a1"), asset("a2")]);
    await state().refresh("open");
    state().put(asset("a1", { name: "Mine, a moment ago" })); // this member's own upload, as the queue reports it
    server.held = [asset("a1", { name: "Renamed by a teammate" }), asset("a2", { removed: true })];
    await state().refresh("tab");
    expect(state().assets).toEqual({ a1: asset("a1", { name: "Renamed by a teammate" }) }); // a2 was removed by a teammate

    await state().rename("a1", "Renamed here"); // a new name does not make it one the store holds on to
    expect(state().assets.a1.name).toBe("Renamed here");
    server.held = [asset("a1", { removed: true })]; // once the list has held an asset, the list says whether it is still there
    await state().refresh("tab");
    expect(state().assets).toEqual({});
  });

  it("a removed asset that was renamed before stays one the store holds on to", async () => {
    const { state, server } = setup([asset("a1")]);
    await state().refresh("open");
    await state().setEvent("a1", "Scrimmage");
    await state().remove("a1");
    await state().refresh("tab");
    expect(state().assets.a1).toMatchObject({ event: "Scrimmage", removed: true });
    expect(server.held[0].removed).toBe(true);
  });

  it("keeps an asset that was put and that the list does not hold", async () => {
    const { state } = setup([asset("a1")]);
    state().put(asset("up", { status: "uploading", originalFileId: null }));
    await state().refresh("open");
    await state().refresh("tab");
    expect(Object.keys(state().assets).sort()).toEqual(["a1", "up"]);
  });

  it("renames, sets the event and removes through the API", async () => {
    const { state, server, calls } = setup([asset("a1", { event: "Qualifier 2026-11-08" }), asset("a2")]);
    await state().refresh("open");

    expect(await state().rename("a1", "Climb, take 2")).toEqual({ ok: true, asset: asset("a1", { name: "Climb, take 2", event: "Qualifier 2026-11-08" }) });
    expect(calls.at(-1)).toEqual(["update", "a1", { name: "Climb, take 2" }]);
    expect(state().assets.a1.name).toBe("Climb, take 2");

    expect(await state().setEvent("a1", null)).toMatchObject({ ok: true });
    expect(calls.at(-1)).toEqual(["update", "a1", { event: null }]);
    expect(state().assets.a1).toMatchObject({ name: "Climb, take 2", event: null });
    await state().setEvent("a1", "Scrimmage");
    expect(calls.at(-1)).toEqual(["update", "a1", { event: "Scrimmage" }]);
    expect(state().assets.a1.event).toBe("Scrimmage");

    expect(await state().remove("a1")).toEqual({ ok: true });
    expect(calls.filter((call) => call[0] === "remove")).toEqual([["remove", "a1"]]);
    expect(state().assets.a1).toMatchObject({ id: "a1", name: "Climb, take 2", removed: true });
    expect(ids(visibleAssets(state()))).toEqual(["a2"]);
    await state().refresh("tab"); // a clip may still name it
    expect(state().assets.a1).toMatchObject({ removed: true });

    expect(await state().remove("never-seen")).toEqual({ ok: true }); // the store has nothing to mark
    expect(Object.keys(state().assets).sort()).toEqual(["a1", "a2"]);

    const before = state().assets;
    server.failing = REFUSED;
    expect(await state().rename("a2", "Nope")).toEqual(REFUSED);
    expect(await state().setEvent("a2", "Nope")).toEqual(REFUSED);
    expect(await state().remove("a2")).toEqual(REFUSED);
    expect(state().assets).toBe(before);
    expect(state().problem).toBeNull();
    expect(ids(visibleAssets(state()))).toEqual(["a2"]);
  });

  it("says when uploads are not set up, and when the library cannot be loaded", async () => {
    const { state, server } = setup([asset("a1")]);
    server.setUp = false;
    await state().refresh("open");
    expect(state()).toMatchObject({ loaded: true, setUp: false, problem: null });
    expect(state().assets).toEqual({ a1: asset("a1") });

    server.failing = { ok: false, kind: "network", message: "" };
    await state().refresh("tab");
    expect(state()).toMatchObject({ loaded: true, setUp: false, problem: "network" });
    expect(state().assets).toEqual({ a1: asset("a1") });

    server.failing = null;
    server.setUp = true;
    await state().refresh("tab");
    expect(state()).toMatchObject({ setUp: true, problem: null }); // the next fetch that works clears it
  });

  it("a library that could not be loaded the first time is not loaded", async () => {
    const { state, server } = setup([asset("a1")]);
    server.failing = { ok: false, kind: "signed-out", message: "Sign in to continue." };
    await state().refresh("open");
    expect(state()).toMatchObject({ loaded: false, problem: "signed-out", assets: {} });
  });

  it("holds the uploads, the search, the kind and the event for new uploads", () => {
    const { state, store } = setup();
    const uploads: UploadItem[] = [{ key: "k1", fileName: "IMG_4821.MOV", sizeBytes: 20_000_000, stage: "uploading", sentBytes: 8_400_000, previewFraction: 0, assetId: "a1", message: null, canRetry: false }];
    let told = 0;
    store.subscribe(() => void told++);
    state().setUploads(uploads);
    state().setQuery("climb");
    state().setKind("audio");
    state().setUploadEvent("Qualifier 2026-11-08");
    expect(state()).toMatchObject({ uploads, query: "climb", kind: "audio", uploadEvent: "Qualifier 2026-11-08" });
    expect(told).toBe(4);
  });

  it("finds the asset ids a project uses", () => {
    const transform = { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1, fit: "cover" as const };
    const clip = (id: string, assetId: string, type: "video" | "audio" = "video"): Clip => ({ id, type, assetId, start: 0, duration: 90, in: 0, speed: 1, volume: 1, transform });
    const text: Clip = { id: "t1", type: "text", start: 0, duration: 60, transform, text: "a9", style: { fontFamily: "Geist", fontSize: 64, fontWeight: 600, color: "#ffffff", align: "center" } };
    const track = (id: string, kind: Track["kind"], clips: Clip[]): Track => ({ id, kind, name: id, muted: false, hidden: false, locked: false, clips });
    const doc: TimelineDoc = {
      schemaVersion: 1, format: "short_9x16", width: 1080, height: 1920, fps: 30,
      tracks: [track("t", "text", [text]), track("v", "video", [clip("c1", "a1"), clip("c2", "a2"), clip("c3", "a1")]), track("a", "audio", [clip("c4", "a3", "audio"), clip("c5", "a2", "audio")])],
    };
    expect(docAssetIds(doc)).toEqual(["a1", "a2", "a3"]);
    expect(docAssetIds({ ...doc, tracks: [] })).toEqual([]);
  });
});
