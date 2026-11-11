// The first op Claude may not send yet, or null. Media clips need a library that does not exist; replace_track is kept for stored undo data.
export function checkAllowedOps(ops: unknown[]): { opIndex: number; opName: string; reason: string } | null {
  for (const [opIndex, op] of ops.entries()) {
    const reason = refusal(op);
    if (reason !== null) return { opIndex, opName: (op as { op: string }).op, reason };
  }
  return null;
}

const MEDIA_TYPES = new Set<unknown>(["video", "image", "audio"]);

function refusal(op: unknown): string | null {
  if (typeof op !== "object" || op === null) return null;
  const { op: name, clip } = op as { op?: unknown; clip?: unknown };
  if (name === "add_clip" && typeof clip === "object" && clip !== null && MEDIA_TYPES.has((clip as { type?: unknown }).type)) {
    return "Video, image and audio clips can't be added until the media library exists. Only text clips can be added.";
  }
  if (name === "replace_track") return "Change tracks with add_clip, move_clip and the other ops.";
  return null;
}
