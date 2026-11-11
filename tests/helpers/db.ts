import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { onTestFinished } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

export async function makeTestDb(): Promise<DB> {
  const client = new PGlite();
  onTestFinished(async () => {
    await client.close();
  });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return db;
}
