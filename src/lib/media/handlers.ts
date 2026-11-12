import { z } from "zod";
import type { DB } from "@/db";
import type { CurrentUser } from "@/lib/access-rules";
import { actorFrom, type Actor } from "@/lib/actor";
import { apiRoute } from "@/lib/api-route";
import type { DriveClient } from "@/lib/drive/client";
import { DriveError } from "@/lib/drive/token";
import { LIMITS } from "@/lib/limits";
import { ServiceError } from "@/lib/service-error";
import { MEDIA_MESSAGES } from "./messages";
import {
  completeAssetFile,
  completeUpload,
  failPreview,
  listAssets,
  openAssetFile,
  openUpload,
  removeAsset,
  updateAsset,
  uploadOffset,
  type AssetFileRole,
  type MediaDeps,
} from "./service";
import type { OpenUploadInput } from "./types";

export type MediaHandlerDeps = {
  db: () => DB;
  auth: (req: Request) => Promise<CurrentUser | Response>; // authentication only; the service checks the role
  drive: () => DriveClient | null; // null: media is not set up
  origin: () => string;
};

export type AssetRouteContext = { params: Promise<{ id: string }> };

export const NOT_SET_UP_BODY = { code: "MEDIA_NOT_SET_UP", message: "Uploads are not set up yet." } as const;
export const STORAGE_DOWN_BODY = { code: "STORAGE_UNAVAILABLE", message: MEDIA_MESSAGES.storageDown } as const;

// Only the shape of each body, with unknown keys refused. The service checks the values.
const probeBody = z.strictObject({
  kind: z.enum(["video", "image", "audio"]),
  durationMs: z.number().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  fps: z.number().nullable(),
  hasAudio: z.boolean(),
  videoCodec: z.string().nullable(),
});

const openBody: z.ZodType<OpenUploadInput> = z.strictObject({
  fileName: z.string(),
  sizeBytes: z.number(),
  mimeType: z.string(),
  lastModifiedMs: z.number(),
  probe: probeBody,
  event: z.string().optional(),
});

const updateBody = z.strictObject({ name: z.string().optional(), event: z.string().nullable().optional() });

const fileRole: z.ZodType<AssetFileRole> = z.enum(["preview", "poster"]);
const openFileBody = z.strictObject({ role: fileRole, sizeBytes: z.number() });
const completeFileBody = z.strictObject({ role: fileRole });

const idsParam = z.array(z.string()).max(LIMITS.mediaIdsPerRequest, MEDIA_MESSAGES.tooManyIds);

const invalid = (message: string) => new ServiceError("INVALID", 400, message);

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

function checked<T>(shape: z.ZodType<T>, value: unknown): T {
  const parsed = shape.safeParse(value);
  if (!parsed.success) throw invalid(describeIssue(parsed.error));
  return parsed.data;
}

// A request's JSON body in the given shape. Anything else is refused as INVALID.
async function bodyOf<T>(req: Request, shape: z.ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw invalid("Body must be valid JSON");
  }
  return checked(shape, json);
}

// The asset ids a list request names in `?ids=a,b`. Undefined when it names none: the whole library is meant.
function idsOf(req: Request): string[] | undefined {
  const param = new URL(req.url).searchParams.get("ids");
  if (param === null) return undefined;
  return checked(idsParam, param.split(",").filter((id) => id !== ""));
}

const notSetUp = () => Response.json(NOT_SET_UP_BODY, { status: 503 });

// The one line a failed Drive call leaves: which call, the status and Google's short code, which is all a DriveError holds.
const logDriveError = (error: DriveError) => console.error("Drive call failed", error.call, error.status, error.reason);

// What every route does around its own work. `apiRoute` refuses a write from another site and answers what the
// service refuses. Then the member is looked up, before anything else is read. And a failed Drive call is answered
// 502 with that one line logged.
function mediaRoute<Rest extends unknown[]>(deps: MediaHandlerDeps, handler: (actor: Actor, req: Request, ...rest: Rest) => Promise<Response>) {
  return apiRoute(async (req: Request, ...rest: Rest): Promise<Response> => {
    const user = await deps.auth(req);
    if (user instanceof Response) return user;
    try {
      return await handler(actorFrom(user), req, ...rest);
    } catch (error) {
      if (!(error instanceof DriveError)) throw error;
      logDriveError(error);
      return Response.json(STORAGE_DOWN_BODY, { status: 502 });
    }
  });
}

export function makeMediaHandlers(deps: MediaHandlerDeps) {
  // What the service needs to reach Drive. Null when media is not set up. A Drive failure the member is not shown
  // (a file that could not be moved to the trash) leaves the same one line.
  const media = (): MediaDeps | null => {
    const drive = deps.drive();
    return drive ? { db: deps.db(), drive, origin: deps.origin(), onDriveError: logDriveError } : null;
  };

  return {
    list: mediaRoute(deps, async (actor, req) => {
      const ids = idsOf(req);
      const assets = await listAssets(deps.db(), actor, { ids });
      return Response.json({ assets, setUp: deps.drive() !== null });
    }),

    open: mediaRoute(deps, async (actor, req) => {
      const service = media();
      if (!service) return notSetUp();
      const { asset, uploadUrl, offset } = await openUpload(service, actor, await bodyOf(req, openBody));
      return Response.json({ asset, uploadUrl, offset }, { status: 201 });
    }),

    update: mediaRoute(deps, async (actor, req, ctx: AssetRouteContext) => {
      const { id } = await ctx.params;
      const patch = await bodyOf(req, updateBody);
      return Response.json({ asset: await updateAsset(deps.db(), actor, id, patch) });
    }),

    remove: mediaRoute(deps, async (actor, _req, ctx: AssetRouteContext) => {
      const service = media();
      if (!service) return notSetUp();
      const { id } = await ctx.params;
      await removeAsset(service, actor, id);
      return new Response(null, { status: 204 });
    }),

    offset: mediaRoute(deps, async (actor, _req, ctx: AssetRouteContext) => {
      const service = media();
      if (!service) return notSetUp();
      const { id } = await ctx.params;
      const { uploadUrl, offset, done } = await uploadOffset(service, actor, id);
      return Response.json({ uploadUrl, offset, done });
    }),

    complete: mediaRoute(deps, async (actor, _req, ctx: AssetRouteContext) => {
      const service = media();
      if (!service) return notSetUp();
      const { id } = await ctx.params;
      return Response.json({ asset: await completeUpload(service, actor, id) });
    }),

    openFile: mediaRoute(deps, async (actor, req, ctx: AssetRouteContext) => {
      const service = media();
      if (!service) return notSetUp();
      const { id } = await ctx.params;
      const { uploadUrl } = await openAssetFile(service, actor, id, await bodyOf(req, openFileBody));
      return Response.json({ uploadUrl }, { status: 201 });
    }),

    completeFile: mediaRoute(deps, async (actor, req, ctx: AssetRouteContext) => {
      const service = media();
      if (!service) return notSetUp();
      const { id } = await ctx.params;
      const { role } = await bodyOf(req, completeFileBody);
      return Response.json({ asset: await completeAssetFile(service, actor, id, role) });
    }),

    previewFailed: mediaRoute(deps, async (actor, _req, ctx: AssetRouteContext) => {
      const { id } = await ctx.params;
      return Response.json({ asset: await failPreview(deps.db(), actor, id) });
    }),
  };
}

// The token a browser reads media files with: read-only, for any signed-in member, and never kept by a cache.
export function makeReadTokenHandler(deps: MediaHandlerDeps): (req: Request) => Promise<Response> {
  return mediaRoute(deps, async () => {
    const drive = deps.drive();
    if (!drive) return notSetUp();
    const { accessToken, expiresAt } = await drive.readToken(LIMITS.mediaReadTokenMinSeconds);
    return Response.json({ accessToken, expiresAt }, { headers: { "Cache-Control": "no-store" } });
  });
}
