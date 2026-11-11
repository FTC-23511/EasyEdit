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

  it("project_ops has a nullable jsonb inverse column", async () => {
    const db = await makeTestDb();
    const r = await db.execute(sql`select data_type, is_nullable from information_schema.columns where table_name = 'project_ops' and column_name = 'inverse'`);
    expect(rowsOf(r)).toEqual([{ data_type: "jsonb", is_nullable: "YES" }]);
  });

  it("projects has a nullable deleted_at timestamp column", async () => {
    const db = await makeTestDb();
    const r = await db.execute(sql`select data_type, is_nullable from information_schema.columns where table_name = 'projects' and column_name = 'deleted_at'`);
    expect(rowsOf(r)).toEqual([{ data_type: "timestamp without time zone", is_nullable: "YES" }]);
  });

  it("project_ops has a nullable request_id, unique per project", async () => {
    const db = await makeTestDb();
    const column = await db.execute(sql`select data_type, is_nullable from information_schema.columns where table_name = 'project_ops' and column_name = 'request_id'`);
    expect(rowsOf(column)).toEqual([{ data_type: "text", is_nullable: "YES" }]);
    await db.execute(sql`insert into projects (id, name, format, doc, created_by, updated_by) values ('p1', 'P', 'short_9x16', '{}', 'u', 'u'), ('p2', 'P', 'short_9x16', '{}', 'u', 'u')`);
    const log = (project: string, version: number, requestId: string | null) =>
      db.execute(sql`insert into project_ops (project_id, version, ops, actor, request_id) values (${project}, ${version}, '[]', 'u', ${requestId})`);
    await log("p1", 1, null);
    await log("p1", 2, null);
    await log("p1", 3, "req-0001");
    await log("p2", 1, "req-0001");
    await expect(log("p1", 4, "req-0001")).rejects.toThrow();
  });

  it("the allowlist only stores trimmed, lowercase emails", async () => {
    const db = await makeTestDb();
    for (const email of ["Kid@gmail.com", " kid@gmail.com"]) {
      await expect(db.execute(sql`insert into allowlist (email, role) values (${email}, 'viewer')`)).rejects.toThrow();
    }
    await db.execute(sql`insert into allowlist (email, role) values ('kid@gmail.com', 'viewer')`);
    expect(rowsOf(await db.execute(sql`select email from allowlist`))).toEqual([{ email: "kid@gmail.com" }]);
  });
});
