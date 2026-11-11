import { meetsRole } from "@/lib/access-rules";
import { actorUserId, displayActor } from "@/lib/projects/display-actor";
import { listProjects } from "@/lib/projects/service";
import { getUserNames } from "@/lib/projects/user-names";
import { timeAgo } from "@/lib/time-ago";
import { escapeQuoted, FORMAT_PRESETS } from "@/lib/timeline";
import { ok, type ToolContext, type ToolResult } from "../types";

export async function listProjectsTool(ctx: ToolContext, input: { cursor?: number }): Promise<ToolResult> {
  const { user } = ctx;
  const can = meetsRole(user.role, "editor") ? "You can read and change projects." : "You can read projects but not change them.";
  const lines = [`Signed in as ${user.name} (${user.role}). ${can}`];

  const projects = await listProjects(ctx.db, ctx.actor);
  if (projects.length === 0) {
    lines.push("No projects yet. Create one with create_project.");
    return ok(lines.join("\n"));
  }

  const start = input.cursor ?? 0;
  const page = projects.slice(start, start + ctx.limits.connectorListPage);
  const names = await getUserNames(ctx.db, page.map((p) => actorUserId(p.updatedBy)));
  const now = ctx.now();
  lines.push(projects.length === 1 ? "1 project:" : `${projects.length} projects, most recently changed first:`);
  for (const p of page) {
    lines.push(
      `${p.id}  "${escapeQuoted(p.name)}"  ${FORMAT_PRESETS[p.format].label}  version ${p.version}  changed ${timeAgo(p.updatedAt, now)} by ${displayActor(p.updatedBy, names)}`,
    );
  }
  const end = start + page.length;
  if (end < projects.length) lines.push(`Showing ${start + 1}–${end} of ${projects.length}. Call list_projects with cursor ${end} for more.`);
  lines.push(`Open a project in the editor at ${ctx.baseUrl}/editor/<id>.`);
  return ok(lines.join("\n"));
}
