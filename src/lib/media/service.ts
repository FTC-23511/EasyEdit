import { and, asc, desc, eq, getTableColumns, inArray, is, isNull, or, sql, SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { DB } from "@/db";
import { assets } from "@/db/schema";
import { requireRole, type Actor } from "@/lib/actor";
import type { DriveClient } from "@/lib/drive/client";
import { DriveError } from "@/lib/drive/token";
import { LIMITS } from "@/lib/limits";
import { getUserNames } from "@/lib/projects/user-names";
import { ServiceError } from "@/lib/service-error";
import { graphemes, isStorableText } from "@/lib/text";
import { FILE_REFUSALS, MEDIA_MESSAGES } from "./messages";
import { checkFile, cleanName, driveName, probeFits } from "./rules";
import type { AssetKind, AssetView, OpenUploadInput } from "./types";

export type MediaDeps = { db: DB; drive: DriveClient; origin: string };
export type OpenedUpload = { asset: AssetView; uploadUrl: string; offset: number };

type AssetRow = typeof assets.$inferSelect;

const refusedFile = (reason: keyof typeof FILE_REFUSALS) => new ServiceError("INVALID", 400, FILE_REFUSALS[reason]);
const gone = () => new ServiceError("NOT_FOUND", 404, MEDIA_MESSAGES.gone);
const tooManyUnfinished = () => new ServiceError("LIMIT_EXCEEDED", 400, MEDIA_MESSAGES.tooManyUnfinished);

const unfinished = eq(assets.status, "uploading");
const unfinishedOf = (actor: Actor) => and(eq(assets.uploadedBy, actor.userId), unfinished);
const newestFirst = [desc(assets.createdAt), asc(assets.id)];

// An asset as a member sees it. It never holds the session address or the id of a file that is still on its way.
function toView(row: AssetRow, names: Map<string, string>): AssetView {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    fileName: row.fileName,
    sizeBytes: row.sizeBytes,
    status: row.status,
    removed: row.removedAt !== null,
    durationMs: row.durationMs,
    width: row.width,
    height: row.height,
    fps: row.fps,
    hasAudio: row.hasAudio,
    originalFileId: row.status === "ready" ? row.driveFileId : null,
    previewStatus: row.previewStatus,
    previewFileId: row.previewFileId,
    posterFileId: row.posterFileId,
    event: row.event,
    uploadedBy: row.uploadedBy,
    uploadedByName: names.get(row.uploadedBy) ?? MEDIA_MESSAGES.formerMember,
    createdAt: row.createdAt.toISOString(),
  };
}

async function viewsOf(db: DB, rows: AssetRow[]): Promise<AssetView[]> {
  const names = await getUserNames(db, rows.map((row) => row.uploadedBy));
  return rows.map((row) => toView(row, names));
}

const viewOf = async (db: DB, row: AssetRow) => (await viewsOf(db, [row]))[0];

// An event name as it is stored: trimmed, and null when nothing is left.
function eventOf(event: string | undefined): string | null {
  const text = (event ?? "").trim();
  if (text === "") return null;
  if (graphemes(text).length > LIMITS.mediaEventChars || !isStorableText(text)) throw new ServiceError("INVALID", 400, MEDIA_MESSAGES.eventTooLong);
  return text;
}

// A frame rate that a `real` column holds: above 0 and not too large, also once it is rounded to that column.
const isFrameRate = (fps: number) => Math.fround(fps) > 0 && Number.isFinite(Math.fround(fps));

// What the file rules do not look at must still be something the database can hold.
function canBeStored(kind: AssetKind, input: OpenUploadInput): boolean {
  if (!Number.isSafeInteger(input.lastModifiedMs)) return false;
  if (!isStorableText(input.fileName) || !isStorableText(input.mimeType)) return false;
  if (kind !== "video") return true; // a frame rate and a codec are kept only for a video
  const { fps, videoCodec } = input.probe;
  return (fps === null || isFrameRate(fps)) && (videoCodec === null || isStorableText(videoCodec));
}

// The whole of a new row. An `insert … select` has no `default`, so every column is named here, and a column
// added to the table must be given a value before this compiles.
type NewAsset = { [K in keyof AssetRow]: AssetRow[K] | SQL };

// The values of a new row in the table's own column order, each cast to its column's type.
function valuesOf(row: NewAsset): SQL {
  const columns = getTableColumns(assets);
  const values = (Object.keys(columns) as (keyof AssetRow)[]).map((key) => {
    const value = row[key];
    return is(value, SQL) ? value : sql`${sql.param(value, columns[key])}::${sql.raw(columns[key].getSQLType())}`;
  });
  return sql.join(values, sql`, `);
}

// How much of an unfinished upload Drive holds. Null when its session is gone: the row is deleted then.
async function heldByDrive(deps: MediaDeps, row: AssetRow): Promise<{ offset: number; done: boolean } | null> {
  if (row.uploadUrl !== null) {
    try {
      const { done, offset } = await deps.drive.uploadOffset(row.uploadUrl, row.sizeBytes);
      return { done, offset }; // the whole size when Drive says done
    } catch (error) {
      if (!(error instanceof DriveError && error.reason === "expired")) throw error;
    }
  }
  await deps.db.delete(assets).where(and(eq(assets.id, row.id), unfinished));
  return null;
}

// This member's unfinished upload of the same file, taken up where it stopped. Null when there is none, or when
// its session has expired. Unfinished uploads that are too old are dropped first: no screen lists them.
async function takeUpUnfinished(deps: MediaDeps, actor: Actor, input: OpenUploadInput): Promise<OpenedUpload | null> {
  const { db } = deps;
  const tooOld = sql`${assets.createdAt} < now() - ${LIMITS.mediaPendingMaxAgeMs / 1000}::integer * interval '1 second'`;
  await db.delete(assets).where(and(unfinishedOf(actor), tooOld));
  const [row] = await db
    .select()
    .from(assets)
    .where(and(unfinishedOf(actor), eq(assets.fileName, input.fileName), eq(assets.sizeBytes, input.sizeBytes), eq(assets.lastModifiedMs, input.lastModifiedMs)));
  if (!row) return null;
  const held = await heldByDrive(deps, row);
  if (!held || row.uploadUrl === null) return null;
  return { asset: await viewOf(db, row), uploadUrl: row.uploadUrl, offset: held.offset };
}

export async function openUpload(deps: MediaDeps, actor: Actor, input: OpenUploadInput): Promise<OpenedUpload> {
  requireRole(actor, "editor");
  const { db, drive } = deps;
  const checked = checkFile({ name: input.fileName, sizeBytes: input.sizeBytes });
  if (!checked.ok) throw refusedFile(checked.reason);
  const { kind } = checked;
  if (!probeFits(kind, input.probe) || !canBeStored(kind, input)) throw refusedFile("unreadable");
  const event = eventOf(input.event);

  const before = await takeUpUnfinished(deps, actor, input);
  if (before) return before;

  const count = await db.$count(assets, unfinishedOf(actor));
  if (count >= LIMITS.mediaPendingPerMember) throw tooManyUnfinished();

  // The file's id is chosen before the upload, so it is recorded before the browser sends a byte.
  const id = nanoid(12);
  const driveFileId = await drive.newFileId();
  const uploadUrl = await drive.openUploadSession({
    id: driveFileId,
    name: driveName(id, input.fileName),
    parentId: await drive.folderId("Originals"),
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    origin: deps.origin,
  });

  const { probe } = input;
  const isVideo = kind === "video";
  const row: NewAsset = {
    id,
    kind,
    name: cleanName(input.fileName),
    fileName: input.fileName,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    lastModifiedMs: input.lastModifiedMs,
    status: "uploading",
    driveFileId,
    uploadUrl,
    durationMs: kind === "image" ? null : probe.durationMs,
    width: kind === "audio" ? null : probe.width,
    height: kind === "audio" ? null : probe.height,
    fps: isVideo ? probe.fps : null,
    hasAudio: probe.hasAudio,
    videoCodec: isVideo ? probe.videoCodec : null,
    previewStatus: isVideo ? "pending" : "none",
    previewFileId: null,
    posterFileId: null,
    pendingPreviewFileId: null,
    pendingPosterFileId: null,
    event,
    uploadedBy: actor.userId,
    createdAt: sql`now()`,
    readyAt: null,
    removedAt: null,
    removedBy: null,
  };
  // One statement holds the limit and yields to a row for the same file that got there first.
  const [inserted] = await db
    .insert(assets)
    .select(
      sql`select ${valuesOf(row)} where (select count(*) from assets where uploaded_by = ${actor.userId}::text and status = 'uploading') < ${LIMITS.mediaPendingPerMember}::integer`,
    )
    .onConflictDoNothing({ target: [assets.uploadedBy, assets.fileName, assets.sizeBytes, assets.lastModifiedMs], where: sql`status = 'uploading'` })
    .returning();
  if (inserted) return { asset: await viewOf(db, inserted), uploadUrl, offset: 0 };

  // The session opened above is left to expire: no file exists until the last byte.
  const after = await takeUpUnfinished(deps, actor, input);
  if (after) return after;
  throw tooManyUnfinished();
}

// An asset, for the member who uploaded it or for an admin.
async function ownAsset(db: DB, actor: Actor, assetId: string): Promise<AssetRow> {
  requireRole(actor, "editor");
  const [row] = await db.select().from(assets).where(eq(assets.id, assetId));
  if (!row || row.removedAt !== null) throw gone();
  if (row.uploadedBy !== actor.userId) requireRole(actor, "admin");
  return row;
}

export async function uploadOffset(deps: MediaDeps, actor: Actor, assetId: string): Promise<{ uploadUrl: string | null; offset: number; done: boolean }> {
  const row = await ownAsset(deps.db, actor, assetId);
  if (row.status === "ready") return { uploadUrl: null, offset: row.sizeBytes, done: true };
  const held = await heldByDrive(deps, row);
  if (!held) throw new ServiceError("CONFLICT", 409, MEDIA_MESSAGES.sessionExpired);
  return { uploadUrl: row.uploadUrl, ...held };
}

export async function completeUpload(deps: MediaDeps, actor: Actor, assetId: string): Promise<AssetView> {
  const { db, drive } = deps;
  const row = await ownAsset(db, actor, assetId);
  if (row.status === "ready") return viewOf(db, row); // a repeat is not an error

  const file = await drive.getFile(row.driveFileId ?? "");
  if (!file || file.trashed || file.sizeBytes !== row.sizeBytes) throw new ServiceError("CONFLICT", 409, MEDIA_MESSAGES.notFinished);
  // The folder is what places a file in the library. A file's driveId says nothing here: it is the shared drive's.
  if (!file.parents.includes(await drive.folderId("Originals"))) throw new ServiceError("INVALID", 400, MEDIA_MESSAGES.wrongFolder);

  const [ready] = await db
    .update(assets)
    .set({ status: "ready", readyAt: sql`now()`, uploadUrl: null, driveFileId: file.id })
    .where(and(eq(assets.id, assetId), unfinished))
    .returning();
  if (ready) return viewOf(db, ready);
  // Another request finished it first.
  const [now] = await db.select().from(assets).where(eq(assets.id, assetId));
  if (!now) throw gone();
  return viewOf(db, now);
}

export async function listAssets(db: DB, actor: Actor, filter: { ids?: string[] } = {}): Promise<AssetView[]> {
  requireRole(actor, "viewer");
  const ownUnfinished = unfinishedOf(actor);
  if (filter.ids) {
    const ids = [...new Set(filter.ids)];
    if (ids.length > LIMITS.mediaIdsPerRequest) throw new ServiceError("INVALID", 400, MEDIA_MESSAGES.tooManyIds);
    if (ids.length === 0) return [];
    // In any state, removed ones too, but never another member's unfinished upload.
    const named = await db
      .select()
      .from(assets)
      .where(and(inArray(assets.id, ids), or(eq(assets.status, "ready"), ownUnfinished)))
      .orderBy(...newestFirst);
    return viewsOf(db, named);
  }
  const ready = await db
    .select()
    .from(assets)
    .where(and(eq(assets.status, "ready"), isNull(assets.removedAt)))
    .orderBy(...newestFirst)
    .limit(LIMITS.mediaListMax);
  const mine = await db.select().from(assets).where(ownUnfinished).orderBy(...newestFirst);
  return viewsOf(db, [...ready, ...mine]);
}
