import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { getDb } from "@/db";

function createAuth() {
  return betterAuth({
    // neon-http cannot run transactions, so the adapter must never open one.
    database: drizzleAdapter(getDb(), { provider: "pg", transaction: false }),
    emailAndPassword: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;

const globalForAuth = globalThis as typeof globalThis & { __easyEditAuth?: Auth };

export function getAuth(): Auth {
  globalForAuth.__easyEditAuth ??= createAuth();
  return globalForAuth.__easyEditAuth;
}
