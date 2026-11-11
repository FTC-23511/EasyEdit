import { z } from "zod";
import { LIMITS } from "@/lib/limits";
import { UNSTORABLE_TEXT, isStorableText } from "@/lib/text";

export const TrackName = z.string().max(LIMITS.trackNameChars).refine(isStorableText, UNSTORABLE_TEXT);

export const FormatId = z.enum(["short_9x16", "feed_4x5", "square_1x1", "long_16x9", "long_4k"]);
export type FormatId = z.infer<typeof FormatId>;

export const TrackKind = z.enum(["video", "overlay", "text", "caption", "audio"]);
export type TrackKind = z.infer<typeof TrackKind>;

export const Transform = z.object({
  x: z.number(), // clip centre, normalised 0..1 of canvas (0.5,0.5 = centre)
  y: z.number(),
  scale: z.number().positive(), // 1 = fitted per `fit`
  rotation: z.number(), // degrees
  opacity: z.number().min(0).max(1),
  fit: z.enum(["cover", "contain"]),
});
export type Transform = z.infer<typeof Transform>;

const ClipBase = {
  id: z.string().min(1),
  start: z.number().int().min(0),
  duration: z.number().int().min(1),
  transform: Transform,
};

export const MediaClip = z.object({
  ...ClipBase,
  type: z.enum(["video", "image", "audio"]),
  assetId: z.string().min(1),
  in: z.number().int().min(0),
  speed: z.number().positive(),
  volume: z.number().min(0).max(2),
});
export type MediaClip = z.infer<typeof MediaClip>;

export const TextStyle = z.object({
  fontFamily: z.string(),
  fontSize: z.number().positive(),
  fontWeight: z.number().int(),
  color: z.string(),
  align: z.enum(["left", "center", "right"]),
});
export type TextStyle = z.infer<typeof TextStyle>;

export const TextClip = z.object({
  ...ClipBase,
  type: z.literal("text"),
  text: z.string().max(LIMITS.textClipChars).refine(isStorableText, UNSTORABLE_TEXT),
  style: TextStyle,
});
export type TextClip = z.infer<typeof TextClip>;

export const Clip = z.discriminatedUnion("type", [MediaClip, TextClip]);
export type Clip = z.infer<typeof Clip>;

export const Track = z.object({
  id: z.string().min(1),
  kind: TrackKind,
  name: TrackName,
  muted: z.boolean(),
  hidden: z.boolean(),
  locked: z.boolean(),
  clips: z.array(Clip),
});
export type Track = z.infer<typeof Track>;

export const TimelineDoc = z.object({
  schemaVersion: z.literal(1),
  format: FormatId,
  width: z.number().int(),
  height: z.number().int(),
  fps: z.number().int(),
  tracks: z.array(Track),
});
export type TimelineDoc = z.infer<typeof TimelineDoc>;
