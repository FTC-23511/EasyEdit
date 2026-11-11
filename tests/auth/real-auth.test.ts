import { makeSignature } from "better-auth/crypto";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import { session as sessionTable, user as userTable } from "@/db/schema";
import { addEntry, removeEntry, SEED_ADMIN_EMAIL, seedAdmin, setRole } from "@/lib/allowlist/service";
import { makeTestDb } from "../helpers/db";

let testDb: DB;
vi.mock("@/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db")>()),
  getDb: () => testDb,
}));

const SECRET = "test-secret-".repeat(4);
const BASE_URL = "http://localhost:3000";

const globalForAuth = globalThis as typeof globalThis & { __easyEditAuth?: unknown };

async function realAuth() {
  const { getAuth } = await import("@/lib/auth");
  const auth = getAuth();
  return { auth, ctx: await auth.$context };
}

// The Cookie header a browser sends after sign-in: the session token signed with the auth secret.
async function sessionCookie(ctx: Awaited<ReturnType<typeof realAuth>>["ctx"], token: string) {
  const signed = `${token}.${await makeSignature(token, SECRET)}`;
  return `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(signed)}`;
}

const apiRequest = (cookie: string) => new Request(`${BASE_URL}/api/projects`, { headers: { cookie } });

async function signIn(ctx: Awaited<ReturnType<typeof realAuth>>["ctx"], email: string, accountId: string) {
  const created = await ctx.internalAdapter.createOAuthUser(
    { email, name: "Kid", emailVerified: true },
    { providerId: "google", accountId },
  );
  const session = await ctx.internalAdapter.createSession(created.user.id);
  return { user: created.user, cookie: await sessionCookie(ctx, session.token) };
}

beforeEach(async () => {
  vi.stubEnv("BETTER_AUTH_URL", BASE_URL);
  vi.stubEnv("BETTER_AUTH_SECRET", SECRET);
  vi.stubEnv("GOOGLE_CLIENT_ID", "test-client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-client-secret");
  delete globalForAuth.__easyEditAuth;
  testDb = await makeTestDb();
  await seedAdmin(testDb);
});

afterEach(() => {
  delete globalForAuth.__easyEditAuth;
  vi.unstubAllEnvs();
});

describe("the real auth instance from src/lib/auth.ts", () => {
  it("getAuth fails with a clear error when BETTER_AUTH_SECRET is not set", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", undefined);
    const { getAuth } = await import("@/lib/auth");
    expect(() => getAuth()).toThrow("BETTER_AUTH_SECRET is not set. Add it to .env.local (see .env.example).");
  });

  it("refuses a non-allowlisted Google user and creates no user row", async () => {
    const { ctx } = await realAuth();
    const err = await ctx.internalAdapter
      .createOAuthUser(
        { email: "rando@gmail.com", name: "R", emailVerified: true },
        { providerId: "google", accountId: "g-1" },
      )
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ body: { code: "NOT_ALLOWLISTED" } });
    expect(await testDb.select().from(userTable)).toHaveLength(0);
  });

  it("refuses an allowlisted email that Google has not verified", async () => {
    const { ctx } = await realAuth();
    const err = await ctx.internalAdapter
      .createOAuthUser(
        { email: SEED_ADMIN_EMAIL, name: "A", emailVerified: false },
        { providerId: "google", accountId: "g-0" },
      )
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ body: { code: "NOT_ALLOWLISTED" } });
    expect(await testDb.select().from(userTable)).toHaveLength(0);
  });

  it("signs in an allowlisted user, then a demotion gives 403 and a removal gives 401 on the next call", async () => {
    const { auth, ctx } = await realAuth();
    const { requireUserApi } = await import("@/lib/access");
    await addEntry(testDb, { email: "kid@gmail.com", role: "editor", invitedBy: SEED_ADMIN_EMAIL });

    const { user, cookie } = await signIn(ctx, "Kid@Gmail.com", "g-2");
    expect(user.email).toBe("kid@gmail.com");
    expect((await auth.api.getSession({ headers: new Headers({ cookie }) }))?.user.email).toBe("kid@gmail.com");
    expect(await requireUserApi(apiRequest(cookie), "editor")).toMatchObject({ id: user.id, role: "editor" });

    await setRole(testDb, "kid@gmail.com", "viewer");
    expect(((await requireUserApi(apiRequest(cookie), "editor")) as Response).status).toBe(403);

    await removeEntry(testDb, "kid@gmail.com");
    expect(await testDb.select().from(sessionTable)).toHaveLength(0);
    expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).toBeNull();
    expect(((await requireUserApi(apiRequest(cookie), "viewer")) as Response).status).toBe(401);

    const again = await ctx.internalAdapter.createSession(user.id).catch((e: unknown) => e);
    expect(again).toMatchObject({ body: { code: "NOT_ALLOWLISTED" } });
  });

  it("refuses a session row that outlives its allowlist row", async () => {
    const { auth, ctx } = await realAuth();
    const { requireUserApi } = await import("@/lib/access");
    await addEntry(testDb, { email: "kid@gmail.com", role: "editor", invitedBy: SEED_ADMIN_EMAIL });
    const { cookie } = await signIn(ctx, "kid@gmail.com", "g-3");

    // The allowlist row is gone but the session row survives, as if removeEntry stopped half way.
    await testDb.execute(sql`delete from allowlist where email = 'kid@gmail.com'`);
    expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).not.toBeNull();
    expect(((await requireUserApi(apiRequest(cookie), "viewer")) as Response).status).toBe(401);
  });
});
