import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rowsOf, type DB } from "@/db";
import { isClaudeClientDocument, isClaudeRedirect } from "@/lib/connector/auth-rules";
import { BASE_URL, CLAUDE_CALLBACK, startConnectorApp, type ConnectorApp } from "../helpers/connector";

let testDb: DB;
vi.mock("@/db", async (original) => ({ ...(await original<typeof import("@/db")>()), getDb: () => testDb }));

// The metadata-document plugin fetches through this transport. Tests never touch the network.
const documents = vi.hoisted(() => ({ served: new Map<string, unknown>(), asked: [] as string[] }));
vi.mock("@better-auth/cimd/node", () => ({
  fetchClientMetadataResource: async (input: RequestInfo | URL) => {
    const url = new Request(input).url;
    documents.asked.push(url);
    const doc = documents.served.get(url);
    if (doc === undefined) throw new TypeError(`no document at ${url}`);
    return Response.json(doc, { headers: { "cache-control": "max-age=60" } });
  },
}));

let app: ConnectorApp;
beforeAll(async () => {
  app = await startConnectorApp();
  testDb = app.db;
});
afterAll(() => app.stop());

const clientRows = async () =>
  rowsOf<{ n: number }>(await app.db.execute(sql`select count(*)::int as n from oauth_client`))[0].n;

describe("address checks", () => {
  it("knows Claude's callback addresses exactly", () => {
    expect(isClaudeRedirect("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isClaudeRedirect("https://claude.com/api/mcp/auth_callback")).toBe(true);
    for (const uri of [
      "https://claude.ai/api/mcp/auth_callback/", "https://claude.ai/api/mcp/auth_callback?x=1", "http://claude.ai/api/mcp/auth_callback",
      "https://claude.ai.evil.example/api/mcp/auth_callback", "https://evil.example/api/mcp/auth_callback", "http://localhost:6274/oauth/callback",
    ]) expect(isClaudeRedirect(uri), uri).toBe(false);
  });

  it("accepts metadata documents only from Claude's hosts", () => {
    expect(isClaudeClientDocument("https://claude.ai/oauth/client.json")).toBe(true);
    expect(isClaudeClientDocument("https://CLAUDE.com/x")).toBe(true);
    for (const url of [
      "http://claude.ai/x", "https://claude.ai:8443/x", "https://claude.ai@evil.example/x", "https://claude.ai.evil.example/x",
      "https://sub.claude.ai/x", "https://evil.example/claude.ai", "not a url",
    ]) expect(isClaudeClientDocument(url), url).toBe(false);
  });
});

describe("what the sign-in server refuses", () => {
  it("1. refuses to register an app with any address that is not Claude's", async () => {
    const before = await clientRows();
    for (const redirectUris of [["https://evil.example/callback"], [CLAUDE_CALLBACK, "https://evil.example/callback"]]) {
      const res = await app.register({ redirectUris });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_redirect_uri");
    }
    expect(await clientRows()).toBe(before);
    expect((await app.register()).ok).toBe(true);
    expect(await clientRows()).toBe(before + 1);
  });

  it("2. stops registering apps at the cap", async () => {
    await app.db.execute(sql`
      insert into oauth_client (id, client_id, redirect_uris, created_at)
      select 'cap-' || n, 'cap-' || n, array['https://claude.ai/api/mcp/auth_callback'], now() from generate_series(1, 500) n`);
    try {
      const res = await app.register();
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe("temporarily_unavailable");
    } finally {
      await app.db.execute(sql`delete from oauth_client where id like 'cap-%'`);
    }
    expect((await app.register()).ok).toBe(true);
  });

  it("3. never sends a member to another address, even for an app row that lists one", async () => {
    await app.db.execute(sql`
      insert into oauth_client (id, client_id, redirect_uris, token_endpoint_auth_method, grant_types, response_types, created_at)
      values ('evil', 'evil', array['https://evil.example/callback'], 'none', array['authorization_code'], array['code'], now())`);
    const { cookie } = await app.signIn("ada@gmail.com");
    const to = await app.authorize({ clientId: "evil", cookie, redirectUri: "https://evil.example/callback" });
    expect(`${to.origin}${to.pathname}`).toBe(`${BASE_URL}/api/auth/error`);
    expect(to.searchParams.get("error")).toBe("invalid_redirect");
  });

  it("4. fetches no metadata document from another host", async () => {
    const elsewhere = "https://evil.example/client.json";
    documents.served.set(elsewhere, {
      client_id: elsewhere, client_name: "Claude", redirect_uris: [CLAUDE_CALLBACK],
      token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"],
    });
    const { cookie } = await app.signIn("grace@gmail.com");
    const to = await app.authorize({ clientId: elsewhere, cookie }).catch(() => null);
    expect(to?.pathname).not.toBe("/consent");
    expect(to?.origin).not.toBe("https://claude.ai");
    expect(documents.asked).not.toContain(elsewhere);
    expect(rowsOf(await app.db.execute(sql`select 1 from oauth_client where client_id = ${elsewhere}`))).toHaveLength(0);
  });

  it("5. a signed-in member cannot create an app through the API", async () => {
    const { cookie } = await app.signIn("linus@gmail.com");
    const before = await clientRows();
    const res = await app.send(new Request(`${BASE_URL}/api/auth/oauth2/create-client`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: BASE_URL },
      body: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK], client_name: "Mine" }),
    }));
    expect(res.status).toBe(401);
    expect(await clientRows()).toBe(before);
  });

  it("6. the session-token endpoint is off", async () => {
    const { cookie } = await app.signIn("margaret@gmail.com");
    expect((await app.send(new Request(`${BASE_URL}/api/auth/token`, { headers: { cookie } }))).status).toBe(404);
  });

  it("7. offers only the authorization-code and refresh grants", async () => {
    const meta = await (await app.send(new Request(`${BASE_URL}/.well-known/oauth-authorization-server/api/auth`))).json();
    expect([...meta.grant_types_supported].sort()).toEqual(["authorization_code", "refresh_token"]);
  });

  it("8. limits registrations per address, and the count survives a new server instance", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      app.forgetServerInstance();
      statuses.push((await app.register({ ip: "203.0.113.77" })).status);
    }
    expect(statuses.slice(0, 5).every((s) => s >= 200 && s < 300)).toBe(true);
    expect(statuses[5]).toBe(429);
    // The in-memory store outlives a new auth instance inside one process, so check that the count is kept in the database.
    const kept = rowsOf<{ n: number }>(await app.db.execute(sql`select max(count)::int as n from rate_limit where key like ${"203.0.113.77|%"}`));
    expect(kept[0].n).toBe(5);
  });
});
