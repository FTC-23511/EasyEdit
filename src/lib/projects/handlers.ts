import { z } from "zod";
import type { DB } from "@/db";
import type { CurrentUser } from "@/lib/access-rules";
import { actorFrom } from "@/lib/actor";
import { apiRoute } from "@/lib/api-route";
import { LIMITS } from "@/lib/limits";
import { actorUserId, displayActor } from "@/lib/projects/display-actor";
import {
  applyProjectOps,
  createProject,
  deleteProject,
  duplicateProject,
  getOpsSince,
  getProject,
  getProjectVersion,
  listProjects,
  renameProject,
} from "@/lib/projects/service";
import { getUserNames } from "@/lib/projects/user-names";
import type { ErrorBody } from "@/lib/service-error";
import type { OpInput } from "@/lib/timeline";

// Authentication only: the service checks the role.
export type HandlerDeps = {
  db: () => DB;
  auth: (req: Request) => Promise<CurrentUser | Response>;
};

export type ProjectRouteContext = { params: Promise<{ id: string }> };

const opsBody = z.object({
  baseVersion: z.number().int().min(0),
  ops: z.array(z.unknown()).min(1),
  strict: z.boolean().optional(),
  requestId: z.string().optional(), // the service checks its format
});

// Only the shape; the service checks the name and format themselves.
const createBody = z.object({ name: z.string(), format: z.string() });

const renameBody = z.object({ name: z.string() });

// Versions are Postgres integers.
const sinceParam = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(0).max(2_147_483_647));

const limitParam = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(LIMITS.opsPageMax));

function errorResponse(status: number, body: ErrorBody): Response {
  return Response.json(body, { status });
}

const invalid = (message: string) => errorResponse(400, { code: "INVALID", message });

const notFound = (id: string) => errorResponse(404, { code: "NOT_FOUND", message: `Project "${id}" not found` });

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

async function readJson(req: Request): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await req.json() };
  } catch {
    return { ok: false };
  }
}

export function makeProjectHandlers(deps: HandlerDeps) {
  return {
    list: apiRoute(async (req: Request): Promise<Response> => {
      const user = await deps.auth(req);
      if (user instanceof Response) return user;
      return Response.json({ projects: await listProjects(deps.db(), actorFrom(user)) });
    }),

    create: apiRoute(async (req: Request): Promise<Response> => {
      const user = await deps.auth(req);
      if (user instanceof Response) return user;
      const json = await readJson(req);
      if (!json.ok) return invalid("Body must be valid JSON");
      const parsed = createBody.safeParse(json.value);
      if (!parsed.success) return invalid(describeIssue(parsed.error));
      const { id } = await createProject(deps.db(), actorFrom(user), parsed.data);
      return Response.json({ id }, { status: 201 });
    }),

    get: apiRoute(async (req: Request, ctx: ProjectRouteContext): Promise<Response> => {
      const user = await deps.auth(req);
      if (user instanceof Response) return user;
      const { id } = await ctx.params;
      const project = await getProject(deps.db(), actorFrom(user), id);
      if (!project) return notFound(id);
      return Response.json({
        id: project.id,
        name: project.name,
        format: project.format,
        doc: project.doc,
        version: project.version,
      });
    }),

    version: apiRoute(async (req: Request, ctx: ProjectRouteContext): Promise<Response> => {
      const user = await deps.auth(req);
      if (user instanceof Response) return user;
      const { id } = await ctx.params;
      const version = await getProjectVersion(deps.db(), actorFrom(user), id);
      if (version === null) return notFound(id);
      return Response.json({ version });
    }),

    rename: apiRoute(async (req: Request, ctx: ProjectRouteContext): Promise<Response> => {
      const user = await deps.auth(req);
      if (user instanceof Response) return user;
      const { id } = await ctx.params;
      const json = await readJson(req);
      if (!json.ok) return invalid("Body must be valid JSON");
      const parsed = renameBody.safeParse(json.value);
      if (!parsed.success) return invalid(describeIssue(parsed.error));
      return Response.json(await renameProject(deps.db(), actorFrom(user), id, parsed.data.name));
    }),

    remove: apiRoute(async (req: Request, ctx: ProjectRouteContext): Promise<Response> => {
      const user = await deps.auth(req);
      if (user instanceof Response) return user;
      const { id } = await ctx.params;
      await deleteProject(deps.db(), actorFrom(user), id);
      return new Response(null, { status: 204 });
    }),

    duplicate: apiRoute(async (req: Request, ctx: ProjectRouteContext): Promise<Response> => {
      const user = await deps.auth(req);
      if (user instanceof Response) return user;
      const { id } = await ctx.params;
      const copy = await duplicateProject(deps.db(), actorFrom(user), id);
      return Response.json({ id: copy.id }, { status: 201 });
    }),
  };
}

export function makeOpsHandlers(deps: HandlerDeps) {
  return {
    getSince: apiRoute(async (req: Request, ctx: ProjectRouteContext): Promise<Response> => {
      const user = await deps.auth(req);
      if (user instanceof Response) return user;
      const { id } = await ctx.params;
      const since = sinceParam.safeParse(new URL(req.url).searchParams.get("since"));
      if (!since.success) return invalid("since must be a non-negative integer");
      const rawLimit = new URL(req.url).searchParams.get("limit");
      const limit = rawLimit === null ? undefined : limitParam.safeParse(rawLimit);
      if (limit && !limit.success) return invalid(`limit must be an integer from 1 to ${LIMITS.opsPageMax}`);
      const result = await getOpsSince(deps.db(), actorFrom(user), id, since.data, limit?.data);
      if (!result) return notFound(id);
      const names = result.entries.length
        ? await getUserNames(deps.db(), result.entries.map((e) => actorUserId(e.actor)))
        : new Map<string, string>();
      const entries = result.entries.map((e) => ({ ...e, actorName: displayActor(e.actor, names) }));
      return Response.json({ ...result, entries });
    }),

    postOps: apiRoute(async (req: Request, ctx: ProjectRouteContext): Promise<Response> => {
      const user = await deps.auth(req);
      if (user instanceof Response) return user;
      const { id } = await ctx.params;
      const json = await readJson(req);
      if (!json.ok) return invalid("Body must be valid JSON");
      const parsed = opsBody.safeParse(json.value);
      if (!parsed.success) return invalid(describeIssue(parsed.error));
      const { version, ops, inverse } = await applyProjectOps(deps.db(), actorFrom(user), {
        projectId: id,
        baseVersion: parsed.data.baseVersion,
        ops: parsed.data.ops as OpInput[],
        strict: parsed.data.strict,
        requestId: parsed.data.requestId,
      });
      return Response.json({ version, ops, inverse });
    }),
  };
}
