import { sql } from "drizzle-orm";
import { rowsOf, type DB } from "@/db";
import type { Limits } from "@/lib/limits";

// Each member's Claude has its own allowance, counted from what the database already holds.
// The checks read and the write follows, so two calls at the same instant can both pass. That is accepted.
export type Budget = { ok: true } | { ok: false; message: string };

const OK: Budget = { ok: true };

const tooManyChanges = (count: number, limit: number) =>
  `Too many changes at once: ${count} in the last minute (the limit is ${limit}). Wait a minute, then continue.`;

const DAY_USED_UP =
  "Today's allowance for changes made through Claude is used up. It frees up over the next 24 hours. Editing in the app still works.";

const tooManyProjects = (limit: number) =>
  `Claude has created ${limit} projects for you in the last day, which is the limit. Use an existing project, or create one in the app.`;

// Changes this actor logged in the last minute, and bytes of change data they stored in the last day. One query.
export async function checkWriteBudget(
  db: DB,
  actorId: string,
  limits: Pick<Limits, "connectorWritesPerMinute" | "connectorBytesPerDay">,
): Promise<Budget> {
  const [usage] = rowsOf<{ minute: number | string; bytes: number | string }>(
    await db.execute(sql`
      select
        count(*) filter (where created_at > now() - interval '1 minute') as minute,
        coalesce(sum(pg_column_size(ops) + coalesce(pg_column_size(inverse), 0)), 0) as bytes
      from project_ops
      where actor = ${actorId} and created_at > now() - interval '1 day'
    `),
  );
  const minute = Number(usage.minute);
  if (minute >= limits.connectorWritesPerMinute) return { ok: false, message: tooManyChanges(minute, limits.connectorWritesPerMinute) };
  if (Number(usage.bytes) >= limits.connectorBytesPerDay) return { ok: false, message: DAY_USED_UP };
  return OK;
}

// Projects this actor created in the last day (deleted ones count). One query.
export async function checkProjectBudget(db: DB, actorId: string, limits: Pick<Limits, "connectorProjectsPerDay">): Promise<Budget> {
  const [usage] = rowsOf<{ created: number | string }>(
    await db.execute(sql`
      select count(*) as created
      from projects
      where created_by = ${actorId} and created_at > now() - interval '1 day'
    `),
  );
  if (Number(usage.created) >= limits.connectorProjectsPerDay) return { ok: false, message: tooManyProjects(limits.connectorProjectsPerDay) };
  return OK;
}
