import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rowsOf, type DB } from "@/db";
import { isConnectorRequest, readConsentRequest, type SearchParams } from "@/lib/connector/consent";
import { BASE_URL, CLAUDE_CALLBACK, MCP_URL, SECRET, startConnectorApp, type ConnectorApp } from "../helpers/connector";

let testDb: DB;
vi.mock("@/db", async (original) => ({ ...(await original<typeof import("@/db")>()), getDb: () => testDb }));


let app: ConnectorApp;
beforeAll(async () => {
  app = await startConnectorApp();
  testDb = app.db;
});
afterAll(() => app.stop());

// What the consent page receives from Next for an address.
function pageParams(url: URL): SearchParams {
  const out: SearchParams = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    out[key] = all.length > 1 ? all : all[0];
  }
  return out;
}

describe("the consent page", () => {
  it("asks a first-time member, and Allow sends them to Claude with a code", async () => {
    const { cookie } = await app.signIn("ada@gmail.com");
    const asked = await app.authorize({ clientId: app.newClient(), cookie, state: "st-9" });
    expect(asked.pathname).toBe("/consent");
    expect(isConnectorRequest(pageParams(asked))).toBe(true);
    expect(await readConsentRequest(app.db, SECRET, pageParams(asked))).toEqual({ ok: true, view: { clientName: "Claude", verifiedHost: "claude.ai" } });

    const back = await app.decide({ cookie, consentUrl: asked, accept: true });
    expect(`${back.origin}${back.pathname}`).toBe(CLAUDE_CALLBACK);
    expect(back.searchParams.get("code")).toEqual(expect.any(String));
    expect(back.searchParams.get("state")).toBe("st-9");
  });

  it("asks again a member who allowed the same app before, also when the request says prompt=none", async () => {
    const { cookie } = await app.signIn("grace@gmail.com");
    const clientId = app.newClient();
    await app.decide({ cookie, consentUrl: await app.authorize({ clientId, cookie }), accept: true });
    expect((await app.authorize({ clientId, cookie })).pathname).toBe("/consent");
    expect((await app.authorize({ clientId, cookie, prompt: "none" })).pathname).toBe("/consent");
  });

  it("asks again when the request is a form post that says prompt=none", async () => {
    const { cookie } = await app.signIn("barbara@gmail.com");
    const clientId = app.newClient();
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
    const back = await app.decide({ cookie, consentUrl: await app.authorize({ clientId: app.newClient(), cookie }), accept: false });
    expect(`${back.origin}${back.pathname}`).toBe(CLAUDE_CALLBACK);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("code")).toBeNull();
    expect(rowsOf(await app.db.execute(sql`select 1 from oauth_consent where user_id = ${userId}`))).toHaveLength(0);
  });

  it("refuses a link that was changed, and one for an app that does not exist", async () => {
    const { cookie } = await app.signIn("margaret@gmail.com");
    const asked = await app.authorize({ clientId: app.newClient(), cookie });
    const changed = new URL(asked);
    changed.searchParams.set("client_id", app.newClient({ name: "Other" }));
    expect(await readConsentRequest(app.db, SECRET, pageParams(changed))).toEqual({ ok: false });
    expect(await readConsentRequest(app.db, SECRET, { client_id: "nope" })).toEqual({ ok: false });
    expect(await readConsentRequest(app.db, "another-secret-".repeat(3), pageParams(asked))).toEqual({ ok: false });
    expect(isConnectorRequest({ error: "NOT_ALLOWLISTED" })).toBe(false);
  });

  it("names claude.ai for an app known by its metadata document, and cuts a long name", async () => {
    const { cookie } = await app.signIn("katherine@gmail.com");
    const known = await app.authorize({ clientId: app.newClient(), cookie });
    expect(await readConsentRequest(app.db, SECRET, pageParams(known))).toEqual({ ok: true, view: { clientName: "Claude", verifiedHost: "claude.ai" } });

    const long = await app.authorize({ clientId: app.newClient({ name: "Claude ".repeat(12) }), cookie });
    const read = await readConsentRequest(app.db, SECRET, pageParams(long));
    expect(read).toMatchObject({ ok: true, view: { verifiedHost: "claude.ai" } });
    expect(read.ok && read.view.clientName.length).toBe(60);
  });

  it("does not vouch for an app that registered itself before open registration was switched off", async () => {
    await app.db.execute(sql`
      insert into oauth_client (id, client_id, name, redirect_uris, token_endpoint_auth_method, grant_types, response_types, created_at)
      values ('old', 'old', 'Helper', array[${CLAUDE_CALLBACK}], 'none', array['authorization_code'], array['code'], now())`);
    const { cookie } = await app.signIn("dorothy@gmail.com");
    // Such a row was never linked to the endpoint, so this asks without naming it.
    const asked = await app.authorize({ clientId: "old", cookie, resource: null });
    expect(asked.pathname).toBe("/consent");
    expect(await readConsentRequest(app.db, SECRET, pageParams(asked))).toEqual({ ok: true, view: { clientName: "Helper", verifiedHost: null } });
  });
});
