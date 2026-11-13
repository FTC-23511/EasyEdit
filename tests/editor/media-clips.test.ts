import { describe, expect, it } from "vitest";
import { addMedia, addTrack } from "@/lib/editor/actions";
import { LIMITS } from "@/lib/limits";
import { MESSAGES } from "@/lib/editor/messages";
import { findClip } from "@/lib/editor/store";
import { DEFAULT_IMAGE_SECONDS, mediaClipFor, trimBounds } from "@/lib/editor/media-clips";
import type { AssetView } from "@/lib/media/types";
import { DEFAULT_TRANSFORM, type MediaClip } from "@/lib/timeline";
import { makeStore } from "./fixtures";

const video = { id: "a1", kind: "video" as const, durationMs: 12_500 }; // 375 frames at 30 fps
const base = { type: "video", assetId: "a1", speed: 1, volume: 1, transform: { ...DEFAULT_TRANSFORM } };

describe("a new media clip", () => {
  it("is the whole video by default", () => {
    expect(mediaClipFor(video, 60, 30)).toEqual({ ...base, start: 60, duration: 375, in: 0 });
  });
  it("can begin partway in and last a given time", () => {
    expect(mediaClipFor(video, 0, 30, { inSeconds: 2, durationSeconds: 3 })).toEqual({ ...base, start: 0, duration: 90, in: 60 });
  });
  it("never runs past the end of the media", () => {
    expect(mediaClipFor(video, 0, 30, { inSeconds: 10, durationSeconds: 30 })).toMatchObject({ in: 300, duration: 75 });
    expect(mediaClipFor(video, 0, 30, { inSeconds: 12.5 })).toBeNull();
    expect(mediaClipFor(video, 0, 30, { durationSeconds: 0 })).toMatchObject({ duration: 1 });
  });
  it("an image lasts three seconds unless told otherwise", () => {
    expect(DEFAULT_IMAGE_SECONDS).toBe(3);
    expect(mediaClipFor({ id: "i1", kind: "image", durationMs: null }, 0, 30)).toMatchObject({ type: "image", duration: 90, in: 0 });
    expect(mediaClipFor({ id: "i1", kind: "image", durationMs: null }, 0, 30, { durationSeconds: 300 })).toMatchObject({ duration: 9000 });
    expect(mediaClipFor({ id: "i1", kind: "image", durationMs: null }, 0, 30, { durationSeconds: 0 })).toMatchObject({ duration: 1 });
  });
  it("rounds times to the nearest frame", () => {
    expect(mediaClipFor(video, 0, 30, { inSeconds: 1.99, durationSeconds: 0.99 })).toMatchObject({ in: 60, duration: 30 });
  });
});

describe("how far a clip can be trimmed", () => {
  const clip = { id: "c1", ...base, start: 100, duration: 90, in: 60 } as MediaClip;
  it("stops where the media starts and ends", () => {
    expect(trimBounds(clip, 375)).toEqual({ minStart: 40, maxEnd: 415 });
  });
  it("allows for speed", () => {
    expect(trimBounds({ ...clip, speed: 2 }, 375)).toEqual({ minStart: 70, maxEnd: 257 });
  });
  it("has no bounds for an image, even one given a length", () => {
    expect(trimBounds({ ...clip, type: "image" }, 375)).toBeUndefined();
  });
  it("has no bounds for a video of unknown length", () => {
    expect(trimBounds(clip, undefined)).toBeUndefined();
  });
  it("lets a one-frame start trim at speed 1.5 be dragged back out", () => {
    expect(trimBounds({ ...clip, in: 1, start: 100, duration: 249, speed: 1.5 }, 375)?.minStart).toBe(99);
  });
  it("lets an end reach the last frame that still rounds inside the media", () => {
    expect(trimBounds({ ...clip, in: 0, start: 0, duration: 22, speed: 0.45 }, 10)?.maxEnd).toBe(23);
  });
  it("is exact where a frame rounds half up", () => {
    // 21 × 0.5 is 10.5, which rounds to 11: one frame past a 10-frame asset, and past an end at 10.
    expect(trimBounds({ ...clip, in: 0, start: 100, duration: 4, speed: 0.5 }, 10)?.maxEnd).toBe(120);
    expect(trimBounds({ ...clip, in: 0, start: 100, duration: 20, speed: 0.5 }, 375)?.minStart).toBe(100);
    // A clip from the first frame at speed 0.7 can still grow back by one: 2 × 0.7 rounds to 1, as 1 × 0.7 does.
    expect(trimBounds({ ...clip, in: 0, start: 100, duration: 1, speed: 0.7 }, 375)?.minStart).toBe(99);
  });
  it("never lets a start go before frame 0", () => {
    expect(trimBounds({ ...clip, start: 10 }, 375)).toEqual({ minStart: 0, maxEnd: 325 });
  });
});

const asset = (over: Partial<AssetView> = {}): AssetView => ({
  id: "a1",
  kind: "video",
  name: "intake",
  fileName: "intake.mp4",
  sizeBytes: 1000,
  status: "ready",
  removed: false,
  durationMs: 12_500,
  width: 1920,
  height: 1080,
  fps: 30,
  hasAudio: true,
  originalFileId: "orig-a1",
  previewStatus: "ready",
  previewFileId: "prev-a1",
  posterFileId: "post-a1",
  event: null,
  uploadedBy: "u1",
  uploadedByName: "Ada Lovelace",
  createdAt: "2026-11-01T10:00:00.000Z",
  ...over,
});

const AUDIO = asset({ id: "s1", kind: "audio", name: "crowd", durationMs: 4_000, width: null, height: null, fps: null });
const IMAGE = asset({ id: "i1", kind: "image", name: "logo", durationMs: null, fps: null, hasAudio: false });

// The store at playhead 60: v1 holds c1 and c2 up to frame 60, t1 holds x1 (0 to 60) and x2 (90 to 120).
function storeAt60(canEdit = true) {
  const store = makeStore({ canEdit });
  store.getState().seek(60);
  return store;
}

const trackOf = (store: ReturnType<typeof makeStore>, clipId: string) => findClip(store.getState().doc, clipId)?.track;

describe("adding media from the library", () => {
  it("adds a video at the playhead on the video track and selects it", () => {
    const store = storeAt60();
    addMedia(store, asset());
    const { doc, selection, queue } = store.getState();
    const added = doc.tracks.flatMap((t) => t.clips.filter((c) => c.type !== "text" && c.assetId === "a1").map((c) => ({ track: t.id, clip: c })));
    expect(added).toHaveLength(1);
    expect(added[0].track).toBe("v1");
    expect(added[0].clip).toMatchObject({ assetId: "a1", start: 60, duration: 375, in: 0, speed: 1, volume: 1 });
    expect(selection.clipIds).toEqual([added[0].clip.id]);
    expect(queue).toMatchObject([{ label: "add media" }]);
  });

  it("adds audio on the audio track and an image on the video track", () => {
    const forAudio = storeAt60();
    addMedia(forAudio, AUDIO);
    const audioId = forAudio.getState().selection.clipIds[0];
    expect(trackOf(forAudio, audioId)?.id).toBe("a1");
    expect(findClip(forAudio.getState().doc, audioId)!.clip).toMatchObject({ type: "audio", assetId: "s1", start: 60, duration: 120 });

    const forImage = storeAt60();
    addMedia(forImage, IMAGE);
    const imageId = forImage.getState().selection.clipIds[0];
    expect(trackOf(forImage, imageId)?.id).toBe("v1");
    expect(findClip(forImage.getState().doc, imageId)!.clip).toMatchObject({ type: "image", assetId: "i1", start: 60, duration: 90, in: 0 });
  });

  it("goes to another track when the playhead is inside a clip", () => {
    const store = storeAt60();
    addMedia(store, asset());
    addMedia(store, asset());
    const second = store.getState().selection.clipIds[0];
    expect(trackOf(store, second)?.name).toBe("Video 2");
    expect(findClip(store.getState().doc, second)!.clip).toMatchObject({ start: 60 });
  });

  it("starts at the frame it is given, else at the playhead", () => {
    const store = storeAt60();
    addMedia(store, asset(), { frame: 200 });
    const added = findClip(store.getState().doc, store.getState().selection.clipIds[0])!;
    expect([added.track.id, added.clip.start]).toEqual(["v1", 200]);
  });

  it("wishes for the track it is given, else the selected track when that track takes the clip", () => {
    const withOverlay = () => {
      const store = storeAt60();
      addTrack(store, "overlay");
      const overlay = store.getState().doc.tracks.find((t) => t.kind === "overlay")!.id;
      return { store, overlay };
    };
    const added = (store: ReturnType<typeof makeStore>) => trackOf(store, store.getState().selection.clipIds[0])?.id;

    const selected = withOverlay();
    selected.store.getState().selectTrack(selected.overlay);
    addMedia(selected.store, asset());
    expect(added(selected.store)).toBe(selected.overlay);

    const given = withOverlay();
    given.store.getState().selectTrack(given.overlay);
    addMedia(given.store, asset(), { trackId: "v1" });
    expect(added(given.store)).toBe("v1");

    const unfit = withOverlay();
    unfit.store.getState().selectTrack("a1"); // an audio track does not take a video
    addMedia(unfit.store, asset());
    expect(added(unfit.store)).toBe("v1");
  });

  it("says there is no room when the project can take no more tracks", () => {
    const store = makeStore();
    const full = Array.from({ length: LIMITS.tracksPerProject - store.getState().doc.tracks.length }, () => "video" as const);
    for (const kind of full) addTrack(store, kind);
    for (const track of store.getState().doc.tracks) if (track.kind === "video" || track.kind === "overlay") addMedia(store, asset(), { trackId: track.id });
    const before = store.getState().doc;
    addMedia(store, asset());
    expect(store.getState().doc).toBe(before);
    expect(store.getState().notice).toMatchObject({ text: MESSAGES.noRoom });
  });

  it("does nothing for a viewer", () => {
    const store = storeAt60(false);
    const before = store.getState().doc;
    addMedia(store, asset());
    addMedia(store, asset({ status: "uploading" }));
    expect(store.getState().doc).toBe(before);
    expect(store.getState().notice).toBeNull();
  });

  it("says so when the file is not ready", () => {
    expect(MESSAGES.mediaNotReady).toBe("This file isn't ready yet.");
    for (const unready of [asset({ status: "uploading" }), asset({ removed: true })]) {
      const store = storeAt60();
      const before = store.getState().doc;
      addMedia(store, unready);
      expect(store.getState().doc).toBe(before);
      expect(store.getState().queue).toEqual([]);
      expect(store.getState().notice).toMatchObject({ text: MESSAGES.mediaNotReady });
    }
  });
});
