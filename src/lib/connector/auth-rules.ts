import { count, isNull } from "drizzle-orm";
import { APIError, createAuthMiddleware, type AuthMiddleware } from "better-auth/api";
import type { DB } from "@/db";
import { oauthClient } from "@/db/schema";
import { CLAUDE_REDIRECT_URIS, CLIENT_DOCUMENT_HOSTS, MAX_REGISTERED_CLIENTS } from "@/lib/connector/config";

// Exact match only: no trailing slash, query or other scheme.
export function isClaudeRedirect(uri: string): boolean {
  return CLAUDE_REDIRECT_URIS.includes(uri);
}

export function isClaudeClientDocument(clientIdUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(clientIdUrl);
  } catch {
    return false;
  }
  return url.protocol === "https:"
    && url.port === ""
    && url.username === ""
    && url.password === ""
    && CLIENT_DOCUMENT_HOSTS.includes(url.hostname);
}

// Apps that registered themselves. Apps known by a metadata document carry a discovery id.
async function selfRegisteredClients(db: DB): Promise<number> {
  const [row] = await db.select({ n: count() }).from(oauthClient).where(isNull(oauthClient.clientDiscoveryId));
  return row.n;
}

// Runs before every /api/auth request and acts only on registration. The count and the insert are separate statements,
// so the cap can be passed by a few rows when registrations arrive together.
export function connectorBeforeHook(db: DB): AuthMiddleware {
  return createAuthMiddleware(async (ctx) => {
    if (ctx.path !== "/oauth2/register") return;
    const uris: unknown = ctx.body?.redirect_uris;
    const onlyClaude = Array.isArray(uris) && uris.length > 0 && uris.every((uri) => typeof uri === "string" && isClaudeRedirect(uri));
    if (!onlyClaude) {
      throw new APIError("BAD_REQUEST", {
        error: "invalid_redirect_uri",
        error_description: "Only Claude's callback addresses can be registered.",
      });
    }
    if ((await selfRegisteredClients(db)) >= MAX_REGISTERED_CLIENTS) {
      throw new APIError("SERVICE_UNAVAILABLE", {
        error: "temporarily_unavailable",
        error_description: "No more apps can register right now.",
      });
    }
  });
}
