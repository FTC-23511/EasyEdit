import { describe, expect, it } from "vitest";
import { LIMITS } from "@/lib/limits";
import { getProjectTool } from "@/lib/mcp/tools/get-project";
import { applyProjectOps, createProject, deleteProject } from "@/lib/projects/service";
import type { OpInput } from "@/lib/timeline";
import { makeTestDb } from "../helpers/db";
import { addText, fillWithText, toolContext } from "./context";

const grace = { userId: "u2", email: "u2@gmail.com", role: "editor" as const };

describe("get_project", () => {
  it("prints the project with its version, frames, ids and styles", async () => {
    const db = await makeTestDb();
    const { id } = await createProject(db, grace, { name: "Qualifier recap", format: "short_9x16" });
    await applyProjectOps(db, grace, { projectId: id, baseVersion: 0, ops: [addText(15, "QUALIFIER RECAP", { id: "x1", duration: 45 }) as OpInput] });
    expect(await getProjectTool(await toolContext(db, { role: "viewer" }), { project_id: id })).toEqual({ isError: false, text:
`Project "Qualifier recap" (id ${id})
Format short_9x16 1080x1920 @30fps · duration 2.00s · version 1
Track v1 [video] "Video 1"
  (empty)
Track t1 [text] "Text 1"
  x1  text  0.50–2.00s  frames 15–60  "QUALIFIER RECAP"  font="Geist" size=96 weight=700 color="#ffffff" align=center x=0.5 y=0.5
Track cap [caption] "Captions"
  (empty)
Track a1 [audio] "Audio 1"
  (empty)` });
  });

  it("says so when the project does not exist or was deleted", async () => {
    const db = await makeTestDb();
    const ctx = await toolContext(db);
    const { id } = await createProject(db, grace, { name: "Gone", format: "short_9x16" });
    await deleteProject(db, grace, id);
    for (const project_id of ["nope", id]) {
      expect(await getProjectTool(ctx, { project_id })).toEqual({ isError: true, text: `No project with id "${project_id}". It may have been deleted. Call list_projects to see the ids.` });
    }
  });

  it("a 1,000-clip project comes in pages: none over the limit, each clip exactly once, each with the head", async () => {
    const db = await makeTestDb();
    const ctx = await toolContext(db);
    const { id } = await createProject(db, grace, { name: "Long one", format: "long_16x9" });
    const version = await fillWithText(db, grace, id, 1000);

    const seen: string[] = [];
    let cursor: number | undefined;
    let pageVersion: number | undefined;
    let pages = 0;
    do {
      const r = await getProjectTool(ctx, { project_id: id, cursor, version: pageVersion });
      expect(r.isError).toBe(false);
      expect(r.text.length).toBeLessThanOrEqual(LIMITS.connectorReadChars + 400); // the name, head and footer lines ride on top
      const lines = r.text.split("\n");
      expect(lines[0]).toBe(`Project "Long one" (id ${id})`);
      expect(lines[1]).toContain(`· version ${version}`);
      for (const line of lines) {
        const clip = /^ {2}(k\d+) {2}text /.exec(line);
        if (clip) seen.push(clip[1]);
      }
      const more = /, cursor (\d+) and version (\d+) to read on\.$/.exec(lines.at(-1)!);
      cursor = more ? Number(more[1]) : undefined;
      pageVersion = more ? Number(more[2]) : undefined;
      if (more) expect(pageVersion).toBe(version);
      pages++;
    } while (cursor !== undefined && pages < 50);

    expect(pages).toBeGreaterThan(3);
    expect(seen).toHaveLength(1000);
    expect(new Set(seen).size).toBe(1000);
    expect((await getProjectTool(ctx, { project_id: id, cursor: 5000, version })).text.split("\n").at(-1)).toBe("(no more lines)");
  });

  it("refuses the next page when the project changed between two pages", async () => {
    const db = await makeTestDb();
    const ctx = await toolContext(db);
    const { id } = await createProject(db, grace, { name: "Long one", format: "long_16x9" });
    const version = await fillWithText(db, grace, id, 300);
    const first = (await getProjectTool(ctx, { project_id: id })).text.split("\n");
    const more = /, cursor (\d+) and version (\d+) to read on\.$/.exec(first.at(-1)!)!;
    expect(Number(more[2])).toBe(version);

    await applyProjectOps(db, grace, { projectId: id, baseVersion: version, ops: [{ op: "remove_clip", clipId: "k0" }, { op: "remove_clip", clipId: "k1" }] });
    expect(await getProjectTool(ctx, { project_id: id, cursor: Number(more[1]), version })).toEqual({
      isError: true,
      text: `The project changed to version ${version + 1} while you were reading. Read it again from the start, without a cursor.`,
    });
  });

  it("refuses a cursor without the version it came from, and ignores a version without a cursor", async () => {
    const db = await makeTestDb();
    const ctx = await toolContext(db);
    const { id } = await createProject(db, grace, { name: "Long one", format: "long_16x9" });
    const version = await fillWithText(db, grace, id, 300);
    expect(await getProjectTool(ctx, { project_id: id, cursor: 40 })).toEqual({
      isError: true,
      text: "A cursor needs the version it came from. Read the project again from the start, without a cursor.",
    });
    const whole = await getProjectTool(ctx, { project_id: id });
    expect(await getProjectTool(ctx, { project_id: id, cursor: 0 })).toEqual(whole);
    expect(await getProjectTool(ctx, { project_id: id, cursor: 0, version: version + 7 })).toEqual(whole);
    expect(await getProjectTool(ctx, { project_id: id, version: version + 7 })).toEqual(whole);
  });
});
