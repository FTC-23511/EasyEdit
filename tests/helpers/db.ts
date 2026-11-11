import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, onTestFinished } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

// One migrated database per test file; every makeTestDb() call gets its own clone of it.
let template: Promise<PGlite> | undefined;

async function migratedTemplate(): Promise<PGlite> {
  const client = new PGlite();
  await migrate(drizzle(client, { schema }), { migrationsFolder });
  return client;
}

afterAll(async () => {
  if (template) await (await template).close();
});

export async function makeTestDb(): Promise<DB> {
  template ??= migratedTemplate();
  const client = (await (await template).clone()) as PGlite;
  onTestFinished(async () => {
    await client.close();
  });
  return drizzle(client, { schema });
}
