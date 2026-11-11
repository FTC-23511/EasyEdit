import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { LIMITS } from "@/lib/limits";
import { FormatId } from "@/lib/timeline";
import { UNEXPECTED } from "./errors";
import { createProjectTool } from "./tools/create-project";
import { editTimelineTool } from "./tools/edit-timeline";
import { getProjectTool } from "./tools/get-project";
import { listProjectsTool } from "./tools/list-projects";
import type { ToolContext, ToolResult } from "./types";

// The ops edit_timeline accepts, as Claude reads them.
export const EDIT_DESCRIPTION = `Change a project's timeline with a batch of ops. The whole batch is applied, or none of it.

Always pass expected_version: the version from your latest get_project, create_project or edit result for this project. If the project changed since, nothing is applied and you get the changes and the current project back.

Times are whole frames: frame = seconds × fps, and the project's first line gives fps. Ids come from get_project. Leave "id" out of new clips and tracks; the result lists the ids the server made.

Ops:
{"op":"add_clip","trackId":T,"clip":CLIP,"ripple":true}      ripple is optional: it pushes later clips right
{"op":"remove_clip","clipId":C,"ripple":true}               ripple is optional: it closes the gap
{"op":"move_clip","clipId":C,"start":F,"trackId":T}         trackId is optional: another track
{"op":"trim_clip","clipId":C,"edge":"start"|"end","to":F}   to is the new timeline frame of that edge
{"op":"split_clip","clipId":C,"at":F}                       the second half gets a new id
{"op":"update_clip","clipId":C,"patch":{...}}               text, style{...}, transform{...}; never start or duration
{"op":"add_track","track":{"kind":"video"|"overlay"|"text"|"audio","name":S},"index":N}   index is optional
{"op":"update_track","trackId":T,"patch":{"name":S,"muted":B,"hidden":B,"locked":B}}       any of the four
{"op":"move_track","trackId":T,"index":N}                   a later track draws on top
{"op":"remove_track","trackId":T}
{"op":"set_format","format":"short_9x16"|"feed_4x5"|"square_1x1"|"long_16x9"|"long_4k"}

A text CLIP: {"type":"text","start":F,"duration":F,"text":S,"transform":{"x":0.5,"y":0.5,"scale":1,"rotation":0,"opacity":1,"fit":"contain"},"style":{"fontFamily":"Geist","fontSize":96,"fontWeight":700,"color":"#ffffff","align":"center"}}
x and y place the clip's center as a fraction of the frame: 0.5, 0.5 is the middle. Only text clips can be added today. For plain text, add_text is simpler.`;

// A database error code (such as "22021"), on the error or its cause. Only a short plain token is taken.
function errorCode(error: unknown): string | undefined {
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    const code = (candidate as { code?: unknown } | null)?.code;
    if (typeof code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(code)) return code;
  }
  return undefined;
}

// Every tool answers through here, and Claude reads UNEXPECTED when one throws.
// The log gets the tool name, the error's class and its database code. Never the error itself, its message or its stack:
// a failed query's message holds the values bound to it, which are the tool's arguments.
function answer<Input>(name: string, tool: (input: Input) => Promise<ToolResult>) {
  return async (input: Input) => {
    try {
      const { text, isError } = await tool(input);
      return { content: [{ type: "text" as const, text }], isError };
    } catch (error) {
      const kind = error instanceof Error ? error.constructor.name : typeof error;
      const code = errorCode(error);
      console.error("Connector tool failed", name, kind, ...(code ? [code] : []));
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

  server.registerTool(
    "get_project",
    {
      title: "Read a project",
      description:
        "Read one project's timeline as text: its format, version, tracks and clips, with times in seconds and in frames and every clip's id. Call this before changing a project, and pass the version it reports as expected_version. Long projects come in pages: pass cursor to read on.",
      inputSchema: z.object({ project_id: z.string().min(1), cursor: z.number().int().min(0).optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    answer("get_project", (input) => getProjectTool(ctx, input)),
  );

  server.registerTool(
    "create_project",
    {
      title: "Create a project",
      description:
        "Create an empty project with a name and a format: short_9x16 (1080×1920, Reels and Shorts), feed_4x5 (1080×1350), square_1x1 (1080×1080), long_16x9 (1920×1080) or long_4k (3840×2160). Returns the new project's id, its version (0) and its starting tracks.",
      inputSchema: z.object({ name: z.string(), format: FormatId }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    answer("create_project", (input) => createProjectTool(ctx, input)),
  );

  server.registerTool(
    "edit_timeline",
    {
      title: "Edit the timeline",
      description: EDIT_DESCRIPTION,
      inputSchema: z.object({
        project_id: z.string().min(1),
        expected_version: z.number().int().min(0),
        ops: z.array(z.record(z.string(), z.unknown())).min(1).max(LIMITS.opsPerRequest),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    answer("edit_timeline", (input) => editTimelineTool(ctx, input)),
  );
}
