import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { getDb } from "@/db";
import { makeSessionCreateBefore, makeUserCreateBefore } from "@/lib/auth-hooks";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Add it to .env.local (see .env.example).`);
  return value;
}

function createAuth() {
  const db = getDb();
  return betterAuth({
    // neon-http cannot run transactions, so the adapter must never open one.
    database: drizzleAdapter(db, { provider: "pg", transaction: false }),
    trustedOrigins: [requiredEnv("BETTER_AUTH_URL")],
    emailAndPassword: { enabled: false },
    socialProviders: {
      google: {
        clientId: requiredEnv("GOOGLE_CLIENT_ID"),
        clientSecret: requiredEnv("GOOGLE_CLIENT_SECRET"),
        prompt: "select_account",
      },
    },
    // Every request must reach the database so a removed user is locked out on their next request.
    session: { cookieCache: { enabled: false } },
    databaseHooks: {
      user: { create: { before: makeUserCreateBefore(db) } },
      session: { create: { before: makeSessionCreateBefore(db) } },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

const globalForAuth = globalThis as typeof globalThis & { __easyEditAuth?: Auth };

export function getAuth(): Auth {
  globalForAuth.__easyEditAuth ??= createAuth();
  return globalForAuth.__easyEditAuth;
}
