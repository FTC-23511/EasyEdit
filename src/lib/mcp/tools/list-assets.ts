import { sourceFrames } from "@/lib/media/rules";
import { listAssets } from "@/lib/media/service";
import type { AssetKind, AssetView } from "@/lib/media/types";
import { timeAgo } from "@/lib/time-ago";
import { DEFAULT_FPS, escapeQuoted } from "@/lib/timeline";
import { oneLine } from "../one-line";
import { ok, type ToolContext, type ToolResult } from "../types";

const CLOSING =
  "Put one on a timeline with add_media. You cannot see inside footage yet: go by names, events and lengths, and ask the person when unsure.";

// The team's ready media, newest first, one line each. Pages are cut by count, like list_projects.
export async function listAssetsTool(ctx: ToolContext, input: { kind?: AssetKind; search?: string; cursor?: number }): Promise<ToolResult> {
  const library = (await listAssets(ctx.db, ctx.actor)).filter((a) => a.status === "ready" && !a.removed);
  if (library.length === 0) return ok("The library is empty. A person uploads media in the editor's Media tab.");

  const word = input.search?.toLowerCase();
  const matches = library.filter(
    (a) => (input.kind === undefined || a.kind === input.kind) && (word === undefined || [a.name, a.event ?? ""].some((s) => s.toLowerCase().includes(word))),
  );
  if (matches.length === 0) return ok(`No assets match. The library has ${library.length} in all; call list_assets with no filter to see them.`);

  const start = input.cursor ?? 0;
  const page = matches.slice(start, start + ctx.limits.connectorAssetsPage);
  const now = ctx.now();
  const lines = [matches.length === 1 ? "1 asset:" : `${matches.length} assets, newest first:`];
  for (const asset of page) lines.push(assetLine(asset, now));
  const end = start + page.length;
  if (end < matches.length) lines.push(`Showing ${start + 1}–${end} of ${matches.length}. Call list_assets with ${nextCall(input, end)} for more.`);
  lines.push(CLOSING);
  return ok(lines.join("\n"));
}

const quoted = (text: string) => `"${escapeQuoted(oneLine(text))}"`;

// The arguments of the call for the next page: the same filter, and the cursor.
function nextCall(input: { kind?: AssetKind; search?: string }, cursor: number): string {
  const filter: string[] = [];
  if (input.kind !== undefined) filter.push(`kind ${quoted(input.kind)}`);
  if (input.search !== undefined) filter.push(`search ${quoted(input.search)}`);
  return filter.length === 0 ? `cursor ${cursor}` : `${filter.join(", ")} and cursor ${cursor}`;
}

function assetLine(asset: AssetView, now: Date): string {
  const parts = [asset.id, asset.kind, quoted(asset.name)];
  if (asset.kind !== "image" && asset.durationMs !== null) {
    const frames = sourceFrames(asset.durationMs, DEFAULT_FPS);
    parts.push(`${(asset.durationMs / 1000).toFixed(2)}s (${frames} frames at ${DEFAULT_FPS} fps)`);
  }
  if (asset.kind !== "audio" && asset.width !== null && asset.height !== null) parts.push(`${asset.width}x${asset.height}`);
  if (asset.kind === "video") parts.push(asset.hasAudio ? "with sound" : "no sound");
  if (asset.event !== null) parts.push(`event ${quoted(asset.event)}`);
  parts.push(`uploaded ${timeAgo(new Date(asset.createdAt), now)} by ${oneLine(asset.uploadedByName)}`);
  return parts.join("  ");
}
