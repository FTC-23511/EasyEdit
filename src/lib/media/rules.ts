import { LIMITS } from "@/lib/limits";
import { graphemes, isStorableText } from "@/lib/text";
import type { AssetKind, AssetProbe } from "./types";

export const ACCEPTED_EXTENSIONS: Record<AssetKind, readonly string[]> = {
  video: ["mp4", "m4v", "mov", "webm"],
  image: ["jpg", "jpeg", "png", "webp"],
  audio: ["mp3", "m4a", "wav", "aac"],
};

export type FileRefusal = "empty" | "too-large" | "heic" | "unsupported" | "unreadable";

const HEIC_EXTENSIONS = ["heic", "heif"];
const MAX_SIDE_PX = 16_384;
const DRIVE_NAME_CHARS = 120;

// The text after the last dot, in lower case. "" when there is no dot or nothing before it.
function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
}

export function kindFromName(fileName: string): AssetKind | null {
  const extension = extensionOf(fileName);
  for (const kind of ["video", "image", "audio"] as const) {
    if (ACCEPTED_EXTENSIONS[kind].includes(extension)) return kind;
  }
  return null;
}

export function checkFile(file: { name: string; sizeBytes: number }): { ok: true; kind: AssetKind } | { ok: false; reason: FileRefusal } {
  if (file.sizeBytes <= 0) return { ok: false, reason: "empty" };
  if (file.sizeBytes > LIMITS.mediaFileBytes) return { ok: false, reason: "too-large" };
  if (HEIC_EXTENSIONS.includes(extensionOf(file.name))) return { ok: false, reason: "heic" };
  const kind = kindFromName(file.name);
  return kind ? { ok: true, kind } : { ok: false, reason: "unsupported" };
}

const isLength = (ms: number | null) => ms !== null && ms >= 1;
const isSide = (px: number | null) => px !== null && px >= 1 && px <= MAX_SIDE_PX;

// True when what was read from the file fits its extension and makes sense: the same kind; a video or audio
// length of at least 1 ms; a video or image at least 1 px and at most 16,384 px on each side.
export function probeFits(kind: AssetKind, probe: AssetProbe): boolean {
  if (probe.kind !== kind) return false;
  if (kind !== "image" && !isLength(probe.durationMs)) return false;
  if (kind !== "audio" && !(isSide(probe.width) && isSide(probe.height))) return false;
  return true;
}

// The file name without its extension, runs of white space made one space, trimmed, cut to mediaNameChars
// characters as a person counts them. "Untitled" when nothing is left or the text cannot be stored.
export function cleanName(fileName: string): string {
  const stem = fileName.replace(/\.[^.]*$/, "").replace(/\s+/g, " ").trim();
  const name = graphemes(stem).slice(0, LIMITS.mediaNameChars).join("").trimEnd();
  return name && isStorableText(name) ? name : "Untitled";
}

// `${assetId}__${name}` with every character other than a letter, a digit, a space, ".", "-" or "_" made "_",
// at most 120 characters, the extension kept. Characters are counted whole, so a cut never splits one.
export function driveName(assetId: string, fileName: string): string {
  const prefix = Array.from(`${assetId}__`);
  const safe = Array.from(fileName.replace(/[^\p{L}\p{Nd} ._-]/gu, "_"));
  const dot = safe.lastIndexOf(".");
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const extension = dot > 0 ? safe.slice(dot) : [];
  const room = Math.max(0, DRIVE_NAME_CHARS - prefix.length - extension.length);
  return [...prefix, ...stem.slice(0, room), ...extension].slice(0, DRIVE_NAME_CHARS).join("");
}

// A media length in frames of a project: never less than 1.
export function sourceFrames(durationMs: number, fps: number): number {
  return Math.max(1, Math.floor((durationMs * fps) / 1000));
}
