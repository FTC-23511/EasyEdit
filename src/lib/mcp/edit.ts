import { requireRole } from "@/lib/actor";
import { applyProjectOps, getProject, type AppliedOps, type ProjectRecord } from "@/lib/projects/service";
import type { OpInput } from "@/lib/timeline";
import { checkWriteBudget } from "./budget";
import { failureResult, notFoundText } from "./errors";
import { newIdLines, projectPage } from "./project-text";
import { editRequestId } from "./request-id";
import { fail, type ToolContext, type ToolResult } from "./types";

export type EditDone = { ok: true; applied: AppliedOps; project: ProjectRecord } | { ok: false; result: ToolResult };

// The one path every write takes: role, budget, request id, strict apply, then the project is read again.
// Strict: a change planned against an older version is refused, never rebased onto edits Claude has not seen.
// The request id makes a repeat of the same call on the same version answer with the change it already made.
export async function runEdit(
  ctx: ToolContext,
  input: { projectId: string; expectedVersion: number; ops: OpInput[]; key: unknown },
): Promise<EditDone> {
  const { projectId, expectedVersion, ops, key } = input;
  try {
    requireRole(ctx.actor, "editor");
    const budget = await checkWriteBudget(ctx.db, ctx.actor.userId, ctx.limits);
    if (!budget.ok) return { ok: false, result: fail(budget.message) };
    const applied = await applyProjectOps(ctx.db, ctx.actor, {
      projectId,
      baseVersion: expectedVersion,
      ops,
      strict: true,
      requestId: editRequestId({ actorId: ctx.actor.userId, projectId, expectedVersion, key }),
    });
    const project = await getProject(ctx.db, ctx.actor, projectId);
    if (!project) return { ok: false, result: fail(notFoundText(projectId)) };
    return { ok: true, applied, project };
  } catch (error) {
    return { ok: false, result: await failureResult(ctx, error, { projectId, expectedVersion, ops }) };
  }
}

export function editedText(ctx: ToolContext, firstLine: string, done: { applied: AppliedOps; project: ProjectRecord }): string {
  const { applied, project } = done;
  const lines = [firstLine];
  if (project.version !== applied.version) lines.push(`The project has changed again since: it is now at version ${project.version}.`);
  const ids = newIdLines(applied.ops);
  if (ids.length > 0) lines.push("New ids:", ...ids);
  lines.push(projectPage(project, { maxChars: ctx.limits.connectorEchoChars }).text);
  return lines.join("\n");
}
