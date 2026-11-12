import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, pgTable, real, serial, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
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

export const assets = pgTable(
  "assets",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["video", "image", "audio"] }).notNull(),
    name: text("name").notNull(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    lastModifiedMs: bigint("last_modified_ms", { mode: "number" }).notNull(),
    status: text("status", { enum: ["uploading", "ready"] }).notNull().default("uploading"),
    driveFileId: text("drive_file_id"),
    uploadUrl: text("upload_url"), // the session address; a secret; cleared when the upload completes
    durationMs: integer("duration_ms"),
    width: integer("width"), // as shown, after rotation
    height: integer("height"),
    fps: real("fps"),
    hasAudio: boolean("has_audio").notNull().default(false),
    videoCodec: text("video_codec"),
    previewStatus: text("preview_status", { enum: ["none", "pending", "ready", "failed"] }).notNull().default("none"),
    previewFileId: text("preview_file_id"),
    posterFileId: text("poster_file_id"),
    pendingPreviewFileId: text("pending_preview_file_id"), // chosen when that upload was opened; moved over when it completes
    pendingPosterFileId: text("pending_poster_file_id"),
    event: text("event"),
    uploadedBy: text("uploaded_by").notNull(), // a user id
    createdAt: timestamp("created_at").notNull().defaultNow(),
    readyAt: timestamp("ready_at"),
    removedAt: timestamp("removed_at"),
    removedBy: text("removed_by"),
  },
  (t) => [
    check("assets_kind_check", sql`${t.kind} in ('video', 'image', 'audio')`),
    check("assets_status_check", sql`${t.status} in ('uploading', 'ready')`),
    check("assets_preview_status_check", sql`${t.previewStatus} in ('none', 'pending', 'ready', 'failed')`),
    // One unfinished upload per member and file: choosing the same file again finds it.
    uniqueIndex("assets_unfinished_upload_unique").on(t.uploadedBy, t.fileName, t.sizeBytes, t.lastModifiedMs).where(sql`${t.status} = 'uploading'`),
    index("assets_created_at_idx").on(t.createdAt),
  ],
);
