import { nanoid } from "nanoid";
import { meetsRole } from "@/lib/access-rules";
import { placeClips } from "@/lib/editor/placement";
import { DEFAULT_TEXT_SECONDS, TEXT_PRESETS, presetClip } from "@/lib/editor/text-presets";
import { LIMITS } from "@/lib/limits";
import { getProject } from "@/lib/projects/service";
import { isStorableText } from "@/lib/text";
import type { TimelineDoc } from "@/lib/timeline";
import { editedText, priorEdit, runEdit, type EditDone } from "../edit";
import { conflictResult, NO_ROOM_FOR_TEXT, notFoundText, roleMessage, textItemInvalid, tooManyTextItems } from "../errors";
import { fail, ok, type ToolContext, type ToolResult } from "../types";

export type TextItem = {
  text: string;
  preset?: "title" | "subtitle" | "lower-third";
  start_seconds?: number;
  duration_seconds?: number;
  track_id?: string;
};

// Text clips from the editor's presets, placed where the editor would put them: the wished track if it is free,
// else a free text track, else a new one. One call is one change.
export async function addTextTool(
  ctx: ToolContext,
  input: { project_id: string; expected_version: number; items: TextItem[] },
): Promise<ToolResult> {
  if (!meetsRole(ctx.actor.role, "editor")) return fail(roleMessage(ctx.user.role));

  const bad = input.items.findIndex(({ text }) => text.length < 1 || text.length > LIMITS.textClipChars || !isStorableText(text));
  if (bad >= 0) return fail(textItemInvalid(bad));
  if (input.items.length > ctx.limits.connectorTextItems) return fail(tooManyTextItems(ctx.limits.connectorTextItems));

  // The key is the call, not the ops: the ops carry freshly made ids, and a repeat must hash the same.
  const edit = { projectId: input.project_id, expectedVersion: input.expected_version, key: { tool: "add_text", items: input.items } };
  // Before the version check: once the first call landed the project has moved on, and a repeat gets the first answer.
  const prior = await priorEdit(ctx, edit);
  if (prior) return answer(ctx, input.items.length, prior);

  const project = await getProject(ctx.db, ctx.actor, input.project_id);
  if (!project) return fail(notFoundText(input.project_id));
  if (project.version !== input.expected_version) return conflictResult(ctx, input.project_id, input.expected_version);

  const placement = placeClips(
    project.doc,
    input.items.map((item) => ({ clip: textClip(project.doc, item), trackId: item.track_id ?? null })),
    () => nanoid(10),
  );
  if (!placement.ok) return fail(NO_ROOM_FOR_TEXT);

  return answer(ctx, input.items.length, await runEdit(ctx, { ...edit, ops: placement.ops }));
}

function textClip(doc: TimelineDoc, item: TextItem) {
  const preset = TEXT_PRESETS.find((p) => p.id === (item.preset ?? "title")) ?? TEXT_PRESETS[0];
  const clip = presetClip(preset, Math.round((item.start_seconds ?? 0) * doc.fps), doc.fps);
  return { ...clip, text: item.text, duration: Math.max(1, Math.round((item.duration_seconds ?? DEFAULT_TEXT_SECONDS) * doc.fps)) };
}

function answer(ctx: ToolContext, count: number, done: EditDone): ToolResult {
  if (!done.ok) return done.result;
  const clips = count === 1 ? "1 text clip" : `${count} text clips`;
  return ok(editedText(ctx, `Added ${clips} as version ${done.applied.version}.`, done));
}
