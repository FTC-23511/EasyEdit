// One file the browser keeps: how large it is and when it was last used.
export type CacheEntry = { fileId: string; bytes: number; usedAt: number };

// The files to drop, least recently used first, so that incomingBytes fits under capBytes. Never one in `keep`.
// When no room can be made that way, nothing is dropped.
export function pickEvictions(entries: CacheEntry[], incomingBytes: number, capBytes: number, keep: Set<string>): string[] {
  let held = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const drop: string[] = [];
  // Of two files used at the same time, the one listed first goes first.
  for (const entry of entries.filter((one) => !keep.has(one.fileId)).sort((a, b) => a.usedAt - b.usedAt)) {
    if (held + incomingBytes <= capBytes) break;
    drop.push(entry.fileId);
    held -= entry.bytes;
  }
  return held + incomingBytes <= capBytes ? drop : [];
}
