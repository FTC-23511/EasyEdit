import type { OpInput } from "@/lib/timeline";
import { editedText, runEdit } from "../edit";
import { assetNotUsable, opNotAvailable } from "../errors";
import { checkAllowedOps, checkAssetOps } from "../op-rules";
import { ok, type ToolContext, type ToolResult } from "../types";

export async function editTimelineTool(
  ctx: ToolContext,
  input: { project_id: string; expected_version: number; ops: unknown[] },
): Promise<ToolResult> {
  const notAllowed = checkAllowedOps(input.ops);
  if (notAllowed) return opNotAvailable(notAllowed);
  // Before the project is read: an asset id that is wrong says how to find the right one.
  const badAsset = await checkAssetOps(ctx.db, input.ops);
  if (badAsset) return assetNotUsable(badAsset);

  // The engine checks each op's shape; the service refuses the whole batch if one is wrong.
  const done = await runEdit(ctx, {
    projectId: input.project_id,
    expectedVersion: input.expected_version,
    ops: input.ops as OpInput[],
    key: input.ops,
  });
  if (!done.ok) return done.result;
  const n = done.applied.ops.length;
  return ok(editedText(ctx, `Applied ${n} ${n === 1 ? "op" : "ops"} as version ${done.applied.version}.`, done));
}
