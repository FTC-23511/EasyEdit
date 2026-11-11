import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { mcp } from "@better-auth/mcp";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { getDb } from "@/db";
import { makeSessionCreateBefore, makeUserCreateBefore } from "@/lib/auth-hooks";
import { connectorBeforeHook, isClaudeClientDocument, isClaudeRedirect } from "@/lib/connector/auth-rules";
import { DYNAMIC_REGISTRATION, mcpResourceUrl } from "@/lib/connector/config";
import { requiredEnv } from "@/lib/env";

const DAY_SECONDS = 24 * 60 * 60;
// A session lasts this long after its last renewal, so people who keep coming back stay signed in.
const SESSION_SECONDS = 30 * DAY_SECONDS;
// A session is renewed at most once a day.
const SESSION_RENEW_AFTER_SECONDS = DAY_SECONDS;

function createAuth() {
  const db = getDb();
  return betterAuth({
    // neon-http cannot run transactions, so the adapter must never open one.
    database: drizzleAdapter(db, { provider: "pg", transaction: false }),
    secret: requiredEnv("BETTER_AUTH_SECRET"),
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
    session: {
      cookieCache: { enabled: false },
      expiresIn: SESSION_SECONDS,
      updateAge: SESSION_RENEW_AFTER_SECONDS,
    },
    databaseHooks: {
      user: { create: { before: makeUserCreateBefore(db) } },
      session: { create: { before: makeSessionCreateBefore(db) } },
    },
    plugins: [
      // Signs the connector's access tokens. Session responses carry no token header.
      jwt({ disableSettingJwtHeader: true }),
      mcp({
        resource: mcpResourceUrl(),
        loginPage: "/login",
        consentPage: "/consent",
        allowDynamicClientRegistration: DYNAMIC_REGISTRATION,
        allowUnauthenticatedClientRegistration: DYNAMIC_REGISTRATION,
        grantTypes: ["authorization_code", "refresh_token"],
        // A member is only ever sent back to Claude, whatever an app registered.
        validateRedirectUri: (uri, _registered, matches) => matches && isClaudeRedirect(uri),
        // Nobody manages apps through the API.
        clientPrivileges: () => false,
      }),
      cimd({
        fetchClientMetadataResource,
        metadataProfile: "mcp-2026-07-28",
        isMetadataDocumentUrlAllowed: (url) => isClaudeClientDocument(url),
      }),
    ],
    // On everywhere, not only in production. Counted in the database: an in-memory count would
    // reset with every new server instance.
    rateLimit: { enabled: true, storage: "database" },
    // The jwt plugin's session-to-token endpoint is off. The only tokens handed out are the connector's.
    disabledPaths: ["/token"],
    hooks: { before: connectorBeforeHook(db) },
  });
}

export type Auth = ReturnType<typeof createAuth>;

const globalForAuth = globalThis as typeof globalThis & { __easyEditAuth?: Auth };

export function getAuth(): Auth {
  globalForAuth.__easyEditAuth ??= createAuth();
  return globalForAuth.__easyEditAuth;
}
