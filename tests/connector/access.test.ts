import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
