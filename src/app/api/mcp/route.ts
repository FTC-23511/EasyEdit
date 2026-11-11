import { requireMcpAuth } from "@better-auth/mcp";
import { createMcpHandler } from "mcp-handler";
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { refusalResponse, resolveConnectorCaller } from "@/lib/connector/caller";
import { mcpResourceUrl } from "@/lib/connector/config";
import { toolContextFor } from "@/lib/mcp/context";
import { SERVER_INSTRUCTIONS } from "@/lib/mcp/guide";
import { registerTools } from "@/lib/mcp/server";

// The one place a bearer token is accepted. It never reads the session cookie and has no cross-origin rule:
// a browser never sends a bearer token on its own. The website's routes keep apiRoute and never accept one.
export const maxDuration = 30;

// Only POST: each request stands alone, and Next answers every other method with 405.
export function POST(request: Request): Promise<Response> {
  return requireMcpAuth(
    getAuth(),
    async (req, claims) => {
      // The token says who is calling. The allowlist and the grant, read now, decide whether they may.
      const caller = await resolveConnectorCaller(getDb(), claims);
      if (!caller.ok) return refusalResponse(caller.reason);
      const handler = createMcpHandler((server) => registerTools(server, toolContextFor(caller.user)), {
        serverInfo: { name: "easyedit", version: "1.0.0" },
        instructions: SERVER_INSTRUCTIONS,
      });
      return handler(req);
    },
    { resource: mcpResourceUrl() },
  )(request);
}
