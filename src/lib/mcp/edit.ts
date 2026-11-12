import { requireRole } from "@/lib/actor";
import { applyProjectOps, getAppliedRequest, getProject, type AppliedOps, type ProjectRecord } from "@/lib/projects/service";
import type { OpInput } from "@/lib/timeline";
import { checkWriteBudget } from "./budget";
import { failureResult, notFoundText } from "./errors";
import { newIdLines, projectPage } from "./project-text";
import { editRequestId } from "./request-id";
import { fail, type ToolContext, type ToolResult } from "./types";

export type EditDone = { ok: true; applied: AppliedOps; project: ProjectRecord } | { ok: false; result: ToolResult };

type EditKey = { projectId: string; expectedVersion: number; key: unknown };

const requestIdOf = (ctx: ToolContext, { projectId, expectedVersion, key }: EditKey) =>
  editRequestId({ actorId: ctx.actor.userId, projectId, expectedVersion, key });

// The answer a repeated call already got, or null. For tools that must look at the project before they can build ops.
export async function priorEdit(ctx: ToolContext, input: EditKey): Promise<EditDone | null> {
  const applied = await getAppliedRequest(ctx.db, ctx.actor, input.projectId, requestIdOf(ctx, input));
  if (!applied) return null;
  const project = await getProject(ctx.db, ctx.actor, input.projectId);
  if (!project) return { ok: false, result: fail(notFoundText(input.projectId)) };
  return { ok: true, applied, project };
}

// The one path every write takes: role, an earlier landing of the same call, budget, strict apply, then the project is read again.
// Strict: a change planned against an older version is refused, never rebased onto edits Claude has not seen.
// The request id makes a repeat of the same call on the same version answer with the change it already made,
// before the budget is counted: a repeat is not a new change.
export async function runEdit(
  ctx: ToolContext,
  input: { projectId: string; expectedVersion: number; ops: OpInput[]; key: unknown },
): Promise<EditDone> {
  const { projectId, expectedVersion, ops } = input;
  try {
    requireRole(ctx.actor, "editor");
    const prior = await priorEdit(ctx, input);
    if (prior) return prior;
    const budget = await checkWriteBudget(ctx.db, ctx.actor.userId, ctx.limits);
    if (!budget.ok) return { ok: false, result: fail(budget.message) };
    const applied = await applyProjectOps(ctx.db, ctx.actor, {
      projectId,
      baseVersion: expectedVersion,
      ops,
      strict: true,
      requestId: requestIdOf(ctx, input),
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
  const shown = ids.slice(0, ctx.limits.connectorNewIdLines);
  if (shown.length > 0) lines.push("New ids:", ...shown);
  if (ids.length > shown.length) lines.push(`  … and ${ids.length - shown.length} more. Read the project to see them.`);
  lines.push(projectPage(project, { maxChars: ctx.limits.connectorEchoChars }).text);
  return lines.join("\n");
}
