import { and, asc, desc, eq, getTableColumns, inArray, is, isNull, or, sql, SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import { rowsOf, type DB } from "@/db";
import { assets, projects } from "@/db/schema";
import { meetsRole } from "@/lib/access-rules";
import { requireRole, type Actor } from "@/lib/actor";
import type { DriveClient } from "@/lib/drive/client";
import { DriveError } from "@/lib/drive/token";
import { LIMITS } from "@/lib/limits";
import { getUserNames } from "@/lib/projects/user-names";
import { ServiceError } from "@/lib/service-error";
import { graphemes, isStorableText } from "@/lib/text";
import { FILE_REFUSALS, MEDIA_MESSAGES, NAMED_PROJECTS } from "./messages";
import { checkFile, cleanName, driveName, probeFits } from "./rules";
import type { AssetKind, AssetView, OpenUploadInput } from "./types";

// onDriveError: told of each Drive failure that the member is not shown. The service itself prints nothing.
export type MediaDeps = { db: DB; drive: DriveClient; origin: string; onDriveError?: (error: DriveError) => void };
export type OpenedUpload = { asset: AssetView; uploadUrl: string; offset: number };

type AssetRow = typeof assets.$inferSelect;

const refusedFile = (reason: keyof typeof FILE_REFUSALS) => new ServiceError("INVALID", 400, FILE_REFUSALS[reason]);
const gone = () => new ServiceError("NOT_FOUND", 404, MEDIA_MESSAGES.gone);
const tooManyUnfinished = () => new ServiceError("LIMIT_EXCEEDED", 400, MEDIA_MESSAGES.tooManyUnfinished);
const notFinished = () => new ServiceError("CONFLICT", 409, MEDIA_MESSAGES.notFinished);

const unfinished = eq(assets.status, "uploading");
const unfinishedOf = (actor: Actor) => and(eq(assets.uploadedBy, actor.userId), unfinished);
// What a member is shown: every finished asset, and of the unfinished uploads only their own.
const shownTo = (actor: Actor) => or(eq(assets.status, "ready"), unfinishedOf(actor));
// What a member can change: what they are shown, while it is in the library.
const inLibraryFor = (actor: Actor) => and(isNull(assets.removedAt), shownTo(actor));
const newestFirst = [desc(assets.createdAt), asc(assets.id)];

// The browser that was making a preview copy is taken to be gone (a closed tab, or the member left the editor)
// when the copy is still not in this long after the original was. The row stays `pending`, so a copy that
// arrives later still makes it ready.
const previewGivenUp = (row: AssetRow) =>
  row.previewStatus === "pending" && row.readyAt !== null && Date.now() - row.readyAt.getTime() > LIMITS.mediaPreviewWaitMs;

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
    previewStatus: previewGivenUp(row) ? "failed" : row.previewStatus,
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

// A file's type goes to Drive in a request header, so it is short and holds only printable ASCII. It may be
// empty: a browser gives no type for a file it does not know.
const MIME_TYPE_CHARS = 255;
const isSendableType = (mimeType: string) => mimeType.length <= MIME_TYPE_CHARS && /^[\x20-\x7e]*$/.test(mimeType);
// What Drive is told of a file whose type is not known.
const UNKNOWN_TYPE = "application/octet-stream";

// What the file rules do not look at must still be something the database can hold and Drive can be sent.
function canBeStored(kind: AssetKind, input: OpenUploadInput): boolean {
  if (!Number.isSafeInteger(input.lastModifiedMs)) return false;
  if (!isStorableText(input.fileName) || !isSendableType(input.mimeType)) return false;
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

// The error of a statement that failed holds every value the statement was given, and the database's own account
// of it can quote the row. One of the new row's values is the session address, which no error may hold. So what is
// thrown instead keeps the database's five-character error code and nothing else: not the error, not as its cause.
function notRecorded(error: unknown): Error {
  const codes = [error, (error as { cause?: unknown } | null)?.cause].map((from) => (from as { code?: unknown } | null)?.code);
  const code = codes.find((value) => typeof value === "string" && /^[0-9A-Z]{5}$/.test(value));
  return new Error(code ? `The upload could not be recorded (database error ${code}).` : "The upload could not be recorded.");
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
    mimeType: input.mimeType === "" ? UNKNOWN_TYPE : input.mimeType, // the row keeps the type as it was given
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
  let inserted: AssetRow | undefined;
  try {
    [inserted] = await db
      .insert(assets)
      .select(
        sql`select ${valuesOf(row)} where (select count(*) from assets where uploaded_by = ${actor.userId}::text and status = 'uploading') < ${LIMITS.mediaPendingPerMember}::integer`,
      )
      .onConflictDoNothing({ target: [assets.uploadedBy, assets.fileName, assets.sizeBytes, assets.lastModifiedMs], where: sql`status = 'uploading'` })
      .returning();
  } catch (error) {
    throw notRecorded(error);
  }
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
  // The session address goes only to the member who opened the upload. An admin is told how far it has come.
  return { uploadUrl: row.uploadedBy === actor.userId ? row.uploadUrl : null, ...held };
}

export async function completeUpload(deps: MediaDeps, actor: Actor, assetId: string): Promise<AssetView> {
  const { db, drive } = deps;
  const row = await ownAsset(db, actor, assetId);
  if (row.status === "ready") return viewOf(db, row); // a repeat is not an error

  const file = await drive.getFile(row.driveFileId ?? "");
  if (!file || file.trashed || file.sizeBytes !== row.sizeBytes) throw notFinished();
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
  if (filter.ids) {
    const ids = [...new Set(filter.ids)];
    if (ids.length > LIMITS.mediaIdsPerRequest) throw new ServiceError("INVALID", 400, MEDIA_MESSAGES.tooManyIds);
    if (ids.length === 0) return [];
    // In any state, removed ones too, but never another member's unfinished upload.
    const named = await db
      .select()
      .from(assets)
      .where(and(inArray(assets.id, ids), shownTo(actor)))
      .orderBy(...newestFirst);
    return viewsOf(db, named);
  }
  const ready = await db
    .select()
    .from(assets)
    .where(and(eq(assets.status, "ready"), isNull(assets.removedAt)))
    .orderBy(...newestFirst)
    .limit(LIMITS.mediaListMax);
  const mine = await db.select().from(assets).where(unfinishedOf(actor)).orderBy(...newestFirst);
  return viewsOf(db, [...ready, ...mine]);
}

// An asset the member can change: in the library, and not another member's unfinished upload.
async function libraryAsset(db: DB, actor: Actor, assetId: string): Promise<AssetRow> {
  const [row] = await db.select().from(assets).where(and(eq(assets.id, assetId), inLibraryFor(actor)));
  if (!row) throw gone();
  return row;
}

// A name as it is stored: trimmed, and 1 to mediaNameChars characters as a person counts them.
function nameOf(name: string): string {
  const text = name.trim();
  const length = graphemes(text).length;
  if (length < 1 || length > LIMITS.mediaNameChars || !isStorableText(text)) throw new ServiceError("INVALID", 400, MEDIA_MESSAGES.badName);
  return text;
}

export async function updateAsset(db: DB, actor: Actor, assetId: string, patch: { name?: string; event?: string | null }): Promise<AssetView> {
  requireRole(actor, "editor");
  const changes: { name?: string; event?: string | null } = {};
  if (patch.name !== undefined) changes.name = nameOf(patch.name);
  if (patch.event !== undefined) changes.event = patch.event === null ? null : eventOf(patch.event);
  if (Object.keys(changes).length === 0) return viewOf(db, await libraryAsset(db, actor, assetId)); // nothing to change

  const [row] = await db
    .update(assets)
    .set(changes)
    .where(and(eq(assets.id, assetId), inLibraryFor(actor)))
    .returning();
  if (!row) throw gone();
  return viewOf(db, row);
}

// A project that is not deleted and has a clip of this asset on any of its tracks.
const usedBy = (assetId: string) =>
  and(
    isNull(projects.deletedAt),
    sql`jsonb_path_exists(${projects.doc}, '$.tracks[*].clips[*] ? (@.assetId == $id)', jsonb_build_object('id', ${assetId}::text))`,
  );

// Moves files to the trash, each on its own. What the member asked for is done by then, so a Drive failure here
// is not shown to them. It is reported instead: that report is the only record that the file is still in Drive.
// A failure that is not Drive's answer is not hidden: it is thrown once every file has been tried.
async function trashQuietly(deps: MediaDeps, fileIds: (string | null)[]): Promise<void> {
  const tried = await Promise.allSettled(fileIds.filter((id) => id !== null).map((id) => deps.drive.trashFile(id)));
  const failures = tried.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
  const others: unknown[] = [];
  for (const failure of failures) {
    if (failure instanceof DriveError) deps.onDriveError?.(failure);
    else others.push(failure);
  }
  if (others.length > 0) throw others[0];
}

// Cancels an upload session whose row is gone, so no more of its file can be sent. As in trashQuietly, a Drive
// failure is reported and not shown, and any other failure is thrown.
async function cancelQuietly(deps: MediaDeps, sessionUrl: string | null): Promise<void> {
  if (sessionUrl === null) return;
  try {
    await deps.drive.cancelSession(sessionUrl);
  } catch (error) {
    if (!(error instanceof DriveError)) throw error;
    deps.onDriveError?.(error);
  }
}

export async function removeAsset(deps: MediaDeps, actor: Actor, assetId: string): Promise<void> {
  requireRole(actor, "editor");
  const { db } = deps;

  // An unfinished upload is canceled by its uploader or an admin. Its row goes, then its Drive session.
  const mayCancel = meetsRole(actor.role, "admin") ? unfinished : unfinishedOf(actor);
  const canceled = await db
    .delete(assets)
    .where(and(eq(assets.id, assetId), mayCancel))
    .returning({ uploadUrl: assets.uploadUrl });
  if (canceled.length > 0) return cancelQuietly(deps, canceled[0].uploadUrl);

  // One statement looks for a project that uses the asset and marks it, so none can take it up in between.
  const marked = rowsOf<Record<string, string | null>>(
    await db.execute(sql`
      update assets set removed_at = now(), removed_by = ${actor.userId}::text
      where id = ${assetId}::text and status = 'ready' and removed_at is null
        and not exists (select 1 from ${projects} where ${usedBy(assetId)})
      returning drive_file_id, preview_file_id, poster_file_id
    `),
  );
  if (marked.length > 0) return trashQuietly(deps, Object.values(marked[0]));

  // Nothing was marked. Why not?
  const [row] = await db.select().from(assets).where(eq(assets.id, assetId));
  if (!row || row.removedAt !== null) throw gone();
  if (row.status !== "ready") requireRole(actor, "admin"); // another member's unfinished upload
  const users = await db
    .select({ name: projects.name, total: sql<number>`count(*) over ()`.mapWith(Number) })
    .from(projects)
    .where(usedBy(assetId))
    .orderBy(sql`lower(${projects.name})`, asc(projects.name), asc(projects.id))
    .limit(NAMED_PROJECTS);
  // The last project let go of it between the two looks.
  if (users.length === 0) throw new ServiceError("CONFLICT", 409, MEDIA_MESSAGES.usedAMomentAgo);
  const names = users.map((project) => project.name);
  throw new ServiceError("CONFLICT", 409, MEDIA_MESSAGES.usedIn(names, users[0].total));
}

export type AssetFileRole = "preview" | "poster";

// What is made from an original in the browser and kept in `Previews`.
type AssetFile = {
  kinds: AssetKind[]; // the assets that have one
  maxBytes: number;
  suffix: string; // its name in Drive is `<assetId>.<suffix>`
  mimeType: string;
  column: "previewFileId" | "posterFileId"; // holds its id once it is in
  pendingColumn: "pendingPreviewFileId" | "pendingPosterFileId"; // and while it is on its way
  waitFor: (fileId: string) => Partial<NewAsset>; // records the id of one that is on its way
  moveOver: Partial<NewAsset>; // makes the one that was on its way the one that is in
};

const ASSET_FILES: Record<AssetFileRole, AssetFile> = {
  preview: {
    kinds: ["video"],
    maxBytes: LIMITS.mediaFileBytes,
    suffix: "preview.mp4",
    mimeType: "video/mp4",
    column: "previewFileId",
    pendingColumn: "pendingPreviewFileId",
    waitFor: (fileId) => ({ pendingPreviewFileId: fileId }),
    moveOver: { previewFileId: sql`${assets.pendingPreviewFileId}`, pendingPreviewFileId: null, previewStatus: "ready" },
  },
  poster: {
    kinds: ["video", "image"],
    maxBytes: LIMITS.mediaPosterBytes,
    suffix: "poster.jpg",
    mimeType: "image/jpeg",
    column: "posterFileId",
    pendingColumn: "pendingPosterFileId",
    waitFor: (fileId) => ({ pendingPosterFileId: fileId }),
    moveOver: { posterFileId: sql`${assets.pendingPosterFileId}`, pendingPosterFileId: null },
  },
};

export async function openAssetFile(deps: MediaDeps, actor: Actor, assetId: string, input: { role: AssetFileRole; sizeBytes: number }): Promise<{ uploadUrl: string }> {
  requireRole(actor, "editor");
  const { db, drive } = deps;
  const row = await libraryAsset(db, actor, assetId);
  if (row.status !== "ready") throw notFinished();
  const file = ASSET_FILES[input.role];
  if (!file.kinds.includes(row.kind)) throw new ServiceError("INVALID", 400, MEDIA_MESSAGES.wrongFileRole);
  const { sizeBytes } = input;
  if (!Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > file.maxBytes) throw new ServiceError("INVALID", 400, MEDIA_MESSAGES.badFileSize);

  // As for an original, the file's id is chosen first and recorded before the browser sends a byte.
  const fileId = await drive.newFileId();
  const uploadUrl = await drive.openUploadSession({
    id: fileId,
    name: `${row.id}.${file.suffix}`,
    parentId: await drive.folderId("Previews"),
    mimeType: file.mimeType,
    sizeBytes,
    origin: deps.origin,
  });
  // Opening again replaces the id of the file that was on its way.
  const recorded = await db
    .update(assets)
    .set(file.waitFor(fileId))
    .where(and(eq(assets.id, row.id), isNull(assets.removedAt)))
    .returning({ id: assets.id });
  if (recorded.length === 0) throw gone(); // removed while Drive was being asked
  return { uploadUrl };
}

export async function completeAssetFile(deps: MediaDeps, actor: Actor, assetId: string, role: AssetFileRole): Promise<AssetView> {
  requireRole(actor, "editor");
  const { db, drive } = deps;
  const file = ASSET_FILES[role];
  const row = await libraryAsset(db, actor, assetId);
  const fileId = row[file.pendingColumn];
  if (fileId === null) {
    if (row[file.column] !== null) return viewOf(db, row); // a repeat once the file is in is not an error
    throw notFinished(); // none was opened
  }

  const inDrive = await drive.getFile(fileId);
  const whole = inDrive !== null && !inDrive.trashed && inDrive.sizeBytes > 0;
  if (!whole || !inDrive.parents.includes(await drive.folderId("Previews"))) throw notFinished();

  // One statement moves the id over, and only while this file is still the one on its way.
  const [moved] = await db
    .update(assets)
    .set(file.moveOver)
    .where(and(eq(assets.id, row.id), eq(assets[file.pendingColumn], fileId), isNull(assets.removedAt)))
    .returning();
  if (!moved) {
    await libraryAsset(db, actor, row.id); // gone, when it was removed while Drive was being asked
    throw notFinished(); // or a newer file took this one's place
  }
  await trashQuietly(deps, [row[file.column]]); // the file that was there before
  return viewOf(db, moved);
}

export async function failPreview(db: DB, actor: Actor, assetId: string): Promise<AssetView> {
  requireRole(actor, "editor");
  const [failed] = await db
    .update(assets)
    .set({ previewStatus: "failed" })
    .where(and(eq(assets.id, assetId), inLibraryFor(actor), eq(assets.previewStatus, "pending")))
    .returning();
  // A preview copy that is in, or that failed before, is left as it is.
  return viewOf(db, failed ?? (await libraryAsset(db, actor, assetId)));
}

// What a project check needs to know about an asset. No role check: callers have checked the actor already.
export type AssetFact = { id: string; kind: AssetKind; ready: boolean; removed: boolean; durationMs: number | null };

// A fact for every id that has a row, removed assets and unfinished uploads included.
export async function loadAssetFacts(db: DB, ids: string[]): Promise<Map<string, AssetFact>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: assets.id, kind: assets.kind, status: assets.status, removedAt: assets.removedAt, durationMs: assets.durationMs })
    .from(assets)
    .where(inArray(assets.id, unique));
  return new Map(rows.map((row) => [row.id, { id: row.id, kind: row.kind, ready: row.status === "ready", removed: row.removedAt !== null, durationMs: row.durationMs }]));
}
