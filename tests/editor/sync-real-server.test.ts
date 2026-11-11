// The editor's client (api, sync and store) against the real route handlers on PGlite, so the
// rules the fake server stands in for (base versions, request ids, roles, paging by size) are
// checked against the server itself.
import { describe, expect, it, onTestFinished } from "vitest";
import type { DB } from "@/db";
import { user } from "@/db/schema";
import type { CurrentUser } from "@/lib/access-rules";
import { UNAUTHENTICATED_BODY } from "@/lib/api-errors";
import { loadRecentActivity } from "@/lib/editor/activity";
import { createProjectApi } from "@/lib/editor/api";
import { MESSAGES, explainOpError } from "@/lib/editor/messages";
import { createEditorStore, findClip } from "@/lib/editor/store";
import { createSync } from "@/lib/editor/sync";
import { makeOpsHandlers, makeProjectHandlers } from "@/lib/projects/handlers";
import { applyProjectOps, createProject, deleteProject, getProject } from "@/lib/projects/service";
import type { OpInput } from "@/lib/timeline";
import { text } from "./fixtures";
import { makeTestDb } from "../helpers/db";

const ORIGIN = "http://localhost:3000";

const ADA: CurrentUser = { id: "u1", email: "u1@gmail.com", name: "Ada", image: null, role: "editor" };
const GRACE: CurrentUser = { id: "u2", email: "u2@gmail.com", name: "Grace", image: null, role: "editor" };
const actor = (u: CurrentUser) => ({ userId: u.id, email: u.email, role: u.role });

type Wire = {
  user: CurrentUser | (() => Response); // who the server's sign-in check finds, or the answer it gives instead (built anew each time: a Response can be read once)
  origin: string; // the Origin header on writes
  requests: string[];
  loseNextPostAnswer: boolean; // the next post is applied on the server, and its answer never arrives
};

// A fetch that hands each request to the route handler Next would call for that path.
function routedFetch(db: DB, wire: Wire): typeof fetch {
  const deps = { db: () => db, auth: async () => (typeof wire.user === "function" ? wire.user() : wire.user) };
  const ops = makeOpsHandlers(deps);
  const projects = makeProjectHandlers(deps);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), ORIGIN);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    headers.set("host", new URL(ORIGIN).host);
    if (method !== "GET") headers.set("origin", wire.origin);
    const req = new Request(url, { method, headers, body: init?.body as string | undefined });
    const route = url.pathname.match(/^\/api\/projects\/([^/]+)(\/ops|\/version)?$/);
    if (!route) throw new Error(`No route for ${url.pathname}`);
    const ctx = { params: Promise.resolve({ id: decodeURIComponent(route[1]) }) };
    const path = route[2] ?? "";
    wire.requests.push(`${method} ${path || "/"}${url.search}`);
    if (path === "/ops" && method === "POST") {
      const res = await ops.postOps(req, ctx);
      if (wire.loseNextPostAnswer) {
        wire.loseNextPostAnswer = false;
        throw new TypeError("Failed to fetch");
      }
      return res;
    }
    if (path === "/ops") return ops.getSince(req, ctx);
    if (path === "/version") return projects.version(req, ctx);
    return projects.get(req, ctx);
  }) as typeof fetch;
}

// Waits on real timers: the handlers and PGlite run on their own promises.
async function until(done: () => boolean, ms = 8000) {
  const start = Date.now();
  while (!done()) {
    if (Date.now() - start > ms) throw new Error("Timed out waiting.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Ada's project at version 1: t1 holds x1 (0-60) and x2 (90-120).
async function project() {
  const db = await makeTestDb();
  await db.insert(user).values([
    { id: "u1", name: "Ada", email: "u1@gmail.com", emailVerified: true },
    { id: "u2", name: "Grace", email: "u2@gmail.com", emailVerified: true },
  ]);
  const { id } = await createProject(db, actor(ADA), { name: "P", format: "short_9x16" });
  await applyProjectOps(db, actor(ADA), {
    projectId: id,
    baseVersion: 0,
    ops: [
      { op: "add_clip", trackId: "t1", clip: text("x1", 0, 60) },
      { op: "add_clip", trackId: "t1", clip: text("x2", 90, 30) },
    ],
  });
  return { db, id, stored: async () => (await getProject(db, actor(ADA), id))! };
}

// An open editor for `who`, loaded from the stored project; `versionOffset` makes it think the
// project is further along than it is.
async function openEditor(db: DB, id: string, who: CurrentUser, wire: Partial<Wire> = {}, versionOffset = 0) {
  const w: Wire = { user: who, origin: ORIGIN, requests: [], loseNextPostAnswer: false, ...wire };
  const api = createProjectApi(id, routedFetch(db, w));
  const loaded = (await getProject(db, actor(ADA), id))!;
  const store = createEditorStore({
    projectId: id,
    name: loaded.name,
    doc: loaded.doc,
    version: loaded.version + versionOffset,
    me: { id: who.id, name: who.name },
    canEdit: who.role !== "viewer",
  });
  const sync = createSync({ store, api, isVisible: () => true });
  sync.start();
  onTestFinished(() => sync.stop());
  const posts = () => w.requests.filter((r) => r.startsWith("POST")).length;
  return { wire: w, api, store, sync, posts, st: () => store.getState() };
}

const moveX2 = (start: number): OpInput[] => [{ op: "move_clip", clipId: "x2", start }];

describe("the editor against the real server", () => {
  it("an edit lands as the next version, and the client's copy equals the stored project", async () => {
    const { db, id, stored } = await project();
    const ada = await openEditor(db, id, ADA);
    ada.st().edit(moveX2(200), "move");
    await until(() => ada.st().queue.length === 0);
    const s = await stored();
    expect(ada.st()).toMatchObject({ status: "saved", server: { version: 2 } });
    expect(s.version).toBe(2);
    expect(ada.st().server.doc).toEqual(s.doc);
    expect(ada.st().doc).toEqual(s.doc);
    expect(ada.st().activity.at(-1)).toMatchObject({ version: 2, actor: "u1", actorName: "Ada" });
  });

  it("two people's interleaved edits converge, each sees the other, and undo still works", async () => {
    const { db, id, stored } = await project();
    const ada = await openEditor(db, id, ADA);
    const grace = await openEditor(db, id, GRACE);
    ada.st().edit(moveX2(200), "move");
    grace.st().edit([{ op: "update_clip", clipId: "x1", patch: { text: "GO" } }], "text");
    ada.st().edit([{ op: "add_clip", trackId: "t1", clip: text("na", 400, 30) }], "add");
    grace.st().edit([{ op: "add_clip", trackId: "t1", clip: text("nb", 500, 30) }], "add");
    await until(() => ada.st().queue.length === 0 && grace.st().queue.length === 0);
    ada.sync.visibilityChanged(); // check for the other's edits now
    grace.sync.visibilityChanged();
    await until(() => ada.st().server.version === 5 && grace.st().server.version === 5);
    const s = await stored();
    expect(s.version).toBe(5);
    expect(ada.st().doc).toEqual(s.doc);
    expect(grace.st().doc).toEqual(s.doc);
    expect(ada.st().remote?.names).toEqual(["Grace"]);
    expect(grace.st().remote?.names).toEqual(["Ada"]);
    ada.st().undo();
    await until(() => ada.st().queue.length === 0);
    expect(findClip((await stored()).doc, "na")).toBeNull();
    expect(ada.st().notice).toBeNull();
  });

  it("an edit whose answer was lost lands once, is confirmed by the catch-up, and undoes with the server's inverse", async () => {
    const { db, id, stored } = await project();
    const ada = await openEditor(db, id, ADA, { loseNextPostAnswer: true });
    ada.st().edit([{ op: "add_clip", trackId: "t1", clip: text("n1", 400, 30) }], "add");
    await until(() => ada.st().status === "offline");
    ada.sync.retryNow();
    await until(() => ada.st().queue.length === 0 && ada.st().status === "saved");
    expect(ada.wire.requests).toEqual(["POST /ops", "GET /ops?since=1&limit=500"]);
    const s = await stored();
    expect(s.version).toBe(2);
    expect(ada.st().doc).toEqual(s.doc);
    ada.st().undo();
    await until(() => ada.st().queue.length === 0);
    expect(findClip((await stored()).doc, "n1")).toBeNull();
  });

  it("a repeated request id gets the first answer back, even on an older base; someone else's use of it is refused", async () => {
    const { db, id } = await project();
    const ada = await openEditor(db, id, ADA);
    ada.sync.stop();
    const ops = [{ op: "add_clip", trackId: "t1", clip: text("n1", 400, 30) }] as never;
    const first = await ada.api.postOps({ baseVersion: 1, ops, requestId: "req-00000001" });
    await applyProjectOps(db, actor(GRACE), { projectId: id, baseVersion: 2, ops: moveX2(300) });
    expect(first).toMatchObject({ ok: true, version: 2 });
    expect(await ada.api.postOps({ baseVersion: 1, ops, requestId: "req-00000001" })).toEqual(first);
    const grace = await openEditor(db, id, GRACE);
    grace.sync.stop();
    expect(await grace.api.postOps({ baseVersion: 3, ops: moveX2(310) as never, requestId: "req-00000001" })).toMatchObject({
      ok: false,
      kind: "op",
      code: "INVALID",
    });
  });

  it("an undo the server refuses as stale keeps the other person's change", async () => {
    const { db, id, stored } = await project();
    const ada = await openEditor(db, id, ADA);
    ada.st().edit(moveX2(200), "move");
    await until(() => ada.st().queue.length === 0);
    // Grace moves the same clip before Ada's editor has looked again.
    await applyProjectOps(db, actor(GRACE), { projectId: id, baseVersion: 2, ops: moveX2(300) });
    ada.st().undo();
    await until(() => ada.st().queue.length === 0 && ada.st().server.version === 3);
    expect(ada.st().notice?.text).toBe(MESSAGES.undoRefused);
    expect(findClip(ada.st().doc, "x2")!.clip.start).toBe(300);
    expect((await stored()).version).toBe(3);
    expect([ada.st().undoStack, ada.st().redoStack]).toEqual([[], []]);
  });

  it("a client that is ahead of the server gets a 409, tries three times, then gives the edit up", async () => {
    const { db, id, stored } = await project();
    const ada = await openEditor(db, id, ADA, {}, 5);
    ada.st().edit(moveX2(200), "move");
    await until(() => ada.st().queue.length === 0);
    expect(ada.posts()).toBe(3);
    expect(ada.st().notice?.text).toBe(explainOpError("INVALID"));
    expect(findClip(ada.st().doc, "x2")!.clip.start).toBe(90);
    expect((await stored()).version).toBe(1);
  });

  it("a viewer reads everything and never writes; an editor whose role drops mid-session gets a 403 and loses editing", async () => {
    const { db, id } = await project();
    const viewer = await openEditor(db, id, { ...GRACE, role: "viewer" });
    expect(await viewer.api.getVersion()).toEqual({ ok: true, version: 1 });
    expect(await viewer.api.getOpsSince(0)).toMatchObject({ ok: true, version: 1, hasMore: false });
    expect(await viewer.api.getProject()).toMatchObject({ ok: true, version: 1, name: "P" });
    expect(viewer.st().edit(moveX2(200), "move")).toMatchObject({ ok: false, code: "READ_ONLY" });
    expect(viewer.posts()).toBe(0);

    const ada = await openEditor(db, id, ADA);
    ada.wire.user = { ...ADA, role: "viewer" };
    ada.st().edit(moveX2(200), "move");
    await until(() => !ada.st().canEdit);
    expect(ada.st().queue).toEqual([]);
    expect(ada.st().notice?.text).toBe(MESSAGES.lostAccess);
    expect(findClip(ada.st().doc, "x2")!.clip.start).toBe(90);
  });

  it("signed out: one notice, and the queue lands once the person is signed in again and comes back to the tab", async () => {
    const { db, id, stored } = await project();
    const ada = await openEditor(db, id, ADA);
    let denied = 0;
    ada.wire.user = () => {
      denied += 1;
      return Response.json(UNAUTHENTICATED_BODY, { status: 401 });
    };
    ada.st().edit(moveX2(200), "move");
    await until(() => ada.st().status === "signed-out");
    expect(ada.st().notice?.text).toBe(MESSAGES.signedOut);
    const notice = ada.st().notice;
    ada.st().edit(moveX2(210), "move"); // editing goes on
    // Coming back to the tab while still signed out asks the server again and is refused again.
    const before = denied;
    ada.sync.visibilityChanged();
    await until(() => denied > before);
    expect(ada.st().queue).toHaveLength(2);
    ada.wire.user = ADA; // signed in again in another tab
    // Showing the tab is ignored while a request is in flight, so keep showing it until the queue is sent.
    await until(() => {
      if (ada.st().queue.length === 0) return true;
      ada.sync.visibilityChanged();
      return false;
    });
    // The same notice object: the second refusal showed no second notice.
    expect(ada.st()).toMatchObject({ status: "saved", notice, server: { version: 3 } });
    expect(findClip((await stored()).doc, "x2")!.clip.start).toBe(210);
  });

  it("a deleted project answers 404 and the editor says so for good", async () => {
    const { db, id } = await project();
    const ada = await openEditor(db, id, ADA);
    await deleteProject(db, actor(ADA), id);
    ada.st().edit(moveX2(200), "move");
    await until(() => ada.st().status === "deleted");
    ada.sync.visibilityChanged();
    ada.sync.retryNow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ada.wire.requests).toEqual(["POST /ops"]);
  });

  it("a write from another origin is refused with 403, and the editor reads it as lost access", async () => {
    const { db, id, stored } = await project();
    const ada = await openEditor(db, id, ADA, { origin: "https://elsewhere.example" });
    ada.st().edit(moveX2(200), "move");
    await until(() => !ada.st().canEdit);
    expect(ada.st()).toMatchObject({ queue: [], notice: { text: MESSAGES.lostAccess } });
    expect((await stored()).version).toBe(1);
  });

  it("a gap whose first page is cut short by size is caught up completely, by the sync and by the activity list", async () => {
    const { db, id, stored } = await project();
    const ada = await openEditor(db, id, ADA);
    ada.sync.stop();
    // Four pairs of large entries (200 clips of 2,000 characters, then their removal), then a move.
    const added = (n: number) =>
      Array.from({ length: 200 }, (_, i) => ({ op: "add_clip", trackId: "t1", clip: text(`b${n}_${i}`, 1000 + i * 10, 10, { text: "x".repeat(2000) }) })) as OpInput[];
    const removed = (n: number) => Array.from({ length: 200 }, (_, i) => ({ op: "remove_clip", clipId: `b${n}_${i}` })) as OpInput[];
    let base = 1;
    for (let n = 0; n < 4; n++) {
      await applyProjectOps(db, actor(GRACE), { projectId: id, baseVersion: base++, ops: added(n) });
      await applyProjectOps(db, actor(GRACE), { projectId: id, baseVersion: base++, ops: removed(n) });
    }
    await applyProjectOps(db, actor(GRACE), { projectId: id, baseVersion: base++, ops: moveX2(300) });
    expect(await ada.api.getOpsSince(1, 500)).toMatchObject({ ok: true, version: 5, hasMore: true, entries: { length: 4 } });

    ada.wire.requests.length = 0;
    ada.sync.start();
    ada.sync.visibilityChanged();
    const s = await stored();
    await until(() => ada.st().server.version === s.version, 15_000);
    expect(ada.st().doc).toEqual(s.doc);
    expect(ada.wire.requests.filter((r) => r.startsWith("GET /ops"))).toEqual(["GET /ops?since=1&limit=500", "GET /ops?since=5&limit=500"]);
    expect(await loadRecentActivity(ada.api, ada.store)).toBe(true);
    expect(ada.st().activity.map((e) => e.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  }, 60_000);
});
