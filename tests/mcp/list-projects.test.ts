import { describe, expect, it } from "vitest";
import { user } from "@/db/schema";
import { claudeActorFor } from "@/lib/actor";
import { listProjectsTool } from "@/lib/mcp/tools/list-projects";
import { applyProjectOps, createProject, deleteProject } from "@/lib/projects/service";
import type { OpInput } from "@/lib/timeline";
import { makeTestDb } from "../helpers/db";
import { addText, toolContext } from "./context";

const grace = { userId: "u2", email: "u2@gmail.com", role: "editor" as const };
// The test database's clock counts whole milliseconds, so changes meant to sort apart need a gap.
const nextMillisecond = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("list_projects", () => {
  it("says who is signed in and lists the projects, most recently changed first", async () => {
    const db = await makeTestDb();
    const ctx = await toolContext(db);
    await db.insert(user).values({ id: "u2", name: "Grace Hopper", email: "u2@gmail.com", emailVerified: true });
    const first = await createProject(db, grace, { name: 'Qualifier "recap"', format: "short_9x16" });
    const second = await createProject(db, grace, { name: "Season", format: "long_16x9" });
    const gone = await createProject(db, grace, { name: "Deleted", format: "square_1x1" });
    await deleteProject(db, grace, gone.id);
    await nextMillisecond();
    await applyProjectOps(db, claudeActorFor(ctx.user), { projectId: first.id, baseVersion: 0, ops: [addText(0) as OpInput] });

    expect(await listProjectsTool(ctx, {})).toEqual({ isError: false, text: [
      "Signed in as Ada Lovelace (editor). You can read and change projects.",
      "2 projects, most recently changed first:",
      `${first.id}  "Qualifier \\"recap\\""  Short 9:16  version 1  changed just now by Claude (for Ada Lovelace)`,
      `${second.id}  "Season"  Long 16:9  version 0  changed just now by Grace Hopper`,
      "Open a project in the editor at https://studio.test/editor/<id>.",
    ].join("\n") });
  });

  it("tells a viewer they can only read, and says so when there is nothing yet", async () => {
    const db = await makeTestDb();
    expect((await listProjectsTool(await toolContext(db, { role: "viewer" }), {})).text).toBe(
      "Signed in as Ada Lovelace (viewer). You can read projects but not change them.\nNo projects yet. Create one with create_project.",
    );
  });

  it("pages a long list", async () => {
    const db = await makeTestDb();
    const ctx = await toolContext(db, { limits: { connectorListPage: 2 } });
    for (const name of ["A", "B", "C"]) {
      await createProject(db, grace, { name, format: "short_9x16" });
      await nextMillisecond();
    }
    const one = (await listProjectsTool(ctx, {})).text.split("\n");
    expect(one[1]).toBe("3 projects, most recently changed first:");
    expect(one.slice(2, 4).map((l) => l.split("  ")[1])).toEqual(['"C"', '"B"']);
    expect(one[4]).toBe("Showing 1–2 of 3. Call list_projects with cursor 2 for more.");
    const two = (await listProjectsTool(ctx, { cursor: 2 })).text.split("\n");
    expect(two.slice(2, -1).map((l) => l.split("  ")[1])).toEqual(['"A"']);
    expect(two.join("\n")).not.toContain("Showing");
  });
});
