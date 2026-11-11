import { createHash } from "node:crypto";

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) if (src[k] !== undefined) out[k] = sortKeys(src[k]);
    return out;
  }
  return value;
}

// JSON with object keys sorted at every level; arrays keep their order; undefined values are left out.
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

// The same call from the same member on the same version always gets the same id, so a retry is not applied twice.
export function editRequestId(parts: { actorId: string; projectId: string; expectedVersion: number; key: unknown }): string {
  const digest = createHash("sha256")
    .update(stableJson([parts.actorId, parts.projectId, parts.expectedVersion, parts.key]))
    .digest("base64url");
  return `c${digest.slice(0, 42)}`;
}
