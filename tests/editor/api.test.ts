import { describe, expect, it, vi } from "vitest";
import { createProjectApi } from "@/lib/editor/api";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function apiWith(respond: (url: string) => Response) {
  const fetchFn = vi.fn<typeof fetch>(async (url) => respond(String(url)));
  return { api: createProjectApi("p1", fetchFn), fetchFn };
}

describe("project api", () => {
  it("posts ops as JSON and returns the version and the inverse", async () => {
    const { api, fetchFn } = apiWith(() => json(200, { version: 6, ops: [], inverse: [{ op: "remove_clip", clipId: "n1" }] }));
    expect(await api.postOps({ baseVersion: 5, ops: [{ op: "remove_clip", clipId: "x1" }] }))
      .toEqual({ ok: true, version: 6, inverse: [{ op: "remove_clip", clipId: "n1" }] });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("/api/projects/p1/ops");
    expect(init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });
    expect(JSON.parse(String(init!.body))).toEqual({ baseVersion: 5, ops: [{ op: "remove_clip", clipId: "x1" }] });
  });

  it("puts the request id in the body when one is given", async () => {
    const { api, fetchFn } = apiWith(() => json(200, { version: 6, ops: [], inverse: [] }));
    await api.postOps({ baseVersion: 5, ops: [{ op: "remove_clip", clipId: "x1" }], requestId: "edit_0001" });
    expect(JSON.parse(String(fetchFn.mock.calls[0][1]!.body))).toEqual({
      baseVersion: 5,
      ops: [{ op: "remove_clip", clipId: "x1" }],
      requestId: "edit_0001",
    });
  });

  it("builds the read URLs", async () => {
    const { api, fetchFn } = apiWith((url) => json(200, url.includes("/ops") ? { version: 5, entries: [], hasMore: false } : { version: 5, doc: {}, name: "P" }));
    await api.getVersion();
    await api.getOpsSince(5, 500);
    await api.getProject();
    expect(fetchFn.mock.calls.map((call) => call[0])).toEqual(["/api/projects/p1/version", "/api/projects/p1/ops?since=5&limit=500", "/api/projects/p1"]);
  });

  it.each([
    [400, { code: "OVERLAP", message: "m", opIndex: 0 }, { ok: false, kind: "op", code: "OVERLAP", message: "m", opIndex: 0 }],
    [409, { code: "CONFLICT", message: "m", currentVersion: 9 }, { ok: false, kind: "conflict", currentVersion: 9 }],
    [401, { code: "UNAUTHENTICATED", message: "m" }, { ok: false, kind: "signed-out" }],
    [403, { code: "FORBIDDEN", message: "m" }, { ok: false, kind: "forbidden" }],
    [404, { code: "NOT_FOUND", message: "m" }, { ok: false, kind: "not-found" }],
    [500, { code: "INTERNAL", message: "m" }, { ok: false, kind: "network" }],
  ])("maps status %i to a typed failure", async (status, body, expected) => {
    expect(await apiWith(() => json(status, body)).api.postOps({ baseVersion: 5, ops: [] })).toEqual(expected);
  });

  it.each([
    ["a 404 page from the host", 404, null],
    ["a 404 with another code", 404, { code: "ROUTE_MISSING", message: "m" }],
    ["a 401 page from the host", 401, null],
    ["a 401 with another code", 401, { code: "NOT_FOUND", message: "m" }],
  ])("reads %s as a network failure, since only the server's own code means signed out or deleted", async (_name, status, body) => {
    const answer = () =>
      body === null ? new Response("<html>Not here</html>", { status, headers: { "content-type": "text/html" } }) : json(status, body);
    await expect(apiWith(answer).api.getVersion()).resolves.toEqual({ ok: false, kind: "network" });
    await expect(apiWith(answer).api.postOps({ baseVersion: 5, ops: [] })).resolves.toEqual({ ok: false, kind: "network" });
  });

  it("treats a thrown fetch and a non-JSON answer as a network failure", async () => {
    expect(await apiWith(() => { throw new TypeError("Failed to fetch"); }).api.getVersion()).toEqual({ ok: false, kind: "network" });
    expect(await apiWith(() => new Response("<html>", { status: 200 })).api.getVersion()).toEqual({ ok: false, kind: "network" });
  });

  it("treats an error answer whose body is not JSON as a network failure", async () => {
    const html = () => new Response("<html>Bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } });
    await expect(apiWith(html).api.postOps({ baseVersion: 5, ops: [] })).resolves.toEqual({ ok: false, kind: "network" });
    await expect(apiWith(html).api.getOpsSince(5)).resolves.toEqual({ ok: false, kind: "network" });
  });
});
