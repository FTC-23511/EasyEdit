import { graphemes } from "@/lib/text";
import { docDuration } from "./presets";
import type { Clip, Track, TimelineDoc, Transform } from "./types";

const TEXT_PREVIEW_CHARS = 40;

export function framesToSeconds(f: number, fps: number): string {
  return (f / fps).toFixed(2);
}

const ESCAPES: Record<string, string> = {
  "\\": "\\\\",
  '"': '\\"',
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

export function escapeQuoted(text: string): string {
  return text.replace(/[\\"\n\r\t\u2028\u2029]/g, (ch) => ESCAPES[ch]);
}

function describeText(text: string): string {
  const flat = text.replace(/\r\n|\r|\n/g, " ");
  const chars = graphemes(flat);
  const shown = chars.length > TEXT_PREVIEW_CHARS ? `${chars.slice(0, TEXT_PREVIEW_CHARS).join("")}…` : flat;
  return escapeQuoted(shown);
}

function describeClip(clip: Clip, fps: number): string {
  const range = `${framesToSeconds(clip.start, fps)}–${framesToSeconds(clip.start + clip.duration, fps)}s`;
  if (clip.type === "text") {
    return `  ${clip.id}  text  ${range}  "${describeText(clip.text)}"`;
  }
  return `  ${clip.id}  ${clip.type}  ${range}  asset=${clip.assetId} in=${framesToSeconds(clip.in, fps)}s speed=${clip.speed} vol=${clip.volume}`;
}

// Scale, rotation and opacity are only worth a word when they are not the defaults.
function describeTransformChanges(t: Transform): string {
  let out = "";
  if (t.scale !== 1) out += ` scale=${t.scale}`;
  if (t.rotation !== 0) out += ` rotation=${t.rotation}`;
  if (t.opacity !== 1) out += ` opacity=${t.opacity}`;
  return out;
}

function describeClipInDetail(clip: Clip, fps: number): string {
  const range = `${framesToSeconds(clip.start, fps)}–${framesToSeconds(clip.start + clip.duration, fps)}s`;
  const frames = `frames ${clip.start}–${clip.start + clip.duration}`;
  const head = `  ${clip.id}  ${clip.type}  ${range}  ${frames}`;
  const t = clip.transform;
  if (clip.type === "text") {
    const s = clip.style;
    return (
      `${head}  "${escapeQuoted(clip.text)}"` +
      `  font="${escapeQuoted(s.fontFamily)}" size=${s.fontSize} weight=${s.fontWeight} color="${escapeQuoted(s.color)}" align=${s.align} x=${t.x} y=${t.y}` +
      describeTransformChanges(t)
    );
  }
  return (
    `${head}  asset="${escapeQuoted(clip.assetId)}" in=${framesToSeconds(clip.in, fps)}s speed=${clip.speed} vol=${clip.volume}` +
    `  x=${t.x} y=${t.y} fit=${t.fit}` +
    describeTransformChanges(t)
  );
}

function describeTrack(track: Track, fps: number, detail: boolean): string[] {
  const flags = [
    track.hidden && "hidden",
    track.muted && "muted",
    track.locked && "locked",
  ].filter(Boolean);
  const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";
  const lines = [`Track ${track.id} [${track.kind}] "${escapeQuoted(track.name)}"${suffix}`];
  if (track.clips.length === 0) {
    lines.push("  (empty)");
  } else {
    const sorted = [...track.clips].sort((a, b) => a.start - b.start);
    for (const clip of sorted) lines.push(detail ? describeClipInDetail(clip, fps) : describeClip(clip, fps));
  }
  return lines;
}

export function describe(doc: TimelineDoc, opts?: { version?: number; detail?: boolean }): string {
  const version = opts?.version === undefined ? "" : ` · version ${opts.version}`;
  const lines = [
    `Format ${doc.format} ${doc.width}x${doc.height} @${doc.fps}fps · duration ${framesToSeconds(docDuration(doc), doc.fps)}s${version}`,
  ];
  for (const track of doc.tracks) lines.push(...describeTrack(track, doc.fps, opts?.detail === true));
  return lines.join("\n");
}
