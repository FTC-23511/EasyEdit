import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { rowsOf, type DB } from "@/db";
import { checkProjectBudget, checkWriteBudget } from "@/lib/mcp/budget";
import { createProjectTool } from "@/lib/mcp/tools/create-project";
import { displayActor } from "@/lib/projects/display-actor";
import { applyProjectOps, createProject, listProjects } from "@/lib/projects/service";
import type { OpInput } from "@/lib/timeline";
import { makeTestDb } from "../helpers/db";
import { addText, toolContext } from "./context";

const rows = async (db: DB) => rowsOf<{ id: string; name: string; created_by: string }>(await db.execute(sql`select id, name, created_by from projects order by created_at`));
const idIn = (text: string) => /\(id ([^)]+)\)/.exec(text)![1];

describe("create_project", () => {
  it("creates a project recorded as Claude's, and answers with its id, version, link and tracks", async () => {
    const db = await makeTestDb();
    const ctx = await toolContext(db);
    const r = await createProjectTool(ctx, { name: "  Qualifier recap ", format: "short_9x16" });
    const [row] = await rows(db);
    expect(r.isError).toBe(false);
    expect(r.text.split("\n").slice(0, 4)).toEqual([
      `Created project "Qualifier recap" (id ${row.id}), version 0.`,
      `Open it in the editor: https://studio.test/editor/${row.id}`,
      `Project "Qualifier recap" (id ${row.id})`,
      "Format short_9x16 1080x1920 @30fps · duration 0.00s · version 0",
    ]);
    expect(r.text).toContain('Track t1 [text] "Text 1"');
    expect(row.created_by).toBe("claude:u1");
    const [listed] = await listProjects(db, ctx.actor);
    expect(displayActor(listed.updatedBy, new Map([["u1", "Ada Lovelace"]]))).toBe("Claude (for Ada Lovelace)");
  });

  it("refuses a bad name or format with the service's sentence, and a viewer with the role sentence", async () => {
    const db = await makeTestDb();
    const ctx = await toolContext(db);
    expect(await createProjectTool(ctx, { name: "   ", format: "short_9x16" })).toEqual({ isError: true, text: "Enter a name up to 100 characters." });
    expect(await createProjectTool(ctx, { name: "x".repeat(101), format: "short_9x16" })).toMatchObject({ isError: true });
    expect(await createProjectTool(ctx, { name: "OK", format: "imax" })).toEqual({ isError: true, text: "Pick a format." });
    const viewer = await toolContext(db, { id: "u3", role: "viewer" });
    expect(await createProjectTool(viewer, { name: "Mine", format: "short_9x16" })).toEqual({
      isError: true, text: "Your role is viewer. You can read projects but not change them. An admin can change your role on the Admin page.",
    });
    expect(await rows(db)).toHaveLength(0);
  });

  it("a repeat of the same name and format within a minute returns the first project", async () => {
    const db = await makeTestDb();
    const ctx = await toolContext(db);
    const first = await createProjectTool(ctx, { name: "Recap", format: "short_9x16" });
    const again = await createProjectTool(ctx, { name: "Recap ", format: "short_9x16" });
    expect(again.isError).toBe(false);
    expect(again.text.split("\n")[0]).toBe(`This project was created a moment ago, so it is used again: "Recap" (id ${idIn(first.text)}).`);
    expect(await rows(db)).toHaveLength(1);

    // Another format, another name, another member, or a minute later: a new project.
    await createProjectTool(ctx, { name: "Recap", format: "long_16x9" });
    await createProjectTool(ctx, { name: "Recap 2", format: "short_9x16" });
    await createProjectTool(await toolContext(db, { id: "u2", name: "Grace Hopper" }), { name: "Recap", format: "short_9x16" });
    expect(await rows(db)).toHaveLength(4);
    await db.execute(sql`update projects set created_at = now() - interval '2 minutes'`);
    expect((await createProjectTool(ctx, { name: "Recap", format: "short_9x16" })).text).toMatch(/^Created project "Recap"/);
    expect(await rows(db)).toHaveLength(5);
  });

  it("a repeat is answered even when the daily number is reached, but a deleted project is not used again", async () => {
    const db = await makeTestDb();
    const ctx = await toolContext(db, { limits: { connectorProjectsPerDay: 1 } });
    const first = await createProjectTool(ctx, { name: 'Say "go"', format: "short_9x16" });
    expect(first.text.split("\n")[0]).toBe(`Created project "Say \\"go\\"" (id ${idIn(first.text)}), version 0.`);
    const again = await createProjectTool(ctx, { name: 'Say "go"', format: "short_9x16" });
    expect(again.text.split("\n")[0]).toBe(`This project was created a moment ago, so it is used again: "Say \\"go\\"" (id ${idIn(first.text)}).`);

    await db.execute(sql`update projects set deleted_at = now()`);
    const roomy = await toolContext(db, { limits: { connectorProjectsPerDay: 5 } });
    expect((await createProjectTool(roomy, { name: 'Say "go"', format: "short_9x16" })).text).toMatch(/^Created project/);
    expect(await rows(db)).toHaveLength(2);
  });

  it("stops at the daily number of projects, and frees a place a day later", async () => {
    const db = await makeTestDb();
    const ctx = await toolContext(db, { limits: { connectorProjectsPerDay: 2 } });
    await createProjectTool(ctx, { name: "One", format: "short_9x16" });
    await createProjectTool(ctx, { name: "Two", format: "short_9x16" });
    expect(await createProjectTool(ctx, { name: "Three", format: "short_9x16" })).toEqual({
      isError: true, text: "Claude has created 2 projects for you in the last day, which is the limit. Use an existing project, or create one in the app.",
    });
    expect(await rows(db)).toHaveLength(2);
    await db.execute(sql`update projects set created_at = now() - interval '25 hours' where name = 'One'`);
    expect((await createProjectTool(ctx, { name: "Three", format: "short_9x16" })).isError).toBe(false);
  });
});

describe("the write budget", () => {
  const LOOSE = { connectorWritesPerMinute: 1000, connectorBytesPerDay: 1_000_000_000 };

  async function withTwoChanges() {
    const db = await makeTestDb();
    const claude = (await toolContext(db)).actor;
    const { id } = await createProject(db, claude, { name: "P", format: "short_9x16" });
    await applyProjectOps(db, claude, { projectId: id, baseVersion: 0, ops: [addText(0) as OpInput] });
    await applyProjectOps(db, claude, { projectId: id, baseVersion: 1, ops: [addText(60) as OpInput] });
    return { db, claude };
  }

  it("counts one actor's changes in the last minute", async () => {
    const { db } = await withTwoChanges();
    expect(await checkWriteBudget(db, "claude:u1", LOOSE)).toEqual({ ok: true });
    expect(await checkWriteBudget(db, "claude:u1", { ...LOOSE, connectorWritesPerMinute: 2 })).toEqual({
      ok: false, message: "Too many changes at once: 2 in the last minute (the limit is 2). Wait a minute, then continue.",
    });
    // The member's own edits in the app and other members' Claude do not count.
    expect(await checkWriteBudget(db, "u1", { ...LOOSE, connectorWritesPerMinute: 1 })).toEqual({ ok: true });
    expect(await checkWriteBudget(db, "claude:u2", { ...LOOSE, connectorWritesPerMinute: 1 })).toEqual({ ok: true });
    await db.execute(sql`update project_ops set created_at = now() - interval '2 minutes'`);
    expect(await checkWriteBudget(db, "claude:u1", { ...LOOSE, connectorWritesPerMinute: 2 })).toEqual({ ok: true });
  });

  it("counts one actor's stored change data over the last day", async () => {
    const { db } = await withTwoChanges();
    const tight = { ...LOOSE, connectorBytesPerDay: 1 };
    expect(await checkWriteBudget(db, "claude:u1", tight)).toEqual({
      ok: false, message: "Today's allowance for changes made through Claude is used up. It frees up over the next 24 hours. Editing in the app still works.",
    });
    expect(await checkWriteBudget(db, "claude:u2", tight)).toEqual({ ok: true });
    await db.execute(sql`update project_ops set created_at = now() - interval '25 hours'`);
    expect(await checkWriteBudget(db, "claude:u1", tight)).toEqual({ ok: true });
  });

  it("counts the stored inverse as well as the ops", async () => {
    const { db } = await withTwoChanges();
    const [size] = rowsOf<{ ops: number | string; inverse: number | string }>(
      await db.execute(sql`select sum(pg_column_size(ops)) as ops, sum(pg_column_size(inverse)) as inverse from project_ops`),
    );
    const opsOnly = Number(size.ops);
    expect(Number(size.inverse)).toBeGreaterThan(0);
    expect(await checkWriteBudget(db, "claude:u1", { ...LOOSE, connectorBytesPerDay: opsOnly + 1 })).toMatchObject({ ok: false });
    expect(await checkWriteBudget(db, "claude:u1", { ...LOOSE, connectorBytesPerDay: opsOnly + Number(size.inverse) + 1 })).toEqual({ ok: true });
  });

  it("the project budget counts deleted projects too", async () => {
    const db = await makeTestDb();
    const claude = (await toolContext(db)).actor;
    const { id } = await createProject(db, claude, { name: "P", format: "short_9x16" });
    await db.execute(sql`update projects set deleted_at = now() where id = ${id}`);
    expect(await checkProjectBudget(db, "claude:u1", { connectorProjectsPerDay: 1 })).toMatchObject({ ok: false });
    expect(await checkProjectBudget(db, "claude:u1", { connectorProjectsPerDay: 2 })).toEqual({ ok: true });
  });
});
