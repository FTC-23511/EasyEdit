import { APIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import { user } from "@/db/schema";
import { getRole, normalizeEmail } from "@/lib/allowlist/service";

// `code` makes Better Auth's OAuth callback redirect to the errorCallbackURL instead of answering with JSON.
function notAllowlisted(): APIError {
  return new APIError("FORBIDDEN", { code: "NOT_ALLOWLISTED", message: "NOT_ALLOWLISTED" });
}

export function makeUserCreateBefore(db: DB) {
  return async <U extends { email: string }>(newUser: U): Promise<{ data: U }> => {
    const email = normalizeEmail(newUser.email);
    if ((await getRole(db, email)) === null) throw notAllowlisted();
    return { data: { ...newUser, email } };
  };
}

export function makeSessionCreateBefore(db: DB) {
  return async (session: { userId: string }): Promise<void> => {
    const rows = await db.select({ email: user.email }).from(user).where(eq(user.id, session.userId));
    const email = rows[0]?.email;
    if (email === undefined || (await getRole(db, email)) === null) throw notAllowlisted();
  };
}
