import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { rowsOf } from "@/db";
import { user } from "@/db/schema";
import { LIMITS } from "@/lib/limits";
import { conflictResult, failureResult, OP_HINTS } from "@/lib/mcp/errors";
import { editTimelineTool } from "@/lib/mcp/tools/edit-timeline";
import { applyProjectOps, createProject, deleteProject, getProject } from "@/lib/projects/service";
import type { OpInput } from "@/lib/timeline";
import { makeTestDb } from "../helpers/db";
import { addText, fillWithText, textClip, toolContext } from "./context";

const grace = { userId: "u2", email: "u2@gmail.com", role: "editor" as const };

// Lets a test change the project just before or just after the next getProject read. Otherwise the service is the real one.
const nextRead = vi.hoisted(() => ({ before: null as null | (() => Promise<unknown>), after: null as null | (() => Promise<unknown>) }));
vi.mock("@/lib/projects/service", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/projects/service")>();
  return {
    ...real,
    getProject: async (...args: Parameters<typeof real.getProject>) => {
      const { before, after } = nextRead;
      nextRead.before = nextRead.after = null;
      await before?.();
      const project = await real.getProject(...args);
      await after?.();
      return project;
    },
  };
});

async function setup(over: Parameters<typeof toolContext>[1] = {}) {
  const db = await makeTestDb();
  const ctx = await toolContext(db, over);
  await db.insert(user).values({ id: "u2", name: "Grace Hopper", email: "u2@gmail.com", emailVerified: true });
  const { id } = await createProject(db, grace, { name: "Qualifier recap", format: "short_9x16" });
  const edit = (expected_version: number, ops: unknown[]) => editTimelineTool(ctx, { project_id: id, expected_version, ops });
  const project = async () => (await getProject(db, grace, id))!;
  const texts = async () => (await project()).doc.tracks[1].clips.map((c) => (c as { text: string }).text);
  const log = async () => rowsOf<{ version: number; actor: string; request_id: string | null }>(
    await db.execute(sql`select version, actor, request_id from project_ops where project_id = ${id} order by version`));
  return { db, ctx, id, edit, project, texts, log };
}

describe("edit_timeline", () => {
  it("applies a batch and reports the version, the new ids and the project", async () => {
    const { edit, project, log } = await setup();
    const r = await edit(0, [addText(0), addText(60, "SECOND")]);
    const clips = (await project()).doc.tracks[1].clips;
    expect(r.isError).toBe(false);
    expect(r.text.split("\n").slice(0, 6)).toEqual([
      "Applied 2 ops as version 1.",
      "New ids:",
      `  clip ${clips[0].id} on track t1`,
      `  clip ${clips[1].id} on track t1`,
      expect.stringMatching(/^Project "Qualifier recap" \(id /),
      "Format short_9x16 1080x1920 @30fps · duration 3.00s · version 1",
    ]);
    expect(r.text).toContain('"SECOND"  font="Geist"');
    expect(await log()).toEqual([{ version: 1, actor: "claude:u1", request_id: expect.stringMatching(/^c[A-Za-z0-9_-]{42}$/) }]);
    expect((await edit(1, [{ op: "move_clip", clipId: clips[0].id, start: 200 }])).text.split("\n")[0]).toBe("Applied 1 op as version 2.");
  });

  it("applies nothing when one op fails, and says which op, why and how to fix it", async () => {
    const { edit, project } = await setup();
    const r = await edit(0, [addText(0), addText(10)]);
    expect(r.isError).toBe(true);
    const lines = r.text.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("Edit refused: ops[1] (add_clip) failed with OVERLAP.");
    expect(lines[1]).toMatch(/^add_clip: clips ".+" and ".+" overlap on track "t1"$/);
    expect(lines[2]).toBe(`How to fix: ${OP_HINTS.OVERLAP}`);
    expect(lines[3]).toBe("Nothing was applied.");
    expect(await project()).toMatchObject({ version: 0 });
    expect((await project()).doc.tracks[1].clips).toEqual([]);
  });

  it.each<[string, unknown, string]>([
    ["an id that does not exist", { op: "move_clip", clipId: "nope", start: 0 }, "Edit refused: ops[0] (move_clip) failed with NOT_FOUND."],
    ["a text clip on a video track", { ...addText(0), trackId: "v1" }, "Edit refused: ops[0] (add_clip) failed with WRONG_TRACK_KIND."],
    ["seconds where frames belong", addText(1.5), "Edit refused: ops[0] (add_clip) failed with INVALID."],
    ["an op that does not exist", { op: "fade_clip", clipId: "x" }, "Edit refused: ops[0] (fade_clip) failed with INVALID."],
    ["something that is not an op", { clipId: "x" }, "Edit refused: ops[0] (op) failed with INVALID."],
  ])("refuses %s", async (_name, op, firstLine) => {
    const { edit, project } = await setup();
    const r = await edit(0, [op]);
    expect(r.isError).toBe(true);
    expect(r.text.split("\n")[0]).toBe(firstLine);
    expect(r.text.split("\n").at(-1)).toBe("Nothing was applied.");
    expect((await project()).version).toBe(0);
  });

  it("refuses a locked track with the hint to unlock it", async () => {
    const { db, id, edit } = await setup();
    await applyProjectOps(db, grace, { projectId: id, baseVersion: 0, ops: [{ op: "update_track", trackId: "t1", patch: { locked: true } }] });
    const r = await edit(1, [addText(0)]);
    expect(r.text.split("\n")[0]).toBe("Edit refused: ops[0] (add_clip) failed with TRACK_LOCKED.");
    expect(r.text).toContain(OP_HINTS.TRACK_LOCKED);
  });

  it("refuses media clips and whole-track replacement for now", async () => {
    const { edit, project } = await setup();
    const video = { op: "add_clip", trackId: "v1", clip: { type: "video", assetId: "made-up", start: 0, duration: 30, in: 0, speed: 1, volume: 1, transform: textClip(0).transform } };
    expect(await edit(0, [addText(0), video])).toEqual({ isError: true, text: [
      "Edit refused: ops[1] (add_clip) is not available here.",
      "Video, image and audio clips can't be added until the media library exists. Only text clips can be added.",
      "Nothing was applied.",
    ].join("\n") });
    expect(await edit(0, [{ op: "replace_track", track: (await project()).doc.tracks[1], index: 1 }])).toEqual({ isError: true, text: [
      "Edit refused: ops[0] (replace_track) is not available here.",
      "Change tracks with add_clip, move_clip and the other ops.",
      "Nothing was applied.",
    ].join("\n") });
    expect((await project()).version).toBe(0);
  });

  it("refuses an edit made against an old version, and shows what changed", async () => {
    const { db, id, edit, project, texts } = await setup();
    await applyProjectOps(db, grace, { projectId: id, baseVersion: 0, ops: [addText(0, "BY GRACE") as OpInput] });
    const r = await edit(0, [addText(0, "BY CLAUDE")]);
    expect(r.isError).toBe(true);
    const lines = r.text.split("\n");
    expect(lines.slice(0, 5)).toEqual([
      "Edit refused: the project changed after version 0. It is now at version 1. Nothing was applied.",
      "Changes you have not seen:",
      "  version 1 · Grace Hopper · Added text",
      "Current project:",
      `Project "Qualifier recap" (id ${id})`,
    ]);
    expect(r.text).toContain('"BY GRACE"');
    expect(lines.at(-1)).toBe("Plan again from this, then send your change with expected_version 1.");
    expect((await project()).version).toBe(1);

    // The next attempt, planned against what came back, lands, and the person's edit is intact.
    expect((await edit(1, [addText(60, "BY CLAUDE")])).isError).toBe(false);
    expect(await texts()).toEqual(["BY GRACE", "BY CLAUDE"]);
  });

  it("names its own earlier change as yours, cuts a long list of changes, and catches a version from the future", async () => {
    const { db, id, edit } = await setup({ limits: { connectorConflictEntries: 2 } });
    await edit(0, [addText(0)]);
    for (let v = 1; v <= 3; v++) {
      await applyProjectOps(db, grace, { projectId: id, baseVersion: v, ops: [{ op: "set_format", format: v % 2 ? "long_16x9" : "short_9x16" }] });
    }
    expect((await edit(0, [addText(300)])).text.split("\n").slice(1, 5)).toEqual([
      "Changes you have not seen:",
      "  version 1 · you · Added text",
      "  version 2 · Grace Hopper · Changed the format to Long 16:9",
      "  … and 2 more",
    ]);
    const ahead = (await edit(9, [addText(300)])).text.split("\n");
    expect(ahead[0]).toBe("Edit refused: expected_version 9 is ahead of the project, which is at version 4. Nothing was applied.");
    expect(ahead[1]).toBe("Current project:");
    expect(ahead.at(-1)).toBe("Plan again from this, then send your change with expected_version 4.");
  });

  it("the same call sent twice lands once and gets the same answer", async () => {
    const { edit, project, log } = await setup();
    const first = await edit(0, [addText(0)]);
    const sameWithKeysReordered = { clip: textClip(0), trackId: "t1", op: "add_clip" };
    expect(await edit(0, [sameWithKeysReordered])).toEqual(first);
    expect(await log()).toHaveLength(1);
    expect((await project()).doc.tracks[1].clips).toHaveLength(1);
  });

  it("the same ops against the new version are a new change", async () => {
    const { edit, log, texts } = await setup();
    const pushed = [{ ...addText(0), ripple: true }];
    await edit(0, pushed);
    expect((await edit(1, pushed)).text.split("\n")[0]).toBe("Applied 1 op as version 2.");
    expect(await log()).toHaveLength(2);
    expect(await texts()).toHaveLength(2);
  });

  it("refuses a viewer, an unknown project and more than 500 ops, and writes nothing", async () => {
    const { edit, project, log } = await setup({ role: "viewer" });
    expect(await edit(0, [addText(0)])).toEqual({ isError: true, text: "Your role is viewer. You can read projects but not change them. An admin can change your role on the Admin page." });
    expect((await project()).version).toBe(0);
    expect(await log()).toEqual([]);

    const editor = await setup();
    expect(await editTimelineTool(editor.ctx, { project_id: "nope", expected_version: 0, ops: [addText(0)] }))
      .toEqual({ isError: true, text: 'No project with id "nope". It may have been deleted. Call list_projects to see the ids.' });
    const many = Array.from({ length: LIMITS.opsPerRequest + 1 }, (_, i) => addText(i * 30));
    expect(await editor.edit(0, many)).toEqual({ isError: true, text: `At most ${LIMITS.opsPerRequest} ops per request\nNothing was applied.` });
  });

  it("stops a run of changes at the budget", async () => {
    const { edit, project } = await setup({ limits: { connectorWritesPerMinute: 1 } });
    expect((await edit(0, [addText(0)])).isError).toBe(false);
    expect(await edit(1, [addText(60)])).toEqual({ isError: true, text: "Too many changes at once: 1 in the last minute (the limit is 1). Wait a minute, then continue." });
    expect((await project()).version).toBe(1);
  });

  it("a repeat of a change that landed gets the first answer even when the budget is used up", async () => {
    const { edit, project, log } = await setup({ limits: { connectorWritesPerMinute: 1 } });
    const first = await edit(0, [addText(0)]);
    expect(first.isError).toBe(false);
    expect(await edit(0, [addText(0)])).toEqual(first);
    expect(await edit(1, [addText(60)])).toEqual({ isError: true, text: "Too many changes at once: 1 in the last minute (the limit is 1). Wait a minute, then continue." });
    expect(await log()).toHaveLength(1);
    expect((await project()).version).toBe(1);
  });

  it("the answer to an edit of a large project stays small", async () => {
    const { db, id, edit } = await setup();
    const version = await fillWithText(db, grace, id, 999);
    const r = await edit(version, [{ op: "update_clip", clipId: "k5", patch: { text: "CHANGED" } }]);
    expect(r.isError).toBe(false);
    expect(r.text.length).toBeLessThanOrEqual(LIMITS.connectorEchoChars + 500);
    expect(r.text.split("\n").at(-1)).toMatch(new RegExp(`^… \\d+ more lines\\. Call get_project with project_id ".+", cursor \\d+ and version ${version + 1} to read on\\.$`));
    const conflict = await edit(0, [addText(0)]);
    expect(conflict.text.length).toBeLessThanOrEqual(LIMITS.connectorEchoChars + 1500);
  });

  it("a conflict on a project too long to attach whole says to read the rest first", async () => {
    const { db, id, edit } = await setup();
    const version = await fillWithText(db, grace, id, 999);
    const lines = (await edit(0, [addText(0)])).text.split("\n");
    expect(lines.at(-2)).toMatch(new RegExp(`^… \\d+ more lines\\. Call get_project with project_id ".+", cursor \\d+ and version ${version} to read on\\.$`));
    expect(lines.at(-1)).toBe(`The project text above is cut. Read the rest with get_project, then send your change with expected_version ${version}.`);
  });

  it("a repeat after someone else's change gets the first change back, and says the project has moved on", async () => {
    const { db, id, edit, log } = await setup();
    const first = await edit(0, [addText(0)]);
    await applyProjectOps(db, grace, { projectId: id, baseVersion: 1, ops: [addText(60, "BY GRACE") as OpInput] });
    const again = (await edit(0, [addText(0)])).text.split("\n");
    expect(again[0]).toBe("Applied 1 op as version 1.");
    expect(again[1]).toBe("The project has changed again since: it is now at version 2.");
    expect(again[2]).toBe(first.text.split("\n")[1]);
    expect(await log()).toHaveLength(2);
  });

  it("keeps the engine's message on one line when an id holds a line break", async () => {
    const { edit } = await setup();
    const lines = (await edit(0, [{ op: "move_clip", clipId: "a\nb\u2028c", start: 0 }])).text.split("\n");
    expect(lines).toEqual([
      "Edit refused: ops[0] (move_clip) failed with NOT_FOUND.",
      'move_clip: clip "a b c" not found',
      `How to fix: ${OP_HINTS.NOT_FOUND}`,
      "Nothing was applied.",
    ]);
  });

  it("tells a viewer about the role, not the budget", async () => {
    const { edit } = await setup({ role: "viewer", limits: { connectorWritesPerMinute: 0 } });
    expect((await edit(0, [addText(0)])).text).toBe("Your role is viewer. You can read projects but not change them. An admin can change your role on the Admin page.");
  });

  it("passes on any error that is not a refused write", async () => {
    const { ctx, id } = await setup();
    await expect(failureResult(ctx, new Error("boom"), { projectId: id, expectedVersion: 0, ops: [] })).rejects.toThrow("boom");
  });

  it("lists only the changes up to the version it shows, when another lands while it reads", async () => {
    const { db, id, edit } = await setup();
    await applyProjectOps(db, grace, { projectId: id, baseVersion: 0, ops: [addText(0, "BY GRACE") as OpInput] });
    nextRead.after = () => applyProjectOps(db, grace, { projectId: id, baseVersion: 1, ops: [addText(60, "LATE") as OpInput] });
    const lines = (await edit(0, [addText(300)])).text.split("\n");
    expect(lines.slice(0, 4)).toEqual([
      "Edit refused: the project changed after version 0. It is now at version 1. Nothing was applied.",
      "Changes you have not seen:",
      "  version 1 · Grace Hopper · Added text",
      "Current project:",
    ]);
    expect(lines.at(-1)).toBe("Plan again from this, then send your change with expected_version 1.");
  });

  it("lists no changes for a project still at the expected version", async () => {
    const { ctx, id } = await setup();
    const lines = (await conflictResult(ctx, id, 0)).text.split("\n");
    expect(lines[1]).toBe("Current project:");
  });

  it("answers not found when the project is deleted as the change lands, or during a conflict", async () => {
    const notFound = (id: string) => ({ isError: true, text: `No project with id "${id}". It may have been deleted. Call list_projects to see the ids.` });
    const landed = await setup();
    nextRead.before = () => deleteProject(landed.db, grace, landed.id);
    expect(await landed.edit(0, [addText(0)])).toEqual(notFound(landed.id));

    const refused = await setup();
    await applyProjectOps(refused.db, grace, { projectId: refused.id, baseVersion: 0, ops: [addText(0) as OpInput] });
    nextRead.before = () => deleteProject(refused.db, grace, refused.id);
    expect(await refused.edit(0, [addText(60)])).toEqual(notFound(refused.id));
  });
});
