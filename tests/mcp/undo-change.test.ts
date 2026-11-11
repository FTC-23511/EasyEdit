import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { user } from "@/db/schema";
import { editTimelineTool } from "@/lib/mcp/tools/edit-timeline";
import { undoChangeTool } from "@/lib/mcp/tools/undo-change";
import { applyProjectOps, createProject, getProject } from "@/lib/projects/service";
import type { OpInput, TextClip } from "@/lib/timeline";
import { makeTestDb } from "../helpers/db";
import { addText, toolContext } from "./context";

const grace = { userId: "u2", email: "u2@gmail.com", role: "editor" as const };

async function setup(over: Parameters<typeof toolContext>[1] = {}) {
  const db = await makeTestDb();
  const ctx = await toolContext(db, over);
  await db.insert(user).values({ id: "u2", name: "Grace Hopper", email: "u2@gmail.com", emailVerified: true });
  const { id } = await createProject(db, grace, { name: "Qualifier recap", format: "short_9x16" });
  await applyProjectOps(db, grace, { projectId: id, baseVersion: 0, ops: [addText(0, "FIRST", { id: "x1" }) as OpInput] }); // version 1
  const edit = (expected_version: number, ops: unknown[]) => editTimelineTool(ctx, { project_id: id, expected_version, ops });
  const undo = (expected_version: number, version: number) => undoChangeTool(ctx, { project_id: id, expected_version, version });
  const project = async () => (await getProject(db, grace, id))!;
  const text = async () => ((await project()).doc.tracks[1].clips[0] as TextClip | undefined)?.text;
  const retext = (to: string) => [{ op: "update_clip", clipId: "x1", patch: { text: to } }];
  return { db, id, edit, undo, project, text, retext };
}

describe("undo_change", () => {
  it("undoes its own change through the stored inverse, as a new version", async () => {
    const { edit, undo, project, text, retext } = await setup();
    await edit(1, retext("SECOND")); // version 2
    const r = await undo(2, 2);
    expect(r.isError).toBe(false);
    expect(r.text.split("\n")[0]).toBe("Undid version 2 (Edited a clip) as version 3.");
    expect(r.text).toContain('"FIRST"');
    expect(await text()).toBe("FIRST");
    expect((await project()).version).toBe(3);
  });

  it("undoes a person's change too", async () => {
    const { undo, project } = await setup();
    expect((await undo(1, 1)).text.split("\n")[0]).toBe("Undid version 1 (Added text) as version 2.");
    expect((await project()).doc.tracks[1].clips).toEqual([]);
  });

  it("is refused when that part was changed afterwards, and the later change stays", async () => {
    const { db, id, edit, undo, project, text, retext } = await setup();
    await edit(1, retext("BY CLAUDE")); // version 2
    await applyProjectOps(db, grace, { projectId: id, baseVersion: 2, ops: retext("BY GRACE") as OpInput[] }); // version 3
    expect(await undo(3, 2)).toEqual({ isError: true, text: "Can't undo version 2: that part of the project was changed afterwards.\nNothing was applied." });
    expect(await text()).toBe("BY GRACE");
    expect((await project()).version).toBe(3);
  });

  it("needs the current version like any write, and names a version that does not exist", async () => {
    const { db, id, edit, undo, retext } = await setup();
    await edit(1, retext("SECOND")); // version 2
    await applyProjectOps(db, grace, { projectId: id, baseVersion: 2, ops: [addText(300, "ELSEWHERE") as OpInput] }); // version 3
    expect((await undo(2, 2)).text.split("\n")[0]).toBe("Edit refused: the project changed after version 2. It is now at version 3. Nothing was applied.");
    expect((await undo(3, 2)).isError).toBe(false); // an unrelated later change does not block it
    expect(await undo(4, 9)).toEqual({ isError: true, text: "No change with version 9 in this project." });
    expect((await undoChangeTool(await toolContext(db), { project_id: "nope", expected_version: 0, version: 1 })).text).toMatch(/^No project with id "nope"\./);
  });

  it("the same call sent twice lands once; undoing, redoing and undoing again all work", async () => {
    const { edit, undo, project, text, retext } = await setup();
    await edit(1, retext("SECOND")); // version 2
    const first = await undo(2, 2);  // version 3: back to FIRST
    expect(await undo(2, 2)).toEqual(first);
    expect((await project()).version).toBe(3);
    expect((await undo(3, 3)).isError).toBe(false); // version 4: SECOND again
    expect(await text()).toBe("SECOND");
    expect((await undo(4, 2)).isError).toBe(false); // version 5: FIRST again
    expect(await text()).toBe("FIRST");
  });

  it("refuses a viewer", async () => {
    const { undo, project } = await setup({ role: "viewer" });
    expect((await undo(1, 1)).text).toMatch(/^Your role is viewer\./);
    expect((await project()).version).toBe(1);
  });

  it("refuses a viewer before anything else, even a version that does not exist", async () => {
    const { undo } = await setup({ role: "viewer" });
    expect((await undo(1, 9)).text).toMatch(/^Your role is viewer\./);
  });

  it("passes the engine's reason on when the undo data no longer applies", async () => {
    const { db, id, undo, project } = await setup();
    await applyProjectOps(db, grace, { projectId: id, baseVersion: 1, ops: [{ op: "remove_clip", clipId: "x1" }] }); // version 2
    expect(await undo(2, 1)).toEqual({ isError: true, text: 'Can\'t undo version 1: remove_clip: clip "x1" not found\nNothing was applied.' });
    expect((await project()).version).toBe(2);
  });

  it("restores a whole removed track, which edit_timeline would not accept", async () => {
    const { db, id, undo, project, text } = await setup();
    await applyProjectOps(db, grace, { projectId: id, baseVersion: 1, ops: [{ op: "remove_track", trackId: "t1" }] }); // version 2
    expect((await undo(2, 2)).text.split("\n")[0]).toBe("Undid version 2 (Removed a track) as version 3.");
    expect((await project()).doc.tracks[1].id).toBe("t1");
    expect(await text()).toBe("FIRST");
  });

  it("refuses a change without undo data, and a version missing from the log", async () => {
    const { db, id, edit, undo, project, retext } = await setup();
    await edit(1, retext("SECOND")); // version 2
    await edit(2, retext("THIRD")); // version 3
    await db.execute(sql`update project_ops set inverse = null where project_id = ${id} and version = 1`);
    await db.execute(sql`update project_ops set inverse = '[]'::jsonb where project_id = ${id} and version = 2`);
    expect(await undo(3, 1)).toEqual({ isError: true, text: "Version 1 has no undo data." });
    expect(await undo(3, 2)).toEqual({ isError: true, text: "Version 2 has no undo data." });
    await db.execute(sql`delete from project_ops where project_id = ${id} and version = 2`);
    expect(await undo(3, 2)).toEqual({ isError: true, text: "No change with version 2 in this project." });
    expect((await project()).version).toBe(3);
  });

  it("two different undos sent against the same version are two different calls", async () => {
    const { db, id, edit, undo, retext } = await setup();
    await edit(1, retext("SECOND")); // version 2
    await applyProjectOps(db, grace, { projectId: id, baseVersion: 2, ops: [addText(300, "ELSEWHERE") as OpInput] }); // version 3
    expect((await undo(3, 3)).text.split("\n")[0]).toBe("Undid version 3 (Added text) as version 4.");
    expect((await undo(3, 2)).text.split("\n")[0]).toBe("Edit refused: the project changed after version 3. It is now at version 4. Nothing was applied.");
  });
});
