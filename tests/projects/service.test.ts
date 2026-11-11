import type { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { rowsOf, type DB } from "@/db";
import type { Actor } from "@/lib/actor";
import {
  applyProjectOps,
  createProject,
  getOpsSince,
  getProject,
  getProjectVersion,
  listProjects,
  type OpsPage,
} from "@/lib/projects/service";
import { DEFAULT_TRANSFORM, createEmptyDoc, type OpInput, type TextClip } from "@/lib/timeline";
import { makeTestDb } from "../helpers/db";

const as = (userId: string): Actor => ({ userId, email: `${userId}@gmail.com`, role: "editor" });

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
  const { id } = await createProject(db, as("u1"), { name: "Qual recap", format: "short_9x16" });
  const r = await applyProjectOps(db, as("u1"), {
    projectId: id,
    baseVersion: 0,
    ops: [
      { op: "add_clip", trackId: "t1", clip: textClip({ id: "c1", start: 0 }) },
      { op: "add_clip", trackId: "t1", clip: textClip({ id: "c2", start: 60 }) },
    ],
  });
  expect(r).toMatchObject({ version: 1 });
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
    const { id } = await createProject(db, as("u1"), { name: "Qual recap", format: "short_9x16" });
    const r = await applyProjectOps(db, as("u1"), {
      projectId: id,
      baseVersion: 0,
      ops: [{ op: "add_clip", trackId: "t1", clip: textClip({ id: undefined }) }],
    });
    expect(r).toMatchObject({ version: 1 });
    const op = r.ops[0] as Extract<OpInput, { op: "add_clip" }>;
    expect(op.clip.id).toEqual(expect.any(String));
    const since = await getOpsSince(db, as("u1"), id, 0);
    expect(since!.entries).toHaveLength(1);
    expect(since).toEqual({
      version: 1,
      entries: [{ version: 1, ops: r.ops, inverse: [{ op: "remove_clip", clipId: op.clip.id }], actor: "u1", requestId: null, createdAt: expect.any(Date) }],
      hasMore: false,
    });
    const project = await getProject(db, as("u1"), id);
    expect(project).toMatchObject({ version: 1, updatedBy: "u1" });
    expect(textClips(project!.doc).map((c) => c.id)).toEqual([op.clip.id]);
  });

  it("createProject stores an empty doc at version 0 and getProject returns it", async () => {
    const db = await makeTestDb();
    const created = await createProject(db, as("u7"), { name: "Worlds reel", format: "long_16x9" });
    expect(created).toEqual({ id: expect.any(String), version: 0 });
    const project = await getProject(db, as("u1"), created.id);
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
    const a = await createProject(db, as("u1"), { name: "A", format: "short_9x16" });
    await nextMillisecond();
    const b = await createProject(db, as("u2"), { name: "B", format: "square_1x1" });
    expect((await listProjects(db, as("u1"))).map((p) => p.id)).toEqual([b.id, a.id]);
    await nextMillisecond();
    await applyProjectOps(db, as("u3"), {
      projectId: a.id,
      baseVersion: 0,
      ops: [{ op: "add_clip", trackId: "t1", clip: textClip() }],
    });
    const list = await listProjects(db, as("u1"));
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

  it("set_format updates the project's stored format with the doc", async () => {
    const db = await makeTestDb();
    const { id } = await createProject(db, as("u1"), { name: "Qual recap", format: "short_9x16" });
    const r = await applyProjectOps(db, as("u1"), {
      projectId: id,
      baseVersion: 0,
      ops: [{ op: "set_format", format: "long_16x9" }],
    });
    expect(r).toMatchObject({ version: 1 });
    const project = await getProject(db, as("u1"), id);
    expect(project!.doc.format).toBe("long_16x9");
    expect(project!.format).toBe("long_16x9");
    expect((await listProjects(db, as("u1"))).find((p) => p.id === id)!.format).toBe("long_16x9");
  });

  it("invalid op leaves doc and version unchanged", async () => {
    const db = await makeTestDb();
    const { id } = await createProject(db, as("u1"), { name: "Qual recap", format: "short_9x16" });
    await expect(
      applyProjectOps(db, as("u1"), {
        projectId: id,
        baseVersion: 0,
        ops: [{ op: "remove_clip", clipId: "nope" }],
      }),
    ).rejects.toMatchObject({ status: 400, code: "NOT_FOUND", opIndex: 0 });
    const project = await getProject(db, as("u1"), id);
    expect(project!.version).toBe(0);
    expect(project!.doc).toEqual(createEmptyDoc("short_9x16"));
    expect(await loggedVersions(db, id)).toEqual([]);
  });

  it("an op that fails part way through the batch reports its index and writes nothing", async () => {
    const db = await makeTestDb();
    const { id } = await createProject(db, as("u1"), { name: "Qual recap", format: "short_9x16" });
    await expect(
      applyProjectOps(db, as("u1"), {
        projectId: id,
        baseVersion: 0,
        ops: [
          { op: "add_clip", trackId: "t1", clip: textClip({ id: "c1" }) },
          { op: "move_clip", clipId: "ghost", start: 10 },
        ],
      }),
    ).rejects.toMatchObject({ status: 400, code: "NOT_FOUND", opIndex: 1 });
    expect((await getProject(db, as("u1"), id))!.version).toBe(0);
    expect(await loggedVersions(db, id)).toEqual([]);
  });

  it("empty ops are rejected as INVALID", async () => {
    const db = await makeTestDb();
    const { id } = await createProject(db, as("u1"), { name: "Qual recap", format: "short_9x16" });
    const r = applyProjectOps(db, as("u1"), { projectId: id, baseVersion: 0, ops: [] });
    await expect(r).rejects.toMatchObject({ status: 400, code: "INVALID" });
    await expect(r).rejects.not.toHaveProperty("opIndex");
    expect((await getProject(db, as("u1"), id))!.version).toBe(0);
  });

  it("ops that fail validation are rejected as INVALID with the op index", async () => {
    const db = await makeTestDb();
    const { id } = await createProject(db, as("u1"), { name: "Qual recap", format: "short_9x16" });
    await expect(
      applyProjectOps(db, as("u1"), {
        projectId: id,
        baseVersion: 0,
        ops: [
          { op: "add_clip", trackId: "t1", clip: textClip() },
          { op: "move_clip", clipId: "c1", start: -5 },
        ],
      }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID", opIndex: 1, message: expect.any(String) });
    expect((await getProject(db, as("u1"), id))!.version).toBe(0);
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

    const [claude, human] = await Promise.allSettled([
      applyProjectOps(db, as("claude:u1"), {
        projectId: id,
        baseVersion: 1,
        ops: [{ op: "move_clip", clipId: "c1", start: 120 }],
      }),
      applyProjectOps(db, as("u2"), {
        projectId: id,
        baseVersion: 1,
        ops: [{ op: "update_clip", clipId: "c2", patch: { text: "Finals!" } }],
      }),
    ]);

    expect(claude.status).toBe("fulfilled");
    expect(human.status).toBe("fulfilled");
    const versions = [claude, human].map((r) => (r as PromiseFulfilledResult<{ version: number }>).value.version);
    expect(versions.sort()).toEqual([2, 3]);

    // Both read version 1, so one conditional write must have matched zero rows and been retried.
    expect(writes).toEqual([1, 0, 1]);
    vi.restoreAllMocks();

    const project = await getProject(db, as("u1"), id);
    expect(project!.version).toBe(3);
    const clips = textClips(project!.doc);
    expect(clips.find((c) => c.id === "c1")).toMatchObject({ start: 120, text: "hi" });
    expect(clips.find((c) => c.id === "c2")).toMatchObject({ start: 60, text: "Finals!" });
    expect(await loggedVersions(db, id)).toEqual([1, 2, 3]);
    const actors = (await getOpsSince(db, as("u1"), id, 1))!.entries.map((e) => e.actor).sort();
    expect(actors).toEqual(["claude:u1", "u2"]);
  });

  it("stale base whose ops no longer validate is rejected", async () => {
    const db = await makeTestDb();
    const id = await seedTwoClips(db);
    const human = await applyProjectOps(db, as("u2"), {
      projectId: id,
      baseVersion: 1,
      ops: [{ op: "remove_clip", clipId: "c1" }],
    });
    expect(human).toMatchObject({ version: 2 });
    await expect(
      applyProjectOps(db, as("claude:u1"), {
        projectId: id,
        baseVersion: 1,
        ops: [{ op: "move_clip", clipId: "c1", start: 120 }],
      }),
    ).rejects.toMatchObject({ status: 400, code: "NOT_FOUND", opIndex: 0 });
    expect((await getProject(db, as("u1"), id))!.version).toBe(2);
    expect(await loggedVersions(db, id)).toEqual([1, 2]);
  });

  it("a base version ahead of the project is a 409 conflict", async () => {
    const db = await makeTestDb();
    const { id } = await createProject(db, as("u1"), { name: "Qual recap", format: "short_9x16" });
    await expect(
      applyProjectOps(db, as("u1"), {
        projectId: id,
        baseVersion: 5,
        ops: [{ op: "add_clip", trackId: "t1", clip: textClip() }],
      }),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT", currentVersion: 0 });
    expect((await getProject(db, as("u1"), id))!.version).toBe(0);
  });

  it("gives up with 409 CONFLICT after losing the race three times", async () => {
    const db = await makeTestDb();
    const id = await seedTwoClips(db);
    const results = await Promise.allSettled(
      [1, 2, 3, 4, 5].map((n) =>
        applyProjectOps(db, as(`u${n}`), {
          projectId: id,
          baseVersion: 1,
          ops: [{ op: "update_clip", clipId: "c1", patch: { text: `edit ${n}` } }],
        }),
      ),
    );
    const landed = results.filter((r) => r.status === "fulfilled");
    const conflicts = results.filter((r) => r.status === "rejected");
    expect(landed.map((r) => r.value.version).sort()).toEqual([2, 3, 4]);
    expect(conflicts).toHaveLength(2);
    for (const r of conflicts) {
      expect(r.reason).toMatchObject({ status: 409, code: "CONFLICT", currentVersion: 4 });
    }
    expect((await getProject(db, as("u1"), id))!.version).toBe(4);
    expect(await loggedVersions(db, id)).toEqual([1, 2, 3, 4]);
  });

  const bump = (db: DB, id: string, v: number) =>
    applyProjectOps(db, as("u1"), { projectId: id, baseVersion: v, ops: [{ op: "update_track", trackId: "v1", patch: { name: `V${v}` } }] });

  it("pages through the op log; following version never skips or repeats an entry", async () => {
    const db = await makeTestDb();
    const { id } = await createProject(db, as("u1"), { name: "P", format: "short_9x16" });
    for (let v = 0; v < 5; v++) await bump(db, id, v);
    const first = (await getOpsSince(db, as("u1"), id, 0, 2))!;
    expect(first).toMatchObject({ version: 2, hasMore: true });
    expect(first.entries.map((e) => e.version)).toEqual([1, 2]);
    const seen: number[] = [];
    let since = 0;
    let page: OpsPage;
    do {
      page = (await getOpsSince(db, as("u1"), id, since, 2))!;
      seen.push(...page.entries.map((e) => e.version));
      since = page.version;
    } while (page.hasMore);
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(page).toMatchObject({ version: 5, hasMore: false });
  });

  it("returns at most 100 entries by default", async () => {
    const db = await makeTestDb();
    const { id } = await createProject(db, as("u1"), { name: "P", format: "short_9x16" });
    for (let v = 0; v < 101; v++) await bump(db, id, v);
    const page = (await getOpsSince(db, as("u1"), id, 0))!;
    expect(page.entries).toHaveLength(100);
    expect(page).toMatchObject({ version: 100, hasMore: true });
  });

  it("getProjectVersion returns the version, or null for an unknown project", async () => {
    const db = await makeTestDb();
    const id = await seedTwoClips(db);
    expect(await getProjectVersion(db, as("u1"), id)).toBe(1);
    expect(await getProjectVersion(db, as("u1"), "missing")).toBeNull();
  });

  it("getOpsSince with current version returns no entries", async () => {
    const db = await makeTestDb();
    const id = await seedTwoClips(db);
    // Hide the op log: the cheap poll must not need it.
    await db.execute(sql`alter table project_ops rename to project_ops_hidden`);
    expect(await getOpsSince(db, as("u1"), id, 1)).toEqual({ version: 1, entries: [], hasMore: false });
    await db.execute(sql`alter table project_ops_hidden rename to project_ops`);
    const since0 = await getOpsSince(db, as("u1"), id, 0);
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
        const write = await applyProjectOps(db, as("u2"), {
          projectId: id,
          baseVersion: 1,
          ops: [{ op: "move_clip", clipId: "c2", start: 200 }],
        });
        expect(write).toMatchObject({ version: 2 });
      }
      return result;
    }) as PGlite["query"]);

    const polled = await getOpsSince(db, as("u1"), id, 0);
    vi.restoreAllMocks();

    expect(interleaved).toBe(true);
    expect(polled!.version).toBe(1);
    expect(polled!.entries.map((e) => e.version)).toEqual([1]);
    // The next poll from the reported version picks up version 2 exactly once.
    const next = await getOpsSince(db, as("u1"), id, polled!.version);
    expect(next!.version).toBe(2);
    expect(next!.entries.map((e) => e.version)).toEqual([2]);
  });

  it("getOpsSince returns only the entries after the given version, in order", async () => {
    const db = await makeTestDb();
    const id = await seedTwoClips(db);
    await applyProjectOps(db, as("u2"), { projectId: id, baseVersion: 1, ops: [{ op: "remove_clip", clipId: "c2" }] });
    await applyProjectOps(db, as("claude:u1"), {
      projectId: id,
      baseVersion: 2,
      ops: [{ op: "move_clip", clipId: "c1", start: 90 }],
    });
    expect(await getOpsSince(db, as("u1"), id, 1)).toEqual({
      version: 3,
      entries: [
        {
          version: 2,
          ops: [{ op: "remove_clip", clipId: "c2" }],
          inverse: [{ op: "add_clip", trackId: "t1", clip: textClip({ id: "c2", start: 60 }) }],
          actor: "u2",
          requestId: null,
          createdAt: expect.any(Date),
        },
        {
          version: 3,
          ops: [{ op: "move_clip", clipId: "c1", start: 90 }],
          inverse: [{ op: "move_clip", clipId: "c1", start: 0, expect: { start: 90 } }],
          actor: "claude:u1",
          requestId: null,
          createdAt: expect.any(Date),
        },
      ],
      hasMore: false,
    });
  });

  it("returns and stores the inverse of each write; rows from before this change read back as null", async () => {
    const db = await makeTestDb();
    const { id } = await createProject(db, as("u1"), { name: "P", format: "short_9x16" });
    const r = await applyProjectOps(db, as("u1"), { projectId: id, baseVersion: 0, ops: [{ op: "add_clip", trackId: "t1", clip: textClip({ id: "c9" }) }] });
    expect(r.inverse).toEqual([{ op: "remove_clip", clipId: "c9" }]);
    expect((await getOpsSince(db, as("u1"), id, 0))!.entries).toEqual([
      { version: 1, ops: r.ops, inverse: r.inverse, actor: "u1", requestId: null, createdAt: expect.any(Date) },
    ]);
    await db.execute(sql`update project_ops set inverse = null`);
    expect((await getOpsSince(db, as("u1"), id, 0))!.entries[0].inverse).toBeNull();
  });

  it("undo is an ordinary edit: A's stored inverse removes only A's clip after B's edit", async () => {
    const db = await makeTestDb();
    const { id } = await createProject(db, as("a"), { name: "P", format: "short_9x16" });
    await applyProjectOps(db, as("a"), { projectId: id, baseVersion: 0, ops: [{ op: "add_clip", trackId: "t1", clip: textClip({ id: "ax", start: 0 }) }] });
    await applyProjectOps(db, as("b"), { projectId: id, baseVersion: 1, ops: [{ op: "add_clip", trackId: "t1", clip: textClip({ id: "by", start: 60 }) }] });
    const stored = (await getOpsSince(db, as("a"), id, 0))!.entries[0].inverse!;
    const undo = await applyProjectOps(db, as("a"), { projectId: id, baseVersion: 2, strict: true, ops: stored });
    expect(undo.version).toBe(3);
    expect(textClips((await getProject(db, as("a"), id))!.doc).map((c) => c.id)).toEqual(["by"]);
    expect(undo.inverse).toEqual([{ op: "add_clip", trackId: "t1", clip: textClip({ id: "ax", start: 0 }) }]);
  });

  it("strict refuses a stale base with 409 and writes nothing; strict at the current version lands", async () => {
    const db = await makeTestDb();
    const id = await seedTwoClips(db);
    await applyProjectOps(db, as("u2"), { projectId: id, baseVersion: 1, ops: [{ op: "remove_clip", clipId: "c2" }] });
    await expect(applyProjectOps(db, as("u1"), { projectId: id, baseVersion: 1, strict: true, ops: [{ op: "move_clip", clipId: "c1", start: 90 }] }))
      .rejects.toMatchObject({ status: 409, code: "CONFLICT", currentVersion: 2 });
    expect(await loggedVersions(db, id)).toEqual([1, 2]);
    await expect(applyProjectOps(db, as("u1"), { projectId: id, baseVersion: 2, strict: true, ops: [{ op: "move_clip", clipId: "c1", start: 90 }] }))
      .resolves.toMatchObject({ version: 3 });
  });

  it("two strict writes from the same base: one lands, the other is refused and never rebased", async () => {
    const db = await makeTestDb();
    const id = await seedTwoClips(db);
    const results = await Promise.allSettled([
      applyProjectOps(db, as("u1"), { projectId: id, baseVersion: 1, strict: true, ops: [{ op: "move_clip", clipId: "c1", start: 120 }] }),
      applyProjectOps(db, as("u2"), { projectId: id, baseVersion: 1, strict: true, ops: [{ op: "update_clip", clipId: "c2", patch: { text: "Finals!" } }] }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ status: 409, code: "CONFLICT", currentVersion: 2 });
    expect(await loggedVersions(db, id)).toEqual([1, 2]);
  });

  it("a rebased write returns and stores the inverse against the doc it finally landed on", async () => {
    const db = await makeTestDb();
    const id = await seedTwoClips(db);
    // Pass-through spy on the real database: just before this write's first conditional update runs,
    // another writer moves c1 to 30, so the first attempt (which read c1 at 0) loses and is rebased.
    const execute = db.execute.bind(db);
    let interleaved = false;
    vi.spyOn(db, "execute").mockImplementation((async (query: Parameters<DB["execute"]>[0]) => {
      if (!interleaved) {
        interleaved = true;
        const other = await applyProjectOps(db, as("u2"), {
          projectId: id,
          baseVersion: 1,
          ops: [{ op: "move_clip", clipId: "c1", start: 30 }],
        });
        expect(other).toMatchObject({ version: 2 });
      }
      return execute(query);
    }) as never);

    const r = await applyProjectOps(db, as("u1"), {
      projectId: id,
      baseVersion: 1,
      ops: [{ op: "move_clip", clipId: "c1", start: 120 }],
    });
    vi.restoreAllMocks();

    expect(interleaved).toBe(true);
    expect(r.version).toBe(3);
    // Against the first read c1 was at 0; against the doc it landed on, c1 was at 30.
    expect(r.inverse).toEqual([{ op: "move_clip", clipId: "c1", start: 30, expect: { start: 120 } }]);
    const stored = (await getOpsSince(db, as("u1"), id, 2))!.entries;
    expect(stored.map((e) => ({ version: e.version, inverse: e.inverse }))).toEqual([{ version: 3, inverse: r.inverse }]);
  });

  it("unknown project → 404", async () => {
    const db = await makeTestDb();
    const r = applyProjectOps(db, as("u1"), {
      projectId: "missing",
      baseVersion: 0,
      ops: [{ op: "add_clip", trackId: "t1", clip: textClip() }],
    });
    await expect(r).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    await expect(r).rejects.not.toHaveProperty("opIndex");
    expect(await getProject(db, as("u1"), "missing")).toBeNull();
    expect(await getOpsSince(db, as("u1"), "missing", 0)).toBeNull();
    expect(await loggedVersions(db, "missing")).toEqual([]);
  });
});
