import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { LIMITS } from "@/lib/limits";
import { FormatId } from "@/lib/timeline";
import { UNEXPECTED } from "./errors";
import { EDIT_DESCRIPTION, buildEditingGuide } from "./guide";
import { addMediaTool } from "./tools/add-media";
import { addTextTool } from "./tools/add-text";
import { createProjectTool } from "./tools/create-project";
import { editTimelineTool } from "./tools/edit-timeline";
import { getProjectTool } from "./tools/get-project";
import { listAssetsTool } from "./tools/list-assets";
import { listProjectsTool } from "./tools/list-projects";
import { undoChangeTool } from "./tools/undo-change";
import { ok, type ToolContext, type ToolResult } from "./types";

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

const GUIDE_URI = "easyedit://editing-guide";

export function registerTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_editing_guide",
    {
      title: "Editing guide",
      description:
        "How to edit well in this app: how a project is built, what is possible today, and rules for short videos. Read it once before your first edit in a conversation.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    answer("get_editing_guide", async () => ok(buildEditingGuide())),
  );

  server.registerPrompt(
    "editing-guide",
    { title: "Editing guide", description: "Load the EasyEdit editing guide into the conversation." },
    () => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: buildEditingGuide() } }] }),
  );

  server.registerResource(
    "editing-guide",
    GUIDE_URI,
    { title: "Editing guide", mimeType: "text/markdown" },
    () => ({ contents: [{ uri: GUIDE_URI, mimeType: "text/markdown", text: buildEditingGuide() }] }),
  );

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
        "Read one project's timeline as text: its format, version, tracks and clips, with times in seconds and in frames and every clip's id. Call this before changing a project, and pass the version it reports as expected_version. Long projects come in pages: to read on, pass the cursor and the version that the last line of a page names. If the project changed in between, you are told to start again.",
      inputSchema: z.object({
        project_id: z.string().min(1),
        cursor: z.number().int().min(0).optional(),
        version: z.number().int().min(0).optional(),
      }),
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

  server.registerTool(
    "add_text",
    {
      title: "Add text",
      description:
        "Add one or more text clips from a preset (title, subtitle or lower-third) at a time given in seconds. It finds a free text track or makes one. Defaults: preset title, start 0, 3 seconds. Use this for plain text; use edit_timeline to restyle or move it afterwards. Needs expected_version, like edit_timeline.",
      inputSchema: z.object({
        project_id: z.string().min(1),
        expected_version: z.number().int().min(0),
        items: z
          .array(
            z.object({
              text: z.string().min(1).max(LIMITS.textClipChars),
              preset: z.enum(["title", "subtitle", "lower-third"]).optional(),
              start_seconds: z.number().min(0).optional(),
              duration_seconds: z.number().positive().optional(),
              track_id: z.string().min(1).optional(),
            }),
          )
          .min(1)
          .max(LIMITS.connectorTextItems),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    answer("add_text", (input) => addTextTool(ctx, input)),
  );

  server.registerTool(
    "list_assets",
    {
      title: "List media",
      description:
        'List the team\'s uploaded video, images and audio, newest first, with each asset\'s id, kind, length and size. Filter by kind, or by a word in the name or event. Use an id from here in add_media, or as "assetId" in a media clip for edit_timeline. You cannot see inside footage yet: go by names, events and lengths.',
      inputSchema: z.object({
        kind: z.enum(["video", "image", "audio"]).optional(),
        search: z.string().max(100).optional(),
        cursor: z.number().int().min(0).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    answer("list_assets", (input) => listAssetsTool(ctx, input)),
  );

  server.registerTool(
    "add_media",
    {
      title: "Add media",
      description:
        "Put one or more assets from list_assets on the timeline. Times are in seconds. Each item takes asset_id and, optionally, start_seconds, in_seconds (where in the footage to begin), duration_seconds and track_id. Without start_seconds, an item goes right after the one before it; the first goes after what is already on its track. Video and audio default to their full length, images to 3 seconds. It finds a free track of the right kind or makes one. Needs expected_version, like edit_timeline.",
      inputSchema: z.object({
        project_id: z.string().min(1),
        expected_version: z.number().int().min(0),
        items: z
          .array(
            z.object({
              asset_id: z.string().min(1),
              start_seconds: z.number().min(0).optional(),
              in_seconds: z.number().min(0).optional(),
              duration_seconds: z.number().positive().optional(),
              track_id: z.string().min(1).optional(),
            }),
          )
          .min(1)
          .max(LIMITS.connectorMediaItems),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    answer("add_media", (input) => addMediaTool(ctx, input)),
  );

  server.registerTool(
    "undo_change",
    {
      title: "Undo a change",
      description:
        "Undo one earlier change to a project, by the version that change produced (edit results and conflict reports name versions). Works for your changes and for other people's, like the editor's Activity list. It is refused if that part of the project was changed afterwards. Needs expected_version, like edit_timeline.",
      inputSchema: z.object({
        project_id: z.string().min(1),
        expected_version: z.number().int().min(0),
        version: z.number().int().min(1),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    answer("undo_change", (input) => undoChangeTool(ctx, input)),
  );
}
