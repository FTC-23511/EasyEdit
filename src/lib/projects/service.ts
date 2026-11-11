import { and, asc, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { rowsOf, type DB } from "@/db";
import { projectOps, projects } from "@/db/schema";
import { requireRole, type Actor } from "@/lib/actor";
import { LIMITS } from "@/lib/limits";
import { copyName, createProjectInput, projectName } from "@/lib/projects/schemas";
import { ServiceError } from "@/lib/service-error";
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

export type ProjectRecord = {
  id: string;
  name: string;
  format: FormatId;
  doc: TimelineDoc;
  version: number;
  updatedBy: string;
  updatedAt: Date;
};

export type ProjectSummary = Omit<ProjectRecord, "doc">;

export type OpLogEntry = {
  version: number;
  ops: Op[];
  inverse: Op[] | null;
  actor: string;
  requestId: string | null;
  createdAt: Date;
};

export type AppliedOps = { version: number; ops: Op[]; inverse: Op[] };

const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const REQUEST_ID_INDEX = "project_ops_project_id_request_id_unique";

// Deleted projects are hidden from every read and write.
const notDeleted = isNull(projects.deletedAt);
const liveProject = (id: string) => and(eq(projects.id, id), notDeleted);

const invalidName = () => new ServiceError("INVALID", 400, `Enter a name up to ${LIMITS.projectNameChars} characters.`);

export async function createProject(
  db: DB,
  actor: Actor,
  input: { name: string; format: string },
): Promise<{ id: string; version: 0 }> {
  requireRole(actor, "editor");
  const name = projectName.safeParse(input.name);
  if (!name.success) throw invalidName();
  const format = createProjectInput.shape.format.safeParse(input.format);
  if (!format.success) throw new ServiceError("INVALID", 400, "Pick a format.");

  const id = newId();
  await db.insert(projects).values({
    id,
    name: name.data,
    format: format.data,
    doc: createEmptyDoc(format.data),
    version: 0,
    createdBy: actor.userId,
    updatedBy: actor.userId,
  });
  return { id, version: 0 };
}

export async function getProject(db: DB, actor: Actor, id: string): Promise<ProjectRecord | null> {
  requireRole(actor, "viewer");
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
    .where(liveProject(id));
  return rows[0] ?? null;
}

export async function listProjects(db: DB, actor: Actor): Promise<ProjectSummary[]> {
  requireRole(actor, "viewer");
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
    .where(notDeleted)
    .orderBy(desc(projects.updatedAt), asc(projects.id));
}

async function readVersion(db: DB, id: string): Promise<number | null> {
  const rows = await db.select({ version: projects.version }).from(projects).where(liveProject(id));
  return rows[0]?.version ?? null;
}

const notFound = (projectId: string) => new ServiceError("NOT_FOUND", 404, `Project "${projectId}" not found`);

const conflict = (message: string, currentVersion: number) =>
  new ServiceError("CONFLICT", 409, message, { currentVersion });

const rejected = (error: OpError, code: OpError["code"] = error.code) =>
  new ServiceError(code, 400, error.message, { opIndex: error.opIndex });

const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

// Updates the doc, and the format column that mirrors it, only if its version is still the one read, and logs
// the ops and their inverse from that same update, so the doc and the op log can never disagree. Returns the new
// version, or null if another writer won or the project was deleted since it was read.
async function writeIfUnchanged(
  db: DB,
  input: {
    projectId: string;
    readVersion: number;
    doc: TimelineDoc;
    ops: Op[];
    inverse: Op[];
    actor: string;
    requestId: string | null;
  },
): Promise<number | null> {
  const result = await db.execute(sql`
    with upd as (
      update projects
      set doc = ${JSON.stringify(input.doc)}::jsonb, format = ${input.doc.format}::text, version = version + 1,
          updated_by = ${input.actor}::text, updated_at = now()
      where id = ${input.projectId}::text and version = ${input.readVersion}::integer and deleted_at is null
      returning version
    )
    insert into project_ops (project_id, version, ops, inverse, actor, request_id)
    select ${input.projectId}::text, version, ${JSON.stringify(input.ops)}::jsonb, ${JSON.stringify(input.inverse)}::jsonb,
           ${input.actor}::text, ${input.requestId}::text from upd
    returning version
  `);
  const rows = rowsOf<{ version: number }>(result);
  return rows.length > 0 ? Number(rows[0].version) : null;
}

// The result already logged under this request id, or null. A request id belongs to the person who first used it.
export async function getAppliedRequest(db: DB, actor: Actor, projectId: string, requestId: string): Promise<AppliedOps | null> {
  const rows = await db
    .select({ version: projectOps.version, ops: projectOps.ops, inverse: projectOps.inverse, actor: projectOps.actor })
    .from(projectOps)
    .where(and(eq(projectOps.projectId, projectId), eq(projectOps.requestId, requestId)));
  const row = rows[0];
  if (!row) return null;
  if (row.actor !== actor.userId) throw new ServiceError("INVALID", 400, "requestId is already in use");
  return { version: row.version, ops: row.ops, inverse: row.inverse ?? [] };
}

// True when a write failed because its request id was logged first. Drivers may wrap the database error.
function isRequestIdTaken(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    const { code, constraint } = e as { code?: unknown; constraint?: unknown };
    if (code === "23505" && (constraint === REQUEST_ID_INDEX || e.message.includes(REQUEST_ID_INDEX))) return true;
  }
  return false;
}

export async function applyProjectOps(
  db: DB,
  actor: Actor,
  input: { projectId: string; baseVersion: number; ops: OpInput[]; strict?: boolean; requestId?: string },
): Promise<AppliedOps> {
  requireRole(actor, "editor");
  const requestId = input.requestId ?? null;
  if (requestId !== null && !REQUEST_ID.test(requestId)) {
    throw new ServiceError("INVALID", 400, "requestId must be 8 to 64 letters, digits, - or _");
  }
  if (!Array.isArray(input.ops) || input.ops.length === 0) {
    throw new ServiceError("INVALID", 400, "ops must be a non-empty array");
  }
  if (input.ops.length > LIMITS.opsPerRequest) {
    throw new ServiceError("LIMIT_EXCEEDED", 400, `At most ${LIMITS.opsPerRequest} ops per request`);
  }
  let ops: Op[];
  try {
    ops = prepareOps(input.ops, newId);
  } catch (error) {
    if (error instanceof OpError) throw rejected(error, "INVALID");
    throw error;
  }

  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    const rows = await db
      .select({ doc: projects.doc, version: projects.version })
      .from(projects)
      .where(liveProject(input.projectId));
    const current = rows[0];
    if (!current) throw notFound(input.projectId);
    // A retry of a write that already landed gets the original answer, even after newer edits.
    if (requestId !== null) {
      const prior = await getAppliedRequest(db, actor, input.projectId, requestId);
      if (prior) return prior;
    }
    // A strict write is refused unless its base is the current version, so it never lands on edits the caller
    // has not seen. Inverses do not need this: their guards refuse an undo that would overwrite a later change.
    if (input.strict && current.version !== input.baseVersion) {
      throw conflict(`Project is at version ${current.version}, not ${input.baseVersion}`, current.version);
    }
    if (input.baseVersion > current.version) {
      throw conflict(
        `Base version ${input.baseVersion} is ahead of the project's version ${current.version}`,
        current.version,
      );
    }

    // Optimistic rebase: ops address clips and tracks by id, so they are applied to the current doc
    // even when the caller's base is older. They are rejected only if they no longer apply. The inverse is
    // recomputed on every attempt, so it always undoes the write against the doc it actually landed on.
    let doc: TimelineDoc;
    let inverse: Op[];
    try {
      ({ doc, inverse } = applyOps(current.doc, ops));
    } catch (error) {
      if (error instanceof OpError) throw rejected(error);
      throw error;
    }
    if (jsonBytes(doc) > LIMITS.docBytes) {
      throw new ServiceError("LIMIT_EXCEEDED", 400, `A project can be at most ${LIMITS.docBytes / 1024 / 1024} MB`);
    }
    // Every accepted change must be undoable with one request.
    if (inverse.length > LIMITS.opsPerRequest) {
      throw new ServiceError("LIMIT_EXCEEDED", 400, "This change is too large to undo in one step. Send it in smaller batches.");
    }
    if (jsonBytes(ops) + jsonBytes(inverse) > LIMITS.opLogRowBytes) {
      throw new ServiceError("LIMIT_EXCEEDED", 400, "This change is too large. Send it in smaller steps.");
    }
    // The undo is itself a write, logged with its own inverse (the redo, which is the same size again).
    // The inverse always applies to the doc it was just computed from, so this dry run cannot fail.
    if (jsonBytes(inverse) + jsonBytes(applyOps(doc, inverse).inverse) > LIMITS.opLogRowBytes) {
      throw new ServiceError("LIMIT_EXCEEDED", 400, "This change is too large to undo in one step. Send it in smaller batches.");
    }

    let version: number | null;
    try {
      version = await writeIfUnchanged(db, {
        projectId: input.projectId,
        readVersion: current.version,
        doc,
        ops,
        inverse,
        actor: actor.userId,
        requestId,
      });
    } catch (error) {
      // The same request id landed first. The whole statement failed, so the doc is unchanged.
      if (requestId !== null && isRequestIdTaken(error)) {
        const prior = await getAppliedRequest(db, actor, input.projectId, requestId);
        if (prior) return prior;
      }
      throw error;
    }
    if (version !== null) return { version, ops, inverse };
  }

  const currentVersion = await readVersion(db, input.projectId);
  if (currentVersion === null) throw notFound(input.projectId);
  throw conflict(
    `Project changed ${MAX_WRITE_ATTEMPTS} times while applying these ops; reload and try again`,
    currentVersion,
  );
}

// Changes neither the version nor the op log: the name is not part of the doc.
export async function renameProject(db: DB, actor: Actor, id: string, name: string): Promise<{ id: string; name: string }> {
  requireRole(actor, "editor");
  const parsed = projectName.safeParse(name);
  if (!parsed.success) throw invalidName();
  const rows = await db
    .update(projects)
    .set({ name: parsed.data, updatedBy: actor.userId, updatedAt: sql`now()` })
    .where(liveProject(id))
    .returning({ name: projects.name });
  if (!rows[0]) throw notFound(id);
  return { id, name: rows[0].name };
}

// A soft delete: the row and its op log are kept, and the row records who deleted it.
export async function deleteProject(db: DB, actor: Actor, id: string): Promise<void> {
  requireRole(actor, "editor");
  const rows = await db
    .update(projects)
    .set({ deletedAt: sql`now()`, updatedBy: actor.userId, updatedAt: sql`now()` })
    .where(liveProject(id))
    .returning({ id: projects.id });
  if (!rows[0]) throw notFound(id);
}

// The doc is copied inside the insert itself, so the copy is always the version current at that moment.
export async function duplicateProject(db: DB, actor: Actor, id: string): Promise<{ id: string; version: 0 }> {
  requireRole(actor, "editor");
  const source = await db.select({ name: projects.name }).from(projects).where(liveProject(id));
  if (!source[0]) throw notFound(id);
  const copyId = newId();
  const result = await db.execute(sql`
    insert into projects (id, name, format, doc, version, created_by, updated_by)
    select ${copyId}::text, ${copyName(source[0].name)}::text, format, doc, 0, ${actor.userId}::text, ${actor.userId}::text
    from projects
    where id = ${id}::text and deleted_at is null
    returning id
  `);
  if (rowsOf(result).length === 0) throw notFound(id);
  return { id: copyId, version: 0 };
}

export type OpsPage = { version: number; entries: OpLogEntry[]; hasMore: boolean };

export async function getProjectVersion(db: DB, actor: Actor, id: string): Promise<number | null> {
  requireRole(actor, "viewer");
  return readVersion(db, id);
}

export async function getOpsSince(
  db: DB,
  actor: Actor,
  projectId: string,
  since: number,
  limit: number = LIMITS.opsPageDefault,
): Promise<OpsPage | null> {
  requireRole(actor, "viewer");
  const version = await readVersion(db, projectId);
  if (version === null) return null;
  if (version === since) return { version, entries: [], hasMore: false };
  // The next limit + 1 entries, bounded by the version read above, so a write that lands in between is left
  // for the next poll. The extra entry only shows whether more remain.
  const next = db
    .select({
      version: projectOps.version,
      ops: projectOps.ops,
      inverse: projectOps.inverse,
      actor: projectOps.actor,
      requestId: projectOps.requestId,
      createdAt: projectOps.createdAt,
    })
    .from(projectOps)
    .where(and(eq(projectOps.projectId, projectId), gt(projectOps.version, since), lte(projectOps.version, version)))
    .orderBy(asc(projectOps.version))
    .limit(limit + 1)
    .as("next");
  // Sized in the database, so entries past the byte budget are never sent here.
  const sized = db
    .select({
      version: next.version,
      ops: next.ops,
      inverse: next.inverse,
      actor: next.actor,
      requestId: next.requestId,
      createdAt: next.createdAt,
      position: sql<number>`row_number() over (order by ${next.version})`.mapWith(Number).as("position"),
      found: sql<number>`count(*) over ()`.mapWith(Number).as("found"),
      runningBytes: sql<number>`sum(octet_length(${next.ops}::text) + coalesce(octet_length(${next.inverse}::text), 0)) over (order by ${next.version})`
        .mapWith(Number)
        .as("running_bytes"),
    })
    .from(next)
    .as("sized");
  // Entries are added until the next one would pass the byte budget; the first is always sent.
  const rows = await db
    .select()
    .from(sized)
    .where(and(lte(sized.position, limit), or(eq(sized.position, 1), lte(sized.runningBytes, LIMITS.opsPageBytes))))
    .orderBy(asc(sized.version));
  const entries: OpLogEntry[] = rows.map(({ version, ops, inverse, actor, requestId, createdAt }) => ({
    version,
    ops,
    inverse,
    actor,
    requestId,
    createdAt,
  }));
  const hasMore = rows.length > 0 && rows.length < rows[0].found;
  // When more remain, the caller resumes from the last entry it got, so nothing is skipped.
  return { version: hasMore ? entries[entries.length - 1].version : version, entries, hasMore };
}
