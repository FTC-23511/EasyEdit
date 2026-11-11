import { sql } from "drizzle-orm";
import { rowsOf, type DB } from "@/db";

// Imports only the database, so the allowlist service can call it without a cycle.

// Ends a member's connector access in one statement: their tokens and consent, and their website sessions when asked.
// Access tokens tied to a refresh token would also go by cascade; deleting them directly covers the rest.
export async function revokeAccess(
  db: DB,
  who: { email: string } | { userId: string },
  opts: { sessions: boolean },
): Promise<void> {
  const target = "email" in who
    ? sql`select id from "user" where lower(email) = ${who.email.trim().toLowerCase()}`
    : sql`select id from "user" where id = ${who.userId}`;
  const sessions = opts.sessions
    ? sql`, gone_sessions as (delete from session where user_id in (select id from target))`
    : sql``;
  await db.execute(sql`
    with target as (${target})${sessions},
      gone_access as (delete from oauth_access_token where user_id in (select id from target)),
      gone_refresh as (delete from oauth_refresh_token where user_id in (select id from target)),
      gone_consent as (delete from oauth_consent where user_id in (select id from target))
    select 1
  `);
}

// Lowercase emails of the members who have a live grant.
export async function connectedEmails(db: DB): Promise<Set<string>> {
  const rows = rowsOf<{ email: string }>(await db.execute(sql`
    select distinct lower(u.email) as email from oauth_consent c join "user" u on u.id = c.user_id
  `));
  return new Set(rows.map((r) => r.email));
}
