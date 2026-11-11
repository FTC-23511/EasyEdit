import { DEFAULT_TRANSFORM, type TextClip } from "@/lib/timeline";

export const TEXT_FONT = "Geist";
export const DEFAULT_TEXT_SECONDS = 3;

export type TextPreset = {
  id: "title" | "subtitle" | "lower-third";
  label: string;
  text: string;
  fontSize: number;
  fontWeight: number;
  align: "left" | "center" | "right";
  y: number;
};

export const TEXT_PRESETS: TextPreset[] = [
  { id: "title", label: "Title", text: "Your title", fontSize: 96, fontWeight: 700, align: "center", y: 0.5 },
  { id: "subtitle", label: "Subtitle", text: "Your subtitle", fontSize: 56, fontWeight: 500, align: "center", y: 0.6 },
  { id: "lower-third", label: "Lower third", text: "Name and role", fontSize: 44, fontWeight: 600, align: "left", y: 0.62 },
];

// The id is a stand-in: placement gives the clip its real one.
export function presetClip(preset: TextPreset, start: number, fps: number): TextClip {
  return {
    id: "preset",
    type: "text",
    start,
    duration: DEFAULT_TEXT_SECONDS * fps,
    text: preset.text,
    transform: { ...DEFAULT_TRANSFORM, x: 0.5, y: preset.y },
    style: { fontFamily: TEXT_FONT, fontSize: preset.fontSize, fontWeight: preset.fontWeight, color: "#ffffff", align: preset.align },
  };
}
