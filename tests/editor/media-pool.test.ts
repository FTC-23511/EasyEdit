import { describe, expect, it, vi } from "vitest";
import { MAX_IDLE_ELEMENTS, createMediaPool, upcomingWants, type MediaElement, type MediaPool } from "@/components/editor/media/media-pool";
import { mediaWants, upcomingAssetIds, type MediaWant } from "@/lib/editor/media-plan";
import { createMediaFiles, createMemoryStore } from "@/lib/media/media-files";
import { IMAGE_MAX_SIDE } from "@/lib/media/preview-spec";
import type { AssetView } from "@/lib/media/types";
import { drawFrame } from "@/lib/render/compositor";
import { createEmptyDoc, type Clip, type MediaClip, type TimelineDoc } from "@/lib/timeline";
import { assetView } from "../helpers/media-services";
import { video } from "./fixtures";

// A video or audio element that writes down what is done to it and lets the test fire its events.
type Pretend = MediaElement & { kind: "video" | "audio"; plays: number; pauses: number; loads: number; readyState: number; fire(type: string): void };

function pretendElement(kind: "video" | "audio", behavior: { refuseRate?: boolean; rejectPlay?: boolean }): Pretend {
  const listeners = new Map<string, (() => void)[]>();
  let rate = 1;
  const el: Pretend = {
    kind,
    src: "",
    currentTime: 0,
    volume: 1,
    muted: false,
    paused: true,
    readyState: 0,
    videoWidth: kind === "video" ? 1280 : undefined,
    videoHeight: kind === "video" ? 720 : undefined,
    plays: 0,
    pauses: 0,
    loads: 0,
    get playbackRate() {
      return rate;
    },
    set playbackRate(value: number) {
      if (behavior.refuseRate) throw new DOMException("The rate is not supported.", "NotSupportedError");
      rate = value;
    },
    play() {
      el.plays += 1;
      if (behavior.rejectPlay) return Promise.reject(new DOMException("Not allowed.", "NotAllowedError"));
      (el as { paused: boolean }).paused = false;
      return Promise.resolve();
    },
    pause() {
      el.pauses += 1;
      (el as { paused: boolean }).paused = true;
    },
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeAttribute(name) {
      if (name === "src") el.src = "";
    },
    load() {
      el.loads += 1;
    },
    fire(type) {
      for (const listener of listeners.get(type) ?? []) listener();
    },
  };
  return el;
}

// Everything the timers, the reads and the promises started has run.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const videoAsset = (over: Partial<AssetView> = {}) => assetView({ originalFileId: "o1", previewStatus: "ready", previewFileId: "p1", ...over });
const imageAsset = (over: Partial<AssetView> = {}) =>
  assetView({ id: "i", kind: "image", originalFileId: "img", previewStatus: "none", previewFileId: null, durationMs: null, ...over });

const want = (clipId: string, assetId = "a", over: Partial<MediaWant> = {}): MediaWant =>
  ({ clipId, assetId, type: "video", seconds: 0, rate: 0, volume: 0, ...over });
const clip = (clipId: string, assetId = "a", type: MediaClip["type"] = "video") => video(clipId, 0, 30, { assetId, type }) as MediaClip;

async function setup(
  options: { assets?: AssetView[]; stored?: string[]; loaded?: boolean; element?: { refuseRate?: boolean; rejectPlay?: boolean }; decoding?: Promise<void> } = {},
) {
  const assets = new Map((options.assets ?? [videoAsset()]).map((asset) => [asset.id, asset]));
  const blobs = new Map<string, Blob>();
  const reads: string[] = [];
  const files = createMediaFiles({
    tokens: { get: async () => "token", invalidate() {} },
    store: createMemoryStore(),
    fetch: async (input) => {
      reads.push(String(input));
      return new Response(null, { status: 404 }); // Drive has none of these files
    },
  });
  const put = async (fileId: string) => {
    const blob = new Blob([`file ${fileId}`]);
    blobs.set(fileId, blob);
    await files.put(fileId, blob);
  };
  for (const fileId of options.stored ?? ["o1", "p1"]) await put(fileId);

  const state = { loaded: options.loaded ?? true, clock: 0 };
  const made: Pretend[] = [];
  const addresses: string[] = [];
  const revoked: string[] = [];
  const decodes: [Blob, number][] = [];
  const picture = {} as CanvasImageSource;
  const make = (kind: "video" | "audio") => () => {
    const el = pretendElement(kind, options.element ?? {});
    made.push(el);
    return el;
  };
  const pool = createMediaPool({
    files,
    asset: (id) => assets.get(id),
    loaded: () => state.loaded,
    makeVideo: make("video"),
    makeAudio: make("audio"),
    decodeImage: async (blob, maxSide) => {
      decodes.push([blob, maxSide]);
      await options.decoding;
      return { image: picture, width: 2160, height: 1215 };
    },
    objectUrl: (blob) => {
      const fileId = [...blobs].find(([, b]) => b === blob)?.[0] ?? "?";
      const url = `blob:${fileId}#${addresses.length + 1}`;
      addresses.push(url);
      return url;
    },
    revokeUrl: (url) => revoked.push(url),
    now: () => state.clock,
  });
  const changes = vi.fn();
  pool.onChange(changes);
  // As the preview does: what is wanted is synced, and synced again once something new can be drawn.
  const syncSettled = async (wants: MediaWant[]) => {
    pool.sync(wants);
    await settle();
    pool.sync(wants);
  };
  return { pool, made, addresses, revoked, decodes, picture, reads, changes, state, assets, put, syncSettled };
}

describe("the media pool", () => {
  it("loads the playback file and shows the picture once the element has data", async () => {
    const h = await setup();
    h.pool.sync([want("c1")]);
    expect(h.pool.resolveSource(clip("c1"), 0)).toBeNull();
    expect(h.pool.label(clip("c1"))).toBe("Loading");
    expect(h.changes).not.toHaveBeenCalled();
    await settle();
    expect(h.changes).toHaveBeenCalledTimes(1); // the file is here, so an element can be made: the preview syncs again
    h.pool.sync([want("c1")]);
    expect(h.made).toHaveLength(1);
    const [el] = h.made;
    expect(el.kind).toBe("video");
    expect(el.src).toBe(h.addresses[0]);
    expect(h.addresses).toEqual(["blob:p1#1"]); // the preview copy
    expect(h.pool.resolveSource(clip("c1"), 0)).toBeNull();
    expect(h.pool.label(clip("c1"))).toBe("Loading");
    h.changes.mockClear();
    el.readyState = 2;
    el.fire("loadeddata");
    expect(h.changes).toHaveBeenCalledTimes(1);
    expect(h.pool.resolveSource(clip("c1"), 0)).toEqual({ image: el, width: 1280, height: 720 });
  });

  it("two clips of one asset get two elements and one file", async () => {
    const h = await setup();
    await h.syncSettled([want("c1"), want("c2")]);
    expect(h.made).toHaveLength(2);
    expect(h.addresses).toHaveLength(1);
    expect(h.made.map((el) => el.src)).toEqual([h.addresses[0], h.addresses[0]]);
  });

  it("plays, pauses, seeks and sets the volume", async () => {
    const h = await setup();
    const playing = want("c1", "a", { rate: 2, volume: 0.5, seconds: 3 });
    await h.syncSettled([playing]);
    const [el] = h.made;
    expect(el).toMatchObject({ currentTime: 3, playbackRate: 2, volume: 0.5, muted: false, plays: 1, pauses: 0 });
    h.pool.sync([{ ...playing, rate: 0, volume: 0 }]); // what mediaWants gives a clip that stands still
    expect(el).toMatchObject({ pauses: 1, volume: 0, muted: true, currentTime: 3 });
    el.currentTime = 2.95;
    h.pool.sync([playing]);
    expect(el).toMatchObject({ currentTime: 2.95, plays: 2 });
  });

  it("a clip whose media cannot be loaded draws a labeled placeholder and playback goes on", async () => {
    const h = await setup({ assets: [videoAsset(), videoAsset({ id: "b", previewFileId: "p2" })], stored: ["p2"] });
    const wants = [want("c1", "a", { rate: 1, volume: 1 }), want("c2", "b", { rate: 1, volume: 1 })];
    expect(() => h.pool.sync(wants)).not.toThrow();
    await settle();
    expect(() => h.pool.sync(wants)).not.toThrow();
    expect(h.pool.label(clip("c1"))).toBe("Can't load media");
    expect(h.pool.resolveSource(clip("c1"), 0)).toBeNull();
    expect(h.made).toHaveLength(1);
    const [el] = h.made;
    expect(el).toMatchObject({ src: "blob:p2#1", plays: 1 });
    el.readyState = 2;
    el.fire("loadeddata");
    expect(h.pool.resolveSource(clip("c2", "b"), 0)).toEqual({ image: el, width: 1280, height: 720 });
  });

  it("says why there is no file", async () => {
    const h = await setup({
      assets: [videoAsset({ id: "pending", previewStatus: "pending", previewFileId: null }), videoAsset({ id: "gone", removed: true })],
      loaded: false,
    });
    const wants = [want("c1", "pending"), want("c2", "gone"), want("c3", "nobody")];
    await h.syncSettled(wants);
    expect(h.pool.label(clip("c1", "pending"))).toBe("Preparing preview");
    expect(h.pool.label(clip("c2", "gone"))).toBe("Media removed");
    expect(h.pool.label(clip("c3", "nobody"))).toBe("Loading");
    h.state.loaded = true;
    await h.syncSettled(wants);
    expect(h.pool.label(clip("c3", "nobody"))).toBe("Media not found");
    expect(h.made).toEqual([]);
    expect(h.addresses).toEqual([]);
    expect(h.reads).toEqual([]);
  });

  it("shows an image decoded once", async () => {
    const h = await setup({ assets: [imageAsset()], stored: ["img"] });
    h.pool.sync([want("c1", "i", { type: "image" })]);
    expect(h.pool.resolveSource(clip("c1", "i", "image"), 0)).toBeNull();
    expect(h.pool.label(clip("c1", "i", "image"))).toBe("Loading");
    await settle();
    expect(h.changes).toHaveBeenCalled();
    h.pool.sync([want("c2", "i", { type: "image" })]);
    await settle();
    expect(h.decodes).toHaveLength(1);
    expect(h.decodes[0][1]).toBe(IMAGE_MAX_SIDE);
    expect(await h.decodes[0][0].text()).toBe("file img");
    expect(h.pool.resolveSource(clip("c1", "i", "image"), 0)).toEqual({ image: h.picture, width: 2160, height: 1215 });
    expect(h.pool.resolveSource(clip("c2", "i", "image"), 0)).toEqual({ image: h.picture, width: 2160, height: 1215 });
    expect(h.made).toEqual([]);
    expect(h.addresses).toEqual([]);
  });

  it("releases elements that are no longer wanted", async () => {
    const h = await setup();
    for (const n of [1, 2, 3, 4, 5, 6]) await h.syncSettled([want(`c${n}`, "a", { rate: 1, volume: 1 })]);
    h.pool.sync([]);
    expect(h.made).toHaveLength(6);
    expect(h.made.every((el) => el.paused)).toBe(true);
    const holding = h.made.filter((el) => el.src !== "");
    expect(holding.length).toBeLessThanOrEqual(MAX_IDLE_ELEMENTS);
    expect(holding).toEqual(h.made.slice(2)); // the four used last
    expect(h.made.slice(0, 2).map((el) => el.loads)).toEqual([1, 1]);
    h.changes.mockClear();
    Object.assign(h.made[0], { readyState: 2 }).fire("loadeddata"); // a released element's events say nothing
    expect(h.changes).not.toHaveBeenCalled();
    h.made[5].play();
    h.pool.dispose();
    expect(h.made.every((el) => el.paused)).toBe(true);
    expect(h.revoked).toEqual(h.addresses);
    expect(h.made.every((el) => el.src === "")).toBe(true);
  });

  it("a rejected play is ignored", async () => {
    const h = await setup({ element: { rejectPlay: true } });
    h.pool.sync([want("c1", "a", { rate: 1, volume: 1 })]);
    await settle();
    expect(() => h.pool.sync([want("c1", "a", { rate: 1, volume: 1, seconds: 2 })])).not.toThrow();
    await settle();
    const [el] = h.made;
    expect(el).toMatchObject({ plays: 1, volume: 1, currentTime: 2 });
  });

  it("a refused rate is ignored", async () => {
    const h = await setup({ element: { refuseRate: true } });
    h.pool.sync([want("c1", "a", { rate: 2, volume: 0.5, seconds: 3 })]);
    await settle();
    expect(() => h.pool.sync([want("c1", "a", { rate: 2, volume: 0.5, seconds: 3 })])).not.toThrow();
    const [el] = h.made;
    expect(el).toMatchObject({ volume: 0.5, muted: false, currentTime: 3, plays: 1 });
  });

  it("a failed read is tried again after 10 s, not before", async () => {
    const h = await setup({ stored: [] });
    h.state.clock = 1_000;
    h.pool.sync([want("c1")]);
    await settle();
    expect(h.pool.label(clip("c1"))).toBe("Can't load media");
    await h.put("p1");
    h.state.clock = 10_999;
    await h.syncSettled([want("c1")]);
    expect(h.pool.label(clip("c1"))).toBe("Can't load media");
    expect(h.made).toEqual([]);
    h.state.clock = 11_000;
    h.pool.sync([want("c1")]);
    expect(h.pool.label(clip("c1"))).toBe("Loading");
    await settle();
    h.pool.sync([want("c1")]);
    const [el] = h.made;
    expect(el.src).toBe(h.addresses[0]);
    el.readyState = 2;
    el.fire("loadeddata");
    expect(h.pool.resolveSource(clip("c1"), 0)).toEqual({ image: el, width: 1280, height: 720 });
  });
});

describe("the media pool, further", () => {
  it("plays an audio clip in an audio element", async () => {
    const h = await setup({ assets: [assetView({ id: "m", kind: "audio", originalFileId: "aud", previewStatus: "none", previewFileId: null })], stored: ["aud"] });
    await h.syncSettled([want("m1", "m", { type: "audio", rate: 1, volume: 1 })]);
    expect(h.made.map((el) => [el.kind, el.src, el.plays])).toEqual([["audio", "blob:aud#1", 1]]);
  });

  it("does not ask a playing element to play again", async () => {
    const h = await setup();
    const playing = want("c1", "a", { rate: 1, volume: 1 });
    await h.syncSettled([playing]);
    h.pool.sync([playing]);
    h.pool.sync([playing]);
    expect(h.made[0].plays).toBe(1);
  });

  it("shows a picture only from data, and says when the element moved or failed", async () => {
    const h = await setup();
    await h.syncSettled([want("c1")]);
    const [el] = h.made;
    el.readyState = 1;
    expect(h.pool.resolveSource(clip("c1"), 0)).toBeNull();
    el.readyState = 2;
    h.changes.mockClear();
    el.fire("seeked");
    expect(h.changes).toHaveBeenCalledTimes(1);
    expect(h.pool.resolveSource(clip("c1"), 0)).not.toBeNull();
    el.fire("error");
    expect(h.changes).toHaveBeenCalledTimes(2);
    expect(h.pool.label(clip("c1"))).toBe("Can't load media");
    expect(h.pool.resolveSource(clip("c1"), 0)).toBeNull();
  });

  it("keeps the elements used last, not the ones made last", async () => {
    const h = await setup();
    for (const id of ["c1", "c2", "c3", "c4", "c5", "c1", "c6"]) await h.syncSettled([want(id)]);
    h.pool.sync([]);
    expect(h.made.map((el) => el.src !== "")).toEqual([true, false, false, true, true, true]);
  });

  it("plays an asset's new file in the clip's element, and shows nothing of the old one meanwhile", async () => {
    const h = await setup({ assets: [videoAsset({ previewStatus: "failed", previewFileId: null })] }); // a small original plays as it is
    await h.syncSettled([want("c1")]);
    const [el] = h.made;
    expect(el.src).toBe("blob:o1#1");
    el.readyState = 2;
    h.assets.set("a", videoAsset());
    h.pool.sync([want("c1")]);
    expect(h.pool.resolveSource(clip("c1"), 0)).toBeNull(); // its picture is of the old file
    el.fire("error"); // the old file
    await settle();
    h.pool.sync([want("c1")]);
    expect(h.made).toEqual([el]);
    expect(el.src).toBe("blob:p1#2");
    expect(h.pool.label(clip("c1"))).toBe("Loading");
    expect(h.pool.resolveSource(clip("c1"), 0)).toEqual({ image: el, width: 1280, height: 720 });
    h.assets.set("a", videoAsset({ removed: true }));
    expect(h.pool.resolveSource(clip("c1"), 0)).toBeNull();
    expect(h.pool.label(clip("c1"))).toBe("Media removed");
  });

  it("reads ahead without making an element", async () => {
    const h = await setup({ assets: [videoAsset(), imageAsset(), videoAsset({ id: "gone", removed: true })], stored: ["p1", "img"] });
    h.pool.preload(["a", "i", "gone", "nobody"]);
    await settle();
    expect(h.addresses).toEqual(["blob:p1#1"]);
    expect(h.decodes).toHaveLength(1);
    expect(h.made).toEqual([]);
    expect(h.changes).toHaveBeenCalledTimes(2);
    h.pool.sync([want("c1"), want("c2", "i", { type: "image" })]);
    expect(h.made.map((el) => el.src)).toEqual(["blob:p1#1"]);
    expect(h.pool.resolveSource(clip("c2", "i", "image"), 0)).not.toBeNull();
  });

  it("reading ahead does not try a failed read again; wanting the clip does", async () => {
    const h = await setup({ stored: [] });
    h.pool.preload(["a"]);
    await settle();
    await h.put("p1");
    h.state.clock = 20_000;
    h.pool.preload(["a"]);
    expect(h.pool.label(clip("c1"))).toBe("Can't load media");
    h.pool.sync([want("c1")]);
    expect(h.pool.label(clip("c1"))).toBe("Loading");
  });

  it("an image that cannot be read says so, and is tried again after 10 s", async () => {
    const h = await setup({ assets: [imageAsset()], stored: [] });
    const image = want("c1", "i", { type: "image" });
    await h.syncSettled([image]);
    expect(h.pool.label(clip("c1", "i", "image"))).toBe("Can't load media");
    await h.put("img");
    h.state.clock = 9_999;
    await h.syncSettled([image]);
    expect(h.pool.label(clip("c1", "i", "image"))).toBe("Can't load media");
    h.state.clock = 10_000;
    await h.syncSettled([image]);
    expect(h.pool.resolveSource(clip("c1", "i", "image"), 0)).toEqual({ image: h.picture, width: 2160, height: 1215 });
  });

  it("a listener that stopped listening hears nothing", async () => {
    const h = await setup();
    const listener = vi.fn();
    h.pool.onChange(listener)();
    await h.syncSettled([want("c1")]);
    expect(h.changes).toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it("starts again after it was let go, and drops what was on its way", async () => {
    const h = await setup({ assets: [videoAsset(), imageAsset()], stored: ["p1", "img"] });
    await h.syncSettled([want("c1"), want("c2", "i", { type: "image" })]);
    h.pool.dispose();
    expect(h.revoked).toEqual(["blob:p1#1"]);
    expect(h.pool.resolveSource(clip("c2", "i", "image"), 0)).toBeNull();
    await h.syncSettled([want("c1"), want("c2", "i", { type: "image" })]);
    expect(h.addresses).toEqual(["blob:p1#1", "blob:p1#2"]);
    expect(h.made.map((el) => el.src)).toEqual(["", "blob:p1#2"]);
    expect(h.decodes).toHaveLength(2);
    h.pool.dispose();
    h.pool.sync([want("c1"), want("c2", "i", { type: "image" })]); // both read again, and let go while on their way
    h.pool.dispose();
    h.changes.mockClear();
    await settle();
    expect(h.changes).not.toHaveBeenCalled();
    expect(h.addresses).toHaveLength(2);
    expect(h.decodes).toHaveLength(2);
    expect(h.pool.resolveSource(clip("c2", "i", "image"), 0)).toBeNull();
  });

  it("drops an image decoded after it was let go", async () => {
    let decoded = () => {};
    const h = await setup({ assets: [imageAsset()], stored: ["img"], decoding: new Promise<void>((resolve) => (decoded = resolve)) });
    h.pool.sync([want("c1", "i", { type: "image" })]);
    await settle();
    expect(h.decodes).toHaveLength(1);
    h.pool.dispose();
    decoded();
    await settle();
    expect(h.changes).not.toHaveBeenCalled();
    expect(h.pool.resolveSource(clip("c1", "i", "image"), 0)).toBeNull();
    expect(h.pool.label(clip("c1", "i", "image"))).toBe("Loading");
  });
});

describe("the media pool at a cut", () => {
  // A browser loads an element that was given an address between two frames, never in the draw that gave it one.
  const browserLoads = (made: Pretend[]) => {
    for (const el of made) {
      if (el.src === "" || el.readyState >= 2) continue;
      el.readyState = 2;
      el.fire("loadeddata");
    }
  };

  // What the compositor draws of the media at a frame: "picture" for a clip drawn from an element, else the
  // placeholder's label.
  function drawn(pool: MediaPool, doc: TimelineDoc, frame: number): string[] {
    const marks: string[] = [];
    const methods: Record<string, unknown> = {
      drawImage: () => marks.push("picture"),
      fillText: (text: string) => marks.push(text),
      measureText: () => ({ width: 0 }),
    };
    const ctx = new Proxy({}, { get: (_target, key) => methods[String(key)] ?? (() => {}), set: () => true });
    drawFrame(ctx as CanvasRenderingContext2D, doc, frame, { resolveSource: pool.resolveSource, placeholderLabel: pool.label });
    return marks;
  }

  const oneTrack = (clips: Clip[]) => {
    const doc = createEmptyDoc("short_9x16");
    doc.tracks[0].clips = clips;
    return doc;
  };

  type Harness = Awaited<ReturnType<typeof setup>>;
  // One draw of the preview at a frame, as preview.tsx makes it, and then the time until the next frame.
  async function frameAt(h: Harness, doc: TimelineDoc, frame: number): Promise<string[]> {
    h.pool.preload(upcomingAssetIds(doc, frame));
    h.pool.sync(mediaWants(doc, frame, { playing: true, rate: 1 }), upcomingWants(doc, frame));
    const marks = drawn(h.pool, doc, frame);
    await settle();
    browserLoads(h.made);
    return marks;
  }

  it("playing across a cut between two clips of one file draws a picture at the cut, not Loading", async () => {
    const h = await setup();
    const doc = oneTrack([video("c1", 0, 30), video("c2", 30, 30, { in: 30 })]);
    for (let frame = 0; frame < 30; frame++) await frameAt(h, doc, frame);
    expect(await frameAt(h, doc, 30)).toEqual(["picture"]);
  });

  it("a clip of another file that starts within the read-ahead window has its element made and loading before it starts", async () => {
    const h = await setup({ assets: [videoAsset(), videoAsset({ id: "b", previewFileId: "p2" })], stored: ["p1", "p2"] });
    const doc = oneTrack([video("c1", 0, 30), video("c3", 30, 30, { assetId: "b", in: 60 })]);
    expect(upcomingWants(doc, 0)).toEqual([{ clipId: "c3", assetId: "b", type: "video", seconds: 2, rate: 0, volume: 0 }]);
    expect(upcomingWants(doc, 30)).toEqual([]); // under the playhead now, so wanted as it plays
    expect(upcomingWants(oneTrack([video("c3", 61, 30, { assetId: "b" })]), 0)).toEqual([]); // past the 2 s window

    await frameAt(h, doc, 0);
    await frameAt(h, doc, 1);
    const ahead = h.made.find((el) => el.src.startsWith("blob:p2"));
    expect(ahead).toMatchObject({ paused: true, muted: true, volume: 0, currentTime: 2, readyState: 2, plays: 0 });
    for (let frame = 2; frame < 30; frame++) await frameAt(h, doc, frame);
    expect(await frameAt(h, doc, 30)).toEqual(["picture"]);
    expect(h.made).toHaveLength(2);
    expect(ahead).toMatchObject({ paused: false, muted: false, volume: 1, plays: 1 });
  });

  it("a split's right piece takes over the left piece's element, which has data, so it shows at once", async () => {
    const h = await setup();
    await h.syncSettled([want("c1", "a", { seconds: 0.5 })]);
    const [el] = h.made;
    browserLoads(h.made);
    // The playhead is on the new right piece now, and the left piece is idle.
    h.pool.sync([want("g1", "a", { seconds: 0.5 })]);
    expect(h.made).toEqual([el]);
    expect(h.pool.resolveSource(clip("g1"), 15)).toEqual({ image: el, width: 1280, height: 720 });
    // Back on the left piece, which takes it again.
    h.pool.sync([want("c1", "a", { seconds: 0.4 })]);
    expect(h.made).toEqual([el]);
    expect(el.currentTime).toBe(0.4);
    // An audio clip of the file gets an audio element of its own.
    h.pool.sync([want("m1", "a", { type: "audio", seconds: 0.4 })]);
    expect(h.made.map((made) => made.kind)).toEqual(["video", "audio"]);
  });

  it("an element read ahead stays its clip's: another clip of the file does not take it", async () => {
    const h = await setup();
    const ahead = want("c2", "a", { seconds: 1 });
    h.pool.sync([], [ahead]);
    await settle();
    h.pool.sync([], [ahead]);
    const [el] = h.made;
    browserLoads(h.made);
    expect(el).toMatchObject({ paused: true, muted: true, volume: 0, currentTime: 1 });
    h.pool.sync([want("c9", "a", { rate: 1, volume: 1 })], [ahead]);
    expect(h.made).toHaveLength(2);
    expect(h.pool.resolveSource(clip("c2"), 30)).toEqual({ image: el, width: 1280, height: 720 });
    expect(el.paused).toBe(true);
  });

  it("while a clip's own element has no data yet, an idle element of the same file stands in", async () => {
    const h = await setup();
    const playing = want("c1", "a", { rate: 1, volume: 1, seconds: 0.9 });
    const next = want("c2", "a", { seconds: 1 });
    h.pool.sync([playing], [next]);
    await settle();
    h.pool.sync([playing], [next]);
    const [first, second] = h.made;
    Object.assign(first, { readyState: 2 }).fire("loadeddata"); // the second has not loaded yet
    const cut = { ...next, rate: 1, volume: 1 };
    h.pool.sync([cut]);
    expect(h.pool.resolveSource(clip("c2"), 30)).toEqual({ image: first, width: 1280, height: 720 });
    // An element another clip is playing is not borrowed.
    h.pool.sync([cut, playing]);
    expect(h.pool.resolveSource(clip("c2"), 30)).toBeNull();
    h.pool.sync([cut]);
    Object.assign(second, { readyState: 2 }).fire("loadeddata");
    expect(h.pool.resolveSource(clip("c2"), 30)).toEqual({ image: second, width: 1280, height: 720 });
    // An element that failed shows that it failed.
    second.fire("error");
    expect(h.pool.resolveSource(clip("c2"), 30)).toBeNull();
    expect(h.pool.label(clip("c2"))).toBe("Can't load media");
  });
});
