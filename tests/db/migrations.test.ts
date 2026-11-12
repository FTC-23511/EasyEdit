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
      expect.arrayContaining(["account", "allowlist", "assets", "project_ops", "projects", "session", "user", "verification"]),
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

  it("has the tables the connector's sign-in needs, and the index the write budget reads", async () => {
    const db = await makeTestDb();
    const tables = rowsOf<{ table_name: string }>(await db.execute(sql`select table_name from information_schema.tables where table_schema = 'public'`)).map((r) => r.table_name);
    expect(tables).toEqual(expect.arrayContaining([
      "jwks", "oauth_client", "oauth_resource", "oauth_client_resource", "oauth_refresh_token",
      "oauth_access_token", "oauth_consent", "oauth_client_assertion", "rate_limit",
    ]));
    const indexes = rowsOf<{ indexname: string }>(await db.execute(sql`select indexname from pg_indexes where tablename = 'project_ops'`)).map((r) => r.indexname);
    expect(indexes).toContain("project_ops_actor_created_at_idx");
  });

  it("assets holds one unfinished upload per member and file, and only the kinds and states it knows", async () => {
    const db = await makeTestDb();
    const columns = rowsOf<{ column_name: string; data_type: string }>(
      await db.execute(sql`select column_name, data_type from information_schema.columns where table_name = 'assets' and column_name in ('size_bytes', 'last_modified_ms', 'fps')`),
    );
    expect(Object.fromEntries(columns.map((c) => [c.column_name, c.data_type]))).toEqual({ size_bytes: "bigint", last_modified_ms: "bigint", fps: "real" }); // a file may be 2 GB
    const indexes = rowsOf<{ indexname: string }>(await db.execute(sql`select indexname from pg_indexes where tablename = 'assets'`)).map((r) => r.indexname);
    expect(indexes).toEqual(expect.arrayContaining(["assets_unfinished_upload_unique", "assets_created_at_idx"]));

    const add = (id: string, over: { kind?: string; status?: string; previewStatus?: string; uploadedBy?: string; sizeBytes?: number } = {}) =>
      db.execute(sql`insert into assets (id, kind, name, file_name, mime_type, size_bytes, last_modified_ms, status, preview_status, uploaded_by)
        values (${id}, ${over.kind ?? "video"}, 'Clip', 'clip.mp4', 'video/mp4', ${over.sizeBytes ?? 2_147_483_648}, 1762800000000, ${over.status ?? "uploading"}, ${over.previewStatus ?? "none"}, ${over.uploadedBy ?? "u1"})`);
    await add("a1");
    await expect(add("a2")).rejects.toThrow(); // the same member, the same file, both unfinished
    await add("a3", { uploadedBy: "u2" });
    await add("a4", { sizeBytes: 5 });
    await add("a5", { status: "ready" });
    await add("a6", { status: "ready" }); // any number of finished copies
    await expect(add("a7", { kind: "gif" })).rejects.toThrow();
    await expect(add("a8", { status: "done", uploadedBy: "u3" })).rejects.toThrow();
    await expect(add("a9", { previewStatus: "soon", uploadedBy: "u3" })).rejects.toThrow();
    const [row] = rowsOf<{ status: string; preview_status: string; has_audio: boolean }>(
      await db.execute(sql`insert into assets (id, kind, name, file_name, mime_type, size_bytes, last_modified_ms, uploaded_by) values ('b1', 'image', 'Field', 'field.jpg', 'image/jpeg', 1, 1, 'u9') returning status, preview_status, has_audio`),
    );
    expect(row).toEqual({ status: "uploading", preview_status: "none", has_audio: false });
  });
});
