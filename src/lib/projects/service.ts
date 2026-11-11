import { and, asc, desc, eq, gt, lte, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { rowsOf, type DB } from "@/db";
import { projectOps, projects } from "@/db/schema";
import {
  OpError,
  applyOps,
  createEmptyDoc,
  prepareOps,
  type FormatId,
  type Op,
  type OpInput,
  type TimelineDoc,
} from "@/lib/timeline";

const MAX_WRITE_ATTEMPTS = 3;

const newId = () => nanoid(12);

export type ApplyResult =
  | { ok: true; version: number; ops: Op[] }
  | {
      ok: false;
      status: 400 | 404 | 409;
      code: string;
      opIndex?: number;
      message: string;
      currentVersion?: number;
    };

export async function createProject(
  db: DB,
  input: { name: string; format: FormatId; actor: string },
): Promise<{ id: string; version: 0 }> {
  const id = newId();
  await db.insert(projects).values({
    id,
    name: input.name,
    format: input.format,
    doc: createEmptyDoc(input.format),
    version: 0,
    createdBy: input.actor,
    updatedBy: input.actor,
  });
  return { id, version: 0 };
}

export async function getProject(
  db: DB,
  id: string,
): Promise<{
  id: string;
  name: string;
  format: FormatId;
  doc: TimelineDoc;
  version: number;
  updatedBy: string;
  updatedAt: Date;
} | null> {
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      format: projects.format,
      doc: projects.doc,
      version: projects.version,
      updatedBy: projects.updatedBy,
      updatedAt: projects.updatedAt,
    })
    .from(projects)
    .where(eq(projects.id, id));
  return rows[0] ?? null;
}

export async function listProjects(
  db: DB,
): Promise<{ id: string; name: string; format: FormatId; version: number; updatedBy: string; updatedAt: Date }[]> {
  return db
    .select({
      id: projects.id,
      name: projects.name,
      format: projects.format,
      version: projects.version,
      updatedBy: projects.updatedBy,
      updatedAt: projects.updatedAt,
    })
    .from(projects)
    .orderBy(desc(projects.updatedAt), asc(projects.id));
}

async function readVersion(db: DB, id: string): Promise<number | null> {
  const rows = await db.select({ version: projects.version }).from(projects).where(eq(projects.id, id));
  return rows[0]?.version ?? null;
}

const notFound = (projectId: string): ApplyResult => ({
  ok: false,
  status: 404,
  code: "NOT_FOUND",
  message: `Project "${projectId}" not found`,
});

const conflict = (message: string, currentVersion: number): ApplyResult => ({
  ok: false,
  status: 409,
  code: "CONFLICT",
  message,
  currentVersion,
});

const rejected = (error: OpError, code: string = error.code): ApplyResult => ({
  ok: false,
  status: 400,
  code,
  opIndex: error.opIndex,
  message: error.message,
});

// Updates the doc only if its version is still the one read, and logs the ops from that same update,
// so the doc and the op log can never disagree. Returns the new version, or null if another writer won.
async function writeIfUnchanged(
  db: DB,
  input: { projectId: string; readVersion: number; doc: TimelineDoc; ops: Op[]; actor: string },
): Promise<number | null> {
  const result = await db.execute(sql`
    with upd as (
      update projects
      set doc = ${JSON.stringify(input.doc)}::jsonb, version = version + 1,
          updated_by = ${input.actor}::text, updated_at = now()
      where id = ${input.projectId}::text and version = ${input.readVersion}::integer
      returning version
    )
    insert into project_ops (project_id, version, ops, actor)
    select ${input.projectId}::text, version, ${JSON.stringify(input.ops)}::jsonb, ${input.actor}::text from upd
    returning version
  `);
  const rows = rowsOf<{ version: number }>(result);
  return rows.length > 0 ? Number(rows[0].version) : null;
}

export async function applyProjectOps(
  db: DB,
  input: { projectId: string; baseVersion: number; ops: OpInput[]; actor: string },
): Promise<ApplyResult> {
  if (!Array.isArray(input.ops) || input.ops.length === 0) {
    return { ok: false, status: 400, code: "INVALID", message: "ops must be a non-empty array" };
  }
  let ops: Op[];
  try {
    ops = prepareOps(input.ops, newId);
  } catch (error) {
    if (error instanceof OpError) return rejected(error, "INVALID");
    throw error;
  }

  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    const rows = await db
      .select({ doc: projects.doc, version: projects.version })
      .from(projects)
      .where(eq(projects.id, input.projectId));
    const current = rows[0];
    if (!current) return notFound(input.projectId);
    if (input.baseVersion > current.version) {
      return conflict(
        `Base version ${input.baseVersion} is ahead of the project's version ${current.version}`,
        current.version,
      );
    }

    // Optimistic rebase: ops address clips and tracks by id, so they are applied to the current doc
    // even when the caller's base is older. They are rejected only if they no longer apply.
    let doc: TimelineDoc;
    try {
      doc = applyOps(current.doc, ops).doc;
    } catch (error) {
      if (error instanceof OpError) return rejected(error);
      throw error;
    }

    const version = await writeIfUnchanged(db, {
      projectId: input.projectId,
      readVersion: current.version,
      doc,
      ops,
      actor: input.actor,
    });
    if (version !== null) return { ok: true, version, ops };
  }

  const currentVersion = await readVersion(db, input.projectId);
  if (currentVersion === null) return notFound(input.projectId);
  return conflict(
    `Project changed ${MAX_WRITE_ATTEMPTS} times while applying these ops; reload and try again`,
    currentVersion,
  );
}

export async function getOpsSince(
  db: DB,
  projectId: string,
  since: number,
): Promise<{ version: number; entries: { version: number; ops: Op[]; actor: string }[] } | null> {
  const version = await readVersion(db, projectId);
  if (version === null) return null;
  if (version === since) return { version, entries: [] };
  const entries = await db
    .select({ version: projectOps.version, ops: projectOps.ops, actor: projectOps.actor })
    .from(projectOps)
    // Bounded by the version read above, so a write that lands in between is left for the next poll.
    .where(and(eq(projectOps.projectId, projectId), gt(projectOps.version, since), lte(projectOps.version, version)))
    .orderBy(asc(projectOps.version));
  return { version, entries };
}
