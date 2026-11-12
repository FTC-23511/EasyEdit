import { LIMITS } from "@/lib/limits";
import type { AssetView } from "./types";

// The file a clip plays in the editor, or why it has none to play.
export type PlaybackFile =
  | { fileId: string; from: "preview" | "original" }
  | { fileId: null; why: "uploading" | "preparing" | "no-preview" | "removed" | "unknown" };

export function playbackFileFor(asset: AssetView | undefined): PlaybackFile {
  if (!asset) return { fileId: null, why: "unknown" };
  if (asset.removed) return { fileId: null, why: "removed" };
  if (asset.status !== "ready" || asset.originalFileId === null) return { fileId: null, why: "uploading" };
  const original: PlaybackFile = { fileId: asset.originalFileId, from: "original" };
  if (asset.kind !== "video") return original;
  if (asset.previewStatus === "ready" && asset.previewFileId !== null) return { fileId: asset.previewFileId, from: "preview" };
  if (asset.previewStatus === "pending") return { fileId: null, why: "preparing" };
  // No preview copy was made. A small original plays well enough as it is.
  return asset.sizeBytes <= LIMITS.mediaDirectPlayBytes ? original : { fileId: null, why: "no-preview" };
}

// What a clip shows in place of its picture. loading and failed are about reading the file, not about the asset.
export const PLACEHOLDER_LABELS: Record<"uploading" | "preparing" | "no-preview" | "removed" | "unknown" | "loading" | "failed", string> = {
  uploading: "Uploading",
  preparing: "Preparing preview",
  "no-preview": "No preview",
  removed: "Media removed",
  unknown: "Media not found",
  loading: "Loading",
  failed: "Can't load media",
};
