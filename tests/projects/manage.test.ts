import type { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { rowsOf, type DB } from "@/db";
import type { Actor } from "@/lib/actor";
import { copyName } from "@/lib/projects/schemas";
import {
  applyProjectOps, createProject, deleteProject, duplicateProject, getOpsSince, getProject,
  getProjectVersion, listProjects, renameProject,
} from "@/lib/projects/service";
import { makeTestDb } from "../helpers/db";

const editor: Actor = { userId: "u1", email: "u1@gmail.com", role: "editor" };
const viewer: Actor = { userId: "u2", email: "u2@gmail.com", role: "viewer" };
const rename1 = { op: "update_track", trackId: "v1", patch: { name: "Main" } } as const;
const logged = async (db: DB, id: string) =>
  rowsOf<{ version: number }>(await db.execute(sql`select version from project_ops where project_id = ${id} order by version`)).map((r) => r.version);

async function oneEdit(db: DB) {
  const { id } = await createProject(db, editor, { name: "Qual recap", format: "short_9x16" });
  await applyProjectOps(db, editor, { projectId: id, baseVersion: 0, ops: [rename1] });
  return id;
}

describe("rename", () => {
  it("trims and stores the name without changing the version", async () => {
    const db = await makeTestDb();
    const id = await oneEdit(db);
    expect(await renameProject(db, editor, id, "  Finals  ")).toEqual({ id, name: "Finals" });
    expect(await getProject(db, editor, id)).toMatchObject({ name: "Finals", version: 1 });
    for (const name of ["", "x".repeat(101)]) {
      await expect(renameProject(db, editor, id, name)).rejects.toMatchObject({ code: "INVALID", status: 400 });
    }
    await expect(renameProject(db, viewer, id, "X")).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await expect(renameProject(db, editor, "missing", "X")).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });
});

describe("names Postgres cannot store", () => {
  const unstorable = ["Qual\u0000recap", "Qual \ud800", "\udc00 recap"];

  it("create and rename refuse a NUL or a lone surrogate with INVALID; an emoji is fine", async () => {
    const db = await makeTestDb();
    for (const name of unstorable) {
      await expect(createProject(db, editor, { name, format: "short_9x16" })).rejects.toMatchObject({ code: "INVALID", status: 400 });
    }
    const { id } = await createProject(db, editor, { name: "Qual 🤖", format: "short_9x16" });
    for (const name of unstorable) {
      await expect(renameProject(db, editor, id, name)).rejects.toMatchObject({ code: "INVALID", status: 400 });
    }
    expect(await getProject(db, editor, id)).toMatchObject({ name: "Qual 🤖" });
  });
});

describe("delete", () => {
  it("hides the project from every read and write, and keeps its op log", async () => {
    const db = await makeTestDb();
    const id = await oneEdit(db);
    await expect(deleteProject(db, viewer, id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await deleteProject(db, editor, id);
    expect(await listProjects(db, editor)).toEqual([]);
    expect(await getProject(db, editor, id)).toBeNull();
    expect(await getProjectVersion(db, editor, id)).toBeNull();
    expect(await getOpsSince(db, editor, id, 0)).toBeNull();
    // Thunks, so each call starts only once its rejection is being awaited.
    for (const attempt of [
      () => applyProjectOps(db, editor, { projectId: id, baseVersion: 1, ops: [rename1] }),
      () => renameProject(db, editor, id, "X"), () => deleteProject(db, editor, id), () => duplicateProject(db, editor, id),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    }
    expect(await logged(db, id)).toEqual([1]);
  });

  it("records who deleted the project and when", async () => {
    const db = await makeTestDb();
    const id = await oneEdit(db);
    const before = (await getProject(db, editor, id))!.updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await deleteProject(db, { userId: "u9", email: "u9@gmail.com", role: "editor" }, id);
    const after = rowsOf<{ updated_by: string; later: boolean; same: boolean }>(await db.execute(sql`
      select updated_by, updated_at > ${before.toISOString()}::timestamptz at time zone 'UTC' as later, updated_at = deleted_at as same
      from projects where id = ${id}`))[0];
    expect(after).toEqual({ updated_by: "u9", later: true, same: true });
  });

  it("an edit that read the project before it was deleted does not land", async () => {
    const db = await makeTestDb();
    const id = await oneEdit(db);
    // Pass-through spy: right after applyProjectOps's first statement (its read) returns, the project is deleted.
    const client = (db as unknown as { $client: PGlite }).$client;
    const query = client.query.bind(client);
    let interleaved = false;
    vi.spyOn(client, "query").mockImplementation((async (...args: Parameters<PGlite["query"]>) => {
      const result = await query(...args);
      if (!interleaved) {
        interleaved = true;
        await deleteProject(db, editor, id);
      }
      return result;
    }) as PGlite["query"]);
    await expect(applyProjectOps(db, editor, { projectId: id, baseVersion: 1, ops: [rename1] }))
      .rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    vi.restoreAllMocks();
    expect(interleaved).toBe(true);
    expect(await logged(db, id)).toEqual([1]);
  });
});

describe("duplicate", () => {
  it("copies the current doc into a new project at version 0 with an empty op log", async () => {
    const db = await makeTestDb();
    const id = await oneEdit(db);
    await expect(duplicateProject(db, viewer, id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const original = (await getProject(db, editor, id))!;
    const copy = await duplicateProject(db, { ...editor, userId: "u9" }, id);
    expect(copy).toEqual({ id: expect.any(String), version: 0 });
    expect(await getProject(db, editor, copy.id)).toMatchObject({
      name: "Qual recap copy", format: "short_9x16", doc: original.doc, version: 0, updatedBy: "u9",
    });
    expect(await logged(db, copy.id)).toEqual([]);
    expect(await getProject(db, editor, id)).toMatchObject({ name: "Qual recap", version: 1 });
  });

  it("a copy name stays within 100 characters and never splits an emoji", () => {
    expect(copyName("Qual")).toBe("Qual copy");
    expect(copyName("x".repeat(100))).toBe("x".repeat(95) + " copy");
    expect(copyName("a".repeat(94) + "🤖🤖")).toBe("a".repeat(94) + " copy");
    expect(copyName("a".repeat(93) + " 🤖🤖")).toBe("a".repeat(93) + " copy");
  });
});
