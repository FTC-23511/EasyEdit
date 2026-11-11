import type { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { rowsOf, type DB } from "@/db";
import {
  applyProjectOps,
  createProject,
  getOpsSince,
  getProject,
  listProjects,
  type ApplyResult,
} from "@/lib/projects/service";
import { DEFAULT_TRANSFORM, createEmptyDoc, type OpInput, type TextClip } from "@/lib/timeline";
import { makeTestDb } from "../helpers/db";

function textClip(overrides: Partial<Record<keyof TextClip, unknown>> = {}) {
  return {
    id: "c1",
    type: "text",
    start: 0,
    duration: 30,
    transform: { ...DEFAULT_TRANSFORM },
    text: "hi",
    style: { fontFamily: "Inter", fontSize: 64, fontWeight: 700, color: "#fff", align: "center" },
    ...overrides,
  } as Extract<OpInput, { op: "add_clip" }>["clip"];
}

async function loggedVersions(db: DB, projectId: string): Promise<number[]> {
  const rows = rowsOf<{ version: number }>(
    await db.execute(sql`select version from project_ops where project_id = ${projectId} order by version`),
  );
  return rows.map((r) => r.version);
}

async function seedTwoClips(db: DB) {
  const { id } = await createProject(db, { name: "Qual recap", format: "short_9x16", actor: "u1" });
  const r = await applyProjectOps(db, {
    projectId: id,
    baseVersion: 0,
    actor: "u1",
    ops: [
      { op: "add_clip", trackId: "t1", clip: textClip({ id: "c1", start: 0 }) },
      { op: "add_clip", trackId: "t1", clip: textClip({ id: "c2", start: 60 }) },
    ],
  });
  expect(r).toMatchObject({ ok: true, version: 1 });
  return id;
}

// PGlite's clock has millisecond resolution; wait so consecutive writes get distinct timestamps.
const nextMillisecond = () => new Promise((resolve) => setTimeout(resolve, 5));

function textClips(doc: { tracks: { id: string; clips: unknown[] }[] }) {
  return doc.tracks.find((t) => t.id === "t1")!.clips as TextClip[];
}

describe("projects service", () => {
  it("create → apply → version 1 and op logged", async () => {
    const db = await makeTestDb();
    const { id } = await createProject(db, { name: "Qual recap", format: "short_9x16", actor: "u1" });
    const r = await applyProjectOps(db, {
      projectId: id,
      baseVersion: 0,
      actor: "u1",
      ops: [{ op: "add_clip", trackId: "t1", clip: textClip({ id: undefined }) }],
    });
    expect(r).toMatchObject({ ok: true, version: 1 });
    const op = (r as Extract<ApplyResult, { ok: true }>).ops[0] as Extract<OpInput, { op: "add_clip" }>;
    expect(op.clip.id).toEqual(expect.any(String));
    const since = await getOpsSince(db, id, 0);
    expect(since!.entries).toHaveLength(1);
    expect(since).toEqual({ version: 1, entries: [{ version: 1, ops: (r as { ops: unknown }).ops, actor: "u1" }] });
    const project = await getProject(db, id);
    expect(project).toMatchObject({ version: 1, updatedBy: "u1" });
    expect(textClips(project!.doc).map((c) => c.id)).toEqual([op.clip.id]);
  });

  it("createProject stores an empty doc at version 0 and getProject returns it", async () => {
    const db = await makeTestDb();
    const created = await createProject(db, { name: "Worlds reel", format: "long_16x9", actor: "u7" });
    expect(created).toEqual({ id: expect.any(String), version: 0 });
    const project = await getProject(db, created.id);
    expect(project).toEqual({
      id: created.id,
      name: "Worlds reel",
      format: "long_16x9",
      doc: createEmptyDoc("long_16x9"),
      version: 0,
      updatedBy: "u7",
      updatedAt: expect.any(Date),
    });
  });

  it("listProjects returns every project, most recently updated first", async () => {
    const db = await makeTestDb();
    const a = await createProject(db, { name: "A", format: "short_9x16", actor: "u1" });
    await nextMillisecond();
    const b = await createProject(db, { name: "B", format: "square_1x1", actor: "u2" });
    expect((await listProjects(db)).map((p) => p.id)).toEqual([b.id, a.id]);
    await nextMillisecond();
    await applyProjectOps(db, {
      projectId: a.id,
      baseVersion: 0,
      actor: "u3",
      ops: [{ op: "add_clip", trackId: "t1", clip: textClip() }],
    });
    const list = await listProjects(db);
    expect(list.map((p) => p.id)).toEqual([a.id, b.id]);
    expect(list[0]).toEqual({
      id: a.id,
      name: "A",
      format: "short_9x16",
      version: 1,
      updatedBy: "u3",
      updatedAt: expect.any(Date),
    });
  });

  it("invalid op leaves doc and version unchanged", async () => {
    const db = await makeTestDb();
    const { id } = await createProject(db, { name: "Qual recap", format: "short_9x16", actor: "u1" });
    const r = await applyProjectOps(db, {
      projectId: id,
      baseVersion: 0,
      actor: "u1",
      ops: [{ op: "remove_clip", clipId: "nope" }],
    });
    expect(r).toMatchObject({ ok: false, status: 400, code: "NOT_FOUND", opIndex: 0 });
    const project = await getProject(db, id);
    expect(project!.version).toBe(0);
    expect(project!.doc).toEqual(createEmptyDoc("short_9x16"));
    expect(await loggedVersions(db, id)).toEqual([]);
  });

  it("an op that fails part way through the batch reports its index and writes nothing", async () => {
    const db = await makeTestDb();
    const { id } = await createProject(db, { name: "Qual recap", format: "short_9x16", actor: "u1" });
    const r = await applyProjectOps(db, {
      projectId: id,
      baseVersion: 0,
      actor: "u1",
      ops: [
        { op: "add_clip", trackId: "t1", clip: textClip({ id: "c1" }) },
        { op: "move_clip", clipId: "ghost", start: 10 },
      ],
    });
    expect(r).toMatchObject({ ok: false, status: 400, code: "NOT_FOUND", opIndex: 1 });
    expect((await getProject(db, id))!.version).toBe(0);
    expect(await loggedVersions(db, id)).toEqual([]);
  });

  it("empty ops are rejected as INVALID", async () => {
    const db = await makeTestDb();
    const { id } = await createProject(db, { name: "Qual recap", format: "short_9x16", actor: "u1" });
    const r = await applyProjectOps(db, { projectId: id, baseVersion: 0, actor: "u1", ops: [] });
    expect(r).toMatchObject({ ok: false, status: 400, code: "INVALID" });
    expect(r).not.toHaveProperty("opIndex");
    expect((await getProject(db, id))!.version).toBe(0);
  });

  it("ops that fail validation are rejected as INVALID with the op index", async () => {
    const db = await makeTestDb();
    const { id } = await createProject(db, { name: "Qual recap", format: "short_9x16", actor: "u1" });
    const r = await applyProjectOps(db, {
      projectId: id,
      baseVersion: 0,
      actor: "u1",
      ops: [
        { op: "add_clip", trackId: "t1", clip: textClip() },
        { op: "move_clip", clipId: "c1", start: -5 },
      ],
    });
    expect(r).toMatchObject({ ok: false, status: 400, code: "INVALID", opIndex: 1 });
    expect((r as { message: string }).message).toEqual(expect.any(String));
    expect((await getProject(db, id))!.version).toBe(0);
    expect(await loggedVersions(db, id)).toEqual([]);
  });

  it("claude and human editing different clips from the same base both land", async () => {
    const db = await makeTestDb();
    const id = await seedTwoClips(db);
    // Pass-through spy on the real database: records how many rows each conditional write returned.
    const writes: number[] = [];
    const execute = db.execute.bind(db);
    vi.spyOn(db, "execute").mockImplementation(
      (query) =>
        execute(query).then((result) => {
          writes.push(rowsOf(result).length);
          return result;
        }) as never,
    );

    const [claude, human] = await Promise.all([
      applyProjectOps(db, {
        projectId: id,
        baseVersion: 1,
        actor: "claude:u1",
        ops: [{ op: "move_clip", clipId: "c1", start: 120 }],
      }),
      applyProjectOps(db, {
        projectId: id,
        baseVersion: 1,
        actor: "u2",
        ops: [{ op: "update_clip", clipId: "c2", patch: { text: "Finals!" } }],
      }),
    ]);

    expect(claude.ok).toBe(true);
    expect(human.ok).toBe(true);
    const versions = [claude, human].map((r) => (r as Extract<ApplyResult, { ok: true }>).version);
    expect(versions.sort()).toEqual([2, 3]);

    // Both read version 1, so one conditional write must have matched zero rows and been retried.
    expect(writes).toEqual([1, 0, 1]);
    vi.restoreAllMocks();

    const project = await getProject(db, id);
    expect(project!.version).toBe(3);
    const clips = textClips(project!.doc);
    expect(clips.find((c) => c.id === "c1")).toMatchObject({ start: 120, text: "hi" });
    expect(clips.find((c) => c.id === "c2")).toMatchObject({ start: 60, text: "Finals!" });
    expect(await loggedVersions(db, id)).toEqual([1, 2, 3]);
    const actors = (await getOpsSince(db, id, 1))!.entries.map((e) => e.actor).sort();
    expect(actors).toEqual(["claude:u1", "u2"]);
  });

  it("stale base whose ops no longer validate is rejected", async () => {
    const db = await makeTestDb();
    const id = await seedTwoClips(db);
    const human = await applyProjectOps(db, {
      projectId: id,
      baseVersion: 1,
      actor: "u2",
      ops: [{ op: "remove_clip", clipId: "c1" }],
    });
    expect(human).toMatchObject({ ok: true, version: 2 });
    const claude = await applyProjectOps(db, {
      projectId: id,
      baseVersion: 1,
      actor: "claude:u1",
      ops: [{ op: "move_clip", clipId: "c1", start: 120 }],
    });
    expect(claude).toMatchObject({ ok: false, status: 400, code: "NOT_FOUND", opIndex: 0 });
    expect((await getProject(db, id))!.version).toBe(2);
    expect(await loggedVersions(db, id)).toEqual([1, 2]);
  });

  it("a base version ahead of the project is a 409 conflict", async () => {
    const db = await makeTestDb();
    const { id } = await createProject(db, { name: "Qual recap", format: "short_9x16", actor: "u1" });
    const r = await applyProjectOps(db, {
      projectId: id,
      baseVersion: 5,
      actor: "u1",
      ops: [{ op: "add_clip", trackId: "t1", clip: textClip() }],
    });
    expect(r).toMatchObject({ ok: false, status: 409, code: "CONFLICT", currentVersion: 0 });
    expect((await getProject(db, id))!.version).toBe(0);
  });

  it("gives up with 409 CONFLICT after losing the race three times", async () => {
    const db = await makeTestDb();
    const id = await seedTwoClips(db);
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        applyProjectOps(db, {
          projectId: id,
          baseVersion: 1,
          actor: `u${n}`,
          ops: [{ op: "update_clip", clipId: "c1", patch: { text: `edit ${n}` } }],
        }),
      ),
    );
    const landed = results.filter((r) => r.ok);
    const conflicts = results.filter((r) => !r.ok);
    expect(landed.map((r) => (r as Extract<ApplyResult, { ok: true }>).version).sort()).toEqual([2, 3, 4]);
    expect(conflicts).toHaveLength(2);
    for (const r of conflicts) {
      expect(r).toMatchObject({ ok: false, status: 409, code: "CONFLICT", currentVersion: 4 });
    }
    expect((await getProject(db, id))!.version).toBe(4);
    expect(await loggedVersions(db, id)).toEqual([1, 2, 3, 4]);
  });

  it("getOpsSince with current version returns no entries", async () => {
    const db = await makeTestDb();
    const id = await seedTwoClips(db);
    // Hide the op log: the cheap poll must not need it.
    await db.execute(sql`alter table project_ops rename to project_ops_hidden`);
    expect(await getOpsSince(db, id, 1)).toEqual({ version: 1, entries: [] });
    await db.execute(sql`alter table project_ops_hidden rename to project_ops`);
    const since0 = await getOpsSince(db, id, 0);
    expect(since0!.version).toBe(1);
    expect(since0!.entries.map((e) => e.version)).toEqual([1]);
  });

  it("getOpsSince never returns entries newer than the version it reports", async () => {
    const db = await makeTestDb();
    const id = await seedTwoClips(db);
    // Pass-through spy on the real client: right after getOpsSince's first statement (the version read)
    // finishes, another writer commits version 2 before getOpsSince's next statement runs.
    const client = (db as unknown as { $client: PGlite }).$client;
    const query = client.query.bind(client);
    let interleaved = false;
    vi.spyOn(client, "query").mockImplementation((async (...args: Parameters<PGlite["query"]>) => {
      const result = await query(...args);
      if (!interleaved) {
        interleaved = true;
        const write = await applyProjectOps(db, {
          projectId: id,
          baseVersion: 1,
          actor: "u2",
          ops: [{ op: "move_clip", clipId: "c2", start: 200 }],
        });
        expect(write).toMatchObject({ ok: true, version: 2 });
      }
      return result;
    }) as PGlite["query"]);

    const polled = await getOpsSince(db, id, 0);
    vi.restoreAllMocks();

    expect(interleaved).toBe(true);
    expect(polled!.version).toBe(1);
    expect(polled!.entries.map((e) => e.version)).toEqual([1]);
    // The next poll from the reported version picks up version 2 exactly once.
    const next = await getOpsSince(db, id, polled!.version);
    expect(next!.version).toBe(2);
    expect(next!.entries.map((e) => e.version)).toEqual([2]);
  });

  it("getOpsSince returns only the entries after the given version, in order", async () => {
    const db = await makeTestDb();
    const id = await seedTwoClips(db);
    await applyProjectOps(db, { projectId: id, baseVersion: 1, actor: "u2", ops: [{ op: "remove_clip", clipId: "c2" }] });
    await applyProjectOps(db, {
      projectId: id,
      baseVersion: 2,
      actor: "claude:u1",
      ops: [{ op: "move_clip", clipId: "c1", start: 90 }],
    });
    expect(await getOpsSince(db, id, 1)).toEqual({
      version: 3,
      entries: [
        { version: 2, ops: [{ op: "remove_clip", clipId: "c2" }], actor: "u2" },
        { version: 3, ops: [{ op: "move_clip", clipId: "c1", start: 90 }], actor: "claude:u1" },
      ],
    });
  });

  it("unknown project → 404", async () => {
    const db = await makeTestDb();
    const r = await applyProjectOps(db, {
      projectId: "missing",
      baseVersion: 0,
      actor: "u1",
      ops: [{ op: "add_clip", trackId: "t1", clip: textClip() }],
    });
    expect(r).toMatchObject({ ok: false, status: 404, code: "NOT_FOUND" });
    expect(r).not.toHaveProperty("opIndex");
    expect(await getProject(db, "missing")).toBeNull();
    expect(await getOpsSince(db, "missing", 0)).toBeNull();
    expect(await loggedVersions(db, "missing")).toEqual([]);
  });
});
