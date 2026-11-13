import type { DB } from "@/db";
import { assetTrouble } from "@/lib/media/refs";
import { loadAssetFacts } from "@/lib/media/service";
import type { AssetKind } from "@/lib/media/types";
import { assetReason } from "./errors";

type OpHit = { opIndex: number; opName: string; reason: string };

// The first op Claude may not send, or null. replace_track is kept for stored undo data.
export function checkAllowedOps(ops: unknown[]): OpHit | null {
  for (const [opIndex, op] of ops.entries()) {
    if (typeof op === "object" && op !== null && (op as { op?: unknown }).op === "replace_track") {
      return { opIndex, opName: "replace_track", reason: "Change tracks with add_clip, move_clip and the other ops." };
    }
  }
  return null;
}

const MEDIA_TYPES = new Set<unknown>(["video", "image", "audio"]);

// The asset an op names, with the clip's type when the op says it: an add_clip of a media clip, or an update_clip
// that sets assetId. Anything of another shape is left to the engine.
function namedAsset(op: unknown): { assetId: string; clipType?: AssetKind } | null {
  if (typeof op !== "object" || op === null) return null;
  const { op: name, clip, patch } = op as { op?: unknown; clip?: unknown; patch?: unknown };
  if (name === "add_clip" && typeof clip === "object" && clip !== null) {
    const { type, assetId } = clip as { type?: unknown; assetId?: unknown };
    if (MEDIA_TYPES.has(type) && typeof assetId === "string") return { assetId, clipType: type as AssetKind };
  }
  if (name === "update_clip" && typeof patch === "object" && patch !== null) {
    const { assetId } = patch as { assetId?: unknown };
    // The clip's type is not known before the project is read, so the kind is not checked here.
    if (typeof assetId === "string") return { assetId };
  }
  return null;
}

// The first op that names an asset the library cannot give it, or null. Makes no query when no op names an asset.
// The projects service checks the same rules again, and it alone checks lengths.
export async function checkAssetOps(db: DB, ops: unknown[]): Promise<OpHit | null> {
  const named = ops.map(namedAsset);
  const ids = named.flatMap((n) => (n ? [n.assetId] : []));
  if (ids.length === 0) return null;
  const facts = await loadAssetFacts(db, ids);
  for (const [opIndex, n] of named.entries()) {
    if (!n) continue;
    const fact = facts.get(n.assetId);
    const trouble = assetTrouble(fact, n.clipType);
    if (trouble) return { opIndex, opName: (ops[opIndex] as { op: string }).op, reason: assetReason(trouble, n.assetId, fact?.kind) };
  }
  return null;
}
