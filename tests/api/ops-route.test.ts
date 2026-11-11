import { describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/access-rules";
import { makeOpsHandlers, makeProjectHandlers } from "@/lib/projects/handlers";
import { createProject } from "@/lib/projects/service";
import { DEFAULT_TRANSFORM } from "@/lib/timeline";
import { makeTestDb } from "../helpers/db";

const ROLE_RANK = { viewer: 0, editor: 1, admin: 2 } as const;

function userWith(role: CurrentUser["role"]): CurrentUser {
  return { id: "u1", email: "u1@gmail.com", name: "U1", image: null, role };
}

async function setup(role: CurrentUser["role"]) {
  const db = await makeTestDb();
  const auth = vi.fn(async (_req: Request, min: CurrentUser["role"]) =>
    ROLE_RANK[role] >= ROLE_RANK[min]
      ? userWith(role)
      : Response.json({ code: "FORBIDDEN" }, { status: 403 }),
  );
  const deps = { db: () => db, auth };
  return { db, auth, ops: makeOpsHandlers(deps), projects: makeProjectHandlers(deps) };
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function post(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const textClip = {
  id: "c1",
  type: "text",
  start: 0,
  duration: 60,
  text: "GO SOLVERS",
  transform: { ...DEFAULT_TRANSFORM },
  style: { fontFamily: "Inter", fontSize: 96, fontWeight: 800, color: "#FFFFFF", align: "center" },
};
const addClip = { op: "add_clip", trackId: "t1", clip: textClip };

describe("ops routes", () => {
  it("viewer cannot POST ops (403)", async () => {
    const { db, ops, auth } = await setup("viewer");
    const { id } = await createProject(db, { name: "P", format: "short_9x16", actor: "u1" });
    const res = await ops.postOps(post(`http://x/api/projects/${id}/ops`, { baseVersion: 0, ops: [addClip] }), ctx(id));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: "FORBIDDEN" });
    expect(auth).toHaveBeenCalledWith(expect.any(Request), "editor");
    const since = await ops.getSince(new Request(`http://x/api/projects/${id}/ops?since=0`), ctx(id));
    expect(await since.json()).toEqual({ version: 0, entries: [] });
  });

  it("POST ops returns 200 with new version; GET since=0 returns the entry", async () => {
    const { db, ops } = await setup("editor");
    const { id } = await createProject(db, { name: "P", format: "short_9x16", actor: "u1" });
    const res = await ops.postOps(post(`http://x/api/projects/${id}/ops`, { baseVersion: 0, ops: [addClip] }), ctx(id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe(1);
    expect(body.ops).toHaveLength(1);

    const got = await ops.getSince(new Request(`http://x/api/projects/${id}/ops?since=0`), ctx(id));
    expect(got.status).toBe(200);
    const since = await got.json();
    expect(since.version).toBe(1);
    expect(since.entries).toHaveLength(1);
    expect(since.entries[0]).toMatchObject({ version: 1, actor: "u1" });
  });

  it("POST ops with bad body returns 400 INVALID", async () => {
    const { db, ops } = await setup("editor");
    const { id } = await createProject(db, { name: "P", format: "short_9x16", actor: "u1" });
    for (const body of [{ baseVersion: 0, ops: "x" }, { baseVersion: -1, ops: [addClip] }, { baseVersion: 0, ops: [] }, "not json"]) {
      const res = await ops.postOps(post(`http://x/api/projects/${id}/ops`, body), ctx(id));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "INVALID", message: expect.any(String) });
    }
  });

  it("GET ops rejects a bad since with 400 INVALID", async () => {
    const { db, ops } = await setup("viewer");
    const { id } = await createProject(db, { name: "P", format: "short_9x16", actor: "u1" });
    for (const since of ["-1", "1.5", "abc", ""]) {
      const res = await ops.getSince(new Request(`http://x/api/projects/${id}/ops?since=${since}`), ctx(id));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "INVALID" });
    }
  });

  it("POST ops surfaces the service status: 409 for a base version ahead, 404 for unknown project", async () => {
    const { db, ops } = await setup("editor");
    const { id } = await createProject(db, { name: "P", format: "short_9x16", actor: "u1" });
    const ahead = await ops.postOps(post(`http://x/api/projects/${id}/ops`, { baseVersion: 5, ops: [addClip] }), ctx(id));
    expect(ahead.status).toBe(409);
    expect(await ahead.json()).toMatchObject({ code: "CONFLICT", currentVersion: 0 });
    const missing = await ops.postOps(post("http://x/api/projects/nope/ops", { baseVersion: 0, ops: [addClip] }), ctx("nope"));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("GET ops for an unknown project returns 404", async () => {
    const { ops } = await setup("viewer");
    const res = await ops.getSince(new Request("http://x/api/projects/nope/ops?since=0"), ctx("nope"));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "NOT_FOUND", message: expect.any(String) });
  });
});

describe("project routes", () => {
  it("a viewer cannot create a project (403); an editor can (201) and it appears in the list", async () => {
    const viewer = await setup("viewer");
    const denied = await viewer.projects.create(post("http://x/api/projects", { name: "Qual", format: "long_16x9" }));
    expect(denied.status).toBe(403);
    expect(await (await viewer.projects.list(new Request("http://x/api/projects"))).json()).toEqual({ projects: [] });

    const { projects } = await setup("editor");
    const res = await projects.create(post("http://x/api/projects", { name: "  Qual  ", format: "long_16x9" }));
    expect(res.status).toBe(201);
    const { id } = await res.json();
    expect(typeof id).toBe("string");

    const list = await (await projects.list(new Request("http://x/api/projects"))).json();
    expect(list.projects).toHaveLength(1);
    expect(list.projects[0]).toMatchObject({ id, name: "Qual", format: "long_16x9", version: 0 });

    const got = await projects.get(new Request(`http://x/api/projects/${id}`), ctx(id));
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ id, name: "Qual", format: "long_16x9", version: 0, doc: { width: 1920 } });
  });

  it("create validates name and format; get of an unknown project is 404", async () => {
    const { projects } = await setup("editor");
    for (const body of [{ name: "", format: "long_16x9" }, { name: "   ", format: "long_16x9" }, { name: "x".repeat(101), format: "long_16x9" }, { name: "ok", format: "nope" }, "{"]) {
      const res = await projects.create(post("http://x/api/projects", body));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "INVALID" });
    }
    const res = await projects.get(new Request("http://x/api/projects/nope"), ctx("nope"));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "NOT_FOUND" });
  });
});
