import { z } from "zod";
import type { AssetView, OpenUploadInput } from "./types";

// Why a call did not work. `message` is the server's own sentence, and empty when it gave none.
export type MediaFailure = { ok: false; kind: "network" | "signed-out" | "forbidden" | "not-set-up" | "storage" | "refused"; message: string };
export type MediaResult<T> = ({ ok: true } & T) | MediaFailure;

export type MediaApi = {
  list(ids?: string[]): Promise<MediaResult<{ assets: AssetView[]; setUp: boolean }>>;
  open(input: OpenUploadInput): Promise<MediaResult<{ asset: AssetView; uploadUrl: string; offset: number }>>;
  offset(assetId: string): Promise<MediaResult<{ uploadUrl: string | null; offset: number; done: boolean }>>;
  complete(assetId: string): Promise<MediaResult<{ asset: AssetView }>>;
  openFile(assetId: string, role: "preview" | "poster", sizeBytes: number): Promise<MediaResult<{ uploadUrl: string }>>;
  completeFile(assetId: string, role: "preview" | "poster"): Promise<MediaResult<{ asset: AssetView }>>;
  previewFailed(assetId: string): Promise<MediaResult<{ asset: AssetView }>>;
  update(assetId: string, patch: { name?: string; event?: string | null }): Promise<MediaResult<{ asset: AssetView }>>;
  remove(assetId: string): Promise<MediaResult<object>>;
  readToken(): Promise<MediaResult<{ accessToken: string; expiresAt: number }>>;
};

const NETWORK: MediaFailure = { ok: false, kind: "network", message: "" };
const UNEXPECTED: MediaFailure = { ok: false, kind: "refused", message: "Unexpected answer." };

// The fields of each answer. A key that is not named here is dropped.
const assetView: z.ZodType<AssetView> = z.object({
  id: z.string(),
  kind: z.enum(["video", "image", "audio"]),
  name: z.string(),
  fileName: z.string(),
  sizeBytes: z.number(),
  status: z.enum(["uploading", "ready"]),
  removed: z.boolean(),
  durationMs: z.number().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  fps: z.number().nullable(),
  hasAudio: z.boolean(),
  originalFileId: z.string().nullable(),
  previewStatus: z.enum(["none", "pending", "ready", "failed"]),
  previewFileId: z.string().nullable(),
  posterFileId: z.string().nullable(),
  event: z.string().nullable(),
  uploadedBy: z.string(),
  uploadedByName: z.string(),
  createdAt: z.string(),
});
const listed = z.object({ assets: z.array(assetView), setUp: z.boolean() });
const opened = z.object({ asset: assetView, uploadUrl: z.string(), offset: z.number() });
const held = z.object({ uploadUrl: z.string().nullable(), offset: z.number(), done: z.boolean() });
const oneAsset = z.object({ asset: assetView });
const fileOpened = z.object({ uploadUrl: z.string() });
const token = z.object({ accessToken: z.string(), expiresAt: z.number() });

// What a call takes from a 2xx body. Null: the body does not hold it.
type Take<T> = (body: unknown) => T | null;

const fieldsOf =
  <T>(shape: z.ZodType<T>): Take<T> =>
  (body) => {
    const parsed = shape.safeParse(body);
    return parsed.success ? parsed.data : null;
  };

const nothing: Take<object> = () => ({}); // the answer to a removal has no body

function failureFor(status: number, body: unknown): MediaFailure {
  const { code, message } = typeof body === "object" && body !== null ? (body as { code?: unknown; message?: unknown }) : {};
  const sentence = typeof message === "string" ? message : "";
  if (status === 401) return { ok: false, kind: "signed-out", message: sentence };
  if (status === 403) return { ok: false, kind: "forbidden", message: sentence };
  if (status === 503 && code === "MEDIA_NOT_SET_UP") return { ok: false, kind: "not-set-up", message: sentence };
  if (status === 502) return { ok: false, kind: "storage", message: sentence };
  return { ok: false, kind: "refused", message: sentence };
}

type Call = { method: "GET" | "POST" | "PATCH" | "DELETE"; path: string; body?: unknown };

const MEDIA = "/api/media";
const assetPath = (assetId: string, rest = "") => `${MEDIA}/${encodeURIComponent(assetId)}${rest}`;

// The website's media routes, as the browser calls them. No call throws: whatever goes wrong is a MediaFailure.
export function createMediaApi(fetchFn?: typeof fetch): MediaApi {
  const doFetch: typeof fetch = fetchFn ?? ((input, init) => fetch(input, init));

  // Sends one request to the page's own origin and reads the answer. A request that could not be written, sent
  // or read to its end is a network failure.
  async function request<T>(call: () => Call, pick: Take<T>): Promise<MediaResult<T>> {
    let response: Response;
    let text: string;
    try {
      const { method, path, body } = call();
      response = await doFetch(path, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
      });
      text = await response.text();
    } catch {
      return NETWORK;
    }
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON: an empty answer, or a page from something in between. The status still says what happened.
    }
    if (!response.ok) return failureFor(response.status, body);
    const fields = pick(body);
    return fields ? { ok: true, ...fields } : UNEXPECTED;
  }

  const post = <T>(path: () => string, pick: Take<T>, body?: unknown) => request(() => ({ method: "POST", path: path(), body }), pick);

  return {
    list: (ids) => request(() => ({ method: "GET", path: ids ? `${MEDIA}?ids=${ids.map(encodeURIComponent).join(",")}` : MEDIA }), fieldsOf(listed)),
    open: (input) => post(() => MEDIA, fieldsOf(opened), input),
    offset: (assetId) => post(() => assetPath(assetId, "/offset"), fieldsOf(held)),
    complete: (assetId) => post(() => assetPath(assetId, "/complete"), fieldsOf(oneAsset)),
    openFile: (assetId, role, sizeBytes) => post(() => assetPath(assetId, "/files"), fieldsOf(fileOpened), { role, sizeBytes }),
    completeFile: (assetId, role) => post(() => assetPath(assetId, "/files/complete"), fieldsOf(oneAsset), { role }),
    previewFailed: (assetId) => post(() => assetPath(assetId, "/preview-failed"), fieldsOf(oneAsset)),
    update: (assetId, patch) => request(() => ({ method: "PATCH", path: assetPath(assetId), body: patch }), fieldsOf(oneAsset)),
    remove: (assetId) => request(() => ({ method: "DELETE", path: assetPath(assetId) }), nothing),
    readToken: () => post(() => "/api/drive/read-token", fieldsOf(token)),
  };
}
