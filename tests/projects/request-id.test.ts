import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { rowsOf, type DB } from "@/db";
import type { Actor } from "@/lib/actor";
import { applyProjectOps, createProject, getOpsSince, getProject } from "@/lib/projects/service";
import { DEFAULT_TRANSFORM, type OpInput } from "@/lib/timeline";
import { makeTestDb } from "../helpers/db";

const as = (userId: string): Actor => ({ userId, email: `${userId}@gmail.com`, role: "editor" });

// No clip id, so applying it twice would add two clips.
const addText = (start = 0): OpInput => ({
  op: "add_clip",
  trackId: "t1",
  clip: { type: "text", start, duration: 30, text: "hi", transform: { ...DEFAULT_TRANSFORM },
    style: { fontFamily: "Inter", fontSize: 64, fontWeight: 700, color: "#fff", align: "center" } },
});

async function project(db: DB): Promise<string> {
  return (await createProject(db, as("u1"), { name: "P", format: "short_9x16" })).id;
}

const textClipCount = async (db: DB, id: string) => (await getProject(db, as("u1"), id))!.doc.tracks.find((t) => t.id === "t1")!.clips.length;

async function logRows(db: DB, id: string) {
  return rowsOf<{ version: number; request_id: string | null }>(
    await db.execute(sql`select version, request_id from project_ops where project_id = ${id} order by version`),
  );
}

describe("safe retry with a request id", () => {
  it("the same id sent twice returns the same answer, logs one row and changes the document once", async () => {
    const db = await makeTestDb();
    const id = await project(db);
    const send = () => applyProjectOps(db, as("u1"), { projectId: id, baseVersion: 0, ops: [addText()], requestId: "req-0001" });
    const first = await send();
    const second = await send();
    expect(second).toEqual(first);
    expect(await logRows(db, id)).toEqual([{ version: 1, request_id: "req-0001" }]);
    expect(await textClipCount(db, id)).toBe(1);
    expect((await getOpsSince(db, as("u1"), id, 0))!.entries[0].requestId).toBe("req-0001");
  });

  it("two concurrent sends of the same id leave one row and both resolve to the same result", async () => {
    const db = await makeTestDb();
    const id = await project(db);
    const send = () => applyProjectOps(db, as("u1"), { projectId: id, baseVersion: 0, ops: [addText()], requestId: "req-0002" });
    const [a, b] = await Promise.all([send(), send()]);
    expect(b).toEqual(a);
    expect(await logRows(db, id)).toHaveLength(1);
    expect(await textClipCount(db, id)).toBe(1);
  });

  it("a write that loses to the same id on the unique index changes nothing and returns the landed result", async () => {
    const db = await makeTestDb();
    const id = await project(db);
    // Just before this write's conditional statement runs, the same request id lands in the log.
    const execute = db.execute.bind(db);
    let interleaved = false;
    vi.spyOn(db, "execute").mockImplementation((async (query: Parameters<DB["execute"]>[0]) => {
      if (!interleaved) {
        interleaved = true;
        await execute(sql`insert into project_ops (project_id, version, ops, inverse, actor, request_id)
          values (${id}, 7, '[{"op":"set_format","format":"long_16x9"}]'::jsonb, null, 'u1', 'req-0003')`);
      }
      return execute(query);
    }) as never);
    const r = await applyProjectOps(db, as("u1"), { projectId: id, baseVersion: 0, ops: [addText()], requestId: "req-0003" });
    vi.restoreAllMocks();
    expect(interleaved).toBe(true);
    expect(r).toEqual({ version: 7, ops: [{ op: "set_format", format: "long_16x9" }], inverse: [] });
    expect((await getProject(db, as("u1"), id))!.version).toBe(0);
    expect(await textClipCount(db, id)).toBe(0);
    expect(await logRows(db, id)).toEqual([{ version: 7, request_id: "req-0003" }]);
  });

  it("the same id on another project is independent", async () => {
    const db = await makeTestDb();
    const one = await project(db);
    const two = await project(db);
    await applyProjectOps(db, as("u1"), { projectId: one, baseVersion: 0, ops: [addText()], requestId: "req-0004" });
    const r = await applyProjectOps(db, as("u1"), { projectId: two, baseVersion: 0, ops: [addText()], requestId: "req-0004" });
    expect(r.version).toBe(1);
    expect(await textClipCount(db, two)).toBe(1);
  });

  it("the same id from another person is INVALID and changes nothing", async () => {
    const db = await makeTestDb();
    const id = await project(db);
    await applyProjectOps(db, as("u1"), { projectId: id, baseVersion: 0, ops: [addText()], requestId: "req-0005" });
    await expect(applyProjectOps(db, as("u2"), { projectId: id, baseVersion: 1, ops: [addText(60)], requestId: "req-0005" }))
      .rejects.toMatchObject({ status: 400, code: "INVALID", message: "requestId is already in use" });
    expect(await logRows(db, id)).toHaveLength(1);
  });

  it("an id in the wrong format is INVALID", async () => {
    const db = await makeTestDb();
    const id = await project(db);
    for (const requestId of ["short", "has space1", "x".repeat(65), "ünïcode-id", ""]) {
      await expect(applyProjectOps(db, as("u1"), { projectId: id, baseVersion: 0, ops: [addText()], requestId }), requestId)
        .rejects.toMatchObject({ status: 400, code: "INVALID" });
    }
    expect(await logRows(db, id)).toEqual([]);
  });

  it("without an id, every send applies", async () => {
    const db = await makeTestDb();
    const id = await project(db);
    await applyProjectOps(db, as("u1"), { projectId: id, baseVersion: 0, ops: [addText()] });
    await applyProjectOps(db, as("u1"), { projectId: id, baseVersion: 0, ops: [addText(60)] });
    expect(await logRows(db, id)).toEqual([{ version: 1, request_id: null }, { version: 2, request_id: null }]);
    expect(await textClipCount(db, id)).toBe(2);
  });

  it("a strict replay still returns the original result after the version has moved on", async () => {
    const db = await makeTestDb();
    const id = await project(db);
    const send = () => applyProjectOps(db, as("u1"), { projectId: id, baseVersion: 0, strict: true, ops: [addText()], requestId: "req-0008" });
    const first = await send();
    await applyProjectOps(db, as("u2"), { projectId: id, baseVersion: 1, ops: [addText(60)] });
    expect(await send()).toEqual(first);
    expect(await textClipCount(db, id)).toBe(2);
  });
});
