import { describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/access-rules";
import { makeOpsHandlers, makeProjectHandlers } from "@/lib/projects/handlers";
import { applyProjectOps, createProject } from "@/lib/projects/service";
import { DEFAULT_TRANSFORM, type OpInput } from "@/lib/timeline";
import { user } from "@/db/schema";
import { makeTestDb } from "../helpers/db";

function userWith(role: CurrentUser["role"]): CurrentUser {
  return { id: "u1", email: "u1@gmail.com", name: "U1", image: null, role };
}

async function setup(role: CurrentUser["role"]) {
  const db = await makeTestDb();
  const auth = vi.fn<(req: Request) => Promise<CurrentUser>>(async () => userWith(role));
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
const addClip = { op: "add_clip", trackId: "t1", clip: textClip } as OpInput;

describe("ops routes", () => {
  it("viewer cannot POST ops (403)", async () => {
    const { db, ops, auth } = await setup("viewer");
    const { id } = await createProject(db, { userId: "u1", email: "u1@gmail.com", role: "editor" }, { name: "P", format: "short_9x16" });
    const res = await ops.postOps(post(`http://x/api/projects/${id}/ops`, { baseVersion: 0, ops: [addClip] }), ctx(id));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: "FORBIDDEN", message: "Your role doesn't allow this." });
    expect(auth).toHaveBeenCalledWith(expect.any(Request));
    const since = await ops.getSince(new Request(`http://x/api/projects/${id}/ops?since=0`), ctx(id));
    expect(await since.json()).toEqual({ version: 0, entries: [], hasMore: false });
  });

  it("POST ops returns 200 with new version; GET since=0 returns the entry", async () => {
    const { db, ops } = await setup("editor");
    const { id } = await createProject(db, { userId: "u1", email: "u1@gmail.com", role: "editor" }, { name: "P", format: "short_9x16" });
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
    const { id } = await createProject(db, { userId: "u1", email: "u1@gmail.com", role: "editor" }, { name: "P", format: "short_9x16" });
    for (const body of [{ baseVersion: 0, ops: "x" }, { baseVersion: -1, ops: [addClip] }, { baseVersion: 0, ops: [] }, "not json"]) {
      const res = await ops.postOps(post(`http://x/api/projects/${id}/ops`, body), ctx(id));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "INVALID", message: expect.any(String) });
    }
  });

  it("GET ops rejects a bad since with 400 INVALID", async () => {
    const { db, ops } = await setup("viewer");
    const { id } = await createProject(db, { userId: "u1", email: "u1@gmail.com", role: "editor" }, { name: "P", format: "short_9x16" });
    for (const since of ["-1", "1.5", "abc", "", "2147483648", "99999999999"]) {
      const res = await ops.getSince(new Request(`http://x/api/projects/${id}/ops?since=${since}`), ctx(id));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "INVALID" });
    }
    const top = await ops.getSince(new Request(`http://x/api/projects/${id}/ops?since=2147483647`), ctx(id));
    expect(top.status).toBe(200);
  });

  it("POST ops with text Postgres cannot store answers 400 INVALID, not 500", async () => {
    const { db, ops } = await setup("editor");
    const { id } = await createProject(db, { userId: "u1", email: "u1@gmail.com", role: "editor" }, { name: "P", format: "short_9x16" });
    for (const body of [
      `{"baseVersion":0,"ops":[{"op":"add_clip","trackId":"t1","clip":${JSON.stringify({ ...textClip, text: "x" }).replace('"x"', '"a\\u0000b"')}}]}`,
      `{"baseVersion":0,"ops":[{"op":"add_track","track":{"kind":"overlay","name":"a\\ud800"}}]}`,
    ]) {
      const res = await ops.postOps(post(`http://x/api/projects/${id}/ops`, body), ctx(id));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "INVALID", opIndex: 0 });
    }
  });

  it("POST ops surfaces the service status: 409 for a base version ahead, 404 for unknown project", async () => {
    const { db, ops } = await setup("editor");
    const { id } = await createProject(db, { userId: "u1", email: "u1@gmail.com", role: "editor" }, { name: "P", format: "short_9x16" });
    const ahead = await ops.postOps(post(`http://x/api/projects/${id}/ops`, { baseVersion: 5, ops: [addClip] }), ctx(id));
    expect(ahead.status).toBe(409);
    expect(await ahead.json()).toMatchObject({ code: "CONFLICT", currentVersion: 0 });
    const missing = await ops.postOps(post("http://x/api/projects/nope/ops", { baseVersion: 0, ops: [addClip] }), ctx("nope"));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("POST ops returns the inverse; GET since returns inverse and createdAt; strict is checked", async () => {
    const { db, ops } = await setup("editor");
    const { id } = await createProject(db, { userId: "u1", email: "u1@gmail.com", role: "editor" }, { name: "P", format: "short_9x16" });
    const res = await ops.postOps(post(`http://x/api/projects/${id}/ops`, { baseVersion: 0, ops: [addClip] }), ctx(id));
    expect(await res.json()).toEqual({ version: 1, ops: [addClip], inverse: [{ op: "remove_clip", clipId: "c1" }] });
    const since = await (await ops.getSince(new Request(`http://x/api/projects/${id}/ops?since=0`), ctx(id))).json();
    expect(since.entries[0]).toEqual({ version: 1, ops: [addClip], inverse: [{ op: "remove_clip", clipId: "c1" }], actor: "u1", actorName: "Someone",
      requestId: null, createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) });
    const stale = await ops.postOps(post(`http://x/api/projects/${id}/ops`, { baseVersion: 0, strict: true, ops: [{ op: "remove_clip", clipId: "c1" }] }), ctx(id));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "CONFLICT", currentVersion: 1 });
    const bad = await ops.postOps(post(`http://x/api/projects/${id}/ops`, { baseVersion: 1, strict: "yes", ops: [addClip] }), ctx(id));
    expect(bad.status).toBe(400);
  });

  it("GET ops names who made each change", async () => {
    const { db, ops } = await setup("viewer");
    await db.insert(user).values([{ id: "u1", name: "Ada Lovelace", email: "ada@gmail.com", emailVerified: true }]);
    const editor = { userId: "u1", email: "u1@gmail.com", role: "editor" as const };
    const { id } = await createProject(db, editor, { name: "P", format: "short_9x16" });
    const retext = (text: string) => [{ op: "update_clip" as const, clipId: "c1", patch: { text } }];
    await applyProjectOps(db, editor, { projectId: id, baseVersion: 0, ops: [addClip] });
    await applyProjectOps(db, { ...editor, userId: "claude:u1" }, { projectId: id, baseVersion: 1, ops: retext("GO") });
    await applyProjectOps(db, { ...editor, userId: "u9" }, { projectId: id, baseVersion: 2, ops: retext("GO!") });
    const page = await (await ops.getSince(new Request(`http://x/api/projects/${id}/ops?since=0`), ctx(id))).json();
    expect(page.entries.map((e: { actorName: string }) => e.actorName)).toEqual(["Ada Lovelace", "Claude (for Ada Lovelace)", "Someone"]);
  });

  it("POST ops takes a requestId: a repeat answers the same body, a malformed one is 400 INVALID", async () => {
    const { db, ops } = await setup("editor");
    const { id } = await createProject(db, { userId: "u1", email: "u1@gmail.com", role: "editor" }, { name: "P", format: "short_9x16" });
    const send = (requestId: unknown) => ops.postOps(post(`http://x/api/projects/${id}/ops`, { baseVersion: 0, ops: [addClip], requestId }), ctx(id));
    const first = await send("retry-0001");
    expect(first.status).toBe(200);
    const body = await first.json();
    const again = await send("retry-0001");
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(body);
    for (const bad of ["short", "has space!", "x".repeat(65), 12345678, null]) {
      const res = await send(bad);
      expect(res.status, String(bad)).toBe(400);
      expect(await res.json()).toMatchObject({ code: "INVALID" });
    }
    const since = await (await ops.getSince(new Request(`http://x/api/projects/${id}/ops?since=0`), ctx(id))).json();
    expect(since.entries.map((e: { requestId: unknown }) => e.requestId)).toEqual(["retry-0001"]);
  });

  it("a stored inverse sent back after a later conflicting edit answers 400 STALE with the op index", async () => {
    const { db, ops } = await setup("editor");
    const { id } = await createProject(db, { userId: "u1", email: "u1@gmail.com", role: "editor" }, { name: "P", format: "short_9x16" });
    const send = (baseVersion: number, body: unknown[]) => ops.postOps(post(`http://x/api/projects/${id}/ops`, { baseVersion, ops: body }), ctx(id));
    await send(0, [addClip]);
    await send(1, [{ op: "move_clip", clipId: "c1", start: 100 }]);
    await send(2, [{ op: "move_clip", clipId: "c1", start: 200 }]);
    const log = await (await ops.getSince(new Request(`http://x/api/projects/${id}/ops?since=1`), ctx(id))).json();
    const res = await send(3, log.entries[0].inverse);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: "STALE", message: 'move_clip: clip "c1" changed since this edit', opIndex: 0 });
  });

  it("POST ops with 501 ops answers 400 LIMIT_EXCEEDED; 500 are accepted", async () => {
    const { db, ops } = await setup("editor");
    const { id } = await createProject(db, { userId: "u1", email: "u1@gmail.com", role: "editor" }, { name: "P", format: "short_9x16" });
    const renames = (n: number) => Array.from({ length: n }, (_, i) => ({ op: "update_track", trackId: "v1", patch: { name: `V${i}` } }));
    const tooMany = await ops.postOps(post(`http://x/api/projects/${id}/ops`, { baseVersion: 0, ops: renames(501) }), ctx(id));
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toEqual({ code: "LIMIT_EXCEEDED", message: "At most 500 ops per request" });
    const ok = await ops.postOps(post(`http://x/api/projects/${id}/ops`, { baseVersion: 0, ops: renames(500) }), ctx(id));
    expect(ok.status).toBe(200);
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
    expect(await denied.json()).toEqual({ code: "FORBIDDEN", message: "Your role doesn't allow this." });
    expect(viewer.auth).toHaveBeenCalledWith(expect.any(Request));
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

  it("POST ops reports the index of the op that failed", async () => {
    const { db, ops } = await setup("editor");
    const { id } = await createProject(db, { userId: "u1", email: "u1@gmail.com", role: "editor" }, { name: "P", format: "short_9x16" });
    const res = await ops.postOps(
      post(`http://x/api/projects/${id}/ops`, { baseVersion: 0, ops: [addClip, { op: "move_clip", clipId: "ghost", start: 10 }] }),
      ctx(id),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "NOT_FOUND", opIndex: 1, message: expect.any(String) });
  });

  it("a viewer can read a project", async () => {
    const { db, projects } = await setup("viewer");
    const { id } = await createProject(db, { userId: "u1", email: "u1@gmail.com", role: "editor" }, { name: "P", format: "short_9x16" });
    const res = await projects.get(new Request(`http://x/api/projects/${id}`), ctx(id));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, name: "P", version: 0 });
  });

  it("GET version answers { version }, 404 when unknown; GET ops validates limit and reports hasMore", async () => {
    const { db, ops, projects } = await setup("viewer");
    const { id } = await createProject(db, { userId: "u1", email: "u1@gmail.com", role: "editor" }, { name: "P", format: "short_9x16" });
    await applyProjectOps(db, { userId: "u1", email: "u1@gmail.com", role: "editor" }, { projectId: id, baseVersion: 0, ops: [addClip] });
    expect(await (await projects.version(new Request(`http://x/api/projects/${id}/version`), ctx(id))).json()).toEqual({ version: 1 });
    expect((await projects.version(new Request("http://x/api/projects/nope/version"), ctx("nope"))).status).toBe(404);
    for (const limit of ["0", "501", "x", "1.5"]) {
      const res = await ops.getSince(new Request(`http://x/api/projects/${id}/ops?since=0&limit=${limit}`), ctx(id));
      expect(res.status, limit).toBe(400);
    }
    const page = await (await ops.getSince(new Request(`http://x/api/projects/${id}/ops?since=0&limit=500`), ctx(id))).json();
    expect(page).toMatchObject({ version: 1, hasMore: false });
  });

  it("PATCH renames, POST duplicate copies, DELETE removes; a foreign Origin is refused", async () => {
    const { db, projects } = await setup("editor");
    const { id } = await createProject(db, { userId: "u1", email: "u1@gmail.com", role: "editor" }, { name: "P", format: "short_9x16" });
    const send = (method: string, url: string, body?: unknown, origin?: string) =>
      new Request(url, { method, headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

    const renamed = await projects.rename(send("PATCH", `http://x/api/projects/${id}`, { name: "Finals" }), ctx(id));
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual({ id, name: "Finals" });
    expect((await projects.rename(send("PATCH", `http://x/api/projects/${id}`, {}), ctx(id))).status).toBe(400);

    const dup = await projects.duplicate(send("POST", `http://x/api/projects/${id}/duplicate`), ctx(id));
    expect(dup.status).toBe(201);
    const { id: copyId } = await dup.json();
    expect(await (await projects.get(new Request(`http://x/api/projects/${copyId}`), ctx(copyId))).json()).toMatchObject({ name: "Finals copy", version: 0 });

    const foreign = await projects.remove(send("DELETE", `http://x/api/projects/${id}`, undefined, "https://evil.example"), ctx(id));
    expect(foreign.status).toBe(403);
    const foreignRename = await projects.rename(send("PATCH", `http://x/api/projects/${id}`, { name: "Evil" }, "https://evil.example"), ctx(id));
    expect(foreignRename.status).toBe(403);
    expect(await foreignRename.json()).toMatchObject({ code: "FORBIDDEN" });
    const foreignCopy = await projects.duplicate(send("POST", `http://x/api/projects/${id}/duplicate`, undefined, "https://evil.example"), ctx(id));
    expect(foreignCopy.status).toBe(403);
    expect(await foreignCopy.json()).toMatchObject({ code: "FORBIDDEN" });
    expect((await (await projects.list(new Request("http://x/api/projects"))).json()).projects.map((p: { name: string }) => p.name).sort())
      .toEqual(["Finals", "Finals copy"]);
    const removed = await projects.remove(send("DELETE", `http://x/api/projects/${id}`), ctx(id));
    expect(removed.status).toBe(204);
    expect(await removed.text()).toBe("");
    expect((await projects.get(new Request(`http://x/api/projects/${id}`), ctx(id))).status).toBe(404);
  });
});
