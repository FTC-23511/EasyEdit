import { getProject } from "@/lib/projects/service";
import { CURSOR_NEEDS_VERSION, notFoundText, projectChangedWhileReading } from "../errors";
import { projectPage } from "../project-text";
import { fail, ok, type ToolContext, type ToolResult } from "../types";

// A page after the first is read only at the version the earlier pages came from: lines shift when the project changes,
// so a page from another version could skip clips or show them twice.
export async function getProjectTool(
  ctx: ToolContext,
  input: { project_id: string; cursor?: number; version?: number },
): Promise<ToolResult> {
  const project = await getProject(ctx.db, ctx.actor, input.project_id);
  if (!project) return fail(notFoundText(input.project_id));
  const cursor = input.cursor ?? 0;
  if (cursor > 0) {
    if (input.version === undefined) return fail(CURSOR_NEEDS_VERSION);
    if (input.version !== project.version) return fail(projectChangedWhileReading(project.version));
  }
  return ok(projectPage(project, { cursor, maxChars: ctx.limits.connectorReadChars }).text);
}
