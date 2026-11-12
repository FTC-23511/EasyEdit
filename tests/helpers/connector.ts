import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeSignature } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import { user } from "@/db/schema";
import { addEntry, getRole, seedAdmin, SEED_ADMIN_EMAIL, type Role } from "@/lib/allowlist/service";
import { clientDocuments } from "./client-documents";
import { makeSuiteDb } from "./db";

export const SECRET = "test-secret-".repeat(4);
export const BASE_URL = "http://localhost:3000";
export const MCP_URL = `${BASE_URL}/api/mcp`;
export const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

// A metadata document as Claude serves it, for a client whose id is the document's address.
export function clientDocument(clientId: string, over: { name?: string; redirectUris?: string[] } = {}) {
  return {
    client_id: clientId, client_name: over.name ?? "Claude", redirect_uris: over.redirectUris ?? [CLAUDE_CALLBACK],
    token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
  };
}

export type Connection = { userId: string; clientId: string; cookie: string; accessToken: string; refreshToken?: string };
export type ConnectorApp = Awaited<ReturnType<typeof startConnectorApp>>;

const globalForAuth = globalThis as typeof globalThis & { __easyEditAuth?: unknown };

export const claimsOf = (jwt: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

// One app for a whole test file: token checks cache the signing keys, so the database must not change under them.
export async function startConnectorApp() {
  vi.stubEnv("BETTER_AUTH_URL", BASE_URL);
  vi.stubEnv("BETTER_AUTH_SECRET", SECRET);
  vi.stubEnv("GOOGLE_CLIENT_ID", "test-client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-client-secret");
  delete globalForAuth.__easyEditAuth;
  const { db, close } = await makeSuiteDb();
  await seedAdmin(db);
  // Served by the transport in ./client-documents, which every test file loads first.
  const documents = clientDocuments();
  documents.served.clear();
  documents.asked.length = 0;
  let addresses = 0;
  let clients = 0;
  // The rate limiter counts per address, so every simulated client gets its own.
  const freshIp = () => `198.51.${100 + Math.floor(addresses / 250)}.${(addresses++ % 250) + 1}`;

  const realAuth = async () => {
    const auth = (await import("@/lib/auth")).getAuth();
    return { auth, ctx: await auth.$context };
  };

  // Hands a request to the handler Next would pick for its path, so nothing leaves the process.
  async function send(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/auth/")) return (await realAuth()).auth.handler(request);
    if (pathname === "/api/mcp") return (await import("@/app/api/mcp/route")).POST(request);
    if (pathname === "/.well-known/oauth-authorization-server") return (await import("@/app/.well-known/oauth-authorization-server/route")).GET(request);
    if (pathname === "/.well-known/oauth-authorization-server/api/auth") return (await import("@/app/.well-known/oauth-authorization-server/api/auth/route")).GET(request);
    if (pathname === "/.well-known/oauth-protected-resource") return (await import("@/app/.well-known/oauth-protected-resource/route")).GET(request);
    if (pathname === "/.well-known/oauth-protected-resource/api/mcp") return (await import("@/app/.well-known/oauth-protected-resource/api/mcp/route")).GET(request);
    throw new Error(`no route for ${request.method} ${request.url}`);
  }

  // Whatever the code under test fetches (its own signing keys, for one) is answered in-process.
  const inProcessFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (!request.url.startsWith(`${BASE_URL}/`)) throw new Error(`unexpected network request to ${request.url}`);
    return send(request);
  }) as typeof fetch;
  vi.stubGlobal("fetch", inProcessFetch);

  // What the browser holds after Google sign-in: a session cookie signed with the auth secret.
  async function signIn(email: string, role: Role = "editor") {
    if ((await getRole(db, email)) === null) await addEntry(db, { email, role, invitedBy: SEED_ADMIN_EMAIL });
    const { ctx } = await realAuth();
    const name = email[0].toUpperCase() + email.slice(1, email.indexOf("@"));
    const existing = (await db.select().from(user).where(eq(user.email, email)))[0];
    const account = existing
      ?? (await ctx.internalAdapter.createOAuthUser({ email, name, emailVerified: true }, { providerId: "google", accountId: `g-${email}` })).user;
    const session = await ctx.internalAdapter.createSession(account.id);
    const signed = `${session.token}.${await makeSignature(session.token, SECRET)}`;
    return { userId: account.id, cookie: `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(signed)}` };
  }

  // Serves a metadata document at an address and returns the address, which is the client's id.
  function serveDocument(url: string, doc: unknown = clientDocument(url)): string {
    documents.served.set(url, doc);
    return url;
  }

  // A client of its own, known by a metadata document on claude.ai. Pass the result as clientId to share one.
  function newClient(over: { name?: string; redirectUris?: string[] } = {}): string {
    const url = `https://claude.ai/oauth/test-client-${++clients}.json`;
    return serveDocument(url, clientDocument(url, over));
  }

  // Open registration is off. Kept to check that the endpoint refuses.
  function register(over: { redirectUris?: string[]; name?: string; ip?: string } = {}) {
    return send(new Request(`${BASE_URL}/api/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": over.ip ?? freshIp() },
      body: JSON.stringify({
        redirect_uris: over.redirectUris ?? [CLAUDE_CALLBACK],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: over.name ?? "Claude",
      }),
    }));
  }

  // Where the browser ends up after asking to authorize: the consent page, the login page, Claude's callback or an error page.
  async function authorize(input: {
    clientId: string; cookie?: string; challenge?: string; state?: string;
    resource?: string | null; redirectUri?: string; prompt?: string;
  }): Promise<URL> {
    const query = new URLSearchParams({
      response_type: "code", client_id: input.clientId, redirect_uri: input.redirectUri ?? CLAUDE_CALLBACK,
      scope: "offline_access", state: input.state ?? "s-1",
      code_challenge: input.challenge ?? pkce().challenge, code_challenge_method: "S256",
    });
    if (input.resource !== null) query.set("resource", input.resource ?? MCP_URL);
    if (input.prompt) query.set("prompt", input.prompt);
    const headers: Record<string, string> = { "x-forwarded-for": freshIp() };
    if (input.cookie) headers.cookie = input.cookie;
    const res = await send(new Request(`${BASE_URL}/api/auth/oauth2/authorize?${query}`, { headers }));
    const location = res.headers.get("location");
    if (location === null) throw new Error(`authorize did not redirect: ${res.status} ${await res.text()}`);
    return new URL(location, BASE_URL);
  }

  // The consent page's two buttons.
  async function decide(input: { cookie: string; consentUrl: URL; accept: boolean }): Promise<URL> {
    const res = await send(new Request(`${BASE_URL}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: input.cookie, origin: BASE_URL },
      body: JSON.stringify({ accept: input.accept, oauth_query: input.consentUrl.search.slice(1) }),
    }));
    const body = (await res.json()) as { url?: string };
    if (typeof body.url !== "string") throw new Error(`consent failed: ${res.status} ${JSON.stringify(body)}`);
    return new URL(body.url, BASE_URL);
  }

  function token(params: Record<string, string>) {
    return send(new Request(`${BASE_URL}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": freshIp() },
      body: new URLSearchParams(params),
    }));
  }

  // Everything claude.ai and the member's browser do, from naming its client to holding tokens.
  async function connect(email: string, role: Role = "editor", opts: { resource?: string | null; clientId?: string } = {}): Promise<Connection> {
    const { userId, cookie } = await signIn(email, role);
    const clientId = opts.clientId ?? newClient();
    const { verifier, challenge } = pkce();
    const asked = await authorize({ clientId, cookie, challenge, resource: opts.resource });
    const back = asked.pathname === "/consent" ? await decide({ cookie, consentUrl: asked, accept: true }) : asked;
    const code = back.searchParams.get("code");
    if (code === null) throw new Error(`no code at ${back}`);
    const params: Record<string, string> = { grant_type: "authorization_code", code, redirect_uri: CLAUDE_CALLBACK, client_id: clientId, code_verifier: verifier };
    if (opts.resource !== null) params.resource = opts.resource ?? MCP_URL;
    const tokens = (await (await token(params)).json()) as { access_token?: string; refresh_token?: string };
    if (typeof tokens.access_token !== "string") throw new Error(`no access token: ${JSON.stringify(tokens)}`);
    return { userId, clientId, cookie, accessToken: tokens.access_token, refreshToken: tokens.refresh_token };
  }

  // One raw protocol request, for checks on status codes and headers.
  function rpc(token: string | null, method: string, params: object = {}, headers: Record<string, string> = {}) {
    return send(new Request(MCP_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18",
        ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }));
  }

  // The official client, talking to the real route.
  async function mcpClient(token: string) {
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), {
      fetch: inProcessFetch, requestInit: { headers: { authorization: `Bearer ${token}` } },
    }));
    return client;
  }

  async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
    const client = await mcpClient(token);
    try {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as { type: string; text?: string }[]).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      return { text, isError: result.isError === true };
    } finally {
      await client.close();
    }
  }

  return {
    db, send, fetch: inProcessFetch, documents, serveDocument, newClient, signIn, register, authorize, decide, token, connect, pkce, rpc, mcpClient, callTool,
    // As a new serverless instance would start: nothing kept in memory.
    forgetServerInstance: () => { delete globalForAuth.__easyEditAuth; },
    async stop() {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      delete globalForAuth.__easyEditAuth;
      await close();
    },
  };
}
