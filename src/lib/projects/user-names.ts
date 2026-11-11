import { inArray } from "drizzle-orm";
import type { DB } from "@/db";
import { user } from "@/db/schema";

export async function getUserNames(db: DB, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, unique));
  return new Map(rows.map((row) => [row.id, row.name]));
}
