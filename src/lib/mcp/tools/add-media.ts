import { nanoid } from "nanoid";
import { meetsRole } from "@/lib/access-rules";
import { mediaClipFor } from "@/lib/editor/media-clips";
import { homeKind, placeClips } from "@/lib/editor/placement";
import { assetTrouble } from "@/lib/media/refs";
import { loadAssetFacts, type AssetFact } from "@/lib/media/service";
import { getProject } from "@/lib/projects/service";
import type { MediaClip, TimelineDoc } from "@/lib/timeline";
import { editedText, priorEdit, runEdit, type EditDone } from "../edit";
import { assetReason, conflictResult, mediaItemOutside, NO_ROOM_FOR_MEDIA, notFoundText, roleMessage, tooManyMediaItems } from "../errors";
import { fail, ok, type ToolContext, type ToolResult } from "../types";

export type MediaItem = { asset_id: string; start_seconds?: number; in_seconds?: number; duration_seconds?: number; track_id?: string };

const NOTHING_APPLIED = "Nothing was applied.";

// Clips of library assets, laid end to end in the order given unless a start is given, and placed where the editor
// would put them: the wished track if it is free, else a free track of the right kind, else a new one. One call is one change.
export async function addMediaTool(
  ctx: ToolContext,
  input: { project_id: string; expected_version: number; items: MediaItem[] },
): Promise<ToolResult> {
  if (!meetsRole(ctx.actor.role, "editor")) return fail(roleMessage(ctx.user.role));
  if (input.items.length > ctx.limits.connectorMediaItems) return fail(tooManyMediaItems(ctx.limits.connectorMediaItems));

  // The key is the call, not the ops: the ops carry freshly made ids, and a repeat must hash the same.
  const edit = { projectId: input.project_id, expectedVersion: input.expected_version, key: { tool: "add_media", items: input.items } };
  // Before the version check: once the first call landed the project has moved on, and a repeat gets the first answer.
  const prior = await priorEdit(ctx, edit);
  if (prior) return answer(ctx, input.items.length, prior);

  const project = await getProject(ctx.db, ctx.actor, input.project_id);
  if (!project) return fail(notFoundText(input.project_id));
  if (project.version !== input.expected_version) return conflictResult(ctx, input.project_id, input.expected_version);

  const facts = await loadAssetFacts(ctx.db, input.items.map((item) => item.asset_id));
  for (const [i, item] of input.items.entries()) {
    // No clip type is passed: the clip takes the asset's kind.
    const trouble = assetTrouble(facts.get(item.asset_id));
    if (trouble) return fail(`items[${i}]: ${assetReason(trouble, item.asset_id)}\n${NOTHING_APPLIED}`);
  }

  const { doc } = project;
  const clips: Omit<MediaClip, "id">[] = [];
  for (const [i, item] of input.items.entries()) {
    const fact = facts.get(item.asset_id)!;
    const previous = clips.at(-1);
    const start =
      item.start_seconds !== undefined
        ? Math.round(item.start_seconds * doc.fps)
        : previous
          ? previous.start + previous.duration
          : trackEnd(doc, fact, item.track_id);
    const clip = mediaClipFor(fact, start, doc.fps, { inSeconds: item.in_seconds, durationSeconds: item.duration_seconds });
    if (!clip) return fail(`${mediaItemOutside(i, (fact.durationMs ?? 0) / 1000)}\n${NOTHING_APPLIED}`);
    clips.push(clip);
  }

  // The id is a stand-in: placement gives each clip its real one.
  const placement = placeClips(
    doc,
    clips.map((clip, i) => ({ clip: { ...clip, id: "new" }, trackId: input.items[i].track_id ?? null })),
    () => nanoid(10),
  );
  if (!placement.ok) return fail(NO_ROOM_FOR_MEDIA);

  return answer(ctx, input.items.length, await runEdit(ctx, { ...edit, ops: placement.ops }));
}

// Where a first item without a start goes: after the last clip of the track it names, else of the first track of
// its home kind, else at 0.
function trackEnd(doc: TimelineDoc, fact: AssetFact, trackId: string | undefined): number {
  const track = doc.tracks.find((t) => t.id === trackId) ?? doc.tracks.find((t) => t.kind === homeKind(fact.kind));
  return Math.max(0, ...(track?.clips ?? []).map((c) => c.start + c.duration));
}

function answer(ctx: ToolContext, count: number, done: EditDone): ToolResult {
  if (!done.ok) return done.result;
  const clips = count === 1 ? "1 clip" : `${count} clips`;
  return ok(editedText(ctx, `Added ${clips} as version ${done.applied.version}.`, done));
}
