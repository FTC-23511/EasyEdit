import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { rowsOf, type DB } from "@/db";
import { removeEntry, setRole } from "@/lib/allowlist/service";
import { refusalResponse, resolveConnectorCaller } from "@/lib/connector/caller";
import { connectedEmails, revokeAccess } from "@/lib/connector/grants";
import { BASE_URL, claimsOf, startConnectorApp, type ConnectorApp } from "../helpers/connector";

let testDb: DB;
vi.mock("@/db", async (original) => ({ ...(await original<typeof import("@/db")>()), getDb: () => testDb }));

let app: ConnectorApp;
beforeAll(async () => {
  app = await startConnectorApp();
  testDb = app.db;
});
afterAll(() => app.stop());

const count = async (table: "session" | "oauth_access_token" | "oauth_refresh_token" | "oauth_consent", userId: string) =>
  rowsOf<{ n: number }>(await app.db.execute(sql`select count(*)::int as n from ${sql.identifier(table)} where user_id = ${userId}`))[0].n;
const who = (c: { accessToken: string }) => resolveConnectorCaller(app.db, claimsOf(c.accessToken));
const refresh = (c: { refreshToken?: string; clientId: string }) =>
  app.token({ grant_type: "refresh_token", refresh_token: c.refreshToken!, client_id: c.clientId });

describe("who is calling", () => {
  it("a connected member resolves with the role they have now", async () => {
    const c = await app.connect("ada@gmail.com");
    expect(await who(c)).toEqual({ ok: true, user: { id: c.userId, email: "ada@gmail.com", name: "Ada", image: null, role: "editor" } });
    await setRole(app.db, "ada@gmail.com", "viewer");
    expect(await who(c)).toMatchObject({ ok: true, user: { role: "viewer" } });
    expect(await connectedEmails(app.db)).toContain("ada@gmail.com");
  });

  it("removing a member deletes their sessions, tokens and consent, and their refresh token stops working", async () => {
    const gone = await app.connect("grace@gmail.com");
    const stays = await app.connect("linus@gmail.com");
    expect(await count("oauth_consent", gone.userId)).toBe(1);
    expect(await count("oauth_refresh_token", gone.userId)).toBeGreaterThan(0);

    await removeEntry(app.db, "grace@gmail.com");

    for (const table of ["session", "oauth_access_token", "oauth_refresh_token", "oauth_consent"] as const) {
      expect(await count(table, gone.userId), table).toBe(0);
    }
    expect(await who(gone)).toEqual({ ok: false, reason: "not-allowlisted" });
    const refreshed = await refresh(gone);
    expect(refreshed.ok).toBe(false);
    expect(((await refreshed.json()) as { access_token?: string }).access_token).toBeUndefined();

    // The other member is untouched.
    expect(await who(stays)).toMatchObject({ ok: true });
    expect((await refresh(stays)).status).toBe(200);
    expect(await count("session", stays.userId)).toBeGreaterThan(0);
  });

  it("a member whose grant was ended is refused until they connect again, and keeps their website session", async () => {
    const c = await app.connect("margaret@gmail.com");
    await revokeAccess(app.db, { userId: c.userId }, { sessions: false });
    expect(await who(c)).toEqual({ ok: false, reason: "revoked" });
    expect((await refresh(c)).ok).toBe(false);
    expect(await count("session", c.userId)).toBeGreaterThan(0);
    expect(await connectedEmails(app.db)).not.toContain("margaret@gmail.com");
    expect(await who(await app.connect("margaret@gmail.com"))).toMatchObject({ ok: true });
  });

  it("ending one member's grant leaves another member of the same app connected", async () => {
    // Claude reaches every member through one client, so a grant must count only for the member who gave it.
    const ended = await app.connect("hedy@gmail.com");
    const kept = await app.connect("annie@gmail.com", "editor", { clientId: ended.clientId });
    expect(claimsOf(kept.accessToken).azp).toBe(ended.clientId);

    await revokeAccess(app.db, { userId: ended.userId }, { sessions: false });

    expect(await who(ended)).toEqual({ ok: false, reason: "revoked" });
    expect(await who(kept)).toMatchObject({ ok: true, user: { id: kept.userId } });
    expect((await refresh(kept)).status).toBe(200);
  });

  it("a member off the allowlist is refused even if a grant row is left behind", async () => {
    const c = await app.connect("katherine@gmail.com");
    await app.db.execute(sql`delete from allowlist where email = 'katherine@gmail.com'`);
    expect(await count("oauth_consent", c.userId)).toBe(1);
    expect(await who(c)).toEqual({ ok: false, reason: "not-allowlisted" });
  });

  it("refuses claims with no subject, an unknown subject, or another app", async () => {
    const c = await app.connect("dorothy@gmail.com");
    expect(await resolveConnectorCaller(app.db, {})).toEqual({ ok: false, reason: "not-allowlisted" });
    expect(await resolveConnectorCaller(app.db, { sub: 7, azp: c.clientId })).toEqual({ ok: false, reason: "not-allowlisted" });
    expect(await resolveConnectorCaller(app.db, { sub: "nobody", azp: c.clientId })).toEqual({ ok: false, reason: "not-allowlisted" });
    expect(await resolveConnectorCaller(app.db, { sub: c.userId, azp: "some-other-app" })).toEqual({ ok: false, reason: "revoked" });
    expect(await resolveConnectorCaller(app.db, { sub: c.userId })).toEqual({ ok: false, reason: "not-allowlisted" });
  });

  it("a removed member gets no sign-in challenge; a disconnected one does", async () => {
    const removed = refusalResponse("not-allowlisted");
    expect(removed.status).toBe(403);
    expect(removed.headers.get("www-authenticate")).toBeNull();
    expect(await removed.json()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "This Google account isn't on the Seattle Solvers allowlist. Ask an admin to add you." } });

    const ended = refusalResponse("revoked");
    expect(ended.status).toBe(401);
    expect(ended.headers.get("www-authenticate")).toBe(
      `Bearer error="invalid_token", error_description="The connection was ended", resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource/api/mcp"`,
    );
    expect(await ended.json()).toMatchObject({ error: { message: "Claude was disconnected from this account. Connect again." } });
  });

  it("signing out of the website leaves the Claude connection working", async () => {
    const c = await app.connect("barbara@gmail.com");
    expect(await count("session", c.userId)).toBe(1);

    const out = await app.send(new Request(`${BASE_URL}/api/auth/sign-out`, {
      method: "POST",
      headers: { cookie: c.cookie, origin: BASE_URL, "x-forwarded-for": "203.0.113.41" },
    }));
    expect(out.status).toBe(200);

    expect(await count("session", c.userId)).toBe(0);
    expect(await who(c)).toMatchObject({ ok: true, user: { id: c.userId } });
    expect((await refresh(c)).status).toBe(200);
  });
});

describe("a token from before a disconnect", () => {
  afterEach(() => vi.useRealTimers());

  // Only the clock the code reads moves; the database and the test runner keep real time.
  const setClock = (at: Date) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at);
  };
  const tools = (c: { accessToken: string }) => app.rpc(c.accessToken, "tools/list");

  it("stays refused after the member connects again through the same app", async () => {
    const start = new Date(Math.floor(Date.now() / 1000) * 1000);
    setClock(start);
    const before = await app.connect("joan@gmail.com");
    expect((await tools(before)).status).toBe(200);
    await revokeAccess(app.db, { userId: before.userId }, { sessions: false });
    expect(await who(before)).toEqual({ ok: false, reason: "revoked" });

    setClock(new Date(start.getTime() + 60_000));
    const after = await app.connect("joan@gmail.com", "editor", { clientId: before.clientId });
    expect(claimsOf(after.accessToken).azp).toBe(before.clientId);

    expect(await who(before)).toEqual({ ok: false, reason: "revoked" });
    expect((await tools(before)).status).toBe(401);
    expect(await who(after)).toMatchObject({ ok: true, user: { id: after.userId } });
    expect((await tools(after)).status).toBe(200);
  });

  it("a token issued in the same second as its grant passes, one from the second before does not", async () => {
    const c = await app.connect("frances@gmail.com");
    const iat = claimsOf(c.accessToken).iat as number;
    const setGrantTime = (seconds: number) =>
      app.db.execute(sql`update oauth_consent set created_at = ${new Date(seconds * 1000).toISOString()} where user_id = ${c.userId}`);

    await setGrantTime(iat);
    expect(await who(c)).toMatchObject({ ok: true });
    expect((await tools(c)).status).toBe(200);
    await setGrantTime(iat + 1);
    expect(await who(c)).toEqual({ ok: false, reason: "revoked" });
    expect((await tools(c)).status).toBe(401);
  });

  it("a token with no usable issue time is refused", async () => {
    const c = await app.connect("mary@gmail.com");
    const claims = claimsOf(c.accessToken);
    expect(await resolveConnectorCaller(app.db, claims)).toMatchObject({ ok: true });
    for (const iat of [undefined, "1700000000", Number.NaN, null]) {
      expect(await resolveConnectorCaller(app.db, { ...claims, iat }), String(iat)).toEqual({ ok: false, reason: "revoked" });
    }
  });
});

describe("ending access", () => {
  it("removing a member again finishes a revoke that failed after the allowlist row was deleted", async () => {
    // Without a resource the access token is stored too, so all four tables hold a row.
    const c = await app.connect("rosalind@gmail.com", "editor", { resource: null });
    // As if the first statement of removeEntry landed and the second failed.
    await app.db.execute(sql`delete from allowlist where email = 'rosalind@gmail.com'`);
    for (const table of ["session", "oauth_access_token", "oauth_refresh_token", "oauth_consent"] as const) {
      expect(await count(table, c.userId), table).toBeGreaterThan(0);
    }

    await removeEntry(app.db, "rosalind@gmail.com");

    for (const table of ["session", "oauth_access_token", "oauth_refresh_token", "oauth_consent"] as const) {
      expect(await count(table, c.userId), table).toBe(0);
    }
  });
});
