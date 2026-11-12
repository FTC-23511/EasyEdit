import { nanoid } from "nanoid";
import type { DB } from "@/db";
import { assets, user } from "@/db/schema";
import type { CurrentUser } from "@/lib/access-rules";
import type { Actor } from "@/lib/actor";
import { createDriveClient } from "@/lib/drive/client";
import { LIMITS } from "@/lib/limits";
import { makeMediaHandlers, makeReadTokenHandler, type AssetRouteContext, type MediaHandlerDeps } from "@/lib/media/handlers";
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

const APP_ORIGIN = "https://app.test"; // where the app is served in tests

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
  return { db, fake, deps: { db, drive, origin: APP_ORIGIN }, ada, grace, vera, root };
}

// A fetch for the browser's API client: each request goes to the route handler Next would call for its method
// and path, with `actor` signed in. A request that has no route throws.
export function handlersFetch(ctx: MediaContext, actor: Actor): typeof fetch {
  const member: CurrentUser = { id: actor.userId, email: actor.email, name: actor.email, image: null, role: actor.role };
  const deps: MediaHandlerDeps = { db: () => ctx.db, auth: async () => member, drive: () => ctx.deps.drive, origin: () => APP_ORIGIN };
  const media = makeMediaHandlers(deps);
  const readToken = makeReadTokenHandler(deps);
  const forAll = new Map<string, (req: Request) => Promise<Response>>([
    ["GET /api/media", media.list],
    ["POST /api/media", media.open],
    ["POST /api/drive/read-token", readToken],
  ]);
  // By what follows the asset's id in the path.
  const forOne = new Map<string, (req: Request, at: AssetRouteContext) => Promise<Response>>([
    ["PATCH ", media.update],
    ["DELETE ", media.remove],
    ["POST /offset", media.offset],
    ["POST /complete", media.complete],
    ["POST /files", media.openFile],
    ["POST /files/complete", media.completeFile],
    ["POST /preview-failed", media.previewFailed],
  ]);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), APP_ORIGIN);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    headers.set("origin", APP_ORIGIN);
    const req = new Request(url, { method, headers, body: init?.body });
    if (url.origin === APP_ORIGIN) {
      const all = forAll.get(`${method} ${url.pathname}`);
      if (all) return all(req);
      const [, id, rest = ""] = /^\/api\/media\/([^/]+)(\/.*)?$/.exec(url.pathname) ?? [];
      const one = forOne.get(`${method} ${rest}`);
      if (id !== undefined && one) return one(req, { params: Promise.resolve({ id: decodeURIComponent(id) }) });
    }
    throw new Error(`No route for ${method} ${url.origin === APP_ORIGIN ? url.pathname : url.href}`);
  }) as typeof fetch;
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

export const CLIP_TRANSFORM = { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1, fit: "cover" };
// A video clip that names an asset, as an add_clip op carries it.
export const mediaClip = (assetId: string, over: Record<string, unknown> = {}) => ({ type: "video", assetId, start: 0, duration: 90, in: 0, speed: 1, volume: 1, transform: CLIP_TRANSFORM, ...over });

// A ready asset row written straight to the database, for tests that need an asset and no Drive. Defaults: a 12.5 s video named "IMG_4821", uploaded by "u1".
export async function insertAsset(db: DB, over: Partial<typeof assets.$inferInsert> = {}): Promise<string> {
  const id = over.id ?? nanoid(12);
  await db.insert(assets).values({
    kind: "video", name: "IMG_4821", fileName: "IMG_4821.MOV", mimeType: "video/quicktime", sizeBytes: 20_000_000, lastModifiedMs: 1_762_800_000_000,
    status: "ready", driveFileId: `drive-${id}`, durationMs: 12_500, width: 1080, height: 1920, fps: 30, hasAudio: true, videoCodec: "hevc",
    previewStatus: "pending", uploadedBy: "u1", readyAt: new Date(), ...over, id,
  });
  return id;
}
