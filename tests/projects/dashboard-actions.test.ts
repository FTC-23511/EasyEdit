import { describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/access-rules";
import { actorFrom } from "@/lib/actor";
import type { Role } from "@/lib/allowlist/service";
import { makeDashboardActions } from "@/lib/projects/dashboard-actions";
import { createProject, deleteProject, getProject, listProjects } from "@/lib/projects/service";
import { makeTestDb } from "../helpers/db";

const form = (fields: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.set(k, v); return f; };

async function setup(role: Role = "editor") {
  const db = await makeTestDb();
  const user: CurrentUser = { id: "u1", email: "u1@gmail.com", name: "U1", image: null, role };
  const revalidate = vi.fn();
  const redirect = vi.fn((path: string): never => { throw new Error(`REDIRECT ${path}`); });
  const actions = makeDashboardActions({ db: () => db, requireUser: async () => user, revalidate, redirect });
  const owner = actorFrom({ ...user, role: "editor" });
  return { db, owner, revalidate, actions };
}

describe("dashboard actions", () => {
  it("create explains a bad name or format and creates nothing", async () => {
    const { db, owner, actions } = await setup();
    for (const name of ["", "   ", "x".repeat(101)]) {
      expect(await actions.create({}, form({ name, format: "short_9x16" }))).toEqual({ error: "Enter a name up to 100 characters." });
    }
    expect(await actions.create({}, form({ name: "Qual", format: "nope" }))).toEqual({ error: "Pick a format." });
    expect(await listProjects(db, owner)).toEqual([]);
  });

  it("create opens the new project in the editor", async () => {
    const { actions } = await setup();
    await expect(actions.create({}, form({ name: "Qual", format: "short_9x16" }))).rejects.toThrow(/^REDIRECT \/editor\/\S+$/);
  });

  it("rename, duplicate and delete change the project and refresh the dashboard", async () => {
    const { db, owner, revalidate, actions } = await setup();
    const { id } = await createProject(db, owner, { name: "Qual", format: "short_9x16" });
    expect(await actions.rename(form({ id, name: "Finals" }))).toEqual({});
    expect(await actions.duplicate(form({ id }))).toEqual({});
    expect((await listProjects(db, owner)).map((p) => p.name).sort()).toEqual(["Finals", "Finals copy"]);
    expect(await actions.remove(form({ id }))).toEqual({});
    expect(await getProject(db, owner, id)).toBeNull();
    expect(revalidate).toHaveBeenCalledTimes(3);
    expect(revalidate).toHaveBeenCalledWith("/dashboard");
  });

  it("a viewer gets the role message and nothing changes", async () => {
    const { db, owner, revalidate, actions } = await setup("viewer");
    const { id } = await createProject(db, owner, { name: "Qual", format: "short_9x16" });
    for (const result of [await actions.rename(form({ id, name: "X" })), await actions.duplicate(form({ id })), await actions.remove(form({ id }))]) {
      expect(result).toEqual({ error: "Your role doesn't allow this." });
    }
    expect(await actions.create({}, form({ name: "New", format: "short_9x16" }))).toEqual({ error: "Your role doesn't allow this." });
    expect((await listProjects(db, owner)).map((p) => p.name)).toEqual(["Qual"]);
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("acting on a deleted project says it no longer exists and refreshes the dashboard, so its card goes", async () => {
    const { db, owner, revalidate, actions } = await setup();
    const { id } = await createProject(db, owner, { name: "Qual", format: "short_9x16" });
    await deleteProject(db, owner, id); // deleted elsewhere, for example in another tab
    for (const act of [() => actions.rename(form({ id, name: "X" })), () => actions.duplicate(form({ id })), () => actions.remove(form({ id }))]) {
      revalidate.mockClear();
      expect(await act()).toEqual({ error: "That project no longer exists." });
      expect(revalidate).toHaveBeenCalledWith("/dashboard");
    }
  });
});
