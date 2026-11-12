import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rowsOf, type DB } from "@/db";
import { addEntry, SEED_ADMIN_EMAIL } from "@/lib/allowlist/service";
import { BASE_URL, CLAUDE_CALLBACK, MCP_URL, startConnectorApp, type ConnectorApp } from "../helpers/connector";
import { answerGoogleInProcess, signInWithGoogle } from "../helpers/google";

let testDb: DB;
vi.mock("@/db", async (original) => ({ ...(await original<typeof import("@/db")>()), getDb: () => testDb }));

let app: ConnectorApp;
beforeAll(async () => {
  app = await startConnectorApp();
  testDb = app.db;
  answerGoogleInProcess(app);
});
afterAll(() => app.stop());

let addresses = 0;
const ip = () => `203.0.113.${++addresses}`;

// A request to authorize as a browser sends it, for Claude's client, with the caller's own state and challenge.
async function authorizeRaw(input: { clientId: string; cookie?: string; state: string; challenge: string; maxAge?: string }): Promise<URL> {
  const query = new URLSearchParams({
    response_type: "code", client_id: input.clientId, redirect_uri: CLAUDE_CALLBACK, scope: "offline_access",
    state: input.state, code_challenge: input.challenge, code_challenge_method: "S256", resource: MCP_URL,
  });
  if (input.maxAge !== undefined) query.set("max_age", input.maxAge);
  const headers: Record<string, string> = { "x-forwarded-for": ip() };
  if (input.cookie) headers.cookie = input.cookie;
  const res = await app.send(new Request(`${BASE_URL}/api/auth/oauth2/authorize?${query}`, { headers }));
  return new URL(res.headers.get("location") ?? "", BASE_URL);
}

const consents = async (userId: string) =>
  rowsOf(await app.db.execute(sql`select 1 from oauth_consent where user_id = ${userId}`)).length;

// A signed login link that no longer asks for consent, made by one member for another (review finding C1, steps 1 and 2).
async function linkWithoutConsent(clientId: string): Promise<URL> {
  const mallory = await app.signIn(`mallory${++addresses}@gmail.com`, "viewer");
  const asked = await authorizeRaw({ clientId, cookie: mallory.cookie, state: "ATTACKER", challenge: app.pkce().challenge, maxAge: "0" });
  expect(asked.pathname).toBe("/login");
  expect(asked.searchParams.get("prompt")).toContain("consent");
  const link = await app.decide({ cookie: mallory.cookie, consentUrl: asked, accept: true });
  expect(link.pathname).toBe("/login");
  expect(link.searchParams.get("sig")).not.toBeNull();
  return link;
}

describe("signing in with Google while connecting Claude", () => {
  it("a login link made by another member ends on the consent page for a member who already has a grant", async () => {
    const bob = await app.connect("bob@gmail.com");
    const link = await linkWithoutConsent(bob.clientId);
    // The link no longer asks for consent: without the rule, the callback would send a code straight to Claude.
    expect(link.searchParams.get("prompt") ?? "").not.toContain("consent");

    const { location } = await signInWithGoogle(app, { email: "bob@gmail.com", name: "Bob", loginUrl: link });
    expect(location.pathname).toBe("/consent");
    expect(location.searchParams.get("code")).toBeNull();
    expect(`${location.origin}${location.pathname}`).not.toBe(CLAUDE_CALLBACK);
  });

  it("the account-chosen step does not hand out a link without the consent prompt either", async () => {
    const grace = await app.connect("grace@gmail.com");
    const link = await linkWithoutConsent(grace.clientId);
    const res = await app.send(new Request(`${BASE_URL}/api/auth/oauth2/continue`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: grace.cookie, origin: BASE_URL, "x-forwarded-for": ip() },
      body: JSON.stringify({ selected: true, oauth_query: link.search.slice(1) }),
    }));
    // The request still says max_age=0, so this step sends the member to sign in again, with a newly signed link.
    const next = new URL(((await res.json()) as { url?: string }).url ?? "", BASE_URL);
    expect(next.pathname).toBe("/login");
    expect(next.searchParams.get("prompt")).toContain("consent");
  });

  it("the ordinary hand-off ends on the consent page for a member who already has a grant", async () => {
    const ada = await app.connect("ada@gmail.com");
    const asked = await authorizeRaw({ clientId: ada.clientId, state: "s-ada", challenge: app.pkce().challenge });
    expect(asked.pathname).toBe("/login");

    const { location } = await signInWithGoogle(app, { email: "ada@gmail.com", name: "Ada", loginUrl: asked });
    expect(location.pathname).toBe("/consent");
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("the ordinary hand-off ends on the consent page for a member with no grant, and Allow then gives Claude a code once", async () => {
    await addEntry(app.db, { email: "linus@gmail.com", role: "editor", invitedBy: SEED_ADMIN_EMAIL });
    const clientId = ((await (await app.register()).json()) as { client_id: string }).client_id;
    const asked = await authorizeRaw({ clientId, state: "s-linus", challenge: app.pkce().challenge });
    expect(asked.pathname).toBe("/login");

    const { location, cookie } = await signInWithGoogle(app, { email: "linus@gmail.com", name: "Linus", loginUrl: asked });
    expect(location.pathname).toBe("/consent");

    // Allow does not come back to the consent page: one press, one code.
    const back = await app.decide({ cookie, consentUrl: location, accept: true });
    expect(`${back.origin}${back.pathname}`).toBe(CLAUDE_CALLBACK);
    expect(back.searchParams.get("code")).toEqual(expect.any(String));
    expect(back.searchParams.get("state")).toBe("s-linus");
    const [{ id }] = rowsOf<{ id: string }>(await app.db.execute(sql`select id from "user" where email = 'linus@gmail.com'`));
    expect(await consents(id)).toBe(1);
  });
});
