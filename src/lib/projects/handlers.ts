import { z } from "zod";
import type { DB } from "@/db";
import type { CurrentUser } from "@/lib/access-rules";
import type { Role } from "@/lib/allowlist/service";
import { applyProjectOps, createProject, getOpsSince, getProject, listProjects } from "@/lib/projects/service";
import { FORMAT_PRESETS, type FormatId, type OpInput } from "@/lib/timeline";

export type HandlerDeps = {
  db: () => DB;
  auth: (req: Request, min: Role) => Promise<CurrentUser | Response>;
};

export type ProjectRouteContext = { params: Promise<{ id: string }> };

const FORMAT_IDS = Object.keys(FORMAT_PRESETS) as [FormatId, ...FormatId[]];

const createBody = z.object({
  name: z.string().trim().min(1).max(100),
  format: z.enum(FORMAT_IDS),
});

const opsBody = z.object({
  baseVersion: z.number().int().min(0),
  ops: z.array(z.unknown()).min(1).max(500),
});

const sinceParam = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER));

type ErrorBody = { code: string; message: string; opIndex?: number; currentVersion?: number };

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
    async list(req: Request): Promise<Response> {
      const user = await deps.auth(req, "viewer");
      if (user instanceof Response) return user;
      return Response.json({ projects: await listProjects(deps.db()) });
    },

    async create(req: Request): Promise<Response> {
      const user = await deps.auth(req, "editor");
      if (user instanceof Response) return user;
      const json = await readJson(req);
      if (!json.ok) return invalid("Body must be valid JSON");
      const parsed = createBody.safeParse(json.value);
      if (!parsed.success) return invalid(describeIssue(parsed.error));
      const { id } = await createProject(deps.db(), { ...parsed.data, actor: user.id });
      return Response.json({ id }, { status: 201 });
    },

    async get(req: Request, ctx: ProjectRouteContext): Promise<Response> {
      const user = await deps.auth(req, "viewer");
      if (user instanceof Response) return user;
      const { id } = await ctx.params;
      const project = await getProject(deps.db(), id);
      if (!project) return notFound(id);
      return Response.json({
        id: project.id,
        name: project.name,
        format: project.format,
        doc: project.doc,
        version: project.version,
      });
    },
  };
}

export function makeOpsHandlers(deps: HandlerDeps) {
  return {
    async getSince(req: Request, ctx: ProjectRouteContext): Promise<Response> {
      const user = await deps.auth(req, "viewer");
      if (user instanceof Response) return user;
      const { id } = await ctx.params;
      const since = sinceParam.safeParse(new URL(req.url).searchParams.get("since"));
      if (!since.success) return invalid("since must be a non-negative integer");
      const result = await getOpsSince(deps.db(), id, since.data);
      if (!result) return notFound(id);
      return Response.json(result);
    },

    async postOps(req: Request, ctx: ProjectRouteContext): Promise<Response> {
      const user = await deps.auth(req, "editor");
      if (user instanceof Response) return user;
      const { id } = await ctx.params;
      const json = await readJson(req);
      if (!json.ok) return invalid("Body must be valid JSON");
      const parsed = opsBody.safeParse(json.value);
      if (!parsed.success) return invalid(describeIssue(parsed.error));
      const result = await applyProjectOps(deps.db(), {
        projectId: id,
        baseVersion: parsed.data.baseVersion,
        ops: parsed.data.ops as OpInput[],
        actor: user.id,
      });
      if (result.ok) return Response.json({ version: result.version, ops: result.ops });
      const { status, code, message, opIndex, currentVersion } = result;
      return errorResponse(status, { code, message, opIndex, currentVersion });
    },
  };
}
