import { requiredEnv } from "@/lib/env";

// Where claude.ai and claude.com send a member back after they allow the connection.
export const CLAUDE_REDIRECT_URIS: readonly string[] = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
];

// Hosts whose client metadata documents the sign-in server reads.
export const CLIENT_DOCUMENT_HOSTS: readonly string[] = ["claude.ai", "claude.com"];

// Clients may register themselves, without a token, at /api/auth/oauth2/register.
export const DYNAMIC_REGISTRATION = true;

export const MAX_REGISTERED_CLIENTS = 500;

export function appBaseUrl(): string {
  return requiredEnv("BETTER_AUTH_URL").replace(/\/+$/, "");
}

// The one address the connector's access tokens are bound to.
export function mcpResourceUrl(): string {
  return `${appBaseUrl()}/api/mcp`;
}
