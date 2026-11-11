import type { DB } from "@/db";
import { getRole, normalizeEmail, ROLE_RANK, type Role } from "@/lib/allowlist/service";

export type CurrentUser = { id: string; email: string; name: string; image: string | null; role: Role };

export type SessionUser = { id: string; email: string; name: string; image?: string | null };

export function meetsRole(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export async function resolveCurrentUser(db: DB, sessionUser: SessionUser | null): Promise<CurrentUser | null> {
  if (!sessionUser) return null;
  const email = normalizeEmail(sessionUser.email);
  const role = await getRole(db, email);
  if (role === null) return null;
  return { id: sessionUser.id, email, name: sessionUser.name, image: sessionUser.image ?? null, role };
}
