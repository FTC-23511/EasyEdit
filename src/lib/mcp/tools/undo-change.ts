import { meetsRole } from "@/lib/access-rules";
import { summarizeOps } from "@/lib/editor/activity";
import { getOpsSince } from "@/lib/projects/service";
import type { OpInput } from "@/lib/timeline";
import { editedText, runEdit } from "../edit";
import { noSuchChange, notFoundText, noUndoData, roleMessage, undoFailure } from "../errors";
import { fail, ok, type ToolContext, type ToolResult } from "../types";

// Applies the inverse stored with an earlier change, as a new change, like the editor's Activity list does.
// The inverse's guards refuse it when that part of the project was changed afterwards.
export async function undoChangeTool(
  ctx: ToolContext,
  input: { project_id: string; expected_version: number; version: number },
): Promise<ToolResult> {
  const { project_id: projectId, expected_version: expectedVersion, version } = input;
  if (!meetsRole(ctx.actor.role, "editor")) return fail(roleMessage(ctx.user.role));

  const page = await getOpsSince(ctx.db, ctx.actor, projectId, version - 1, 1);
  if (!page) return fail(notFoundText(projectId));
  const entry = page.entries[0];
  if (!entry || entry.version !== version) return fail(noSuchChange(version));
  if (!entry.inverse || entry.inverse.length === 0) return fail(noUndoData(version));

  // Not checked against the ops Claude may send: stored undo data may restore a whole track.
  const done = await runEdit(ctx, { projectId, expectedVersion, ops: entry.inverse as OpInput[], key: { tool: "undo_change", version } });
  if (!done.ok) return undoFailure(version, done.result);
  return ok(editedText(ctx, `Undid version ${version} (${summarizeOps(entry.ops)}) as version ${done.applied.version}.`, done));
}
