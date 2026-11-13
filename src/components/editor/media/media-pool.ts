import { PRELOAD_SECONDS, mediaWants, needsSeek, type MediaWant } from "@/lib/editor/media-plan";
import type { MediaFiles } from "@/lib/media/media-files";
import { PLACEHOLDER_LABELS, playbackFileFor } from "@/lib/media/playback";
import { IMAGE_MAX_SIDE } from "@/lib/media/preview-spec";
import type { AssetView } from "@/lib/media/types";
import type { ResolvedSource } from "@/lib/render/compositor";
import type { MediaClip, TimelineDoc } from "@/lib/timeline";

// The preview's video, audio and pictures: the browser elements that play the clips under the playhead, and those of
// the clips that start soon, made to do what mediaWants says, and what the compositor draws from them.

// The part of an audio or video element the pool uses.
export type MediaElement = {
  src: string;
  currentTime: number;
  playbackRate: number;
  volume: number;
  muted: boolean;
  readonly paused: boolean;
  readonly readyState: number;
  readonly videoWidth?: number;
  readonly videoHeight?: number;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: string, listener: () => void): void;
  removeAttribute(name: string): void;
  load(): void;
};

export type PoolDeps = {
  files: MediaFiles;
  asset(assetId: string): AssetView | undefined;
  loaded(): boolean; // the library has answered at least once
  makeVideo(): MediaElement;
  makeAudio(): MediaElement;
  decodeImage(blob: Blob, maxSide: number): Promise<{ image: CanvasImageSource; width: number; height: number }>;
  objectUrl(blob: Blob): string;
  revokeUrl(url: string): void;
  now?: () => number; // default Date.now; times the wait before a failed read is tried again
};

export type MediaPool = {
  // Makes the elements match. wants: the clips under the playhead. ahead: clips that start soon, whose elements are made
  // early and wait at their first moment, paused and silent, so that a cut does not wait for an element to load.
  sync(wants: MediaWant[], ahead?: MediaWant[]): void;
  preload(assetIds: string[]): void;
  resolveSource(clip: MediaClip, frame: number): ResolvedSource | null;
  label(clip: MediaClip): string;
  onChange(listener: () => void): () => void; // something new can be drawn
  // Lets go of every element and address. The pool starts empty afterwards and can still be used.
  dispose(): void;
};

export const MAX_IDLE_ELEMENTS = 4;
const RETRY_MS = 10_000; // a read that failed is tried again when its clip is wanted this long after

// The media clips that start after this frame and within PRELOAD_SECONDS of it, the window upcomingAssetIds reads
// files for, as mediaWants has them at their first frame: standing still there, silent.
export function upcomingWants(doc: TimelineDoc, frame: number): MediaWant[] {
  const ahead = frame + PRELOAD_SECONDS * doc.fps;
  const wants: MediaWant[] = [];
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.start <= frame || clip.start > ahead) continue;
      wants.push(...mediaWants(doc, clip.start, { playing: false, rate: 1 }).filter((want) => want.clipId === clip.id));
    }
  }
  return wants;
}

// Something read from the browser's files, on its way or not.
type Got<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "failed"; at: number };
type ElementKind = "video" | "audio";
// An element, the clip it plays for and the file it plays. usedAt: the sync that last wanted it.
type Held = { el: MediaElement; kind: ElementKind; clipId: string; fileId: string; usedAt: number; failed: boolean };

const kindFor = (want: MediaWant): ElementKind => (want.type === "audio" ? "audio" : "video");
const hasData = (held: Held) => !held.failed && held.el.readyState >= 2;

export function createMediaPool(deps: PoolDeps): MediaPool {
  const now = deps.now ?? Date.now;
  const listeners = new Set<() => void>();
  let addresses = new Map<string, Got<string>>(); // by file id: one blob address per file, shared by its elements
  let pictures = new Map<string, Got<ResolvedSource>>(); // by file id: one decoded image per image asset, which plays its original
  let elements = new Map<string, Held>(); // by clip id, so two clips of one asset can show different moments
  let following = new Set<string>(); // the clips whose elements the last sync made follow a want; the rest are idle
  let round = 0; // counts syncs
  let generation = 0; // counts disposals: what was on its way before one is dropped when it arrives

  const changed = () => {
    for (const listener of [...listeners]) listener();
  };
  const failedNow = (): Got<never> => ({ state: "failed", at: now() });
  const retryDue = (got: Got<unknown>) => got.state === "failed" && now() - got.at >= RETRY_MS;
  const fileOf = (assetId: string) => playbackFileFor(deps.asset(assetId)).fileId;

  // The address of a file, read when it has not been. retry: a failed read whose wait is over is read again.
  function address(fileId: string, retry: boolean): Got<string> {
    const known = addresses.get(fileId);
    if (known && !(retry && retryDue(known))) return known;
    const entry: Got<string> = { state: "loading" };
    addresses.set(fileId, entry);
    const started = generation;
    // A read that ends after the pool was let go makes no address: nothing would revoke it.
    const settle = (got: () => Got<string>) => {
      if (started !== generation) return;
      addresses.set(fileId, got());
      changed();
    };
    deps.files.get(fileId).then(
      (got) => settle(() => (got.ok ? { state: "ready", value: deps.objectUrl(got.blob) } : failedNow())),
      () => settle(failedNow),
    );
    return entry;
  }

  // The decoded picture of an image's file, read and decoded when it has not been.
  function picture(fileId: string, retry: boolean): Got<ResolvedSource> {
    const known = pictures.get(fileId);
    if (known && !(retry && retryDue(known))) return known;
    const entry: Got<ResolvedSource> = { state: "loading" };
    pictures.set(fileId, entry);
    const started = generation;
    const settle = (got: Got<ResolvedSource>) => {
      if (started !== generation) return;
      pictures.set(fileId, got);
      changed();
    };
    deps.files
      .get(fileId)
      .then(async (got) => {
        if (started !== generation) return; // let go: not worth decoding
        if (!got.ok) return settle(failedNow());
        settle({ state: "ready", value: await deps.decodeImage(got.blob, IMAGE_MAX_SIDE) });
      })
      .catch(() => settle(failedNow()));
    return entry;
  }

  function release(el: MediaElement): void {
    if (!el.paused) el.pause();
    el.removeAttribute("src");
    el.load();
  }

  // An idle element of this file that has data, for a wanted clip that has none: the one nearest the moment wanted,
  // such as the left piece's after a split or the clip's before it in the same footage. It shows at once, where a new
  // element would show a placeholder until it loads. wanted: the clips this sync wants, whose elements are not idle.
  function takeOver(want: MediaWant, fileId: string, wanted: Set<string>): Held | undefined {
    const off = (held: Held) => Math.abs(held.el.currentTime - want.seconds);
    let best: Held | undefined;
    for (const held of elements.values()) {
      if (wanted.has(held.clipId) || held.kind !== kindFor(want) || held.fileId !== fileId || !hasData(held)) continue;
      if (!best || off(held) < off(best)) best = held;
    }
    if (!best) return undefined;
    elements.delete(best.clipId);
    best.clipId = want.clipId;
    elements.set(want.clipId, best);
    return best;
  }

  // An idle video element of this file that has data, the one used last: what a clip shows while its own element
  // loads, so that a cut shows the moment just left rather than a placeholder.
  function standIn(fileId: string): Held | undefined {
    let best: Held | undefined;
    for (const held of elements.values()) {
      if (following.has(held.clipId) || held.kind !== "video" || held.fileId !== fileId || !hasData(held)) continue;
      if (!best || held.usedAt > best.usedAt) best = held;
    }
    return best;
  }

  // The element of a wanted clip, playing this file: its own, an idle one it takes over, or a new one.
  function element(want: MediaWant, fileId: string, url: string, wanted: Set<string>): Held {
    const known = elements.get(want.clipId) ?? takeOver(want, fileId, wanted);
    if (known) {
      if (known.fileId !== fileId) {
        known.fileId = fileId;
        known.failed = false;
        known.el.src = url;
      }
      return known;
    }
    const kind = kindFor(want);
    const el = kind === "audio" ? deps.makeAudio() : deps.makeVideo();
    const held: Held = { el, kind, clipId: want.clipId, fileId, usedAt: round, failed: false };
    const mine = () => elements.get(held.clipId) === held; // a released element's events say nothing
    const onData = () => {
      if (mine()) changed();
    };
    el.addEventListener("loadeddata", onData);
    el.addEventListener("seeked", onData);
    el.addEventListener("error", () => {
      if (!mine()) return;
      held.failed = true;
      changed();
    });
    elements.set(want.clipId, held);
    el.src = url;
    return held;
  }

  // Makes an element do what is wanted of it. What the browser refuses is left as it is, and the rest is still done.
  function follow(el: MediaElement, want: MediaWant): void {
    if (want.rate > 0) {
      try {
        if (el.playbackRate !== want.rate) el.playbackRate = want.rate;
      } catch {
        // A rate this browser will not play at: the element keeps the one it has.
      }
      if (el.paused) {
        try {
          el.play().catch(() => {});
        } catch {
          // As a rejected play: the next sync asks again.
        }
      }
    } else if (!el.paused) {
      el.pause();
    }
    el.volume = want.volume;
    el.muted = want.volume === 0;
    if (needsSeek(el.currentTime, want)) el.currentTime = want.seconds;
  }

  return {
    sync(wants, ahead = []) {
      round += 1;
      // A clip read ahead gets its element as a wanted one does, but a failed read is not tried again for it, and an
      // image needs no element: preload decodes it.
      const soon = ahead.filter((want) => want.type !== "image" && !wants.some((w) => w.clipId === want.clipId));
      const wanted = new Set([...wants, ...soon].map((want) => want.clipId));
      const followed = new Set<string>();
      const play = (want: MediaWant, retry: boolean) => {
        const fileId = fileOf(want.assetId);
        if (fileId === null) return;
        if (want.type === "image") {
          picture(fileId, retry);
          return;
        }
        const got = address(fileId, retry);
        if (got.state !== "ready") return;
        const held = element(want, fileId, got.value, wanted);
        held.usedAt = round;
        followed.add(want.clipId);
        follow(held.el, want);
      };
      for (const want of wants) play(want, true);
      for (const want of soon) play(want, false);
      following = followed;
      // The rest are paused, and all but the few used last let go of their file.
      const idle = [...elements].filter(([clipId]) => !following.has(clipId)).sort(([, a], [, b]) => b.usedAt - a.usedAt);
      for (const [, held] of idle) if (!held.el.paused) held.el.pause();
      for (const [clipId, held] of idle.slice(MAX_IDLE_ELEMENTS)) {
        release(held.el);
        elements.delete(clipId);
      }
    },

    preload(assetIds) {
      for (const assetId of assetIds) {
        const asset = deps.asset(assetId);
        const fileId = playbackFileFor(asset).fileId;
        if (asset === undefined || fileId === null) continue;
        if (asset.kind === "image") picture(fileId, false);
        else address(fileId, false);
      }
    },

    resolveSource(clip) {
      const fileId = fileOf(clip.assetId);
      if (fileId === null) return null;
      if (clip.type === "image") {
        const known = pictures.get(fileId);
        return known?.state === "ready" ? known.value : null;
      }
      const own = elements.get(clip.id);
      const current = own?.fileId === fileId ? own : undefined; // an element still on the asset's old file shows nothing
      if (current?.failed) return null; // the placeholder says so
      const held = current && hasData(current) ? current : standIn(fileId);
      if (!held) return null;
      return { image: held.el as unknown as CanvasImageSource, width: held.el.videoWidth ?? 0, height: held.el.videoHeight ?? 0 };
    },

    label(clip) {
      const asset = deps.asset(clip.assetId);
      if (asset === undefined && !deps.loaded()) return PLACEHOLDER_LABELS.loading;
      const file = playbackFileFor(asset);
      if (file.fileId === null) return PLACEHOLDER_LABELS[file.why];
      if (clip.type === "image") {
        return pictures.get(file.fileId)?.state === "failed" ? PLACEHOLDER_LABELS.failed : PLACEHOLDER_LABELS.loading;
      }
      const held = elements.get(clip.id);
      const failed = addresses.get(file.fileId)?.state === "failed" || (held?.fileId === file.fileId && held.failed);
      return failed ? PLACEHOLDER_LABELS.failed : PLACEHOLDER_LABELS.loading;
    },

    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    dispose() {
      generation += 1;
      for (const held of elements.values()) release(held.el);
      for (const got of addresses.values()) if (got.state === "ready") deps.revokeUrl(got.value);
      elements = new Map();
      following = new Set();
      addresses = new Map();
      pictures = new Map();
    },
  };
}
