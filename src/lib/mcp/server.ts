import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { UNEXPECTED } from "./errors";
import { listProjectsTool } from "./tools/list-projects";
import type { ToolContext, ToolResult } from "./types";

// Every tool answers through here. A thrown error is logged by tool name only (never its arguments) and Claude reads UNEXPECTED.
function answer<Input>(name: string, tool: (input: Input) => Promise<ToolResult>) {
  return async (input: Input) => {
    try {
      const { text, isError } = await tool(input);
      return { content: [{ type: "text" as const, text }], isError };
    } catch (error) {
      console.error("Connector tool failed", name, error);
      return { content: [{ type: "text" as const, text: UNEXPECTED }], isError: true };
    }
  };
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description:
        "List the team's video projects, most recently changed first, with each project's id, format and version. Also says who you are signed in as and whether you can make changes. Start here when the person has not named a project.",
      inputSchema: z.object({ cursor: z.number().int().min(0).optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    answer("list_projects", (input) => listProjectsTool(ctx, input)),
  );
}
