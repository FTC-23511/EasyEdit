import { graphemes } from "@/lib/text";
import type { TextClip } from "@/lib/timeline";

export const TEXT_BOX_WIDTH = 0.9; // of the project width
export const LINE_HEIGHT = 1.2; // × font size

// Cuts one word into pieces that each fit maxWidth (at least one grapheme per piece).
function cutWord(word: string, maxWidth: number, measure: (s: string) => number): string[] {
  const pieces: string[] = [];
  let piece = "";
  for (const g of graphemes(word)) {
    if (piece && measure(piece + g) > maxWidth) {
      pieces.push(piece);
      piece = "";
    }
    piece += g;
  }
  if (piece) pieces.push(piece);
  return pieces;
}

function wrapParagraph(paragraph: string, maxWidth: number, measure: (s: string) => number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of paragraph.split(" ").filter(Boolean)) {
    if (current && measure(`${current} ${word}`) <= maxWidth) {
      current = `${current} ${word}`;
      continue;
    }
    if (current) lines.push(current);
    const pieces = measure(word) <= maxWidth ? [word] : cutWord(word, maxWidth, measure);
    current = pieces.pop() ?? "";
    lines.push(...pieces);
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

export function wrapLines(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  return text.split(/\r?\n/).flatMap((paragraph) => wrapParagraph(paragraph, maxWidth, measure));
}

export type TextLine = { text: string; x: number; y: number }; // relative to the clip's center, before rotation and scale

export function layoutText(clip: TextClip, docWidth: number, measure: (s: string) => number): TextLine[] {
  const box = TEXT_BOX_WIDTH * docWidth;
  const lines = wrapLines(clip.text, box, measure);
  const x = clip.style.align === "left" ? -box / 2 : clip.style.align === "right" ? box / 2 : 0;
  return lines.map((text, i) => ({ text, x, y: (i - (lines.length - 1) / 2) * clip.style.fontSize * LINE_HEIGHT }));
}
