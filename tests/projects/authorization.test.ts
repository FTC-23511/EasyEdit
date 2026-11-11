import { describe, expect, it } from "vitest";
import { requireRole, type Actor } from "@/lib/actor";
import { applyProjectOps, createProject, getOpsSince, getProject, listProjects } from "@/lib/projects/service";
import { DEFAULT_TRANSFORM, type OpInput } from "@/lib/timeline";
import { makeTestDb } from "../helpers/db";

const as = (role: Actor["role"], userId = "u1"): Actor => ({ userId, email: `${userId}@gmail.com`, role });
const renames = (n: number): OpInput[] =>
  Array.from({ length: n }, (_, i) => ({ op: "update_track", trackId: "v1", patch: { name: `V${i}` } }));

describe("service authorization", () => {
  it("requireRole throws a 403 FORBIDDEN ServiceError below the minimum", () => {
    expect(() => requireRole(as("viewer"), "editor")).toThrow(
      expect.objectContaining({ name: "ServiceError", code: "FORBIDDEN", status: 403, message: "Your role doesn't allow this." }),
    );
    expect(() => requireRole(as("admin"), "editor")).not.toThrow();
  });

  it("a viewer cannot create or edit, and nothing is written; a viewer can read", async () => {
    const db = await makeTestDb();
    await expect(createProject(db, as("viewer"), { name: "P", format: "short_9x16" })).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(await listProjects(db, as("viewer"))).toEqual([]);
    const { id } = await createProject(db, as("editor"), { name: "P", format: "short_9x16" });
    await expect(applyProjectOps(db, as("viewer"), { projectId: id, baseVersion: 0, ops: renames(1) }))
      .rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(await getProject(db, as("viewer"), id)).toMatchObject({ version: 0 });
    expect(await getOpsSince(db, as("viewer"), id, 0)).toMatchObject({ version: 0, entries: [] });
  });

  it("logs the actor's user id and records it as updatedBy", async () => {
    const db = await makeTestDb();
    const { id } = await createProject(db, as("admin", "a9"), { name: "P", format: "short_9x16" });
    await applyProjectOps(db, as("editor", "e7"), { projectId: id, baseVersion: 0, ops: renames(1) });
    expect(await getProject(db, as("viewer"), id)).toMatchObject({ updatedBy: "e7" });
    expect((await getOpsSince(db, as("viewer"), id, 0))!.entries[0].actor).toBe("e7");
  });
});

describe("service limits", () => {
  it("500 ops in one request are accepted; 501 are LIMIT_EXCEEDED", async () => {
    const db = await makeTestDb();
    const { id } = await createProject(db, as("editor"), { name: "P", format: "short_9x16" });
    await expect(applyProjectOps(db, as("editor"), { projectId: id, baseVersion: 0, ops: renames(501) }))
      .rejects.toMatchObject({ code: "LIMIT_EXCEEDED", status: 400 });
    await expect(applyProjectOps(db, as("editor"), { projectId: id, baseVersion: 0, ops: renames(500) })).resolves.toMatchObject({ version: 1 });
  });

  it("a document over 2 MiB of UTF-8 is LIMIT_EXCEEDED even under 2 M characters", async () => {
    const db = await makeTestDb();
    const { id } = await createProject(db, as("editor"), { name: "P", format: "short_9x16" });
    // Text clips of 2,000 two-byte characters, added in batches that each stay under the op-log row limit.
    const clips = (from: number, n: number): OpInput[] => Array.from({ length: n }, (_, i) => ({
      op: "add_clip", trackId: "t1",
      clip: { id: `x${from + i}`, type: "text", start: (from + i) * 10, duration: 10, text: "é".repeat(2000), transform: { ...DEFAULT_TRANSFORM },
        style: { fontFamily: "Inter", fontSize: 64, fontWeight: 700, color: "#fff", align: "center" } },
    }));
    await applyProjectOps(db, as("editor"), { projectId: id, baseVersion: 0, ops: clips(0, 240) });
    await applyProjectOps(db, as("editor"), { projectId: id, baseVersion: 1, ops: clips(240, 240) }); // about 1.1 M characters, 2.05 MB
    await expect(applyProjectOps(db, as("editor"), { projectId: id, baseVersion: 2, ops: clips(480, 20) }))
      .rejects.toMatchObject({ code: "LIMIT_EXCEEDED", status: 400, message: "A project can be at most 2 MB" });
    expect(await getProject(db, as("editor"), id)).toMatchObject({ version: 2 });
  });

  it("project names are trimmed and at most 100 characters; formats must be known", async () => {
    const db = await makeTestDb();
    const editor = as("editor");
    for (const name of ["", "   ", "x".repeat(101)]) {
      await expect(createProject(db, editor, { name, format: "short_9x16" }))
        .rejects.toMatchObject({ code: "INVALID", status: 400, message: "Enter a name up to 100 characters." });
    }
    await expect(createProject(db, editor, { name: "Qual", format: "nope" })).rejects.toMatchObject({ code: "INVALID", message: "Pick a format." });
    const { id } = await createProject(db, editor, { name: "  Qual  ", format: "short_9x16" });
    expect(await getProject(db, editor, id)).toMatchObject({ name: "Qual" });
  });
});
