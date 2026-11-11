import { graphemes } from "@/lib/text";
import { docDuration } from "./presets";
import type { Clip, Track, TimelineDoc } from "./types";

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

function escapeQuoted(text: string): string {
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

function describeTrack(track: Track, fps: number): string[] {
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
    for (const clip of sorted) lines.push(describeClip(clip, fps));
  }
  return lines;
}

export function describe(doc: TimelineDoc, opts?: { version?: number }): string {
  const version = opts?.version === undefined ? "" : ` · version ${opts.version}`;
  const lines = [
    `Format ${doc.format} ${doc.width}x${doc.height} @${doc.fps}fps · duration ${framesToSeconds(docDuration(doc), doc.fps)}s${version}`,
  ];
  for (const track of doc.tracks) lines.push(...describeTrack(track, doc.fps));
  return lines.join("\n");
}
