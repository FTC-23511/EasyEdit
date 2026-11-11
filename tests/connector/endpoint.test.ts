import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rowsOf, type DB } from "@/db";
import * as route from "@/app/api/mcp/route";
import { requireUserApi } from "@/lib/access";
import { removeEntry, setRole } from "@/lib/allowlist/service";
import { revokeAccess } from "@/lib/connector/grants";
import { UNEXPECTED } from "@/lib/mcp/errors";
import { createProject } from "@/lib/projects/service";
import { BASE_URL, claimsOf, startConnectorApp, type ConnectorApp } from "../helpers/connector";

let testDb: DB;
vi.mock("@/db", async (original) => ({ ...(await original<typeof import("@/db")>()), getDb: () => testDb }));

let app: ConnectorApp;
beforeAll(async () => {
  app = await startConnectorApp();
  testDb = app.db;
});
afterAll(() => app.stop());

const LIST = { name: "list_projects", arguments: {} };
const CHALLENGE = `resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource/api/mcp"`;

describe("POST /api/mcp", () => {
  it("lets a connected member's Claude list tools and call one", async () => {
    const c = await app.connect("ada@gmail.com");
    const client = await app.mcpClient(c.accessToken);
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toContain("list_projects");
    } finally {
      await client.close();
    }
    const r = await app.callTool(c.accessToken, "list_projects");
    expect(r.isError).toBe(false);
    expect(r.text.split("\n")[0]).toBe("Signed in as Ada (editor). You can read and change projects.");
  });

  it("answers no token, a made-up token and a token without the resource with 401 and where to sign in", async () => {
    const loose = await app.connect("grace@gmail.com", "editor", { resource: null });
    for (const token of [null, "not-a-token", loose.accessToken]) {
      const res = await app.rpc(token, "tools/list");
      expect(res.status, String(token)).toBe(401);
      expect(res.headers.get("www-authenticate"), String(token)).toContain(CHALLENGE);
    }
  });

  it("accepts only a token this app signed for this endpoint", async () => {
    const c = await app.connect("barbara@gmail.com");
    const claims = claimsOf(c.accessToken);
    const auth = (await import("@/lib/auth")).getAuth();
    const signed = async (over: Record<string, unknown>) => (await auth.api.signJWT({ body: { payload: { ...claims, ...over } } })).token;
    expect((await app.rpc(await signed({}), "tools/list")).status).toBe(200);

    const [head, , signature] = c.accessToken.split(".");
    const altered = [head, Buffer.from(JSON.stringify({ ...claims, sub: "someone-else" })).toString("base64url"), signature].join(".");
    const refused: [string, string][] = [
      ["another issuer", await signed({ iss: "https://evil.example" })],
      ["another audience", await signed({ aud: `${BASE_URL}/api/other` })],
      ["a client as the audience", await signed({ aud: claims.azp })],
      ["no client", await signed({ azp: undefined, client_id: undefined })],
      ["changed after signing", altered],
    ];
    for (const [what, token] of refused) {
      const res = await app.rpc(token, "tools/list");
      expect(res.status, what).toBe(401);
      expect(res.headers.get("www-authenticate"), what).toContain(CHALLENGE);
    }
  });

  it("refuses an expired token", async () => {
    const c = await app.connect("linus@gmail.com");
    expect((await app.rpc(c.accessToken, "tools/call", LIST)).status).toBe(200);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 61 * 60 * 1000);
      expect((await app.rpc(c.accessToken, "tools/call", LIST)).status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never reads the session cookie, and has no cross-origin rule for token calls", async () => {
    const c = await app.connect("margaret@gmail.com");
    expect((await app.rpc(null, "tools/list", {}, { cookie: c.cookie })).status).toBe(401);
    expect((await app.rpc(c.accessToken, "tools/call", LIST, { origin: "https://claude.ai" })).status).toBe(200);
  });

  it("the website's API does not accept the connector's token", async () => {
    const c = await app.connect("katherine@gmail.com");
    const res = await requireUserApi(new Request(`${BASE_URL}/api/projects`, { headers: { authorization: `Bearer ${c.accessToken}` } }), "viewer");
    expect((res as Response).status).toBe(401);
  });

  it("removal and a role change take effect on the next call", async () => {
    const c = await app.connect("dorothy@gmail.com");
    await setRole(app.db, "dorothy@gmail.com", "viewer");
    expect((await app.callTool(c.accessToken, "list_projects")).text).toContain("(viewer). You can read projects but not change them.");

    await removeEntry(app.db, "dorothy@gmail.com");
    const res = await app.rpc(c.accessToken, "tools/call", LIST);
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(await res.json()).toMatchObject({ error: { message: "This Google account isn't on the Seattle Solvers allowlist. Ask an admin to add you." } });
  });

  it("a disconnected member is asked to sign in again, and connecting again works", async () => {
    const c = await app.connect("joan@gmail.com");
    await revokeAccess(app.db, { userId: c.userId }, { sessions: false });
    const res = await app.rpc(c.accessToken, "tools/call", LIST);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect((await app.callTool((await app.connect("joan@gmail.com")).accessToken, "list_projects")).isError).toBe(false);
  });

  // In production every member reaches the endpoint through Claude's one shared client.
  it("disconnecting one member of a shared client leaves the other connected, as themselves", async () => {
    const ended = await app.connect("hedy@gmail.com");
    const stays = await app.connect("annie@gmail.com", "editor", { clientId: ended.clientId });
    expect(claimsOf(ended.accessToken).azp).toBe(ended.clientId);
    expect(claimsOf(stays.accessToken).azp).toBe(ended.clientId);
    const grants = rowsOf<{ user_id: string; client_id: string }>(
      await app.db.execute(sql`select user_id, client_id from oauth_consent where user_id in (${ended.userId}, ${stays.userId})`),
    );
    expect(grants.map((g) => g.client_id)).toEqual([ended.clientId, ended.clientId]);
    await createProject(app.db, { userId: stays.userId, email: "annie@gmail.com", role: "editor" }, { name: "Shared client", format: "short_9x16" });

    await revokeAccess(app.db, { userId: ended.userId }, { sessions: false });

    const refused = await app.rpc(ended.accessToken, "tools/call", LIST);
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toContain('error="invalid_token"');
    const r = await app.callTool(stays.accessToken, "list_projects");
    expect(r.isError).toBe(false);
    expect(r.text.split("\n")[0]).toBe("Signed in as Annie (editor). You can read and change projects.");
    expect(r.text).toMatch(/ {2}"Shared client" {2}Short 9:16 {2}version 0 {2}changed just now by Annie$/m);
  });

  it("exports only POST, with a time limit", () => {
    expect(Object.keys(route).sort()).toEqual(["POST", "maxDuration"]);
    expect(route.maxDuration).toBe(30);
  });

  it("an unexpected failure tells the caller nothing about the server", async () => {
    const c = await app.connect("frances@gmail.com");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const services = await import("@/lib/projects/service");
    const broken = vi.spyOn(services, "listProjects").mockRejectedValueOnce(new Error("password=hunter2 at 10.0.0.5"));
    try {
      const r = await app.callTool(c.accessToken, "list_projects");
      expect(r).toEqual({ isError: true, text: UNEXPECTED });
      expect(logged).toHaveBeenCalledWith("Connector tool failed", "list_projects", expect.any(Error));
    } finally {
      broken.mockRestore();
      logged.mockRestore();
    }
  });
});
