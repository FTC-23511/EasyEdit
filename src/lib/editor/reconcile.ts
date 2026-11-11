import { OpError, applyOps, type Op, type TimelineDoc } from "@/lib/timeline";
import type { PendingEdit } from "./types";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = definedKeys(a);
    return keys.length === definedKeys(b).length && keys.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

// A key whose value is undefined counts as absent, as it does once the value has been through JSON.
function definedKeys(o: Record<string, unknown>): string[] {
  return Object.keys(o).filter((k) => o[k] !== undefined);
}

// Deep equality that ignores the order of object keys and keys set to undefined, so ops read back
// from the server's log match the ones this tab sent.
export function sameOps(a: Op[], b: Op[]): boolean {
  return deepEqual(a, b);
}

// Applies each queued edit in order on top of the server copy. An edit that no longer applies is
// dropped, and the ones after it are still tried.
export function foldQueue(
  serverDoc: TimelineDoc,
  queue: PendingEdit[],
): { doc: TimelineDoc; kept: PendingEdit[]; dropped: PendingEdit[] } {
  let doc = serverDoc;
  const kept: PendingEdit[] = [];
  const dropped: PendingEdit[] = [];
  for (const edit of queue) {
    try {
      doc = applyOps(doc, edit.ops).doc;
      kept.push(edit);
    } catch (err) {
      if (!(err instanceof OpError)) throw err;
      dropped.push(edit);
    }
  }
  return { doc, kept, dropped };
}
