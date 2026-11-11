const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Splits text into user-perceived characters, so an emoji or a flag stays in one piece.
export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

// Postgres cannot store U+0000 or a lone surrogate (half of an emoji, for example) in text or JSON.
export function isStorableText(text: string): boolean {
  return !text.includes("\u0000") && text.isWellFormed();
}

export const UNSTORABLE_TEXT = "contains a character that cannot be saved";
