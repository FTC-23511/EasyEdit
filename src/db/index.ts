import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;

const globalForDb = globalThis as typeof globalThis & { __easyEditDb?: DB };

export function getDb(): DB {
  if (!globalForDb.__easyEditDb) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is not set. Add it to .env.local (see .env.example).");
    }
    globalForDb.__easyEditDb = drizzle(neon(url), { schema });
  }
  return globalForDb.__easyEditDb;
}

export function rowsOf<T = Record<string, unknown>>(result: unknown): T[] {
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  throw new Error("rowsOf: query result has no rows array");
}
