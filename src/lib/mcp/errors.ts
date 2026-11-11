import type { Role } from "@/lib/allowlist/service";
import { summarizeOps } from "@/lib/editor/activity";
import { actorUserId, displayActor } from "@/lib/projects/display-actor";
import { getOpsSince, getProject } from "@/lib/projects/service";
import { getUserNames } from "@/lib/projects/user-names";
import { ServiceError } from "@/lib/service-error";
import type { OpErrorCode } from "@/lib/timeline";
import { projectPage } from "./project-text";
import { fail, type ToolContext, type ToolResult } from "./types";

// What Claude reads when a tool fails for a reason it cannot see. Nothing about the server goes in it.
export const UNEXPECTED =
  "Something went wrong on the server. Read the project again before you retry: the change may or may not have been applied.";

const NOTHING_APPLIED = "Nothing was applied.";

export function roleMessage(role: Role): string {
  return `Your role is ${role}. You can read projects but not change them. An admin can change your role on the Admin page.`;
}

export function notFoundText(projectId: string): string {
  return `No project with id "${projectId}". It may have been deleted. Call list_projects to see the ids.`;
}

// How to fix an op the engine refused, by its code.
export const OP_HINTS: Record<OpErrorCode, string> = {
  NOT_FOUND: "Check the id against get_project. Ids are case-sensitive.",
  OVERLAP: 'Pick a start where the track is free, use another track, or add "ripple": true to push later clips right.',
  WRONG_TRACK_KIND: "Text clips go on text tracks, video and image clips on video or overlay tracks, audio clips on audio tracks.",
  TRACK_LOCKED: 'The track is locked. Unlock it with update_track {"locked": false} if the person agrees.',
  INVALID: "Compare the op with the list in this tool's description. Times are whole frames.",
  TRIM_OUT_OF_RANGE: "The new edge must leave at least one frame and stay inside the clip's source.",
  DUPLICATE_ID: "Leave ids out of new clips and tracks; the server makes them.",
  STALE: "That part of the project changed. Read it again with get_project.",
  LIMIT_EXCEEDED: "Send fewer ops, or make the change in smaller steps.",
};

// An op Claude may not send yet. The ops are refused before anything is read.
export function opNotAvailable(hit: { opIndex: number; opName: string; reason: string }): ToolResult {
  return fail([`Edit refused: ops[${hit.opIndex}] (${hit.opName}) is not available here.`, hit.reason, NOTHING_APPLIED].join("\n"));
}

// The engine's message echoes ids Claude sent, which may hold line breaks. The refusal keeps it to one line.
const oneLine = (text: string) => text.replace(/\r\n|[\r\n\u2028\u2029]/g, " ");

function opName(ops: unknown[], opIndex: number): string {
  const op = ops[opIndex];
  const name = typeof op === "object" && op !== null ? (op as { op?: unknown }).op : undefined;
  return typeof name === "string" ? name : "op";
}

// The project as it is now, and the changes logged after `expectedVersion`, so Claude can plan again without another read.
export async function conflictResult(ctx: ToolContext, projectId: string, expectedVersion: number): Promise<ToolResult> {
  const project = await getProject(ctx.db, ctx.actor, projectId);
  if (!project) return fail(notFoundText(projectId));
  const current = project.version;

  const lines =
    expectedVersion > current
      ? [`Edit refused: expected_version ${expectedVersion} is ahead of the project, which is at version ${current}. ${NOTHING_APPLIED}`]
      : [
          `Edit refused: the project changed after version ${expectedVersion}. It is now at version ${current}. ${NOTHING_APPLIED}`,
          ...(await unseenChanges(ctx, projectId, expectedVersion, current)),
        ];
  lines.push("Current project:");
  lines.push(projectPage(project, { maxChars: ctx.limits.connectorEchoChars }).text);
  lines.push(`Plan again from this, then send your change with expected_version ${current}.`);
  return fail(lines.join("\n"));
}

// Up to `limits.connectorConflictEntries` log entries after `since`, and how many more there are, as of version `current`.
async function unseenChanges(ctx: ToolContext, projectId: string, since: number, current: number): Promise<string[]> {
  if (current <= since) return [];
  const page = await getOpsSince(ctx.db, ctx.actor, projectId, since, ctx.limits.connectorConflictEntries);
  // Only changes up to the version shown in the answer: one that lands between the two reads waits for the next attempt.
  const entries = (page?.entries ?? []).filter((entry) => entry.version <= current);
  const names = await getUserNames(ctx.db, entries.map((entry) => actorUserId(entry.actor)));
  const lines = ["Changes you have not seen:"];
  for (const entry of entries) {
    const who = entry.actor === ctx.actor.userId ? "you" : displayActor(entry.actor, names);
    lines.push(`  version ${entry.version} · ${who} · ${summarizeOps(entry.ops)}`);
  }
  const more = current - since - entries.length;
  if (more > 0) lines.push(`  … and ${more} more`);
  return lines;
}

// Turns a ServiceError into the answer for a refused write. Anything else is thrown again.
export async function failureResult(
  ctx: ToolContext,
  error: unknown,
  input: { projectId: string; expectedVersion: number; ops: unknown[] },
): Promise<ToolResult> {
  if (!(error instanceof ServiceError)) throw error;
  if (error.code === "FORBIDDEN") return fail(roleMessage(ctx.user.role));
  if (error.status === 404) return fail(notFoundText(input.projectId));
  if (error.code === "CONFLICT") return conflictResult(ctx, input.projectId, input.expectedVersion);
  if (error.opIndex !== undefined) {
    const code = error.code as OpErrorCode;
    return fail(
      [
        `Edit refused: ops[${error.opIndex}] (${opName(input.ops, error.opIndex)}) failed with ${code}.`,
        oneLine(error.message),
        `How to fix: ${OP_HINTS[code]}`,
        NOTHING_APPLIED,
      ].join("\n"),
    );
  }
  return fail(`${error.message}\n${NOTHING_APPLIED}`);
}
