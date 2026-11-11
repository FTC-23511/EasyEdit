import type { Clip, MediaClip, TextClip, TimelineDoc, Track } from "@/lib/timeline";
import { layoutText } from "./text-layout";

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type ResolvedSource = { image: CanvasImageSource; width: number; height: number };
export type DrawOptions = {
  resolveSource?: (assetId: string) => ResolvedSource | null; // the seam where media plugs in; nothing provides it yet
  resolveFont?: (family: string) => string; // a document font name to a CSS font-family list
};

// Repeats the --ed-clip-video and --ed-clip-image colors from src/app/globals.css, because a worker cannot read CSS variables.
export const PLACEHOLDER_FILL = { video: "#2c3d5c", image: "#3b3160" } as const;

export function defaultResolveFont(family: string): string {
  return `"${family}", sans-serif`;
}

export function activeClips(doc: TimelineDoc, frame: number): { track: Track; clip: Clip }[] {
  const active: { track: Track; clip: Clip }[] = [];
  for (const track of doc.tracks) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      if (clip.type === "audio") continue;
      if (clip.start <= frame && frame < clip.start + clip.duration) active.push({ track, clip });
    }
  }
  return active;
}

export function fitRect(srcW: number, srcH: number, dstW: number, dstH: number, fit: "cover" | "contain"): { width: number; height: number } {
  const ratio = fit === "cover" ? Math.max(dstW / srcW, dstH / srcH) : Math.min(dstW / srcW, dstH / srcH);
  return { width: srcW * ratio, height: srcH * ratio };
}

function drawText(ctx: Ctx2D, doc: TimelineDoc, clip: TextClip, resolveFont: (family: string) => string): void {
  const { fontWeight, fontSize, fontFamily, color, align } = clip.style;
  ctx.font = `${fontWeight} ${fontSize}px ${resolveFont(fontFamily)}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  for (const line of layoutText(clip, doc.width, (s) => ctx.measureText(s).width)) ctx.fillText(line.text, line.x, line.y);
}

function drawMedia(ctx: Ctx2D, doc: TimelineDoc, clip: MediaClip & { type: "video" | "image" }, resolveSource?: DrawOptions["resolveSource"]): void {
  const source = resolveSource?.(clip.assetId);
  if (source && source.width > 0 && source.height > 0) {
    const { width, height } = fitRect(source.width, source.height, doc.width, doc.height, clip.transform.fit);
    ctx.drawImage(source.image, -width / 2, -height / 2, width, height);
    return;
  }
  ctx.fillStyle = PLACEHOLDER_FILL[clip.type];
  ctx.fillRect(-doc.width / 2, -doc.height / 2, doc.width, doc.height);
  ctx.fillStyle = "#ededed";
  ctx.font = `500 ${Math.round(doc.width * 0.04)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(clip.type === "video" ? "Video" : "Image", 0, 0);
}

// Draws in project pixels and never reads the canvas size: a caller that wants a smaller canvas scales the context first.
export function drawFrame(ctx: Ctx2D, doc: TimelineDoc, frame: number, options: DrawOptions = {}): void {
  const resolveFont = options.resolveFont ?? defaultResolveFont;
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, doc.width, doc.height);
  for (const { clip } of activeClips(doc, frame)) {
    const t = clip.transform;
    ctx.save();
    ctx.globalAlpha = t.opacity;
    ctx.translate(t.x * doc.width, t.y * doc.height);
    ctx.rotate((t.rotation * Math.PI) / 180);
    ctx.scale(t.scale, t.scale);
    if (clip.type === "text") drawText(ctx, doc, clip, resolveFont);
    else if (clip.type === "video" || clip.type === "image") drawMedia(ctx, doc, clip as MediaClip & { type: "video" | "image" }, options.resolveSource);
    ctx.restore();
  }
}
