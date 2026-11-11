import type { Clip, OpInput } from "@/lib/timeline";

// The inspector shows times in seconds (snapped to whole frames on the way in), and position,
// scale and opacity in percent, where 50% is the center.

export type ClipField =
  | "text"
  | "fontSize"
  | "fontWeight"
  | "color"
  | "align"
  | "x"
  | "y"
  | "scale"
  | "rotation"
  | "opacity"
  | "start"
  | "duration";

// The label of the change, for undo and the activity list.
export const FIELD_LABEL: Record<ClipField, string> = {
  text: "text edit",
  fontSize: "style change",
  fontWeight: "style change",
  color: "style change",
  align: "style change",
  x: "position change",
  y: "position change",
  scale: "position change",
  rotation: "position change",
  opacity: "position change",
  start: "timing change",
  duration: "timing change",
};

export const WEIGHTS: { value: number; label: string }[] = [
  { value: 400, label: "Regular" },
  { value: 500, label: "Medium" },
  { value: 600, label: "Semibold" },
  { value: 700, label: "Bold" },
  { value: 900, label: "Black" },
];

export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 1000;
const ALIGNS = ["left", "center", "right"] as const;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

// At most one decimal, without a trailing ".0" ("33.3", "50").
const oneDecimal = (n: number) => String(Number(n.toFixed(1)) || 0);

// An optional sign, digits and an optional decimal part ("12", "-0.5", ".5", "2."). Not "0x10" or "1e2".
const PLAIN_DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)$/;

export function parseNumber(raw: string): number | null {
  const text = raw.trim();
  return PLAIN_DECIMAL.test(text) ? Number(text) : null;
}

export function clipFieldValue(clip: Clip, field: ClipField, fps: number): string {
  switch (field) {
    case "x":
    case "y":
    case "scale":
    case "opacity":
      return oneDecimal(clip.transform[field] * 100);
    case "rotation":
      return oneDecimal(clip.transform.rotation);
    case "start":
      return (clip.start / fps).toFixed(2);
    case "duration":
      return (clip.duration / fps).toFixed(2);
  }
  if (clip.type !== "text") return "";
  switch (field) {
    case "text":
      return clip.text;
    case "fontSize":
      return oneDecimal(clip.style.fontSize);
    case "fontWeight":
      return String(clip.style.fontWeight);
    case "color":
      return clip.style.color.toLowerCase();
    case "align":
      return clip.style.align;
  }
}

// The ops that set the field to what was typed: null when it is not valid input, [] when it
// changes nothing. The rules of the change itself (overlaps, locked tracks, what text may hold)
// stay with applyOps.
export function clipFieldOps(clip: Clip, field: ClipField, raw: string, fps: number): OpInput[] | null {
  const update = (patch: Record<string, unknown>): OpInput[] => [{ op: "update_clip", clipId: clip.id, patch }];

  switch (field) {
    case "start": {
      const seconds = parseNumber(raw);
      if (seconds === null || seconds < 0) return null;
      const start = Math.max(0, Math.round(seconds * fps));
      return start === clip.start ? [] : [{ op: "move_clip", clipId: clip.id, start }];
    }
    case "duration": {
      const seconds = parseNumber(raw);
      if (seconds === null) return null;
      const duration = Math.max(1, Math.round(seconds * fps));
      return duration === clip.duration ? [] : [{ op: "trim_clip", clipId: clip.id, edge: "end", to: clip.start + duration }];
    }
    case "x":
    case "y": {
      const n = parseNumber(raw);
      return n === null ? null : update({ transform: { [field]: n / 100 } });
    }
    case "scale": {
      const n = parseNumber(raw);
      return n === null || n <= 0 ? null : update({ transform: { scale: n / 100 } });
    }
    case "rotation": {
      const n = parseNumber(raw);
      return n === null ? null : update({ transform: { rotation: n } });
    }
    case "opacity": {
      const n = parseNumber(raw);
      return n === null ? null : update({ transform: { opacity: clamp(n / 100, 0, 1) } });
    }
  }

  if (clip.type !== "text") return null;
  switch (field) {
    case "text":
      return update({ text: raw });
    case "fontSize": {
      const n = parseNumber(raw);
      return n === null ? null : update({ style: { fontSize: clamp(Math.round(n), FONT_SIZE_MIN, FONT_SIZE_MAX) } });
    }
    case "fontWeight": {
      const n = parseNumber(raw);
      return n === null ? null : update({ style: { fontWeight: Math.round(n) } });
    }
    case "color": {
      const color = raw.trim();
      return HEX_COLOR.test(color) ? update({ style: { color: color.toLowerCase() } }) : null;
    }
    case "align": {
      const align = ALIGNS.find((a) => a === raw);
      return align ? update({ style: { align } }) : null;
    }
  }
}
