import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import { BASE_URL, CLAUDE_CALLBACK, MCP_URL, claimsOf, startConnectorApp, type ConnectorApp } from "../helpers/connector";

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

describe("the sign-in server for the connector", () => {
  it("serves both discovery documents, at the path form and at the root form", async () => {
    for (const url of [`${BASE_URL}/.well-known/oauth-authorization-server/api/auth`, `${BASE_URL}/.well-known/oauth-authorization-server`]) {
      const res = await app.send(new Request(url));
      expect(res.status, url).toBe(200);
      expect(await res.json()).toMatchObject({
        issuer: `${BASE_URL}/api/auth`,
        authorization_endpoint: `${BASE_URL}/api/auth/oauth2/authorize`,
        token_endpoint: `${BASE_URL}/api/auth/oauth2/token`,
        registration_endpoint: `${BASE_URL}/api/auth/oauth2/register`,
        code_challenge_methods_supported: ["S256"],
        client_id_metadata_document_supported: true,
      });
    }
    for (const url of [`${BASE_URL}/.well-known/oauth-protected-resource/api/mcp`, `${BASE_URL}/.well-known/oauth-protected-resource`]) {
      const res = await app.send(new Request(url));
      expect(res.status, url).toBe(200);
      expect(await res.json()).toMatchObject({ resource: MCP_URL, authorization_servers: [`${BASE_URL}/api/auth`], bearer_methods_supported: ["header"] });
    }
  });

  it("takes a member from registration to a token that is bound to the endpoint and names only who they are", async () => {
    const c = await app.connect("ada@gmail.com");
    const claims = claimsOf(c.accessToken);
    expect(claims).toMatchObject({ sub: c.userId, aud: MCP_URL, iss: `${BASE_URL}/api/auth`, azp: c.clientId });
    expect(claims.role).toBeUndefined();
    expect(claims.email).toBeUndefined();
    expect(c.refreshToken).toEqual(expect.any(String));
  });

  it("refuses a wrong PKCE verifier", async () => {
    const { cookie } = await app.signIn("grace@gmail.com");
    const clientId = ((await (await app.register()).json()) as { client_id: string }).client_id;
    const asked = await app.authorize({ clientId, cookie });
    const back = asked.pathname === "/consent" ? await app.decide({ cookie, consentUrl: asked, accept: true }) : asked;
    const res = await app.token({
      grant_type: "authorization_code", code: back.searchParams.get("code")!, redirect_uri: CLAUDE_CALLBACK,
      client_id: clientId, code_verifier: app.pkce().verifier, resource: MCP_URL,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("sends a signed-out visitor to /login with the request signed into the address", async () => {
    const clientId = ((await (await app.register()).json()) as { client_id: string }).client_id;
    const to = await app.authorize({ clientId });
    expect(to.pathname).toBe("/login");
    expect(to.searchParams.get("sig")).toEqual(expect.any(String));
  });

  it("a token asked for without the resource is not a signed token for this endpoint", async () => {
    const c = await app.connect("linus@gmail.com", "editor", { resource: null });
    expect(c.accessToken.split(".")).toHaveLength(1);
  });

  it("refreshes a token", async () => {
    const c = await app.connect("margaret@gmail.com");
    const res = await app.token({ grant_type: "refresh_token", refresh_token: c.refreshToken!, client_id: c.clientId });
    expect(res.status).toBe(200);
    const next = (await res.json()) as { access_token: string };
    expect(next.access_token).not.toBe(c.accessToken);
    expect(claimsOf(next.access_token)).toMatchObject({ sub: c.userId, aud: MCP_URL });
  });

  it("accepts a client known by a metadata document on claude.ai", async () => {
    documents.served.set(CLAUDE_DOCUMENT, {
      client_id: CLAUDE_DOCUMENT, client_name: "Claude", redirect_uris: [CLAUDE_CALLBACK],
      token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    });
    const c = await app.connect("katherine@gmail.com", "editor", { clientId: CLAUDE_DOCUMENT });
    expect(claimsOf(c.accessToken)).toMatchObject({ azp: CLAUDE_DOCUMENT, aud: MCP_URL });
  });
});
