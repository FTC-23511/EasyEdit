import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rowsOf, type DB } from "@/db";
import { isConnectorRequest, readConsentRequest, type SearchParams } from "@/lib/connector/consent";
import { BASE_URL, CLAUDE_CALLBACK, MCP_URL, SECRET, startConnectorApp, type ConnectorApp } from "../helpers/connector";

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

const CLAUDE_DOCUMENT = "https://claude.ai/oauth/mcp-client-metadata.json";

// What the consent page receives from Next for an address.
function pageParams(url: URL): SearchParams {
  const out: SearchParams = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    out[key] = all.length > 1 ? all : all[0];
  }
  return out;
}

const newClient = async (name?: string) => ((await (await app.register({ name })).json()) as { client_id: string }).client_id;

describe("the consent page", () => {
  it("asks a first-time member, and Allow sends them to Claude with a code", async () => {
    const { cookie } = await app.signIn("ada@gmail.com");
    const asked = await app.authorize({ clientId: await newClient(), cookie, state: "st-9" });
    expect(asked.pathname).toBe("/consent");
    expect(isConnectorRequest(pageParams(asked))).toBe(true);
    expect(await readConsentRequest(app.db, SECRET, pageParams(asked))).toEqual({ ok: true, view: { clientName: "Claude", verifiedHost: null } });

    const back = await app.decide({ cookie, consentUrl: asked, accept: true });
    expect(`${back.origin}${back.pathname}`).toBe(CLAUDE_CALLBACK);
    expect(back.searchParams.get("code")).toEqual(expect.any(String));
    expect(back.searchParams.get("state")).toBe("st-9");
  });

  it("asks again a member who allowed the same app before, also when the request says prompt=none", async () => {
    const { cookie } = await app.signIn("grace@gmail.com");
    const clientId = await newClient();
    await app.decide({ cookie, consentUrl: await app.authorize({ clientId, cookie }), accept: true });
    expect((await app.authorize({ clientId, cookie })).pathname).toBe("/consent");
    expect((await app.authorize({ clientId, cookie, prompt: "none" })).pathname).toBe("/consent");
  });

  it("asks again when the request is a form post that says prompt=none", async () => {
    const { cookie } = await app.signIn("barbara@gmail.com");
    const clientId = await newClient();
    await app.decide({ cookie, consentUrl: await app.authorize({ clientId, cookie }), accept: true });
    const res = await app.send(new Request(`${BASE_URL}/api/auth/oauth2/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie, "x-forwarded-for": "203.0.113.31" },
      body: new URLSearchParams({
        response_type: "code", client_id: clientId, redirect_uri: CLAUDE_CALLBACK, scope: "offline_access", state: "s-1",
        code_challenge: app.pkce().challenge, code_challenge_method: "S256", resource: MCP_URL, prompt: "none",
      }),
    }));
    expect(new URL(res.headers.get("location") ?? "", BASE_URL).pathname).toBe("/consent");
  });

  it("Don't allow sends the member back to Claude with access_denied, no code and no grant", async () => {
    const { userId, cookie } = await app.signIn("linus@gmail.com");
    const back = await app.decide({ cookie, consentUrl: await app.authorize({ clientId: await newClient(), cookie }), accept: false });
    expect(`${back.origin}${back.pathname}`).toBe(CLAUDE_CALLBACK);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("code")).toBeNull();
    expect(rowsOf(await app.db.execute(sql`select 1 from oauth_consent where user_id = ${userId}`))).toHaveLength(0);
  });

  it("refuses a link that was changed, and one for an app that does not exist", async () => {
    const { cookie } = await app.signIn("margaret@gmail.com");
    const asked = await app.authorize({ clientId: await newClient(), cookie });
    const changed = new URL(asked);
    changed.searchParams.set("client_id", await newClient("Other"));
    expect(await readConsentRequest(app.db, SECRET, pageParams(changed))).toEqual({ ok: false });
    expect(await readConsentRequest(app.db, SECRET, { client_id: "nope" })).toEqual({ ok: false });
    expect(await readConsentRequest(app.db, "another-secret-".repeat(3), pageParams(asked))).toEqual({ ok: false });
    expect(isConnectorRequest({ error: "NOT_ALLOWLISTED" })).toBe(false);
  });

  it("names claude.ai only for an app known by its metadata document, and cuts a long self-given name", async () => {
    documents.served.set(CLAUDE_DOCUMENT, {
      client_id: CLAUDE_DOCUMENT, client_name: "Claude", redirect_uris: [CLAUDE_CALLBACK],
      token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    });
    const { cookie } = await app.signIn("katherine@gmail.com");
    const known = await app.authorize({ clientId: CLAUDE_DOCUMENT, cookie });
    expect(await readConsentRequest(app.db, SECRET, pageParams(known))).toEqual({ ok: true, view: { clientName: "Claude", verifiedHost: "claude.ai" } });

    const selfNamed = await app.authorize({ clientId: await newClient("Claude ".repeat(12)), cookie });
    const read = await readConsentRequest(app.db, SECRET, pageParams(selfNamed));
    expect(read).toMatchObject({ ok: true, view: { verifiedHost: null } });
    expect(read.ok && read.view.clientName.length).toBe(60);
  });
});
