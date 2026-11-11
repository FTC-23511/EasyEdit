import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { rowsOf, type DB } from "@/db";
import { allowlist } from "@/db/schema";

export type Role = "admin" | "editor" | "viewer";

export const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 };

export const SEED_ADMIN_EMAIL = "admin@seattlesolvers.com";

export class AllowlistError extends Error {
  code: "LAST_ADMIN" | "INVALID_EMAIL";
  constructor(code: "LAST_ADMIN" | "INVALID_EMAIL", message: string) {
    super(message);
    this.name = "AllowlistError";
    this.code = code;
  }
}

export function normalizeEmail(e: string): string {
  return e.trim().toLowerCase();
}

function validEmail(e: string): string {
  const email = normalizeEmail(e);
  if (!z.email().safeParse(email).success) {
    throw new AllowlistError("INVALID_EMAIL", `Invalid email: ${e}`);
  }
  return email;
}

// Locks every admin row in a fixed order so concurrent statements that could remove an admin serialize.
const LOCKED_ADMINS = sql`admins as (select email from allowlist where role = 'admin' order by email for update)`;

const lastAdminError = () => new AllowlistError("LAST_ADMIN", "Cannot remove or demote the last admin");

export async function getRole(db: DB, email: string): Promise<Role | null> {
  const rows = await db
    .select({ role: allowlist.role })
    .from(allowlist)
    .where(eq(allowlist.email, normalizeEmail(email)));
  return rows[0]?.role ?? null;
}

export async function listEntries(
  db: DB,
): Promise<{ email: string; role: Role; invitedBy: string | null; createdAt: Date }[]> {
  return db
    .select({
      email: allowlist.email,
      role: allowlist.role,
      invitedBy: allowlist.invitedBy,
      createdAt: allowlist.createdAt,
    })
    .from(allowlist)
    .orderBy(asc(allowlist.createdAt), asc(allowlist.email));
}

export async function addEntry(
  db: DB,
  input: { email: string; role: Role; invitedBy: string },
): Promise<void> {
  const email = validEmail(input.email);
  const invitedBy = normalizeEmail(input.invitedBy);
  // One statement: a conflicting row is only changed if it is not the last admin being demoted.
  const result = await db.execute(sql`
    with ${LOCKED_ADMINS}
    insert into allowlist (email, role, invited_by)
    values (${email}, ${input.role}, ${invitedBy})
    on conflict (email) do update set role = excluded.role
    where allowlist.role <> 'admin'
       or excluded.role = 'admin'
       or (select count(*) from admins) > 1
    returning email
  `);
  if (rowsOf(result).length === 0) throw lastAdminError();
}

export async function setRole(db: DB, email: string, role: Role): Promise<void> {
  const target = normalizeEmail(email);
  const result = await db.execute(sql`
    with ${LOCKED_ADMINS}
    update allowlist set role = ${role}
    where email = ${target}
      and (
        role <> 'admin'
        or ${role} = 'admin'
        or (select count(*) from admins) > 1
      )
    returning email
  `);
  if (rowsOf(result).length > 0) return;
  if ((await getRole(db, target)) !== null) throw lastAdminError();
}

export async function removeEntry(db: DB, email: string): Promise<void> {
  const target = normalizeEmail(email);
  const result = await db.execute(sql`
    with ${LOCKED_ADMINS}
    delete from allowlist
    where email = ${target}
      and (
        role <> 'admin'
        or (select count(*) from admins) > 1
      )
    returning email
  `);
  if (rowsOf(result).length === 0) {
    if ((await getRole(db, target)) !== null) throw lastAdminError();
    return;
  }
  await db.execute(sql`
    delete from session where user_id in (select id from "user" where lower(email) = ${target})
  `);
}

export async function seedAdmin(db: DB): Promise<void> {
  await db.insert(allowlist).values({ email: SEED_ADMIN_EMAIL, role: "admin", invitedBy: null }).onConflictDoNothing();
}
