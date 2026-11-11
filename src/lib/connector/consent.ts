import "server-only";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import { oauthClient } from "@/db/schema";
import { graphemes } from "@/lib/text";

export type SearchParams = Record<string, string | string[] | undefined>;
export type ConsentView = { clientName: string; verifiedHost: string | null };
export type ConsentRequest = { ok: true; view: ConsentView } | { ok: false };

const MAX_CLIENT_NAME = 60;

// The sign-in server signs the request it sends to the login and consent pages.
export function isConnectorRequest(searchParams: SearchParams): boolean {
  return searchParams.sig !== undefined;
}

function toQuery(searchParams: SearchParams): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    for (const v of typeof value === "string" ? [value] : value ?? []) query.append(key, v);
  }
  return query.toString();
}

// What the consent page may show, only for a request this server signed and that has not expired.
export async function readConsentRequest(db: DB, secret: string, searchParams: SearchParams): Promise<ConsentRequest> {
  const clientId = searchParams.client_id;
  if (typeof clientId !== "string") return { ok: false };
  if (!(await verifyOAuthQueryParams(toQuery(searchParams), secret))) return { ok: false };
  const [row] = await db
    .select({ name: oauthClient.name, discoveryId: oauthClient.clientDiscoveryId })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId));
  if (row === undefined) return { ok: false };
  const name = row.name?.trim() ? graphemes(row.name).slice(0, MAX_CLIENT_NAME).join("") : "An app";
  // Only an app known by its metadata document is vouched for by the host that serves it.
  const verifiedHost = row.discoveryId !== null ? new URL(clientId).host : null;
  return { ok: true, view: { clientName: name, verifiedHost } };
}
