import type { DB } from "@/db";
import { user } from "@/db/schema";
import { claudeActorFor, type Actor } from "@/lib/actor";
import type { Role } from "@/lib/allowlist/service";
import { LIMITS, type Limits } from "@/lib/limits";
import type { ToolContext } from "@/lib/mcp/types";
import { applyProjectOps } from "@/lib/projects/service";
import type { OpInput } from "@/lib/timeline";

// A tool context for a member "u1" (or another id), whose user row exists so names resolve.
export async function toolContext(db: DB, over: { id?: string; name?: string; role?: Role; limits?: Partial<Limits> } = {}): Promise<ToolContext> {
  const id = over.id ?? "u1";
  const me = { id, email: `${id}@gmail.com`, name: over.name ?? "Ada Lovelace", image: null, role: over.role ?? ("editor" as Role) };
  await db.insert(user).values({ id, name: me.name, email: me.email, emailVerified: true }).onConflictDoNothing();
  return { db, user: me, actor: claudeActorFor(me), baseUrl: "https://studio.test", limits: { ...LIMITS, ...over.limits }, now: () => new Date() };
}

export const textClip = (start: number, text = "GO SOLVERS", extra: Record<string, unknown> = {}) => ({
  type: "text", start, duration: 30, text,
  transform: { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1, fit: "contain" },
  style: { fontFamily: "Geist", fontSize: 96, fontWeight: 700, color: "#ffffff", align: "center" },
  ...extra,
});
export const addText = (start: number, text?: string, extra?: Record<string, unknown>) => ({ op: "add_clip", trackId: "t1", clip: textClip(start, text, extra) });

// Fills track t1 with `count` back-to-back text clips k0, k1, … in batches of 500. Returns the version reached.
export async function fillWithText(db: DB, actor: Actor, projectId: string, count: number): Promise<number> {
  let version = 0;
  for (let from = 0; from < count; from += 500, version++) {
    const ops = Array.from({ length: Math.min(500, count - from) }, (_, i) => addText((from + i) * 30, `Line ${from + i}`, { id: `k${from + i}` }));
    await applyProjectOps(db, actor, { projectId, baseVersion: version, ops: ops as OpInput[] });
  }
  return version;
}
