import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { rowsOf } from "@/db";
import { addTextTool } from "@/lib/mcp/tools/add-text";
import { applyProjectOps, createProject, deleteProject, getProject } from "@/lib/projects/service";
import type { OpInput, TextClip } from "@/lib/timeline";
import { makeTestDb } from "../helpers/db";
import { addText, toolContext } from "./context";

const grace = { userId: "u2", email: "u2@gmail.com", role: "editor" as const };

async function setup(over: Parameters<typeof toolContext>[1] = {}) {
  const db = await makeTestDb();
  const ctx = await toolContext(db, over);
  const { id } = await createProject(db, grace, { name: "Qualifier recap", format: "short_9x16" });
  const add = (expected_version: number, items: Parameters<typeof addTextTool>[1]["items"]) => addTextTool(ctx, { project_id: id, expected_version, items });
  const project = async () => (await getProject(db, grace, id))!;
  const logRows = async () => rowsOf(await db.execute(sql`select 1 from project_ops where project_id = ${id}`)).length;
  return { db, ctx, id, add, project, logRows };
}

describe("add_text", () => {
  it("adds a title at the start, from the preset, as one change", async () => {
    const { add, project } = await setup();
    const r = await add(0, [{ text: "GO SOLVERS" }]);
    const [clip] = (await project()).doc.tracks[1].clips as TextClip[];
    expect(r.isError).toBe(false);
    expect(r.text.split("\n").slice(0, 3)).toEqual(["Added 1 text clip as version 1.", "New ids:", `  clip ${clip.id} on track t1`]);
    expect(clip).toMatchObject({ type: "text", start: 0, duration: 90, text: "GO SOLVERS", transform: { x: 0.5, y: 0.5 }, style: { fontFamily: "Geist", fontSize: 96, fontWeight: 700, align: "center" } });
  });

  it("turns seconds into frames and uses the named preset", async () => {
    const { add, project } = await setup();
    await add(0, [{ text: "Ada Lovelace, driver", preset: "lower-third", start_seconds: 1.5, duration_seconds: 2 }]);
    expect((await project()).doc.tracks[1].clips[0]).toMatchObject({ start: 45, duration: 60, transform: { y: 0.62 }, style: { fontSize: 44, fontWeight: 600, align: "left" } });
  });

  it("puts overlapping text on a new track, all in one version", async () => {
    const { add, project } = await setup();
    const r = await add(0, [{ text: "ONE" }, { text: "TWO", preset: "subtitle", start_seconds: 1 }, { text: "THREE", start_seconds: 10 }]);
    const p = await project();
    expect(p.version).toBe(1);
    expect(r.text.split("\n")[0]).toBe("Added 3 text clips as version 1.");
    const textTracks = p.doc.tracks.filter((t) => t.kind === "text");
    expect(textTracks.map((t) => t.name)).toEqual(["Text 1", "Text 2"]);
    expect(textTracks.flatMap((t) => t.clips.map((c) => (c as TextClip).text)).sort()).toEqual(["ONE", "THREE", "TWO"]);
    expect(r.text).toContain('("Text 2", text)');
  });

  it("uses the wished track when it is free, and another one when it is not", async () => {
    const { db, id, add, project } = await setup();
    await applyProjectOps(db, grace, { projectId: id, baseVersion: 0, ops: [{ op: "add_track", track: { id: "t2", kind: "text", name: "Text 2" } }, addText(0, "TAKEN", { id: "x1" }) as OpInput] });
    await add(1, [{ text: "WISHED", track_id: "t2" }, { text: "MOVED", track_id: "t1" }]);
    const byTrack = Object.fromEntries((await project()).doc.tracks.map((t) => [t.id, t.clips.map((c) => (c as TextClip).text)]));
    expect(byTrack.t2).toContain("WISHED");
    expect(byTrack.t1).toEqual(["TAKEN"]);
    expect(Object.values(byTrack).flat()).toContain("MOVED");
  });

  it("refuses when there is no room, when the version is old, for a viewer, and for text that cannot be saved", async () => {
    const { db, id, add, project } = await setup();
    const tracks = Array.from({ length: 16 }, (_, i) => ({ op: "add_track", track: { id: `a${i + 2}`, kind: "audio", name: `Audio ${i + 2}` } }));
    await applyProjectOps(db, grace, { projectId: id, baseVersion: 0, ops: [...tracks, addText(0, "TAKEN")] as OpInput[] });
    expect(await add(1, [{ text: "NO ROOM" }])).toEqual({ isError: true, text: "There is no room for that text: the project has 20 tracks and none is free at that time. Remove a track or pick another time." });
    expect((await add(0, [{ text: "OLD", start_seconds: 30 }])).text.split("\n")[0]).toBe("Edit refused: the project changed after version 0. It is now at version 1. Nothing was applied.");
    expect(await add(1, [{ text: "ok" }, { text: "" }])).toEqual({ isError: true, text: "items[1].text must be 1 to 2000 characters that can be saved." });
    expect((await project()).version).toBe(1);

    const viewer = await setup({ role: "viewer" });
    expect((await viewer.add(0, [{ text: "X" }])).text).toMatch(/^Your role is viewer\./);
    expect(await viewer.logRows()).toBe(0);
  });

  it("the same call sent twice lands once and gets the same answer", async () => {
    const { add, project, logRows } = await setup();
    const first = await add(0, [{ text: "GO SOLVERS", start_seconds: 2 }]);
    expect(await add(0, [{ start_seconds: 2, text: "GO SOLVERS" }])).toEqual(first);
    expect(await logRows()).toBe(1);
    expect((await project()).doc.tracks[1].clips).toHaveLength(1);
  });

  it("puts each text on the free track it names, even when another free track comes first", async () => {
    const { db, id, add, project } = await setup();
    await applyProjectOps(db, grace, { projectId: id, baseVersion: 0, ops: [{ op: "add_track", track: { id: "t2", kind: "text", name: "Text 2" } }] });
    await add(1, [{ text: "ON T1", track_id: "t1" }]);
    await add(2, [{ text: "ON T2", track_id: "t2", start_seconds: 10 }]);
    const byTrack = Object.fromEntries((await project()).doc.tracks.map((t) => [t.id, t.clips.map((c) => (c as TextClip).text)]));
    expect(byTrack.t1).toEqual(["ON T1"]);
    expect(byTrack.t2).toEqual(["ON T2"]);
  });

  it("checks the version before looking for room", async () => {
    const { db, id, add } = await setup();
    const tracks = Array.from({ length: 16 }, (_, i) => ({ op: "add_track", track: { id: `a${i + 2}`, kind: "audio", name: `Audio ${i + 2}` } }));
    await applyProjectOps(db, grace, { projectId: id, baseVersion: 0, ops: [...tracks, addText(0, "TAKEN")] as OpInput[] });
    expect((await add(0, [{ text: "OLD AND NO ROOM" }])).text.split("\n")[0]).toBe("Edit refused: the project changed after version 0. It is now at version 1. Nothing was applied.");
  });

  it("refuses text that is too long or cannot be saved, and more items than the limit", async () => {
    const { add, logRows } = await setup({ limits: { connectorTextItems: 2 } });
    const refusal = (i: number) => ({ isError: true, text: `items[${i}].text must be 1 to 2000 characters that can be saved.` });
    expect(await add(0, [{ text: "x".repeat(2001) }])).toEqual(refusal(0));
    expect(await add(0, [{ text: "ok" }, { text: "half \ud83d" }])).toEqual(refusal(1));
    expect(await add(0, [{ text: "nul \u0000" }])).toEqual(refusal(0));
    expect(await add(0, [{ text: "A" }, { text: "B" }, { text: "C" }])).toEqual({ isError: true, text: "At most 2 text clips per call." });
    expect(await logRows()).toBe(0);
    expect((await add(0, [{ text: "x".repeat(2000) }, { text: "B", start_seconds: 5 }])).isError).toBe(false);
  });

  it("refuses a viewer before anything else, even text that cannot be saved", async () => {
    const { add } = await setup({ role: "viewer" });
    expect((await add(0, [{ text: "" }])).text).toMatch(/^Your role is viewer\./);
  });

  it("gives a very short text at least one frame", async () => {
    const { add, project } = await setup();
    expect((await add(0, [{ text: "BLINK", duration_seconds: 0.01 }])).isError).toBe(false);
    expect((await project()).doc.tracks[1].clips[0]).toMatchObject({ start: 0, duration: 1 });
  });

  it("answers not found for an unknown project, and for a repeat after the project was deleted", async () => {
    const { db, ctx, id, add } = await setup();
    const notFound = (pid: string) => ({ isError: true, text: `No project with id "${pid}". It may have been deleted. Call list_projects to see the ids.` });
    expect(await addTextTool(ctx, { project_id: "nope", expected_version: 0, items: [{ text: "X" }] })).toEqual(notFound("nope"));
    expect((await add(0, [{ text: "X" }])).isError).toBe(false);
    await deleteProject(db, grace, id);
    expect(await add(0, [{ text: "X" }])).toEqual(notFound(id));
  });
});
