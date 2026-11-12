import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { sql, type SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { rowsOf } from "@/db";
import { DriveError } from "@/lib/drive/token";
import { LIMITS } from "@/lib/limits";
import { completeUpload, listAssets, openUpload, uploadOffset } from "@/lib/media/service";
import type { OpenUploadInput } from "@/lib/media/types";
import { ServiceError } from "@/lib/service-error";
import { piece } from "../helpers/fake-drive";
import { AUDIO, IMAGE, VIDEO, mediaContext, readyAsset, sendAll, type MediaContext } from "./context";

const MiB = 1024 * 1024;

describe("uploading an original", () => {
  it("opens a Drive session in Originals for the app's origin and records an unfinished asset", async () => {
    const ctx = await mediaContext();
    const { asset, uploadUrl, offset } = await openUpload(ctx.deps, ctx.ada, VIDEO);
    expect(offset).toBe(0);
    expect(asset).toMatchObject({ kind: "video", name: "IMG_4821", fileName: "IMG_4821.MOV", sizeBytes: 20_000_000, status: "uploading", removed: false, durationMs: 12_500, width: 1080, height: 1920, fps: 30, hasAudio: true, originalFileId: null, previewStatus: "pending", previewFileId: null, posterFileId: null, event: null, uploadedBy: ctx.ada.userId });
    expect(ctx.fake.sessions.get(uploadUrl)).toMatchObject({ sizeBytes: 20_000_000, origin: "https://app.test", name: `${asset.id}__IMG_4821.MOV`, parentId: await ctx.deps.drive.folderId("Originals") });
    expect(JSON.stringify(asset)).not.toContain("upload_id");
    expect((await openUpload(ctx.deps, ctx.grace, { ...VIDEO, event: "  " })).asset.event).toBeNull(); // a blank event is no event
  });

  it("marks the asset ready only when Drive holds the whole file", async () => {
    const ctx = await mediaContext();
    const { asset, uploadUrl } = await openUpload(ctx.deps, ctx.ada, VIDEO);
    await piece(ctx.fake, uploadUrl, 0, 8 * MiB, 20_000_000);
    await expect(completeUpload(ctx.deps, ctx.ada, asset.id)).rejects.toMatchObject({ code: "CONFLICT", status: 409, message: "The upload is not finished." });
    expect(await listAssets(ctx.db, ctx.grace)).toEqual([]); // nobody else sees half a file
    await sendAll(ctx.fake, uploadUrl, 20_000_000, 8 * MiB);
    const ready = await completeUpload(ctx.deps, ctx.ada, asset.id);
    expect(ready.status).toBe("ready");
    expect(ctx.fake.files.get(ready.originalFileId!)).toMatchObject({ sizeBytes: 20_000_000, trashed: false });
    expect(await completeUpload(ctx.deps, ctx.ada, asset.id)).toEqual(ready); // a repeat is not an error
    expect((await listAssets(ctx.db, ctx.grace)).map((a) => a.id)).toEqual([asset.id]);
    const [row] = rowsOf<{ upload_url: string | null }>(await ctx.db.execute(sql`select upload_url from assets where id = ${asset.id}`));
    expect(row.upload_url).toBeNull();
  });

  it("choosing the same file again takes up the unfinished upload", async () => {
    const ctx = await mediaContext();
    const first = await openUpload(ctx.deps, ctx.ada, VIDEO);
    await piece(ctx.fake, first.uploadUrl, 0, 8 * MiB, 20_000_000);
    const again = await openUpload(ctx.deps, ctx.ada, VIDEO);
    expect(again.asset.id).toBe(first.asset.id);
    expect(again.uploadUrl).toBe(first.uploadUrl);
    expect(again.offset).toBe(8 * MiB);
    expect(ctx.fake.sessions.size).toBe(1);
    // Another member's same-named file is its own upload.
    expect((await openUpload(ctx.deps, ctx.grace, VIDEO)).asset.id).not.toBe(first.asset.id);
    // Another last-modified time is another file.
    expect((await openUpload(ctx.deps, ctx.ada, { ...VIDEO, lastModifiedMs: VIDEO.lastModifiedMs + 1 })).asset.id).not.toBe(first.asset.id);
  });

  it("starts again when the old session has expired", async () => {
    const ctx = await mediaContext();
    const first = await openUpload(ctx.deps, ctx.ada, VIDEO);
    ctx.fake.expireSessions();
    await expect(uploadOffset(ctx.deps, ctx.ada, first.asset.id)).rejects.toMatchObject({ code: "CONFLICT", message: "This upload expired. Choose the file again." });
    const again = await openUpload(ctx.deps, ctx.ada, VIDEO);
    expect(again.asset.id).not.toBe(first.asset.id);
    expect(again.offset).toBe(0);
  });

  it("refuses files the rules refuse, and a read of the file that does not fit it", async () => {
    const ctx = await mediaContext();
    await expect(openUpload(ctx.deps, ctx.ada, { ...VIDEO, sizeBytes: LIMITS.mediaFileBytes + 1 })).rejects.toMatchObject({ code: "INVALID", message: "This file is larger than 2 GB." });
    await expect(openUpload(ctx.deps, ctx.ada, { ...VIDEO, fileName: "a.gif" })).rejects.toMatchObject({ code: "INVALID" });
    await expect(openUpload(ctx.deps, ctx.ada, { ...VIDEO, probe: IMAGE.probe })).rejects.toMatchObject({ message: "This file couldn't be read. It may be damaged." });
    await expect(openUpload(ctx.deps, ctx.ada, { ...VIDEO, event: "e".repeat(81) })).rejects.toMatchObject({ code: "INVALID" });
    expect(ctx.fake.sessions.size).toBe(0); // nothing was opened in Drive
  });

  it("stops at 20 unfinished uploads per member", async () => {
    const ctx = await mediaContext();
    for (let i = 0; i < 20; i++) await openUpload(ctx.deps, ctx.ada, { ...VIDEO, fileName: `clip-${i}.mov` });
    await expect(openUpload(ctx.deps, ctx.ada, { ...VIDEO, fileName: "one-more.mov" })).rejects.toMatchObject({ code: "LIMIT_EXCEEDED", message: "You have 20 unfinished uploads. Finish or cancel one first." });
    expect((await openUpload(ctx.deps, ctx.grace, VIDEO)).offset).toBe(0); // the limit is per member
  });

  it("drops unfinished uploads older than a week, and does not count them", async () => {
    const ctx = await mediaContext();
    for (let i = 0; i < 20; i++) await openUpload(ctx.deps, ctx.ada, { ...VIDEO, fileName: `clip-${i}.mov` });
    await ctx.db.execute(sql`update assets set created_at = now() - interval '8 days'`);
    expect((await openUpload(ctx.deps, ctx.ada, { ...VIDEO, fileName: "one-more.mov" })).offset).toBe(0);
    const [left] = rowsOf<{ n: number }>(await ctx.db.execute(sql`select count(*)::int as n from assets where status = 'uploading'`));
    expect(left.n).toBe(1);
  });

  it("lets only the uploader or an admin continue an upload, and no viewer start one", async () => {
    const ctx = await mediaContext();
    const { asset, uploadUrl } = await openUpload(ctx.deps, ctx.ada, VIDEO);
    await expect(openUpload(ctx.deps, ctx.vera, VIDEO)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(uploadOffset(ctx.deps, ctx.grace, asset.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(completeUpload(ctx.deps, ctx.grace, asset.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await sendAll(ctx.fake, uploadUrl, 20_000_000);
    expect((await completeUpload(ctx.deps, ctx.root, asset.id)).status).toBe("ready");
  });

  it("does not believe a file that is somewhere else in Drive", async () => {
    const ctx = await mediaContext();
    const { asset, uploadUrl } = await openUpload(ctx.deps, ctx.ada, VIDEO);
    await sendAll(ctx.fake, uploadUrl, 20_000_000);
    const session = ctx.fake.sessions.get(uploadUrl)!;
    ctx.fake.files.get(session.fileId)!.parents = ["some-other-folder"];
    await expect(completeUpload(ctx.deps, ctx.ada, asset.id)).rejects.toMatchObject({ code: "INVALID", message: "That file is not in the library's folder." });
  });

  it("lists ready assets newest first with the uploader's name, and a member's own unfinished uploads", async () => {
    const ctx = await mediaContext();
    const video = await readyAsset(ctx, ctx.ada, VIDEO);
    const image = await readyAsset(ctx, ctx.grace, IMAGE);
    const pending = await openUpload(ctx.deps, ctx.ada, AUDIO);
    expect(image).toMatchObject({ kind: "image", previewStatus: "none", durationMs: null, width: 4032, height: 3024 });
    expect((await listAssets(ctx.db, ctx.vera)).map((a) => a.id)).toEqual([image.id, video.id]);
    expect((await listAssets(ctx.db, ctx.ada)).map((a) => a.id)).toEqual([image.id, video.id, pending.asset.id]);
    expect((await listAssets(ctx.db, ctx.vera))[1].uploadedByName).toBe("Ada Lovelace");
    expect((await listAssets(ctx.db, ctx.vera, { ids: [video.id, pending.asset.id, "nope"] })).map((a) => a.id)).toEqual([video.id]);
  });
});

// The cases above are the plan's. The ones below pin the rest of the rules.

const FILE_UNREADABLE = "This file couldn't be read. It may be damaged.";
const GONE = { code: "NOT_FOUND", status: 404, message: "That file is no longer in the library." };
const VIEW_KEYS = [
  "id", "kind", "name", "fileName", "sizeBytes", "status", "removed", "durationMs", "width", "height", "fps", "hasAudio", "originalFileId",
  "previewStatus", "previewFileId", "posterFileId", "event", "uploadedBy", "uploadedByName", "createdAt",
];

const rows = async <T = Record<string, unknown>>(ctx: MediaContext, query: SQL) => rowsOf<T>(await ctx.db.execute(query));
const assetIds = async (ctx: MediaContext) => (await rows<{ id: string }>(ctx, sql`select id from assets order by id`)).map((row) => row.id);
const unfinishedCount = async (ctx: MediaContext) => (await rows<{ n: number }>(ctx, sql`select count(*)::int as n from assets where status = 'uploading'`))[0].n;
const clip = (name: string): OpenUploadInput => ({ ...VIDEO, fileName: name });
// An error as a log prints it, with everything it holds and nothing cut short.
const everythingIn = (error: unknown) => inspect(error, { depth: Infinity, showHidden: true, maxStringLength: Infinity, maxArrayLength: Infinity });

describe("opening an upload", () => {
  it("records the file as the browser described it, and Drive's id for it before a byte is sent", async () => {
    const ctx = await mediaContext();
    const { asset, uploadUrl } = await openUpload(ctx.deps, ctx.ada, { ...VIDEO, event: "  Qualifier 2026-11-08 " });
    const session = ctx.fake.sessions.get(uploadUrl)!;
    expect(session).toMatchObject({ mimeType: "video/quicktime", received: 0 });
    expect(ctx.fake.files.has(session.fileId)).toBe(false); // no file until the last byte
    const [row] = await rows(ctx, sql`select * from assets`);
    expect(row).toMatchObject({
      id: asset.id, kind: "video", name: "IMG_4821", file_name: "IMG_4821.MOV", mime_type: "video/quicktime", status: "uploading",
      drive_file_id: session.fileId, upload_url: uploadUrl, duration_ms: 12_500, width: 1080, height: 1920, fps: 30, has_audio: true,
      video_codec: "hevc", preview_status: "pending", preview_file_id: null, poster_file_id: null, pending_preview_file_id: null,
      pending_poster_file_id: null, event: "Qualifier 2026-11-08", uploaded_by: ctx.ada.userId, ready_at: null, removed_at: null, removed_by: null,
    });
    expect(Number(row.size_bytes)).toBe(20_000_000);
    expect(Number(row.last_modified_ms)).toBe(1_762_800_000_000);
    expect(asset.id).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(asset).toMatchObject({ event: "Qualifier 2026-11-08", uploadedByName: "Ada Lovelace" });
    expect(asset.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Math.abs(Date.parse(asset.createdAt) - Date.now())).toBeLessThan(60_000);
    expect(Object.keys(asset).sort()).toEqual([...VIEW_KEYS].sort()); // no session address, no file that is on its way
  });

  it("keeps only the facts that belong to the kind of file", async () => {
    const ctx = await mediaContext();
    const audio = (await openUpload(ctx.deps, ctx.ada, AUDIO)).asset;
    expect(audio).toMatchObject({ kind: "audio", name: "theme", previewStatus: "none", durationMs: 95_000, width: null, height: null, fps: null, hasAudio: true });
    // What a probe says beyond its kind is not kept, so it cannot be something the database refuses.
    const odd = await openUpload(ctx.deps, ctx.ada, { ...AUDIO, fileName: "odd.mp3", probe: { ...AUDIO.probe, width: 1.5, height: 0.5, fps: -1, videoCodec: "no\u0000" } });
    expect(odd.asset).toMatchObject({ kind: "audio", width: null, height: null, fps: null });
    const still = await openUpload(ctx.deps, ctx.ada, { ...IMAGE, probe: { ...IMAGE.probe, durationMs: 1.5, fps: Infinity, videoCodec: "no\u0000" } });
    expect(still.asset).toMatchObject({ kind: "image", previewStatus: "none", durationMs: null, fps: null, width: 4032, height: 3024, hasAudio: false });
    expect(await rows(ctx, sql`select video_codec from assets where video_codec is not null`)).toEqual([]);
  });

  it("refuses what the database cannot hold, as a file that could not be read", async () => {
    const ctx = await mediaContext();
    const refused = { code: "INVALID", status: 400, message: FILE_UNREADABLE };
    const bad: OpenUploadInput[] = [
      { ...VIDEO, lastModifiedMs: 1.5 },
      { ...VIDEO, lastModifiedMs: NaN },
      { ...VIDEO, lastModifiedMs: 2 ** 53 },
      { ...VIDEO, fileName: "a\u0000b.mov" },
      { ...VIDEO, fileName: "\ud83d.mov" }, // half an emoji
      { ...VIDEO, mimeType: "video/\u0000" },
      { ...VIDEO, probe: { ...VIDEO.probe, videoCodec: "\udc00" } },
      ...[0, -30, NaN, Infinity, 1e39, 1e-50].map((fps) => ({ ...VIDEO, probe: { ...VIDEO.probe, fps } })),
    ];
    for (const input of bad) await expect(openUpload(ctx.deps, ctx.ada, input), JSON.stringify(input)).rejects.toMatchObject(refused);
    expect(ctx.fake.sessions.size).toBe(0);
    expect(await assetIds(ctx)).toEqual([]);
    // A frame rate may be unknown, a fraction, or below one frame a second.
    expect((await openUpload(ctx.deps, ctx.ada, { ...clip("a.mov"), probe: { ...VIDEO.probe, fps: null, videoCodec: null } })).asset.fps).toBeNull();
    expect((await openUpload(ctx.deps, ctx.ada, { ...clip("b.mov"), probe: { ...VIDEO.probe, fps: 29.97 } })).asset.fps).toBeCloseTo(29.97, 4);
    expect((await openUpload(ctx.deps, ctx.ada, { ...clip("c.mov"), probe: { ...VIDEO.probe, fps: 0.5 } })).asset.fps).toBe(0.5);
    expect((await openUpload(ctx.deps, ctx.ada, { ...clip("d.mov"), lastModifiedMs: -1 })).asset.fileName).toBe("d.mov"); // a date before 1970
  });

  it("refuses a file type that cannot be sent to Drive in a header, as a file that could not be read", async () => {
    const ctx = await mediaContext();
    const refused = { code: "INVALID", status: 400, message: "This file couldn't be read. It may be damaged." };
    const bad = [
      "video/mp4\r\nX-Upload-Content-Length: 1", // a line break
      "video/mp4\n",
      "video/\u4e2d\u6587", // outside Latin-1
      "vid\u00e9o/mp4", // in Latin-1, not ASCII
      "video/mp4\t",
      "video/\u001fmp4", // the last control character
      "video/mp4\u007f", // the first character after the printable ones
      `video/${"x".repeat(250)}`, // 256 characters
    ];
    expect(bad[7]).toHaveLength(256);
    for (const mimeType of bad) await expect(openUpload(ctx.deps, ctx.ada, { ...VIDEO, mimeType }), JSON.stringify(mimeType)).rejects.toMatchObject(refused);
    expect(ctx.fake.calls).toEqual([]); // no request reached Drive
    expect(await assetIds(ctx)).toEqual([]);
    // 255 characters, and every printable character from the space to the tilde, are fine.
    const longest = `video/${"x".repeat(249)}`;
    const printable = "video/quicktime; codecs=\"hvc1, mp4a\" ~";
    expect(longest).toHaveLength(255);
    const long = await openUpload(ctx.deps, ctx.ada, { ...clip("a.mov"), mimeType: longest });
    const odd = await openUpload(ctx.deps, ctx.ada, { ...clip("b.mov"), mimeType: printable });
    expect(ctx.fake.sessions.get(long.uploadUrl)!.mimeType).toBe(longest);
    expect(ctx.fake.sessions.get(odd.uploadUrl)!.mimeType).toBe(printable);
    expect(await rows(ctx, sql`select mime_type from assets order by file_name`)).toEqual([{ mime_type: longest }, { mime_type: printable }]);
  });

  it("opens the session of a file with no type as application/octet-stream, and stores the type as it was given", async () => {
    const ctx = await mediaContext();
    const { asset, uploadUrl } = await openUpload(ctx.deps, ctx.ada, { ...VIDEO, mimeType: "" }); // what a browser says of a file it does not know
    expect(ctx.fake.sessions.get(uploadUrl)).toMatchObject({ mimeType: "application/octet-stream", sizeBytes: 20_000_000 });
    expect(await rows(ctx, sql`select id, mime_type from assets`)).toEqual([{ id: asset.id, mime_type: "" }]);
    // The file Drive ends up with has that type, and the upload completes as any other.
    await sendAll(ctx.fake, uploadUrl, 20_000_000);
    const ready = await completeUpload(ctx.deps, ctx.ada, asset.id);
    expect(ctx.fake.files.get(ready.originalFileId!)).toMatchObject({ mimeType: "application/octet-stream", sizeBytes: 20_000_000 });
    expect(await rows(ctx, sql`select mime_type from assets`)).toEqual([{ mime_type: "" }]);
    // A type that is given is sent as it is.
    const typed = await openUpload(ctx.deps, ctx.ada, clip("typed.mov"));
    expect(ctx.fake.sessions.get(typed.uploadUrl)!.mimeType).toBe("video/quicktime");
  });

  it("says why each refused file was refused, with a 400", async () => {
    const ctx = await mediaContext();
    const refusedWith = (message: string) => ({ code: "INVALID", status: 400, message });
    await expect(openUpload(ctx.deps, ctx.ada, { ...VIDEO, sizeBytes: 0 })).rejects.toMatchObject(refusedWith("This file is empty."));
    await expect(openUpload(ctx.deps, ctx.ada, { ...VIDEO, fileName: "a.gif" })).rejects.toMatchObject(refusedWith("This file type isn't supported. Use MP4, MOV, WebM, JPEG, PNG, WebP, MP3, M4A, WAV or AAC."));
    await expect(openUpload(ctx.deps, ctx.ada, { ...IMAGE, fileName: "IMG_0001.HEIC" })).rejects.toMatchObject(refusedWith("HEIC photos aren't supported yet. Save the photo as JPEG first."));
    // The kind comes from the name: a probe of another kind, or one that makes no sense for it, does not fit.
    await expect(openUpload(ctx.deps, ctx.ada, { ...AUDIO, fileName: "theme.mp4" })).rejects.toMatchObject(refusedWith(FILE_UNREADABLE));
    await expect(openUpload(ctx.deps, ctx.ada, { ...VIDEO, probe: { ...VIDEO.probe, durationMs: 0 } })).rejects.toMatchObject(refusedWith(FILE_UNREADABLE));
    // A refused file is refused before its event is looked at.
    await expect(openUpload(ctx.deps, ctx.ada, { ...VIDEO, fileName: "a.gif", event: "e".repeat(81) })).rejects.toMatchObject({ message: expect.stringContaining("file type") });
    expect(ctx.fake.calls).toEqual([]); // Drive was not asked anything
  });

  it("trims an event name and takes up to 80 characters, as a person counts them", async () => {
    const ctx = await mediaContext();
    const tooLong = { code: "INVALID", status: 400, message: "An event name can be up to 80 characters." };
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}"; // one character to a person, eight to a computer
    expect((await openUpload(ctx.deps, ctx.ada, { ...clip("a.mov"), event: `  ${"e".repeat(80)}\n` })).asset.event).toBe("e".repeat(80));
    expect((await openUpload(ctx.deps, ctx.ada, { ...clip("b.mov"), event: family.repeat(80) })).asset.event).toBe(family.repeat(80));
    expect((await openUpload(ctx.deps, ctx.ada, clip("c.mov"))).asset.event).toBeNull();
    await expect(openUpload(ctx.deps, ctx.ada, { ...clip("d.mov"), event: "e".repeat(81) })).rejects.toMatchObject(tooLong);
    await expect(openUpload(ctx.deps, ctx.ada, { ...clip("d.mov"), event: family.repeat(81) })).rejects.toMatchObject(tooLong);
    await expect(openUpload(ctx.deps, ctx.ada, { ...clip("d.mov"), event: "Qualifier\u0000" })).rejects.toMatchObject(tooLong);
    expect(ctx.fake.sessions.size).toBe(3);
  });

  it("takes up an upload whose bytes are all in Drive at its end", async () => {
    const ctx = await mediaContext();
    const first = await openUpload(ctx.deps, ctx.ada, VIDEO);
    await sendAll(ctx.fake, first.uploadUrl, 20_000_000);
    const again = await openUpload(ctx.deps, ctx.ada, { ...VIDEO, event: "Another event" });
    expect(again).toMatchObject({ uploadUrl: first.uploadUrl, offset: 20_000_000 });
    expect(again.asset).toEqual(first.asset); // the row as it was: still unfinished, its event unchanged
    expect(await uploadOffset(ctx.deps, ctx.ada, first.asset.id)).toEqual({ uploadUrl: first.uploadUrl, offset: 20_000_000, done: true });
    expect((await completeUpload(ctx.deps, ctx.ada, first.asset.id)).status).toBe("ready");
    // Once it is ready, the same file chosen again is a new upload.
    const copy = await openUpload(ctx.deps, ctx.ada, VIDEO);
    expect(copy.asset.id).not.toBe(first.asset.id);
    expect(copy.offset).toBe(0);
    // And that new upload is the one taken up from then on, not the finished one.
    await piece(ctx.fake, copy.uploadUrl, 0, 8 * MiB, 20_000_000);
    expect(await openUpload(ctx.deps, ctx.ada, VIDEO)).toMatchObject({ asset: { id: copy.asset.id }, uploadUrl: copy.uploadUrl, offset: 8 * MiB });
    expect(await assetIds(ctx)).toEqual([first.asset.id, copy.asset.id].sort());
  });

  it("takes a file of the same name and date but another size for another file", async () => {
    const ctx = await mediaContext();
    const first = await openUpload(ctx.deps, ctx.ada, VIDEO);
    const longer = await openUpload(ctx.deps, ctx.ada, { ...VIDEO, sizeBytes: 20_000_001 });
    const renamed = await openUpload(ctx.deps, ctx.ada, { ...VIDEO, fileName: "img_4821.mov" });
    expect(new Set([first.asset.id, longer.asset.id, renamed.asset.id]).size).toBe(3);
    expect(await unfinishedCount(ctx)).toBe(3);
  });

  it("opens a new upload in place of one whose session expired", async () => {
    const ctx = await mediaContext();
    const first = await openUpload(ctx.deps, ctx.ada, VIDEO);
    const other = await openUpload(ctx.deps, ctx.ada, clip("other.mov"));
    ctx.fake.expireSessions();
    const again = await openUpload(ctx.deps, ctx.ada, VIDEO);
    expect(again.uploadUrl).not.toBe(first.uploadUrl);
    expect(again.offset).toBe(0);
    expect(await assetIds(ctx)).toEqual([again.asset.id, other.asset.id].sort()); // the expired row is gone, and only that one
  });

  it("passes on a Drive failure that is not an expiry, and keeps the upload", async () => {
    const ctx = await mediaContext();
    const first = await openUpload(ctx.deps, ctx.ada, VIDEO);
    ctx.fake.failNext(/^PUT /, 503, "backendError");
    await expect(openUpload(ctx.deps, ctx.ada, VIDEO)).rejects.toMatchObject({ name: "DriveError", call: "session", status: 503, reason: "backendError" });
    ctx.fake.failNext(/^PUT /, 500);
    await expect(uploadOffset(ctx.deps, ctx.ada, first.asset.id)).rejects.toMatchObject({ name: "DriveError", call: "session", status: 500, reason: "unknown" });
    expect(await assetIds(ctx)).toEqual([first.asset.id]);
    expect((await openUpload(ctx.deps, ctx.ada, VIDEO)).asset.id).toBe(first.asset.id);
  });

  it("keeps the session address out of the error when the row cannot be written", async () => {
    const ctx = await mediaContext();
    // The database refuses the new row, as it would while it is down. The address is one of the statement's values.
    await ctx.db.execute(sql`alter table assets add constraint refuses_new_rows check (upload_url is null)`);
    const failure: unknown = await openUpload(ctx.deps, ctx.ada, VIDEO).then(
      () => null,
      (error: unknown) => error,
    );
    const [address] = ctx.fake.sessions.keys(); // the session was opened, so there is an address to keep
    expect(address).toContain("upload_id=");
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ServiceError); // the route answers 500 and logs it
    expect(failure).toMatchObject({ name: "Error", message: "The upload could not be recorded (database error 23514)." });
    expect(Object.getOwnPropertyNames(failure).sort()).toEqual(["message", "stack"]); // no cause, no query, no values
    expect(everythingIn(failure)).not.toContain("upload_id");
    expect(await assetIds(ctx)).toEqual([]);
  });

  it("keeps the session address out of the error when the database cannot be reached", async () => {
    const ctx = await mediaContext();
    // A lost connection: the failure names the statement's values, and what it calls a code is not a database's.
    const lost = (): never => {
      throw Object.assign(new Error(`fetch failed, params: ${[...ctx.fake.sessions.keys()].join()}`), { code: "upload_id=1" });
    };
    const db = new Proxy(ctx.db, { get: (target, key) => (key === "insert" ? lost : Reflect.get(target, key)) });
    const failure: unknown = await openUpload({ ...ctx.deps, db }, ctx.ada, VIDEO).then(
      () => null,
      (error: unknown) => error,
    );
    expect(ctx.fake.sessions.size).toBe(1);
    expect(failure).toMatchObject({ name: "Error", message: "The upload could not be recorded." });
    expect(Object.getOwnPropertyNames(failure).sort()).toEqual(["message", "stack"]);
    expect(everythingIn(failure)).not.toContain("upload_id");
  });

  it("keeps the session address out of the error for a file name too long for the database", async () => {
    const ctx = await mediaContext();
    // 2,700 characters with no pattern in them: the database packs a repeated character and then holds the name.
    const name = Array.from({ length: 43 }, (_, i) => createHash("sha256").update(String(i)).digest("hex")).join("").slice(0, 2700);
    const failure: unknown = await openUpload(ctx.deps, ctx.ada, { ...VIDEO, fileName: `${name}.mov` }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(everythingIn(failure)).not.toContain("upload_id");
    expect(await assetIds(ctx)).toEqual([]);
  });

  it("drops only this member's own unfinished uploads, and only after seven days", async () => {
    const ctx = await mediaContext();
    const old = await openUpload(ctx.deps, ctx.ada, clip("old.mov"));
    const graces = await openUpload(ctx.deps, ctx.grace, VIDEO);
    const finished = await readyAsset(ctx, ctx.ada, IMAGE);
    await ctx.db.execute(sql`update assets set created_at = now() - interval '7 days 1 minute'`);
    const recent = await openUpload(ctx.deps, ctx.ada, clip("recent.mov"));
    await ctx.db.execute(sql`update assets set created_at = now() - interval '6 days 23 hours' where id = ${recent.asset.id}`);
    const next = await openUpload(ctx.deps, ctx.ada, clip("next.mov"));
    expect(await assetIds(ctx)).toEqual([graces.asset.id, finished.id, recent.asset.id, next.asset.id].sort());
    // An old upload is not taken up again: the same file is a new upload.
    const again = await openUpload(ctx.deps, ctx.ada, clip("old.mov"));
    expect(again.asset.id).not.toBe(old.asset.id);
    expect(again.offset).toBe(0);
  });

  it("does not count finished uploads toward the 20", async () => {
    const ctx = await mediaContext();
    await readyAsset(ctx, ctx.ada, IMAGE);
    await readyAsset(ctx, ctx.ada, AUDIO);
    for (let i = 0; i < 20; i++) await openUpload(ctx.deps, ctx.ada, clip(`clip-${i}.mov`));
    expect(await unfinishedCount(ctx)).toBe(20);
    await expect(openUpload(ctx.deps, ctx.ada, clip("one-more.mov"))).rejects.toMatchObject({ code: "LIMIT_EXCEEDED", status: 400 });
    expect((await openUpload(ctx.deps, ctx.ada, clip("clip-7.mov"))).offset).toBe(0); // one of the 20 can still be taken up
    expect(ctx.fake.sessions.size).toBe(22); // and the refused one opened nothing in Drive
  });

  it("makes one upload when the same file is opened twice at once", async () => {
    const ctx = await mediaContext();
    const [a, b] = await Promise.all([openUpload(ctx.deps, ctx.ada, VIDEO), openUpload(ctx.deps, ctx.ada, VIDEO)]);
    expect(b.asset.id).toBe(a.asset.id);
    expect(b.uploadUrl).toBe(a.uploadUrl);
    expect([a.offset, b.offset]).toEqual([0, 0]);
    expect(await assetIds(ctx)).toEqual([a.asset.id]);
    expect(ctx.fake.sessions.get(a.uploadUrl)!.name).toBe(`${a.asset.id}__IMG_4821.MOV`);
  });

  it("holds the limit when two files are opened at once", async () => {
    const ctx = await mediaContext();
    for (let i = 0; i < 19; i++) await openUpload(ctx.deps, ctx.ada, clip(`clip-${i}.mov`));
    const results = await Promise.allSettled([openUpload(ctx.deps, ctx.ada, clip("x.mov")), openUpload(ctx.deps, ctx.ada, clip("y.mov"))]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "LIMIT_EXCEEDED", message: "You have 20 unfinished uploads. Finish or cancel one first." } });
    expect(await unfinishedCount(ctx)).toBe(20);
  });
});

describe("continuing and completing an upload", () => {
  it("says how far an upload has come, to its uploader and to an admin", async () => {
    const ctx = await mediaContext();
    const { asset, uploadUrl } = await openUpload(ctx.deps, ctx.ada, VIDEO);
    expect(await uploadOffset(ctx.deps, ctx.ada, asset.id)).toEqual({ uploadUrl, offset: 0, done: false });
    await piece(ctx.fake, uploadUrl, 0, 8 * MiB, 20_000_000);
    expect(await uploadOffset(ctx.deps, ctx.ada, asset.id)).toEqual({ uploadUrl, offset: 8 * MiB, done: false });
    expect(await uploadOffset(ctx.deps, ctx.root, asset.id)).toEqual({ uploadUrl: null, offset: 8 * MiB, done: false });
    await sendAll(ctx.fake, uploadUrl, 20_000_000, 8 * MiB);
    await completeUpload(ctx.deps, ctx.ada, asset.id);
    expect(await uploadOffset(ctx.deps, ctx.ada, asset.id)).toEqual({ uploadUrl: null, offset: 20_000_000, done: true });
  });

  it("gives the session address only to the member who opened the upload", async () => {
    const ctx = await mediaContext();
    const { asset, uploadUrl } = await openUpload(ctx.deps, ctx.ada, VIDEO);
    await piece(ctx.fake, uploadUrl, 0, 8 * MiB, 20_000_000);
    expect(await uploadOffset(ctx.deps, ctx.root, asset.id)).toEqual({ uploadUrl: null, offset: 8 * MiB, done: false });
    await sendAll(ctx.fake, uploadUrl, 20_000_000, 8 * MiB); // every byte is in, and the upload is not completed
    expect(await uploadOffset(ctx.deps, ctx.root, asset.id)).toEqual({ uploadUrl: null, offset: 20_000_000, done: true });
    expect(await uploadOffset(ctx.deps, ctx.ada, asset.id)).toEqual({ uploadUrl, offset: 20_000_000, done: true });
    // An admin's own upload is theirs like anyone's.
    const own = await openUpload(ctx.deps, ctx.root, IMAGE);
    expect(await uploadOffset(ctx.deps, ctx.root, own.asset.id)).toEqual({ uploadUrl: own.uploadUrl, offset: 0, done: false });
  });

  it("deletes the row of an upload whose session expired", async () => {
    const ctx = await mediaContext();
    const { asset } = await openUpload(ctx.deps, ctx.ada, VIDEO);
    const other = await openUpload(ctx.deps, ctx.grace, VIDEO);
    ctx.fake.expireSessions();
    await expect(uploadOffset(ctx.deps, ctx.ada, asset.id)).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(await assetIds(ctx)).toEqual([other.asset.id]);
    await expect(uploadOffset(ctx.deps, ctx.ada, asset.id)).rejects.toMatchObject(GONE);
  });

  it("does not delete an upload that was completed while Drive was being asked", async () => {
    const ctx = await mediaContext();
    const { asset, uploadUrl } = await openUpload(ctx.deps, ctx.ada, VIDEO);
    await sendAll(ctx.fake, uploadUrl, 20_000_000);
    const drive = {
      ...ctx.deps.drive,
      uploadOffset: async (): Promise<never> => {
        await completeUpload(ctx.deps, ctx.ada, asset.id);
        throw new DriveError("session", 404, "expired");
      },
    };
    await expect(uploadOffset({ ...ctx.deps, drive }, ctx.ada, asset.id)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await listAssets(ctx.db, ctx.vera)).map((a) => a.id)).toEqual([asset.id]);
  });

  it("takes a session for expired whatever status Drive gave for it", async () => {
    const ctx = await mediaContext();
    for (const status of [410, 499]) {
      const first = await openUpload(ctx.deps, ctx.ada, VIDEO);
      ctx.fake.failNext(/^PUT /, status);
      await expect(uploadOffset(ctx.deps, ctx.ada, first.asset.id)).rejects.toMatchObject({ code: "CONFLICT", message: "This upload expired. Choose the file again." });
      const second = await openUpload(ctx.deps, ctx.ada, VIDEO);
      ctx.fake.failNext(/^PUT /, status);
      const third = await openUpload(ctx.deps, ctx.ada, VIDEO);
      expect(third.asset.id).not.toBe(second.asset.id);
      expect(await assetIds(ctx)).toEqual([third.asset.id]);
      await ctx.db.execute(sql`delete from assets`);
    }
  });

  it("knows nothing of an asset that does not exist or was removed", async () => {
    const ctx = await mediaContext();
    await expect(uploadOffset(ctx.deps, ctx.ada, "nope")).rejects.toMatchObject(GONE);
    await expect(completeUpload(ctx.deps, ctx.ada, "nope")).rejects.toMatchObject(GONE);
    const removed = await readyAsset(ctx);
    await ctx.db.execute(sql`update assets set removed_at = now(), removed_by = ${ctx.grace.userId} where id = ${removed.id}`);
    await expect(uploadOffset(ctx.deps, ctx.ada, removed.id)).rejects.toMatchObject(GONE);
    await expect(completeUpload(ctx.deps, ctx.ada, removed.id)).rejects.toMatchObject(GONE);
    await expect(uploadOffset(ctx.deps, ctx.root, removed.id)).rejects.toMatchObject(GONE);
  });

  it("is for editors: an uploader who is now a viewer cannot go on", async () => {
    const ctx = await mediaContext();
    const { asset, uploadUrl } = await openUpload(ctx.deps, ctx.ada, VIDEO);
    await sendAll(ctx.fake, uploadUrl, 20_000_000);
    const demoted = { ...ctx.ada, role: "viewer" as const };
    await expect(uploadOffset(ctx.deps, demoted, asset.id)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await expect(completeUpload(ctx.deps, demoted, asset.id)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await expect(uploadOffset(ctx.deps, ctx.vera, "nope")).rejects.toMatchObject({ code: "FORBIDDEN" }); // a viewer is not told what exists
    expect(await unfinishedCount(ctx)).toBe(1);
    // A ready asset is still its uploader's or an admin's to ask about here.
    await completeUpload(ctx.deps, ctx.ada, asset.id);
    await expect(completeUpload(ctx.deps, ctx.grace, asset.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(uploadOffset(ctx.deps, ctx.grace, asset.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await completeUpload(ctx.deps, ctx.root, asset.id)).status).toBe("ready");
  });

  it("records when the upload became ready, and which file it is", async () => {
    const ctx = await mediaContext();
    const { asset, uploadUrl } = await openUpload(ctx.deps, ctx.ada, VIDEO);
    await sendAll(ctx.fake, uploadUrl, 20_000_000);
    const ready = await completeUpload(ctx.deps, ctx.ada, asset.id);
    const { fileId } = ctx.fake.sessions.get(uploadUrl)!;
    expect(ready).toEqual({ ...asset, status: "ready", originalFileId: fileId });
    const [row] = await rows<{ status: string; drive_file_id: string; upload_url: string | null; age: number }>(
      ctx,
      sql`select status, drive_file_id, upload_url, extract(epoch from now() - ready_at)::float8 as age from assets`,
    );
    expect(row).toMatchObject({ status: "ready", drive_file_id: fileId, upload_url: null });
    expect(row.age).toBeGreaterThanOrEqual(0);
    expect(row.age).toBeLessThan(60);
  });

  it("completes one upload and no other", async () => {
    const ctx = await mediaContext();
    const mine = await openUpload(ctx.deps, ctx.ada, VIDEO);
    const other = await openUpload(ctx.deps, ctx.ada, clip("other.mov"));
    const graces = await openUpload(ctx.deps, ctx.grace, VIDEO);
    await sendAll(ctx.fake, mine.uploadUrl, 20_000_000);
    await completeUpload(ctx.deps, ctx.ada, mine.asset.id);
    const states = await rows<{ id: string; status: string }>(ctx, sql`select id, status from assets where status = 'uploading' order by id`);
    expect(states.map((row) => row.id)).toEqual([other.asset.id, graces.asset.id].sort());
  });

  it("returns a ready asset as it is, without asking Drive again", async () => {
    const ctx = await mediaContext();
    const ready = await readyAsset(ctx);
    ctx.fake.files.get(ready.originalFileId!)!.trashed = true; // whatever became of the file since
    const asked = ctx.fake.calls.length;
    expect(await completeUpload(ctx.deps, ctx.ada, ready.id)).toEqual(ready);
    expect(ctx.fake.calls.length).toBe(asked);
  });

  it("leaves an upload that another request completed as that request left it", async () => {
    const ctx = await mediaContext();
    const { asset, uploadUrl } = await openUpload(ctx.deps, ctx.ada, VIDEO);
    await sendAll(ctx.fake, uploadUrl, 20_000_000);
    const drive = {
      ...ctx.deps.drive,
      getFile: async (id: string) => {
        const file = await ctx.deps.drive.getFile(id);
        await completeUpload(ctx.deps, ctx.root, asset.id);
        await ctx.db.execute(sql`update assets set ready_at = '2026-11-08 10:00:00' where id = ${asset.id}`);
        return file;
      },
    };
    expect((await completeUpload({ ...ctx.deps, drive }, ctx.ada, asset.id)).status).toBe("ready");
    expect(await rows(ctx, sql`select ready_at::text as ready_at from assets`)).toEqual([{ ready_at: "2026-11-08 10:00:00" }]);
  });

  it("does not believe a file that was moved to the trash, or one of another size", async () => {
    const ctx = await mediaContext();
    const notFinished = { code: "CONFLICT", status: 409, message: "The upload is not finished." };
    const { asset, uploadUrl } = await openUpload(ctx.deps, ctx.ada, VIDEO);
    await sendAll(ctx.fake, uploadUrl, 20_000_000);
    const file = ctx.fake.files.get(ctx.fake.sessions.get(uploadUrl)!.fileId)!;
    file.trashed = true;
    await expect(completeUpload(ctx.deps, ctx.ada, asset.id)).rejects.toMatchObject(notFinished);
    file.trashed = false;
    for (const sizeBytes of [19_999_999, 20_000_001, 0]) {
      file.sizeBytes = sizeBytes;
      await expect(completeUpload(ctx.deps, ctx.ada, asset.id)).rejects.toMatchObject(notFinished);
    }
    // A file that is both unfinished and elsewhere is called unfinished.
    file.parents = ["some-other-folder"];
    await expect(completeUpload(ctx.deps, ctx.ada, asset.id)).rejects.toMatchObject(notFinished);
    expect(await unfinishedCount(ctx)).toBe(1);
    file.sizeBytes = 20_000_000;
    file.parents = [await ctx.deps.drive.folderId("Originals")];
    expect((await completeUpload(ctx.deps, ctx.ada, asset.id)).status).toBe("ready");
  });

  it("takes a file only from Originals, whatever else is true of it", async () => {
    const ctx = await mediaContext();
    const wrongFolder = { code: "INVALID", status: 400, message: "That file is not in the library's folder." };
    const { asset, uploadUrl } = await openUpload(ctx.deps, ctx.ada, VIDEO);
    await sendAll(ctx.fake, uploadUrl, 20_000_000);
    const file = ctx.fake.files.get(ctx.fake.sessions.get(uploadUrl)!.fileId)!;
    const originals = await ctx.deps.drive.folderId("Originals");
    for (const parents of [[await ctx.deps.drive.folderId("Previews")], [ctx.deps.drive.rootFolderId], ["drive9"], []]) {
      file.parents = parents;
      await expect(completeUpload(ctx.deps, ctx.ada, asset.id)).rejects.toMatchObject(wrongFolder);
    }
    expect(await unfinishedCount(ctx)).toBe(1);
    file.parents = ["some-other-folder", originals];
    expect((await completeUpload(ctx.deps, ctx.ada, asset.id)).status).toBe("ready");
  });

  it("answers both of two requests that complete an upload at once", async () => {
    const ctx = await mediaContext();
    const { asset, uploadUrl } = await openUpload(ctx.deps, ctx.ada, VIDEO);
    await sendAll(ctx.fake, uploadUrl, 20_000_000);
    const [a, b] = await Promise.all([completeUpload(ctx.deps, ctx.ada, asset.id), completeUpload(ctx.deps, ctx.root, asset.id)]);
    expect(a.status).toBe("ready");
    expect(b).toEqual(a);
  });

  it("says the asset is gone when it was canceled while Drive was being asked", async () => {
    const ctx = await mediaContext();
    const { asset, uploadUrl } = await openUpload(ctx.deps, ctx.ada, VIDEO);
    await sendAll(ctx.fake, uploadUrl, 20_000_000);
    const drive = {
      ...ctx.deps.drive,
      getFile: async (id: string) => {
        const file = await ctx.deps.drive.getFile(id);
        await ctx.db.execute(sql`delete from assets where id = ${asset.id}`);
        return file;
      },
    };
    await expect(completeUpload({ ...ctx.deps, drive }, ctx.ada, asset.id)).rejects.toMatchObject(GONE);
  });
});

describe("listing assets", () => {
  it("leaves removed assets out of the library, and gives them when asked for by id", async () => {
    const ctx = await mediaContext();
    const kept = await readyAsset(ctx, ctx.ada, VIDEO);
    const removed = await readyAsset(ctx, ctx.grace, IMAGE);
    await ctx.db.execute(sql`update assets set removed_at = now(), removed_by = ${ctx.root.userId} where id = ${removed.id}`);
    expect(await listAssets(ctx.db, ctx.vera)).toEqual([kept]);
    const named = await listAssets(ctx.db, ctx.vera, { ids: [removed.id, kept.id, removed.id] });
    expect(named).toEqual([{ ...removed, removed: true }, kept]); // newest first, each once
    expect(kept).toMatchObject({ removed: false, originalFileId: expect.any(String) });
  });

  it("gives a member their own unfinished uploads by id, and nobody else's, not even to an admin", async () => {
    const ctx = await mediaContext();
    const pending = await openUpload(ctx.deps, ctx.ada, VIDEO);
    expect(await listAssets(ctx.db, ctx.ada, { ids: [pending.asset.id] })).toEqual([pending.asset]);
    expect(await listAssets(ctx.db, ctx.root, { ids: [pending.asset.id] })).toEqual([]);
    expect(await listAssets(ctx.db, ctx.root)).toEqual([]);
    expect(await listAssets(ctx.db, ctx.ada)).toEqual([pending.asset]);
    expect(await listAssets(ctx.db, ctx.ada, { ids: [] })).toEqual([]); // no ids is not the whole library
  });

  it("takes up to 200 ids in one request", async () => {
    const ctx = await mediaContext();
    const video = await readyAsset(ctx);
    const ids = Array.from({ length: 199 }, (_, i) => `made-up-${i}`);
    expect(await listAssets(ctx.db, ctx.vera, { ids: [...ids, video.id] })).toEqual([video]);
    expect(await listAssets(ctx.db, ctx.vera, { ids: [...ids, video.id, video.id] })).toEqual([video]); // a repeat is not another id
    await expect(listAssets(ctx.db, ctx.vera, { ids: [...ids, video.id, "one-more"] })).rejects.toMatchObject({ code: "INVALID", status: 400, message: "Ask for up to 200 files at a time." });
  });

  it("orders assets made at the same moment by id", async () => {
    const ctx = await mediaContext();
    const a = await readyAsset(ctx, ctx.ada, VIDEO);
    const b = await readyAsset(ctx, ctx.ada, IMAGE);
    const c = await readyAsset(ctx, ctx.ada, AUDIO);
    const d = await openUpload(ctx.deps, ctx.ada, clip("d.mov"));
    const e = await openUpload(ctx.deps, ctx.ada, clip("e.mov"));
    await ctx.db.execute(sql`update assets set created_at = '2026-11-08 10:00:00'`);
    const byId = [a.id, b.id, c.id].sort();
    const unfinishedById = [d.asset.id, e.asset.id].sort();
    expect((await listAssets(ctx.db, ctx.ada)).map((asset) => asset.id)).toEqual([...byId, ...unfinishedById]);
    expect((await listAssets(ctx.db, ctx.ada, { ids: [c.id, b.id, a.id] })).map((asset) => asset.id)).toEqual(byId);
    expect((await listAssets(ctx.db, ctx.ada))[0].createdAt).toBe("2026-11-08T10:00:00.000Z");
    // The newest comes first whatever its id, among the ready ones and among the unfinished ones.
    await ctx.db.execute(sql`update assets set created_at = '2026-11-08 11:00:00' where id in (${byId[2]}, ${unfinishedById[1]})`);
    const newestFirst = [byId[2], byId[0], byId[1]];
    expect((await listAssets(ctx.db, ctx.ada)).map((asset) => asset.id)).toEqual([...newestFirst, unfinishedById[1], unfinishedById[0]]);
    expect((await listAssets(ctx.db, ctx.ada, { ids: byId })).map((asset) => asset.id)).toEqual(newestFirst);
  });

  it("sends at most 2,000 ready assets, the newest ones, and still the member's unfinished uploads", async () => {
    const ctx = await mediaContext();
    await ctx.db.execute(sql`
      insert into assets (id, kind, name, file_name, mime_type, size_bytes, last_modified_ms, status, drive_file_id, uploaded_by, created_at, ready_at)
      select 'bulk-' || lpad(n::text, 4, '0'), 'image', 'Field', 'field.jpg', 'image/jpeg', 3000000, 1762800060000, 'ready', 'file-' || n, ${ctx.grace.userId},
             timestamp '2026-11-01 00:00:00' + n * interval '1 second', now()
      from generate_series(1, 2001) as n
    `);
    const pending = await openUpload(ctx.deps, ctx.ada, VIDEO);
    const listed = await listAssets(ctx.db, ctx.ada);
    expect(listed).toHaveLength(2001);
    expect(listed[0].id).toBe("bulk-2001");
    expect(listed[1999].id).toBe("bulk-0002"); // the oldest one is left out
    expect(listed[2000]).toEqual(pending.asset);
    expect(await listAssets(ctx.db, ctx.vera)).toHaveLength(LIMITS.mediaListMax);
  });

  it("names an uploader whose account is gone as a former member", async () => {
    const ctx = await mediaContext();
    const video = await readyAsset(ctx, ctx.grace);
    expect(video.uploadedByName).toBe("Grace Hopper");
    await ctx.db.execute(sql`delete from "user" where id = ${ctx.grace.userId}`);
    expect(await listAssets(ctx.db, ctx.vera)).toEqual([{ ...video, uploadedByName: "A former member" }]);
  });

  it("never shows the session address or a file that is still on its way", async () => {
    const ctx = await mediaContext();
    const video = await readyAsset(ctx);
    const pending = await openUpload(ctx.deps, ctx.ada, AUDIO);
    await ctx.db.execute(sql`update assets set pending_preview_file_id = 'preview-on-its-way', pending_poster_file_id = 'poster-on-its-way', upload_url = coalesce(upload_url, 'https://www.googleapis.com/upload/drive/v3/files?upload_id=left-behind')`);
    const seen = [
      await listAssets(ctx.db, ctx.ada),
      await listAssets(ctx.db, ctx.ada, { ids: [video.id, pending.asset.id] }),
      (await openUpload(ctx.deps, ctx.ada, AUDIO)).asset,
      await completeUpload(ctx.deps, ctx.ada, video.id),
    ];
    for (const answer of seen) {
      expect(JSON.stringify(answer)).not.toMatch(/upload_id|on-its-way/);
      for (const asset of [answer].flat()) expect(Object.keys(asset).sort()).toEqual([...VIEW_KEYS].sort());
    }
    expect((await listAssets(ctx.db, ctx.ada)).map((asset) => asset.originalFileId)).toEqual([video.originalFileId, null]);
  });
});
