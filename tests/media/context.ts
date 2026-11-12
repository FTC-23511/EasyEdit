import type { DB } from "@/db";
import { user } from "@/db/schema";
import type { Actor } from "@/lib/actor";
import { createDriveClient } from "@/lib/drive/client";
import { LIMITS } from "@/lib/limits";
import { completeUpload, openUpload, type MediaDeps } from "@/lib/media/service";
import type { AssetView, OpenUploadInput } from "@/lib/media/types";
import { makeTestDb } from "../helpers/db";
import { makeFakeDrive, piece, type FakeDrive } from "../helpers/fake-drive";

// Three files as a browser describes them when it opens an upload.
export const VIDEO: OpenUploadInput = {
  fileName: "IMG_4821.MOV",
  sizeBytes: 20_000_000,
  mimeType: "video/quicktime",
  lastModifiedMs: 1_762_800_000_000,
  probe: { kind: "video", durationMs: 12_500, width: 1080, height: 1920, fps: 30, hasAudio: true, videoCodec: "hevc" },
};

export const IMAGE: OpenUploadInput = {
  fileName: "field.jpg",
  sizeBytes: 3_000_000,
  mimeType: "image/jpeg",
  lastModifiedMs: 1_762_800_060_000,
  probe: { kind: "image", durationMs: null, width: 4032, height: 3024, fps: null, hasAudio: false, videoCodec: null },
};

export const AUDIO: OpenUploadInput = {
  fileName: "theme.mp3",
  sizeBytes: 4_000_000,
  mimeType: "audio/mpeg",
  lastModifiedMs: 1_762_800_120_000,
  probe: { kind: "audio", durationMs: 95_000, width: null, height: null, fps: null, hasAudio: true, videoCodec: null },
};

export type MediaContext = { db: DB; fake: FakeDrive; deps: MediaDeps; ada: Actor; grace: Actor; vera: Actor; root: Actor };

const ada: Actor = { userId: "user-ada", email: "ada@gmail.com", role: "editor" };
const grace: Actor = { userId: "user-grace", email: "grace@gmail.com", role: "editor" };
const vera: Actor = { userId: "user-vera", email: "vera@gmail.com", role: "viewer" };
const root: Actor = { userId: "user-root", email: "root@gmail.com", role: "admin" };

// A migrated database with four members in it, and the Drive client talking to a pretend Drive.
export async function mediaContext(): Promise<MediaContext> {
  const db = await makeTestDb();
  const member = (actor: Actor, name: string) => ({ id: actor.userId, name, email: actor.email, emailVerified: true });
  await db.insert(user).values([member(ada, "Ada Lovelace"), member(grace, "Grace Hopper"), member(vera, "Vera Rubin"), member(root, "Root Admin")]);
  const fake = makeFakeDrive();
  const drive = createDriveClient({ config: fake.config, fetch: fake.fetch, now: fake.now });
  return { db, fake, deps: { db, drive, origin: "https://app.test" }, ada, grace, vera, root };
}

// What a browser does: sends 8 MiB pieces from `from` until Drive answers 200.
export async function sendAll(fake: FakeDrive, uploadUrl: string, sizeBytes: number, from = 0): Promise<void> {
  for (let at = from; ; ) {
    const to = Math.min(at + LIMITS.mediaChunkBytes, sizeBytes);
    const answer = await piece(fake, uploadUrl, at, to, sizeBytes);
    if (answer.status === 200) return;
    if (answer.status !== 308) throw new Error(`The pretend Drive answered ${answer.status} to the piece at ${at}.`);
    at = to;
  }
}

// An asset whose original is in Drive: open, send every piece, complete.
export async function readyAsset(ctx: MediaContext, actor: Actor = ctx.ada, input: OpenUploadInput = VIDEO): Promise<AssetView> {
  const { asset, uploadUrl, offset } = await openUpload(ctx.deps, actor, input);
  if (offset < input.sizeBytes) await sendAll(ctx.fake, uploadUrl, input.sizeBytes, offset);
  return completeUpload(ctx.deps, actor, asset.id);
}
