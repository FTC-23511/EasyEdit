import type { Clip, Op, TimelineDoc } from "@/lib/timeline";
import { sourceFrames } from "./rules";
import type { AssetFact } from "./service";
import type { AssetKind } from "./types";

// Why a batch of ops cannot be written: the asset a clip names cannot be used, or a clip would use more of its
// media than there is. assetKind and clipType are set for wrong_kind, frames for past_end.
export type MediaProblem = {
  code: "missing" | "removed" | "not_ready" | "wrong_kind" | "past_end";
  assetId: string;
  opIndex: number;
  clipId: string;
  assetKind?: AssetKind;
  clipType?: AssetKind;
  frames?: number; // the media's length in this project's frames
};

export type AssetTrouble = "missing" | "removed" | "not_ready" | "wrong_kind";

// The patch keys of an update_clip that change how much of its media a clip uses.
const LENGTH_KEYS = ["assetId", "in", "speed"];

const ASSET_IS: Record<AssetKind, string> = { video: "a video", image: "an image", audio: "audio" };
const CLIP_OF: Record<AssetKind, string> = { video: "a video", image: "an image", audio: "an audio" };

function clipsById(doc: TimelineDoc): Map<string, Clip> {
  return new Map(doc.tracks.flatMap((track) => track.clips.map((clip) => [clip.id, clip] as const)));
}

// The asset an op points a clip at, or null: an add_clip of a media clip, or an update_clip that sets assetId.
function namedAsset(op: Op): { assetId: string; clipId: string } | null {
  if (op.op === "add_clip" && op.clip.type !== "text") return { assetId: op.clip.assetId, clipId: op.clip.id };
  if (op.op === "update_clip" && typeof op.patch.assetId === "string") return { assetId: op.patch.assetId, clipId: op.clipId };
  return null;
}

// The clip whose use of its media each op can change, or null, by op index. A split copies what earlier ops of the
// batch did to its clip, so a split of a clip the batch already touched touches its new clip too. A split of a clip
// the batch did not touch is not checked: neither piece uses more of the media than the clip did.
function lengthTouches(ops: Op[]): (string | null)[] {
  const touched = new Set<string>();
  return ops.map((op) => {
    let clipId: string | null = null;
    if (op.op === "add_clip") clipId = op.clip.id;
    else if (op.op === "trim_clip") clipId = op.clipId;
    else if (op.op === "update_clip" && LENGTH_KEYS.some((key) => key in op.patch)) clipId = op.clipId;
    else if (op.op === "split_clip" && touched.has(op.clipId)) clipId = op.newClipId;
    if (clipId !== null) touched.add(clipId);
    return clipId;
  });
}

// A clip the batch split off `clipId` after op `from`, directly or from such a piece, that is still there after
// the batch. It is of the same kind as `clipId`.
function laterPiece(ops: Op[], from: number, clipId: string, clips: Map<string, Clip>): Clip | undefined {
  const line = new Set([clipId]);
  for (const op of ops.slice(from + 1)) {
    if (op.op === "split_clip" && line.has(op.clipId)) line.add(op.newClipId);
  }
  return [...line].map((id) => clips.get(id)).find((clip) => clip !== undefined);
}

// The asset ids a batch must be checked against: those named by an add_clip with a media clip or an update_clip
// that sets assetId, and those of media clips (as they are after the batch) that the batch touched.
export function assetIdsToCheck(after: TimelineDoc, ops: Op[]): string[] {
  const clips = clipsById(after);
  const touches = lengthTouches(ops);
  const ids = new Set<string>();
  ops.forEach((op, opIndex) => {
    const named = namedAsset(op);
    if (named) ids.add(named.assetId);
    const clip = touches[opIndex] === null ? undefined : clips.get(touches[opIndex]);
    if (clip && clip.type !== "text") ids.add(clip.assetId);
  });
  return [...ids];
}

// What stops one asset from being used by a clip, or null. Without clipType the kind is not checked.
export function assetTrouble(fact: AssetFact | undefined, clipType?: AssetKind): AssetTrouble | null {
  if (!fact) return "missing";
  if (fact.removed) return "removed";
  if (!fact.ready) return "not_ready";
  if (clipType !== undefined && fact.kind !== clipType) return "wrong_kind";
  return null;
}

// The first problem, by op order, or null. `after` is the document the batch would produce.
export function findMediaProblem(after: TimelineDoc, ops: Op[], facts: Map<string, AssetFact>): MediaProblem | null {
  const clips = clipsById(after);
  const touches = lengthTouches(ops);
  // A clip's length is checked once, as it is after the batch, and blamed on the last op that could have changed it.
  const lastTouch = new Map<string, number>();
  touches.forEach((clipId, opIndex) => {
    if (clipId !== null) lastTouch.set(clipId, opIndex);
  });

  for (const [opIndex, op] of ops.entries()) {
    const named = namedAsset(op);
    if (named) {
      // An update_clip does not say what kind of clip it changes. The clip does, when the batch leaves it in place,
      // or else a piece split off it after this op, which carries the asset.
      const target = op.op === "add_clip" ? op.clip : (clips.get(named.clipId) ?? laterPiece(ops, opIndex, named.clipId, clips));
      const clipType = target && target.type !== "text" ? target.type : undefined;
      const fact = facts.get(named.assetId);
      const code = assetTrouble(fact, clipType);
      if (code === "wrong_kind") return { code, ...named, opIndex, assetKind: fact?.kind, clipType };
      if (code) return { code, ...named, opIndex };
    }

    const clipId = touches[opIndex];
    if (clipId === null || lastTouch.get(clipId) !== opIndex) continue;
    const clip = clips.get(clipId);
    if (!clip || (clip.type !== "video" && clip.type !== "audio")) continue; // an image has no length
    const durationMs = facts.get(clip.assetId)?.durationMs ?? null;
    if (durationMs === null) continue;
    const frames = sourceFrames(durationMs, after.fps);
    // No frame over is allowed at any speed. A start trim and a split count the new `in` back from where the clip
    // ends in its media, so a trimmed clip or a right piece ends in its footage exactly where the clip did.
    if (clip.in + Math.round(clip.duration * clip.speed) > frames) {
      return { code: "past_end", assetId: clip.assetId, opIndex, clipId, frames };
    }
  }
  return null;
}

function sentence(problem: MediaProblem): string {
  const asset = `asset "${problem.assetId}"`;
  switch (problem.code) {
    case "missing":
      return `${asset} is not in the library`;
    case "removed":
      return `${asset} was removed from the library`;
    case "not_ready":
      return `${asset} is still uploading`;
    case "wrong_kind":
      return `${asset} is ${ASSET_IS[problem.assetKind!]}, so it cannot be used by ${CLIP_OF[problem.clipType!]} clip`;
    case "past_end":
      return `clip "${problem.clipId}" would run past the end of its media, which is ${problem.frames} frames long`;
  }
}

// With the `<op name> (op <i>)` label that `prepareOps` uses: `add_clip (op 0): asset "x" is not in the library`.
export function mediaProblemMessage(problem: MediaProblem, ops: Op[]): string {
  return `${ops[problem.opIndex].op} (op ${problem.opIndex}): ${sentence(problem)}`;
}
