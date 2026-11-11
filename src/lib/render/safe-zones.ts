import type { FormatId } from "@/lib/timeline";

export type SafeZone = { top: number; right: number; bottom: number; left: number; label: string }; // margins as fractions of the frame

const DEFAULT_ZONE: SafeZone = { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05, label: "Safe area" };

export const SAFE_ZONES: Record<FormatId, SafeZone> = {
  short_9x16: { top: 0.14, right: 0.06, bottom: 0.35, left: 0.06, label: "Reels and Shorts safe area" },
  feed_4x5: DEFAULT_ZONE,
  square_1x1: DEFAULT_ZONE,
  long_16x9: DEFAULT_ZONE,
  long_4k: DEFAULT_ZONE,
};
