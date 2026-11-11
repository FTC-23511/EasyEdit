import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { rowsOf } from "@/db";
import { makeTestDb } from "../helpers/db";

describe("migrations", () => {
  it("migrations create all tables", async () => {
    const db = await makeTestDb();
    const r = await db.execute(
      sql`select table_name from information_schema.tables where table_schema='public' order by 1`,
    );
    expect(rowsOf<{ table_name: string }>(r).map((x) => x.table_name)).toEqual(
      expect.arrayContaining(["account", "allowlist", "project_ops", "projects", "session", "user", "verification"]),
    );
  });
});
