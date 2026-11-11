import { describe, escapeQuoted, type Op, type TimelineDoc } from "@/lib/timeline";
import { pageLines } from "./paging";

export type ProjectText = { text: string; next: number | null };

export function projectPage(
  project: { id: string; name: string; doc: TimelineDoc; version: number },
  opts: { cursor?: number; maxChars: number },
): ProjectText {
  const [head, ...body] = describe(project.doc, { version: project.version, detail: true }).split("\n");
  const page = pageLines(body, opts.cursor ?? 0, opts.maxChars);
  const out = [`Project "${escapeQuoted(project.name)}" (id ${project.id})`, head];
  if (page.lines.length > 0) out.push(...page.lines);
  else out.push("(no more lines)");
  if (page.next !== null) {
    out.push(`… ${body.length - page.next} more lines. Call get_project with project_id "${project.id}" and cursor ${page.next} to read on.`);
  }
  return { text: out.join("\n"), next: page.next };
}

// The ids the server made for a batch of ops, one line each, in op order.
export function newIdLines(ops: Op[]): string[] {
  const lines: string[] = [];
  for (const op of ops) {
    if (op.op === "add_track") lines.push(`  track ${op.track.id} ("${escapeQuoted(op.track.name)}", ${op.track.kind})`);
    else if (op.op === "add_clip") lines.push(`  clip ${op.clip.id} on track ${op.trackId}`);
    else if (op.op === "split_clip") lines.push(`  clip ${op.newClipId} (second half of ${op.clipId})`);
  }
  return lines;
}
