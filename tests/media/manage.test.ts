import { sql, type SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { rowsOf, type DB } from "@/db";
import type { Actor } from "@/lib/actor";
import { LIMITS } from "@/lib/limits";
import { completeAssetFile, failPreview, listAssets, loadAssetFacts, openAssetFile, openUpload, removeAsset, updateAsset, type AssetFileRole } from "@/lib/media/service";
import { applyProjectOps, createProject, deleteProject, getProject } from "@/lib/projects/service";
import type { OpInput } from "@/lib/timeline";
import { AUDIO, CLIP_TRANSFORM, IMAGE, VIDEO, mediaClip, mediaContext, readyAsset, sendAll, type MediaContext } from "./context";

const GONE = { code: "NOT_FOUND", status: 404, message: "That file is no longer in the library." };
const NOT_FINISHED = { code: "CONFLICT", status: 409, message: "The upload is not finished." };
const FORBIDDEN = { code: "FORBIDDEN", status: 403 };
const BAD_NAME = { code: "INVALID", status: 400, message: "Enter a name up to 120 characters." };
const BAD_EVENT = { code: "INVALID", status: 400, message: "An event name can be up to 80 characters." };
const WRONG_ROLE = { code: "INVALID", status: 400, message: "A preview copy is for a video, and a still picture for a video or an image." };
const BAD_SIZE = { code: "INVALID", status: 400, message: "That file is empty or too large." };
const POSTER_BYTES = 200_000;
const LATER = { ...VIDEO, fileName: "later.mov" }; // a second video, for an upload that is left unfinished

type Row = {
  status: string;
  name: string;
  event: string | null;
  preview_status: string;
  preview_file_id: string | null;
  poster_file_id: string | null;
  pending_preview_file_id: string | null;
  pending_poster_file_id: string | null;
  removed_at: unknown;
  removed_by: string | null;
};

const rows = async <T = Record<string, unknown>>(ctx: MediaContext, query: SQL) => rowsOf<T>(await ctx.db.execute(query));
const rowOf = async (ctx: MediaContext, id: string) => (await rows<Row>(ctx, sql`select * from assets where id = ${id}`))[0];
const assetCount = async (ctx: MediaContext) => (await rows<{ n: number }>(ctx, sql`select count(*)::int as n from assets`))[0].n;
const trashCalls = (ctx: MediaContext) => ctx.fake.calls.filter((call) => call.method === "PATCH").length;
const isTrashed = (ctx: MediaContext, fileId: string | null) => ctx.fake.files.get(fileId ?? "")?.trashed;
const viewOf = async (ctx: MediaContext, id: string, actor: Actor = ctx.ada) => (await listAssets(ctx.db, actor, { ids: [id] }))[0];

async function projectUsing(ctx: MediaContext, name: string, assetId: string) {
  const { id } = await createProject(ctx.db, ctx.ada, { name, format: "short_9x16" });
  await applyProjectOps(ctx.db, ctx.ada, { projectId: id, baseVersion: 0, ops: [{ op: "add_clip", trackId: "v1", clip: mediaClip(assetId) }] as OpInput[] });
  return id;
}

// Takes every clip of a project off its timeline.
async function emptyProject(ctx: MediaContext, projectId: string) {
  const project = (await getProject(ctx.db, ctx.ada, projectId))!;
  const ops = project.doc.tracks.flatMap((track) => track.clips.map((clip) => ({ op: "remove_clip", clipId: clip.id })));
  await applyProjectOps(ctx.db, ctx.ada, { projectId, baseVersion: project.version, ops: ops as OpInput[] });
}

// A preview copy or a still picture from its first byte to the asset's view: open, send, complete.
async function sendFile(ctx: MediaContext, assetId: string, role: AssetFileRole, sizeBytes = role === "preview" ? 3_000_000 : POSTER_BYTES) {
  const { uploadUrl } = await openAssetFile(ctx.deps, ctx.ada, assetId, { role, sizeBytes });
  await sendAll(ctx.fake, uploadUrl, sizeBytes);
  const view = await completeAssetFile(ctx.deps, ctx.ada, assetId, role);
  return { view, fileId: ctx.fake.sessions.get(uploadUrl)!.fileId };
}

// The same database, with `meanwhile` run once, as soon as the first statement sent with `execute` has been answered.
function afterFirstExecute(db: DB, meanwhile: () => Promise<unknown>): DB {
  let waiting = true;
  return new Proxy(db, {
    get(target, key) {
      if (key === "execute") {
        return async (query: SQL) => {
          const result = await target.execute(query);
          if (waiting) {
            waiting = false;
            await meanwhile();
          }
          return result;
        };
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("renaming an asset and setting its event", () => {
  it("renames an asset and sets its event", async () => {
    const ctx = await mediaContext();
    const asset = await readyAsset(ctx);
    const renamed = await updateAsset(ctx.db, ctx.ada, asset.id, { name: "  Climb, take 2 ", event: "Qualifier 2026-11-08" });
    expect(renamed).toEqual({ ...asset, name: "Climb, take 2", event: "Qualifier 2026-11-08" });
    expect((await updateAsset(ctx.db, ctx.ada, asset.id, { event: null })).event).toBeNull();
    expect((await updateAsset(ctx.db, ctx.ada, asset.id, { event: "  Regionals " })).event).toBe("Regionals");
    expect((await updateAsset(ctx.db, ctx.ada, asset.id, { event: "  " })).event).toBeNull();
    await expect(updateAsset(ctx.db, ctx.ada, asset.id, { name: "" })).rejects.toMatchObject(BAD_NAME);
    await expect(updateAsset(ctx.db, ctx.ada, asset.id, { name: "n".repeat(121) })).rejects.toMatchObject(BAD_NAME);
    await expect(updateAsset(ctx.db, ctx.ada, asset.id, { event: "e".repeat(81) })).rejects.toMatchObject(BAD_EVENT);
    await expect(updateAsset(ctx.db, ctx.vera, asset.id, { name: "Mine now" })).rejects.toMatchObject(FORBIDDEN);
    expect(await listAssets(ctx.db, ctx.vera)).toEqual([{ ...asset, name: "Climb, take 2", event: null }]); // nothing refused was kept
  });

  it("changes only what the patch names, for any editor", async () => {
    const ctx = await mediaContext();
    const asset = await readyAsset(ctx);
    const other = await readyAsset(ctx, ctx.ada, IMAGE);
    const named = await updateAsset(ctx.db, ctx.grace, asset.id, { name: "Climb", event: "Regionals" });
    expect(await updateAsset(ctx.db, ctx.grace, asset.id, { name: "Hang" })).toEqual({ ...named, name: "Hang" });
    expect(await updateAsset(ctx.db, ctx.grace, asset.id, { event: "State" })).toEqual({ ...named, name: "Hang", event: "State" });
    expect(await updateAsset(ctx.db, ctx.grace, asset.id, {})).toEqual({ ...named, name: "Hang", event: "State" });
    expect(await updateAsset(ctx.db, ctx.grace, asset.id, { name: undefined, event: undefined })).toEqual({ ...named, name: "Hang", event: "State" });
    expect(await rowOf(ctx, asset.id)).toMatchObject({ name: "Hang", event: "State", status: "ready" });
    expect(await viewOf(ctx, other.id)).toEqual(other); // and only the asset that was named
  });

  it("counts a name and an event as a person counts them, and takes only text that can be stored", async () => {
    const ctx = await mediaContext();
    const asset = await readyAsset(ctx);
    const thumbs = "👍🏽"; // one character to a person, four to JavaScript
    expect((await updateAsset(ctx.db, ctx.ada, asset.id, { name: "n" })).name).toBe("n");
    expect((await updateAsset(ctx.db, ctx.ada, asset.id, { name: ` ${thumbs.repeat(120)} ` })).name).toBe(thumbs.repeat(120));
    expect((await updateAsset(ctx.db, ctx.ada, asset.id, { event: ` ${thumbs.repeat(80)} ` })).event).toBe(thumbs.repeat(80));
    for (const name of ["   ", "\n\t", thumbs.repeat(121), "a\u0000b", "half \ud83d"]) {
      await expect(updateAsset(ctx.db, ctx.ada, asset.id, { name }), JSON.stringify(name)).rejects.toMatchObject(BAD_NAME);
    }
    for (const event of [thumbs.repeat(81), "a\u0000b", "half \ud83d"]) {
      await expect(updateAsset(ctx.db, ctx.ada, asset.id, { event }), JSON.stringify(event)).rejects.toMatchObject(BAD_EVENT);
    }
    // A bad half of a patch keeps the good half out too.
    await expect(updateAsset(ctx.db, ctx.ada, asset.id, { name: "Fine", event: "e".repeat(81) })).rejects.toMatchObject(BAD_EVENT);
    expect(await rowOf(ctx, asset.id)).toMatchObject({ name: thumbs.repeat(120), event: thumbs.repeat(80) });
  });

  it("finds no removed or unknown asset to rename, and nobody else's unfinished upload", async () => {
    const ctx = await mediaContext();
    const removed = await readyAsset(ctx);
    await removeAsset(ctx.deps, ctx.ada, removed.id);
    await expect(updateAsset(ctx.db, ctx.ada, removed.id, { name: "Back" })).rejects.toMatchObject(GONE);
    await expect(updateAsset(ctx.db, ctx.ada, removed.id, {})).rejects.toMatchObject(GONE);
    await expect(updateAsset(ctx.db, ctx.ada, "nope", { name: "New" })).rejects.toMatchObject(GONE);
    await expect(updateAsset(ctx.db, ctx.ada, "nope", {})).rejects.toMatchObject(GONE);
    expect((await rowOf(ctx, removed.id)).name).toBe(removed.name);

    const { asset: unfinished } = await openUpload(ctx.deps, ctx.ada, LATER);
    for (const other of [ctx.grace, ctx.root]) {
      await expect(updateAsset(ctx.db, other, unfinished.id, { name: "Theirs" })).rejects.toMatchObject(GONE);
      await expect(updateAsset(ctx.db, other, unfinished.id, {})).rejects.toMatchObject(GONE);
    }
    expect(await updateAsset(ctx.db, ctx.ada, unfinished.id, { name: "Mine" })).toMatchObject({ name: "Mine", status: "uploading" });
    // A viewer is told about the role, not about which files exist.
    await expect(updateAsset(ctx.db, ctx.vera, "nope", { name: "New" })).rejects.toMatchObject(FORBIDDEN);
  });
});

describe("removing an asset", () => {
  it("removes an asset nobody uses, and moves its three files to the trash", async () => {
    const ctx = await mediaContext();
    const asset = await readyAsset(ctx);
    const other = await readyAsset(ctx, ctx.ada, IMAGE);
    const preview = await sendFile(ctx, asset.id, "preview");
    const poster = await sendFile(ctx, asset.id, "poster");
    await expect(removeAsset(ctx.deps, ctx.ada, asset.id)).resolves.toBeUndefined();
    for (const fileId of [asset.originalFileId, preview.fileId, poster.fileId]) expect(isTrashed(ctx, fileId), String(fileId)).toBe(true);
    expect(trashCalls(ctx)).toBe(3);
    expect((await listAssets(ctx.db, ctx.ada)).map((a) => a.id)).toEqual([other.id]);
    expect(await listAssets(ctx.db, ctx.ada, { ids: [asset.id] })).toMatchObject([{ id: asset.id, removed: true }]);
    await expect(removeAsset(ctx.deps, ctx.ada, asset.id)).rejects.toMatchObject(GONE);
    expect(trashCalls(ctx)).toBe(3);
    // The other asset is untouched.
    expect(await rowOf(ctx, other.id)).toMatchObject({ removed_at: null, removed_by: null });
    expect(isTrashed(ctx, other.originalFileId)).toBe(false);
  });

  it("lets any editor remove a ready asset, records who did, and lets no viewer", async () => {
    const ctx = await mediaContext();
    const asset = await readyAsset(ctx); // ada's, with no preview copy or still picture: one file to trash
    await expect(removeAsset(ctx.deps, ctx.vera, asset.id)).rejects.toMatchObject(FORBIDDEN);
    await expect(removeAsset(ctx.deps, ctx.vera, "nope")).rejects.toMatchObject(FORBIDDEN);
    expect(await rowOf(ctx, asset.id)).toMatchObject({ removed_at: null, removed_by: null });
    await removeAsset(ctx.deps, ctx.grace, asset.id);
    const row = await rowOf(ctx, asset.id);
    expect(row).toMatchObject({ status: "ready", removed_by: ctx.grace.userId });
    expect(row.removed_at).not.toBeNull();
    expect(isTrashed(ctx, asset.originalFileId)).toBe(true);
    expect(trashCalls(ctx)).toBe(1);
    await expect(removeAsset(ctx.deps, ctx.ada, "nope")).rejects.toMatchObject(GONE);
    expect(await assetCount(ctx)).toBe(1); // a removed asset keeps its row
  });

  it("refuses to remove an asset a project uses, and names the projects", async () => {
    const ctx = await mediaContext();
    const asset = await readyAsset(ctx);
    const recap = await projectUsing(ctx, "Qualifier recap", asset.id);
    const reveal = await projectUsing(ctx, "Robot reveal", asset.id);
    await expect(removeAsset(ctx.deps, ctx.ada, asset.id)).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
      message: 'Used in 2 projects: "Qualifier recap", "Robot reveal". Remove it from those projects first.',
    });
    expect(trashCalls(ctx)).toBe(0);
    expect(isTrashed(ctx, asset.originalFileId)).toBe(false);
    expect(await rowOf(ctx, asset.id)).toMatchObject({ removed_at: null, removed_by: null });

    await deleteProject(ctx.db, ctx.ada, recap);
    await expect(removeAsset(ctx.deps, ctx.ada, asset.id)).rejects.toMatchObject({ code: "CONFLICT", message: 'Used in 1 project: "Robot reveal". Remove it from that project first.' });

    await emptyProject(ctx, reveal);
    await expect(removeAsset(ctx.deps, ctx.ada, asset.id)).resolves.toBeUndefined();
    expect(isTrashed(ctx, asset.originalFileId)).toBe(true);
  });

  it("names at most three projects", async () => {
    const ctx = await mediaContext();
    const asset = await readyAsset(ctx);
    const ids: Record<string, string> = {};
    for (const name of ["D", "B", "E", "A", "C"]) ids[name] = await projectUsing(ctx, name, asset.id);
    await expect(removeAsset(ctx.deps, ctx.ada, asset.id)).rejects.toMatchObject({ message: 'Used in 5 projects: "A", "B", "C" and 2 more. Remove it from those projects first.' });
    await deleteProject(ctx.db, ctx.ada, ids.A);
    await expect(removeAsset(ctx.deps, ctx.ada, asset.id)).rejects.toMatchObject({ message: 'Used in 4 projects: "B", "C", "D" and 1 more. Remove it from those projects first.' });
    await deleteProject(ctx.db, ctx.ada, ids.C);
    await expect(removeAsset(ctx.deps, ctx.ada, asset.id)).rejects.toMatchObject({ message: 'Used in 3 projects: "B", "D", "E". Remove it from those projects first.' });
  });

  it("finds the asset in any clip of any track, counts a project once, and passes over projects that use other assets", async () => {
    const ctx = await mediaContext();
    const asset = await readyAsset(ctx);
    const other = await readyAsset(ctx, ctx.ada, LATER);
    // A project that uses the other asset, and has this one's id only as the words of a text clip.
    const zebra = await projectUsing(ctx, "zebra", other.id);
    const words = { type: "text", text: asset.id, start: 0, duration: 30, transform: CLIP_TRANSFORM, style: { fontFamily: "Geist", fontSize: 64, fontWeight: 700, color: "#ffffff", align: "center" } };
    await applyProjectOps(ctx.db, ctx.ada, { projectId: zebra, baseVersion: 1, ops: [{ op: "add_clip", trackId: "t1", clip: words }] as OpInput[] });
    // A project that has it twice, on its last track, after a clip of the other asset.
    const { id } = await createProject(ctx.db, ctx.ada, { name: 'apple "pie"', format: "long_16x9" });
    const ops = [
      { op: "add_track", track: { id: "o1", kind: "overlay", name: "Overlay 1" } },
      { op: "add_clip", trackId: "v1", clip: mediaClip(other.id) },
      { op: "add_clip", trackId: "o1", clip: mediaClip(other.id) },
      { op: "add_clip", trackId: "o1", clip: mediaClip(asset.id, { start: 200 }) },
      { op: "add_clip", trackId: "o1", clip: mediaClip(asset.id, { start: 400 }) },
    ];
    await applyProjectOps(ctx.db, ctx.ada, { projectId: id, baseVersion: 0, ops: ops as OpInput[] });
    await expect(removeAsset(ctx.deps, ctx.ada, asset.id)).rejects.toMatchObject({ message: 'Used in 1 project: "apple "pie"". Remove it from that project first.' });
    // Alphabetical as a person reads it: a capital letter does not come first.
    await projectUsing(ctx, "Zebra crossing", asset.id);
    await projectUsing(ctx, "banana", asset.id);
    await expect(removeAsset(ctx.deps, ctx.ada, asset.id)).rejects.toMatchObject({ message: 'Used in 3 projects: "apple "pie"", "banana", "Zebra crossing". Remove it from those projects first.' });
    // The other asset is used by two projects of its own.
    await expect(removeAsset(ctx.deps, ctx.ada, other.id)).rejects.toMatchObject({ message: 'Used in 2 projects: "apple "pie"", "zebra". Remove it from those projects first.' });
  });

  it("asks for another try when the last project let go of the asset just as it was refused", async () => {
    const ctx = await mediaContext();
    const asset = await readyAsset(ctx);
    const project = await projectUsing(ctx, "Qualifier recap", asset.id);
    const db = afterFirstExecute(ctx.db, () => emptyProject(ctx, project));
    await expect(removeAsset({ ...ctx.deps, db }, ctx.ada, asset.id)).rejects.toMatchObject({ code: "CONFLICT", status: 409, message: "A project was using that file a moment ago. Try again." });
    expect(await rowOf(ctx, asset.id)).toMatchObject({ removed_at: null });
    await expect(removeAsset(ctx.deps, ctx.ada, asset.id)).resolves.toBeUndefined();
  });

  it("says the asset is gone when someone else removed it at the same moment", async () => {
    const ctx = await mediaContext();
    const asset = await readyAsset(ctx);
    const [first, second] = await Promise.allSettled([removeAsset(ctx.deps, ctx.ada, asset.id), removeAsset(ctx.deps, ctx.grace, asset.id)]);
    expect([first.status, second.status].sort()).toEqual(["fulfilled", "rejected"]);
    expect([first, second].find((result) => result.status === "rejected")).toMatchObject({ reason: GONE });
    expect(trashCalls(ctx)).toBe(1);
  });

  it("removal still succeeds when Drive does not answer", async () => {
    const ctx = await mediaContext();
    const asset = await readyAsset(ctx);
    const preview = await sendFile(ctx, asset.id, "preview");
    const poster = await sendFile(ctx, asset.id, "poster");
    ctx.fake.failNext(/PATCH/, 500);
    await expect(removeAsset(ctx.deps, ctx.ada, asset.id)).resolves.toBeUndefined();
    expect(await listAssets(ctx.db, ctx.ada)).toEqual([]);
    expect((await viewOf(ctx, asset.id)).removed).toBe(true);
    // One file that could not be trashed does not keep the other two.
    expect([asset.originalFileId, preview.fileId, poster.fileId].map((fileId) => isTrashed(ctx, fileId)).sort()).toEqual([false, true, true]);

    // Nor does a Drive that cannot be reached at all.
    const second = await readyAsset(ctx, ctx.ada, IMAGE);
    const drive = { ...ctx.deps.drive, trashFile: () => Promise.reject(new TypeError("fetch failed")) };
    await expect(removeAsset({ ...ctx.deps, drive }, ctx.ada, second.id)).resolves.toBeUndefined();
    expect((await viewOf(ctx, second.id)).removed).toBe(true);
  });

  it("cancels an unfinished upload", async () => {
    const ctx = await mediaContext();
    const mine = await openUpload(ctx.deps, ctx.ada, VIDEO);
    const kept = await openUpload(ctx.deps, ctx.ada, LATER);
    await expect(removeAsset(ctx.deps, ctx.grace, mine.asset.id)).rejects.toMatchObject(FORBIDDEN);
    await expect(removeAsset(ctx.deps, { ...ctx.ada, role: "viewer" }, mine.asset.id)).rejects.toMatchObject(FORBIDDEN); // the uploader, since made a viewer
    expect(await assetCount(ctx)).toBe(2);
    await removeAsset(ctx.deps, ctx.ada, mine.asset.id);
    expect(await rows(ctx, sql`select count(*)::int as n from assets where id = ${mine.asset.id}`)).toEqual([{ n: 0 }]);
    expect((await listAssets(ctx.db, ctx.ada)).map((a) => a.id)).toEqual([kept.asset.id]); // only that upload
    await expect(removeAsset(ctx.deps, ctx.ada, mine.asset.id)).rejects.toMatchObject(GONE);

    const hers = await openUpload(ctx.deps, ctx.grace, VIDEO);
    await removeAsset(ctx.deps, ctx.root, hers.asset.id);
    expect(await rows(ctx, sql`select count(*)::int as n from assets where id = ${hers.asset.id}`)).toEqual([{ n: 0 }]);
    expect(trashCalls(ctx)).toBe(0); // nothing is in Drive yet
  });

  it("cancels an upload whose bytes are all in Drive but which was never completed", async () => {
    const ctx = await mediaContext();
    const { asset, uploadUrl } = await openUpload(ctx.deps, ctx.ada, VIDEO);
    await sendAll(ctx.fake, uploadUrl, VIDEO.sizeBytes);
    await removeAsset(ctx.deps, ctx.ada, asset.id);
    expect(await assetCount(ctx)).toBe(0);
    expect(trashCalls(ctx)).toBe(0);
  });
});

describe("the preview copy's and the still picture's files", () => {
  it("takes a preview copy and a still picture through their own sessions", async () => {
    const ctx = await mediaContext();
    const asset = await readyAsset(ctx);
    const other = await readyAsset(ctx, ctx.ada, { ...VIDEO, fileName: "other.mov" });
    const previews = await ctx.deps.drive.folderId("Previews");
    expect(previews).not.toBe(await ctx.deps.drive.folderId("Originals"));

    const preview = await openAssetFile(ctx.deps, ctx.ada, asset.id, { role: "preview", sizeBytes: 3_000_000 });
    expect(Object.keys(preview)).toEqual(["uploadUrl"]);
    const previewSession = ctx.fake.sessions.get(preview.uploadUrl)!;
    expect(previewSession).toMatchObject({ parentId: previews, name: `${asset.id}.preview.mp4`, mimeType: "video/mp4", sizeBytes: 3_000_000, origin: "https://app.test" });
    expect(await rowOf(ctx, other.id)).toMatchObject({ pending_preview_file_id: null, pending_poster_file_id: null }); // only the asset that was named
    await expect(completeAssetFile(ctx.deps, ctx.ada, asset.id, "preview")).rejects.toMatchObject(NOT_FINISHED); // before the bytes
    await sendAll(ctx.fake, preview.uploadUrl, 3_000_000);
    const withPreview = await completeAssetFile(ctx.deps, ctx.ada, asset.id, "preview");
    expect(withPreview).toEqual({ ...asset, previewStatus: "ready", previewFileId: previewSession.fileId });

    const poster = await openAssetFile(ctx.deps, ctx.grace, asset.id, { role: "poster", sizeBytes: POSTER_BYTES });
    expect(Object.keys(poster)).toEqual(["uploadUrl"]);
    const posterSession = ctx.fake.sessions.get(poster.uploadUrl)!;
    expect(posterSession).toMatchObject({ parentId: previews, name: `${asset.id}.poster.jpg`, mimeType: "image/jpeg", sizeBytes: POSTER_BYTES, origin: "https://app.test" });
    await expect(completeAssetFile(ctx.deps, ctx.grace, asset.id, "poster")).rejects.toMatchObject(NOT_FINISHED);
    await sendAll(ctx.fake, poster.uploadUrl, POSTER_BYTES);
    expect(await completeAssetFile(ctx.deps, ctx.grace, asset.id, "poster")).toEqual({ ...withPreview, posterFileId: posterSession.fileId });

    expect(await rowOf(ctx, asset.id)).toMatchObject({ pending_preview_file_id: null, pending_poster_file_id: null, preview_file_id: previewSession.fileId, poster_file_id: posterSession.fileId });
    expect(isTrashed(ctx, previewSession.fileId)).toBe(false);
    expect(isTrashed(ctx, posterSession.fileId)).toBe(false);
    expect(trashCalls(ctx)).toBe(0); // there was no older file to trash
    expect(await viewOf(ctx, other.id)).toEqual(other);
  });

  it("a still picture changes nothing about the preview copy, and an image can have one", async () => {
    const ctx = await mediaContext();
    const video = await readyAsset(ctx);
    const { view, fileId } = await sendFile(ctx, video.id, "poster");
    expect(view).toEqual({ ...video, posterFileId: fileId }); // the preview is still pending
    expect(await rowOf(ctx, video.id)).toMatchObject({ preview_status: "pending", preview_file_id: null });

    const image = await readyAsset(ctx, ctx.ada, IMAGE);
    const still = await sendFile(ctx, image.id, "poster");
    expect(still.view).toEqual({ ...image, posterFileId: still.fileId });
    expect(still.view.previewStatus).toBe("none");
  });

  it("a view never shows a file that is still on its way", async () => {
    const ctx = await mediaContext();
    const asset = await readyAsset(ctx);
    const preview = await openAssetFile(ctx.deps, ctx.ada, asset.id, { role: "preview", sizeBytes: 3_000_000 });
    const poster = await openAssetFile(ctx.deps, ctx.ada, asset.id, { role: "poster", sizeBytes: POSTER_BYTES });
    const previewId = ctx.fake.sessions.get(preview.uploadUrl)!.fileId;
    const posterId = ctx.fake.sessions.get(poster.uploadUrl)!.fileId;
    // The ids are recorded before a byte is sent.
    expect(await rowOf(ctx, asset.id)).toMatchObject({ pending_preview_file_id: previewId, pending_poster_file_id: posterId, preview_file_id: null, poster_file_id: null, preview_status: "pending" });
    const seen = async () => [...(await listAssets(ctx.db, ctx.vera)), ...(await listAssets(ctx.db, ctx.vera, { ids: [asset.id] }))];
    expect(await seen()).toEqual([asset, asset]);
    await sendAll(ctx.fake, preview.uploadUrl, 3_000_000);
    await sendAll(ctx.fake, poster.uploadUrl, POSTER_BYTES);
    expect(await seen()).toEqual([asset, asset]); // in Drive, but not completed
    const text = JSON.stringify([await seen(), await updateAsset(ctx.db, ctx.ada, asset.id, {}), await failPreview(ctx.db, ctx.ada, asset.id)]);
    for (const secret of [previewId, posterId, "upload_id"]) expect(text).not.toContain(secret);
  });

  it("making a preview copy again replaces the old one", async () => {
    const ctx = await mediaContext();
    const asset = await readyAsset(ctx);
    const first = await sendFile(ctx, asset.id, "preview");
    const second = await sendFile(ctx, asset.id, "preview", 2_000_000);
    expect(second.fileId).not.toBe(first.fileId);
    expect(second.view.previewFileId).toBe(second.fileId);
    expect(isTrashed(ctx, first.fileId)).toBe(true);
    expect(isTrashed(ctx, second.fileId)).toBe(false);
    expect(isTrashed(ctx, asset.originalFileId)).toBe(false);

    const picture = await sendFile(ctx, asset.id, "poster");
    const again = await sendFile(ctx, asset.id, "poster");
    expect(again.view).toMatchObject({ previewFileId: second.fileId, posterFileId: again.fileId, previewStatus: "ready" });
    expect(isTrashed(ctx, picture.fileId)).toBe(true);
    expect(isTrashed(ctx, again.fileId)).toBe(false);
    expect(isTrashed(ctx, second.fileId)).toBe(false); // the preview copy is not the still picture's old file
    expect(trashCalls(ctx)).toBe(2);
  });

  it("keeps the new copy when the old one cannot be moved to the trash", async () => {
    const ctx = await mediaContext();
    const asset = await readyAsset(ctx);
    const first = await sendFile(ctx, asset.id, "preview");
    ctx.fake.failNext(/PATCH/, 500);
    const second = await sendFile(ctx, asset.id, "preview");
    expect(second.view).toMatchObject({ previewStatus: "ready", previewFileId: second.fileId });
    expect(isTrashed(ctx, first.fileId)).toBe(false);
  });

  it("opening again replaces the file that was on its way", async () => {
    const ctx = await mediaContext();
    const asset = await readyAsset(ctx);
    const first = await openAssetFile(ctx.deps, ctx.ada, asset.id, { role: "preview", sizeBytes: 3_000_000 });
    await sendAll(ctx.fake, first.uploadUrl, 3_000_000);
    const second = await openAssetFile(ctx.deps, ctx.ada, asset.id, { role: "preview", sizeBytes: 3_000_000 });
    const secondId = ctx.fake.sessions.get(second.uploadUrl)!.fileId;
    expect(secondId).not.toBe(ctx.fake.sessions.get(first.uploadUrl)!.fileId);
    expect((await rowOf(ctx, asset.id)).pending_preview_file_id).toBe(secondId);
    // The first file is whole in Drive, but it is no longer the one that is waited for.
    await expect(completeAssetFile(ctx.deps, ctx.ada, asset.id, "preview")).rejects.toMatchObject(NOT_FINISHED);
    await sendAll(ctx.fake, second.uploadUrl, 3_000_000);
    expect((await completeAssetFile(ctx.deps, ctx.ada, asset.id, "preview")).previewFileId).toBe(secondId);
    // Once it is in, there is nothing left to complete.
    await expect(completeAssetFile(ctx.deps, ctx.ada, asset.id, "preview")).rejects.toMatchObject(NOT_FINISHED);
    expect((await viewOf(ctx, asset.id)).previewFileId).toBe(secondId);
  });

  it("refuses files that make no sense", async () => {
    const ctx = await mediaContext();
    const video = await readyAsset(ctx, ctx.ada, VIDEO);
    const image = await readyAsset(ctx, ctx.ada, IMAGE);
    const audio = await readyAsset(ctx, ctx.ada, AUDIO);
    const { asset: unfinished } = await openUpload(ctx.deps, ctx.ada, LATER);
    const sessions = ctx.fake.sessions.size;
    const calls = ctx.fake.calls.length;

    await expect(openAssetFile(ctx.deps, ctx.ada, image.id, { role: "preview", sizeBytes: 3_000_000 })).rejects.toMatchObject(WRONG_ROLE);
    await expect(openAssetFile(ctx.deps, ctx.ada, audio.id, { role: "preview", sizeBytes: 3_000_000 })).rejects.toMatchObject(WRONG_ROLE);
    await expect(openAssetFile(ctx.deps, ctx.ada, audio.id, { role: "poster", sizeBytes: POSTER_BYTES })).rejects.toMatchObject(WRONG_ROLE);
    await expect(openAssetFile(ctx.deps, ctx.ada, video.id, { role: "poster", sizeBytes: LIMITS.mediaPosterBytes + 1 })).rejects.toMatchObject(BAD_SIZE);
    await expect(openAssetFile(ctx.deps, ctx.ada, image.id, { role: "poster", sizeBytes: LIMITS.mediaPosterBytes + 1 })).rejects.toMatchObject(BAD_SIZE);
    await expect(openAssetFile(ctx.deps, ctx.ada, video.id, { role: "preview", sizeBytes: LIMITS.mediaFileBytes + 1 })).rejects.toMatchObject(BAD_SIZE);
    for (const sizeBytes of [1.5, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      for (const role of ["preview", "poster"] as const) {
        await expect(openAssetFile(ctx.deps, ctx.ada, video.id, { role, sizeBytes }), `${role} of ${sizeBytes}`).rejects.toMatchObject(BAD_SIZE);
      }
    }
    for (const role of ["preview", "poster"] as const) {
      await expect(openAssetFile(ctx.deps, ctx.ada, unfinished.id, { role, sizeBytes: 1000 })).rejects.toMatchObject(NOT_FINISHED);
      await expect(completeAssetFile(ctx.deps, ctx.ada, unfinished.id, role)).rejects.toMatchObject(NOT_FINISHED);
      await expect(openAssetFile(ctx.deps, ctx.vera, video.id, { role, sizeBytes: 1000 })).rejects.toMatchObject(FORBIDDEN);
      await expect(completeAssetFile(ctx.deps, ctx.vera, video.id, role)).rejects.toMatchObject(FORBIDDEN);
    }
    // None of that reached Drive or the database.
    expect(ctx.fake.sessions.size).toBe(sessions);
    expect(ctx.fake.calls.length).toBe(calls);
    for (const id of [video.id, image.id, audio.id, unfinished.id]) expect(await rowOf(ctx, id)).toMatchObject({ pending_preview_file_id: null, pending_poster_file_id: null });
  });

  it("takes a file of 1 byte and one of exactly the largest size", async () => {
    const ctx = await mediaContext();
    const video = await readyAsset(ctx);
    const image = await readyAsset(ctx, ctx.ada, IMAGE);
    for (const [id, role, sizeBytes] of [
      [video.id, "preview", 1],
      [video.id, "preview", LIMITS.mediaFileBytes],
      [video.id, "poster", 1],
      [video.id, "poster", LIMITS.mediaPosterBytes],
      [image.id, "poster", LIMITS.mediaPosterBytes],
    ] as const) {
      const { uploadUrl } = await openAssetFile(ctx.deps, ctx.ada, id, { role, sizeBytes });
      expect(ctx.fake.sessions.get(uploadUrl)!.sizeBytes, `${role} of ${sizeBytes}`).toBe(sizeBytes);
    }
  });

  it("finds no removed or unknown asset to give a file to, and nobody else's unfinished upload", async () => {
    const ctx = await mediaContext();
    const removed = await readyAsset(ctx);
    const pending = await openAssetFile(ctx.deps, ctx.ada, removed.id, { role: "preview", sizeBytes: 3_000_000 });
    await sendAll(ctx.fake, pending.uploadUrl, 3_000_000);
    await removeAsset(ctx.deps, ctx.ada, removed.id);
    const { asset: unfinished } = await openUpload(ctx.deps, ctx.grace, LATER);
    const sessions = ctx.fake.sessions.size;
    for (const id of [removed.id, "nope", unfinished.id]) {
      for (const role of ["preview", "poster"] as const) {
        await expect(openAssetFile(ctx.deps, ctx.ada, id, { role, sizeBytes: 1000 }), id).rejects.toMatchObject(GONE);
        await expect(completeAssetFile(ctx.deps, ctx.ada, id, role), id).rejects.toMatchObject(GONE);
      }
      await expect(failPreview(ctx.db, ctx.ada, id), id).rejects.toMatchObject(GONE);
    }
    expect(ctx.fake.sessions.size).toBe(sessions);
    expect(await rowOf(ctx, removed.id)).toMatchObject({ preview_status: "pending", preview_file_id: null });
    expect(await rowOf(ctx, unfinished.id)).toMatchObject({ preview_status: "pending", pending_preview_file_id: null });
  });

  it("does not believe a file that is not whole, not in Previews, or in the trash", async () => {
    const ctx = await mediaContext();
    const asset = await readyAsset(ctx);
    const { uploadUrl } = await openAssetFile(ctx.deps, ctx.ada, asset.id, { role: "preview", sizeBytes: 3_000_000 });
    await sendAll(ctx.fake, uploadUrl, 3_000_000);
    const file = ctx.fake.files.get(ctx.fake.sessions.get(uploadUrl)!.fileId)!;
    const previews = await ctx.deps.drive.folderId("Previews");
    const complete = () => completeAssetFile(ctx.deps, ctx.ada, asset.id, "preview");

    for (const parents of [[await ctx.deps.drive.folderId("Originals")], [ctx.deps.drive.rootFolderId], ["drive9"], []]) {
      file.parents = parents;
      await expect(complete(), parents.join()).rejects.toMatchObject(NOT_FINISHED);
    }
    file.parents = [previews];
    file.sizeBytes = 0;
    await expect(complete()).rejects.toMatchObject(NOT_FINISHED);
    file.sizeBytes = 3_000_000;
    file.trashed = true;
    await expect(complete()).rejects.toMatchObject(NOT_FINISHED);
    expect(await rowOf(ctx, asset.id)).toMatchObject({ preview_status: "pending", preview_file_id: null });

    file.trashed = false;
    file.parents = ["some-other-folder", previews]; // a second parent is fine
    file.sizeBytes = 1; // and so is any size above 0
    expect((await complete()).previewStatus).toBe("ready");
  });

  it("does not move a file over that was replaced, or whose asset was removed, while Drive was being asked", async () => {
    const ctx = await mediaContext();
    const asset = await readyAsset(ctx);
    const first = await openAssetFile(ctx.deps, ctx.ada, asset.id, { role: "preview", sizeBytes: 3_000_000 });
    await sendAll(ctx.fake, first.uploadUrl, 3_000_000);
    const during = (meanwhile: () => Promise<unknown>) => ({
      ...ctx.deps,
      drive: {
        ...ctx.deps.drive,
        getFile: async (id: string) => {
          const file = await ctx.deps.drive.getFile(id);
          await meanwhile();
          return file;
        },
      },
    });

    const replaced = during(() => openAssetFile(ctx.deps, ctx.grace, asset.id, { role: "preview", sizeBytes: 3_000_000 }));
    await expect(completeAssetFile(replaced, ctx.ada, asset.id, "preview")).rejects.toMatchObject(NOT_FINISHED);
    expect(await rowOf(ctx, asset.id)).toMatchObject({ preview_status: "pending", preview_file_id: null });

    const second = await openAssetFile(ctx.deps, ctx.ada, asset.id, { role: "preview", sizeBytes: 3_000_000 });
    await sendAll(ctx.fake, second.uploadUrl, 3_000_000);
    const removed = during(() => removeAsset(ctx.deps, ctx.grace, asset.id));
    await expect(completeAssetFile(removed, ctx.ada, asset.id, "preview")).rejects.toMatchObject(GONE);
    expect(await rowOf(ctx, asset.id)).toMatchObject({ preview_status: "pending", preview_file_id: null });
  });

  it("does not record a file for an asset that was removed while Drive was being asked", async () => {
    const ctx = await mediaContext();
    const asset = await readyAsset(ctx);
    const drive = {
      ...ctx.deps.drive,
      newFileId: async () => {
        await removeAsset(ctx.deps, ctx.grace, asset.id);
        return ctx.deps.drive.newFileId();
      },
    };
    await expect(openAssetFile({ ...ctx.deps, drive }, ctx.ada, asset.id, { role: "poster", sizeBytes: POSTER_BYTES })).rejects.toMatchObject(GONE);
    expect((await rowOf(ctx, asset.id)).pending_poster_file_id).toBeNull();
  });

  it("records that a preview copy could not be made", async () => {
    const ctx = await mediaContext();
    const asset = await readyAsset(ctx);
    const other = await readyAsset(ctx, ctx.ada, { ...VIDEO, fileName: "other.mov" });
    await expect(failPreview(ctx.db, ctx.vera, asset.id)).rejects.toMatchObject(FORBIDDEN);
    expect(await failPreview(ctx.db, ctx.grace, asset.id)).toEqual({ ...asset, previewStatus: "failed" });
    expect((await rowOf(ctx, asset.id)).preview_status).toBe("failed");
    expect((await rowOf(ctx, other.id)).preview_status).toBe("pending"); // only the one asked about
    expect(await failPreview(ctx.db, ctx.ada, asset.id)).toEqual({ ...asset, previewStatus: "failed" });

    // A copy that arrives after all makes it ready, and then nothing fails it.
    const { view } = await sendFile(ctx, asset.id, "preview");
    expect(view.previewStatus).toBe("ready");
    expect(await failPreview(ctx.db, ctx.ada, asset.id)).toEqual(view);
    expect(await rowOf(ctx, asset.id)).toMatchObject({ preview_status: "ready", preview_file_id: view.previewFileId });

    // An image has no preview copy to fail.
    const image = await readyAsset(ctx, ctx.ada, IMAGE);
    expect(await failPreview(ctx.db, ctx.ada, image.id)).toEqual(image);
    expect((await rowOf(ctx, image.id)).preview_status).toBe("none");
  });

  it("a preview still pending two hours after the upload is shown as failed", async () => {
    const ctx = await mediaContext();
    const asset = await readyAsset(ctx, ctx.ada, VIDEO);
    expect(await listAssets(ctx.db, ctx.ada)).toMatchObject([{ id: asset.id, previewStatus: "pending" }]);
    await ctx.db.execute(sql`update assets set ready_at = now() - interval '3 hours' where id = ${asset.id}`);
    expect(await listAssets(ctx.db, ctx.ada)).toMatchObject([{ id: asset.id, previewStatus: "failed" }]);
    expect(await listAssets(ctx.db, ctx.ada, { ids: [asset.id] })).toMatchObject([{ id: asset.id, previewStatus: "failed" }]);
    expect((await updateAsset(ctx.db, ctx.ada, asset.id, {})).previewStatus).toBe("failed"); // every view
    expect((await rowOf(ctx, asset.id)).preview_status).toBe("pending");
    const { view } = await sendFile(ctx, asset.id, "preview");
    expect(view.previewStatus).toBe("ready");
    expect((await viewOf(ctx, asset.id)).previewStatus).toBe("ready");
  });

  it("waits the whole two hours, and only for a preview copy that is still expected", async () => {
    const ctx = await mediaContext();
    const asset = await readyAsset(ctx, ctx.ada, VIDEO);
    const waited = (interval: string) => ctx.db.execute(sql`update assets set ready_at = now() - ${interval}::interval where id = ${asset.id}`);
    await waited("1 hour 59 minutes");
    expect((await viewOf(ctx, asset.id)).previewStatus).toBe("pending");
    await waited("2 hours 1 minute");
    expect((await viewOf(ctx, asset.id)).previewStatus).toBe("failed");

    // A copy that is in, an image and an audio file stay what they are, however old.
    const { view } = await sendFile(ctx, asset.id, "preview");
    const image = await readyAsset(ctx, ctx.ada, IMAGE);
    const audio = await readyAsset(ctx, ctx.ada, AUDIO);
    // An unfinished upload is not waited for at all: its original is not in yet.
    const { asset: unfinished } = await openUpload(ctx.deps, ctx.ada, LATER);
    await ctx.db.execute(sql`update assets set ready_at = now() - interval '30 days', created_at = now() - interval '1 day' where status = 'ready'`);
    await ctx.db.execute(sql`update assets set created_at = now() - interval '1 day' where status = 'uploading'`);
    expect((await viewOf(ctx, asset.id)).previewStatus).toBe(view.previewStatus);
    expect((await viewOf(ctx, image.id)).previewStatus).toBe("none");
    expect((await viewOf(ctx, audio.id)).previewStatus).toBe("none");
    expect((await viewOf(ctx, unfinished.id)).previewStatus).toBe("pending");
  });
});

describe("the facts a project check needs", () => {
  it("gives the facts a project check needs", async () => {
    const ctx = await mediaContext();
    const video = await readyAsset(ctx, ctx.ada, VIDEO);
    const image = await readyAsset(ctx, ctx.ada, IMAGE);
    await removeAsset(ctx.deps, ctx.ada, image.id);
    const { asset: unfinished } = await openUpload(ctx.deps, ctx.grace, LATER);
    const facts = await loadAssetFacts(ctx.db, [video.id, image.id, unfinished.id, "nope", video.id]);
    expect(facts).toEqual(
      new Map([
        [video.id, { id: video.id, kind: "video", ready: true, removed: false, durationMs: 12_500 }],
        [image.id, { id: image.id, kind: "image", ready: true, removed: true, durationMs: null }],
        [unfinished.id, { id: unfinished.id, kind: "video", ready: false, removed: false, durationMs: 12_500 }],
      ]),
    );
    expect(facts.has("nope")).toBe(false);
    expect(await loadAssetFacts(ctx.db, [image.id])).toEqual(new Map([[image.id, facts.get(image.id)]])); // only the ones asked for
  });

  it("makes no query for an empty list, and one for any other", async () => {
    const ctx = await mediaContext();
    const video = await readyAsset(ctx);
    const audio = await readyAsset(ctx, ctx.ada, AUDIO);
    let queries = 0;
    const counting = new Proxy(ctx.db, {
      get(target, key) {
        queries += 1;
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(await loadAssetFacts(counting, [])).toEqual(new Map());
    expect(queries).toBe(0);
    expect((await loadAssetFacts(counting, [video.id, audio.id, "nope"])).size).toBe(2);
    expect(queries).toBe(1);
  });
});
