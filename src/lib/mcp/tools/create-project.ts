import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { projects } from "@/db/schema";
import { meetsRole } from "@/lib/access-rules";
import { createProject, getProject } from "@/lib/projects/service";
import { ServiceError } from "@/lib/service-error";
import { isStorableText } from "@/lib/text";
import { escapeQuoted } from "@/lib/timeline";
import { checkProjectBudget } from "../budget";
import { roleMessage } from "../errors";
import { projectPage } from "../project-text";
import { fail, ok, type ToolContext, type ToolResult } from "../types";

// A repeat of the same create within this window is taken as a retry, and answers with the project it already made.
const TWIN_WINDOW = sql`interval '60 seconds'`;

export async function createProjectTool(ctx: ToolContext, input: { name: string; format: string }): Promise<ToolResult> {
  if (!meetsRole(ctx.user.role, "editor")) return fail(roleMessage(ctx.user.role));

  const twinId = await findTwin(ctx, input);
  const twin = twinId ? await getProject(ctx.db, ctx.actor, twinId) : null;
  if (twin) return answer(ctx, twin, `This project was created a moment ago, so it is used again: "${escapeQuoted(twin.name)}" (id ${twin.id}).`);

  const budget = await checkProjectBudget(ctx.db, ctx.actor.userId, ctx.limits);
  if (!budget.ok) return fail(budget.message);

  let id: string;
  try {
    ({ id } = await createProject(ctx.db, ctx.actor, input));
  } catch (error) {
    if (error instanceof ServiceError) return fail(error.message);
    throw error;
  }
  const project = await getProject(ctx.db, ctx.actor, id);
  if (!project) throw new Error("A project just created could not be read");
  return answer(ctx, project, `Created project "${escapeQuoted(project.name)}" (id ${project.id}), version 0.`);
}

// A live project this actor created in the last minute with the same trimmed name and the same format.
// A name the database cannot store has no twin; skipping the lookup lets the service refuse it with its sentence.
async function findTwin(ctx: ToolContext, input: { name: string; format: string }): Promise<string | null> {
  const name = input.name.trim();
  if (!isStorableText(name)) return null;
  const rows = await ctx.db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.createdBy, ctx.actor.userId),
        eq(projects.name, name),
        sql`${projects.format} = ${input.format}`,
        isNull(projects.deletedAt),
        sql`${projects.createdAt} > now() - ${TWIN_WINDOW}`,
      ),
    )
    .orderBy(desc(projects.createdAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

function answer(ctx: ToolContext, project: Parameters<typeof projectPage>[0], firstLine: string): ToolResult {
  return ok(
    [firstLine, `Open it in the editor: ${ctx.baseUrl}/editor/${project.id}`, projectPage(project, { maxChars: ctx.limits.connectorEchoChars }).text].join(
      "\n",
    ),
  );
}
