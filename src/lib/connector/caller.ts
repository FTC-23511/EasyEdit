import { and, eq, exists, lte } from "drizzle-orm";
import type { DB } from "@/db";
import { oauthConsent, user } from "@/db/schema";
import { resolveCurrentUser, type CurrentUser } from "@/lib/access-rules";
import { appBaseUrl } from "@/lib/connector/config";

export type ConnectorCaller = { ok: true; user: CurrentUser } | { ok: false; reason: "not-allowlisted" | "revoked" };

// Who is calling the endpoint, checked on every request: the allowlist first, then whether the grant still stands.
// The grant must be older than the token: a token from before a Disconnect does not come back when the member
// connects again. Grants and token issue times are both kept to the second, so a token from the grant's own second passes.
export async function resolveConnectorCaller(db: DB, claims: { sub?: unknown; azp?: unknown; iat?: unknown }): Promise<ConnectorCaller> {
  const { sub, azp, iat } = claims;
  if (typeof sub !== "string" || typeof azp !== "string") return { ok: false, reason: "not-allowlisted" };
  // A token without a usable issue time is refused below, once the allowlist has had its say.
  const issuedAt = typeof iat === "number" && Number.isFinite(iat) ? new Date(iat * 1000) : undefined;
  const granted = db
    .select({ id: oauthConsent.id })
    .from(oauthConsent)
    .where(and(eq(oauthConsent.userId, user.id), eq(oauthConsent.clientId, azp), issuedAt && lte(oauthConsent.createdAt, issuedAt)));
  const [row] = await db
    .select({ id: user.id, email: user.email, name: user.name, image: user.image, granted: exists(granted) })
    .from(user)
    .where(eq(user.id, sub));
  if (row === undefined) return { ok: false, reason: "not-allowlisted" };
  const current = await resolveCurrentUser(db, row);
  if (current === null) return { ok: false, reason: "not-allowlisted" };
  if (issuedAt === undefined || !row.granted) return { ok: false, reason: "revoked" };
  return { ok: true, user: current };
}

const REFUSALS = {
  "not-allowlisted": { status: 403, message: "This Google account isn't on the Seattle Solvers allowlist. Ask an admin to add you." },
  revoked: { status: 401, message: "Claude was disconnected from this account. Connect again." },
} as const;

// A removed member gets no sign-in challenge, since signing in again would not help; a disconnected one is asked to reconnect.
export function refusalResponse(reason: "not-allowlisted" | "revoked"): Response {
  const { status, message } = REFUSALS[reason];
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (reason === "revoked") {
    headers["www-authenticate"] =
      `Bearer error="invalid_token", error_description="The connection was ended", resource_metadata="${appBaseUrl()}/.well-known/oauth-protected-resource/api/mcp"`;
  }
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }), { status, headers });
}
