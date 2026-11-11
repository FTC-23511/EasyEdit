import { getProject } from "@/lib/projects/service";
import { notFoundText } from "../errors";
import { projectPage } from "../project-text";
import { fail, ok, type ToolContext, type ToolResult } from "../types";

export async function getProjectTool(ctx: ToolContext, input: { project_id: string; cursor?: number }): Promise<ToolResult> {
  const project = await getProject(ctx.db, ctx.actor, input.project_id);
  if (!project) return fail(notFoundText(input.project_id));
  return ok(projectPage(project, { cursor: input.cursor, maxChars: ctx.limits.connectorReadChars }).text);
}
