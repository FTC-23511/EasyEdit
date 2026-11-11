// Takes whole lines from `offset` while they fit in `maxChars` (each costs its length plus a line break).
// Always takes one line when any is left, so a single long line cannot stall a reader.
export function pageLines(lines: string[], offset: number, maxChars: number): { lines: string[]; next: number | null } {
  const start = Math.max(0, offset);
  let used = 0;
  let end = start;
  while (end < lines.length) {
    const cost = lines[end].length + 1;
    if (end > start && used + cost > maxChars) break;
    used += cost;
    end += 1;
  }
  return { lines: lines.slice(start, end), next: end < lines.length ? end : null };
}
