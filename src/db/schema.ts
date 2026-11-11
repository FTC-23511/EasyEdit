import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, serial, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import type { FormatId, Op, TimelineDoc } from "@/lib/timeline";

export * from "./auth-schema";

export const allowlist = pgTable(
  "allowlist",
  {
    email: text("email").primaryKey(),
    role: text("role", { enum: ["admin", "editor", "viewer"] }).notNull(),
    invitedBy: text("invited_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("allowlist_role_check", sql`${t.role} in ('admin', 'editor', 'viewer')`),
    check("allowlist_email_normalized", sql`${t.email} = lower(trim(${t.email}))`),
  ],
);

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  format: text("format").$type<FormatId>().notNull(),
  doc: jsonb("doc").$type<TimelineDoc>().notNull(),
  version: integer("version").notNull().default(0),
  createdBy: text("created_by").notNull(),
  updatedBy: text("updated_by").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  // Set when the project is deleted; a deleted project is hidden from every read and write.
  deletedAt: timestamp("deleted_at"),
});

export const projectOps = pgTable(
  "project_ops",
  {
    id: serial("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    ops: jsonb("ops").$type<Op[]>().notNull(),
    // Null on rows written before inverses were stored.
    inverse: jsonb("inverse").$type<Op[]>(),
    actor: text("actor").notNull(),
    // Set by a client that may retry a write; a request id is applied at most once per project.
    requestId: text("request_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("project_ops_project_id_version_unique").on(t.projectId, t.version),
    uniqueIndex("project_ops_project_id_request_id_unique").on(t.projectId, t.requestId),
    index("project_ops_actor_created_at_idx").on(t.actor, t.createdAt),
  ],
);
