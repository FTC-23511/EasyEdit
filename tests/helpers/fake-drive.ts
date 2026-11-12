import { createVerify, generateKeyPairSync, randomBytes } from "node:crypto";
import type { DriveConfig } from "@/lib/drive/config";
import { SCOPE_READ, SCOPE_WRITE } from "@/lib/drive/token";

// A pretend Google Drive, in memory. It writes down what the real checks showed (drive-facts.md), so a test
// that passes here says something about the real one. It holds no bytes, only how many arrived: a file read
// back is that many zero bytes.

const TOKEN_HOST = "oauth2.googleapis.com";
const API_HOST = "www.googleapis.com";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const ROOT_FOLDER_ID = "folder1"; // the folder that holds the media
const DRIVE_ID = "drive9"; // the shared drive that folder is in; the service account is not a member of it
const TOKEN_LIFE_MS = 3_600_000;
const PIECE_MULTIPLE = 262_144; // every piece but the last is a multiple of 256 KiB
const DEFAULT_FIELDS = ["kind", "id", "name", "mimeType"]; // what Drive reports about a file when not asked for more

// One real key for all the fakes of a test file: making one takes a while.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

type FakeFile = { name: string; parents: string[]; sizeBytes: number; mimeType: string; trashed: boolean };
type FakeSession = { fileId: string; sizeBytes: number; received: number; origin: string | null; name: string; parentId: string; mimeType: string };

export type FakeDrive = {
  fetch: typeof fetch; // answers oauth2.googleapis.com and www.googleapis.com; anything else throws
  config: DriveConfig; // a real RSA key made for the test; rootFolderId "folder1" (the folder that holds the media; every file and folder the fake holds reports driveId "drive9", a different value, as the real Drive does)
  files: Map<string, FakeFile>;
  sessions: Map<string, FakeSession>;
  calls: { method: string; path: string; scope: string | null; origin: string | null }[]; // path: without the query. scope: of the token the call carried
  failNext(match: RegExp, status: number, reason?: string): void; // the next call whose "METHOD path?query" matches is answered so; calls queue up
  dropNextPieceAfter(bytes: number): void; // the next piece keeps this many bytes, then the connection fails
  expireSessions(): void; // every open session now answers 404
  advance(ms: number): void;
  now(): number;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const newId = () => `1${randomBytes(24).toString("base64url")}`;
const sessionAddress = (uploadId: string) => `https://${API_HOST}/upload/drive/v3/files?uploadType=resumable&upload_id=${uploadId}`;

// A refusal in the shape the Drive API gives one.
const refusal = (status: number, reason?: string) =>
  Response.json({ error: { code: status, message: "The pretend Drive refused this call.", errors: reason ? [{ domain: "global", reason }] : [] } }, { status });

const sizeOf = async (body: BodyInit | null): Promise<number> => {
  if (body === null) return 0;
  if (typeof body === "string") return Buffer.byteLength(body);
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength;
  return (await new Response(body).arrayBuffer()).byteLength;
};

const jsonOf = async (headers: Headers, body: BodyInit | null): Promise<Record<string, unknown> | null> => {
  if (!(headers.get("content-type") ?? "").startsWith("application/json")) return null;
  const value: unknown = await new Response(body).json().catch(() => null);
  return isRecord(value) ? value : null;
};

const QUERY_TERM = /^(?:name = '((?:[^'\\]|\\.)*)'|mimeType = '((?:[^'\\]|\\.)*)'|'((?:[^'\\]|\\.)*)' in parents|trashed = (true|false))(?: and (?=.)|$)/;
const unescaped = (text: string) => text.replace(/\\(.)/g, "$1");

// The tests of a list's `q`, for the four kinds of term the app may write. null for anything else.
function readQuery(q: string): ((file: FakeFile) => boolean)[] | null {
  const tests: ((file: FakeFile) => boolean)[] = [];
  let rest = q;
  while (rest !== "") {
    const term = QUERY_TERM.exec(rest);
    if (!term) return null;
    const [whole, name, mimeType, parent, trashed] = term;
    if (name !== undefined) tests.push((file) => file.name === unescaped(name));
    else if (mimeType !== undefined) tests.push((file) => file.mimeType === unescaped(mimeType));
    else if (parent !== undefined) tests.push((file) => file.parents.includes(unescaped(parent)));
    else tests.push((file) => file.trashed === (trashed === "true"));
    rest = rest.slice(whole.length);
  }
  return tests;
}

export function makeFakeDrive(): FakeDrive {
  let clock = Date.now();
  let dropAfter: number | null = null;
  const failures: { match: RegExp; status: number; reason?: string }[] = [];
  const tokens = new Map<string, { scope: string; issuedAt: number }>();
  const expired = new Set<string>();
  const canceled = new Set<string>();

  const config: DriveConfig = { clientEmail: "easyedit-media@easyedit-test.iam.gserviceaccount.com", privateKey, rootFolderId: ROOT_FOLDER_ID };
  const files: FakeDrive["files"] = new Map([[ROOT_FOLDER_ID, { name: "EasyEdit", parents: [], sizeBytes: 0, mimeType: FOLDER_MIME, trashed: false }]]);
  const sessions: FakeDrive["sessions"] = new Map();
  const calls: FakeDrive["calls"] = [];

  // A file as Drive reports it, cut down to the fields asked for. A size is a string, and a folder has none.
  function report(id: string, fields: string[]): Record<string, unknown> {
    const file = files.get(id)!;
    const all: Record<string, unknown> = { kind: "drive#file", id, name: file.name, mimeType: file.mimeType, parents: file.parents, driveId: DRIVE_ID, trashed: file.trashed };
    if (file.mimeType !== FOLDER_MIME) all.size = String(file.sizeBytes);
    return Object.fromEntries(fields.filter((field) => field in all).map((field) => [field, all[field]]));
  }

  const isOpenFolder = (id: unknown): id is string => typeof id === "string" && files.get(id)?.mimeType === FOLDER_MIME && !files.get(id)!.trashed;

  // The token endpoint: checks the signed request against the key, and remembers which scope each token is for.
  async function issueToken(body: BodyInit | null): Promise<Response> {
    const form = new URLSearchParams(await new Response(body).text());
    if (form.get("grant_type") !== GRANT_TYPE) return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
    const [head, claims, signature] = (form.get("assertion") ?? "").split(".");
    const signed = head && claims && signature ? createVerify("RSA-SHA256").update(`${head}.${claims}`).verify(publicKey, signature, "base64url") : false;
    if (!signed) return Response.json({ error: "invalid_grant" }, { status: 400 });
    const { iss, scope } = JSON.parse(Buffer.from(claims, "base64url").toString()) as Record<string, unknown>;
    if (iss !== config.clientEmail) return Response.json({ error: "invalid_grant" }, { status: 400 });
    if (scope !== SCOPE_WRITE && scope !== SCOPE_READ) return Response.json({ error: "invalid_scope" }, { status: 400 });
    const accessToken = `ya29.fake-${randomBytes(18).toString("base64url")}`;
    tokens.set(accessToken, { scope, issuedAt: clock });
    return Response.json({ access_token: accessToken, expires_in: TOKEN_LIFE_MS / 1000, token_type: "Bearer" });
  }

  function generateIds(params: URLSearchParams): Response {
    const count = Number(params.get("count") ?? 10);
    return Response.json({ kind: "drive#generatedIds", space: "drive", ids: Array.from({ length: count }, newId) });
  }

  function list(params: URLSearchParams): Response {
    // The folder is shared, the drive is not: asking by drive is refused (fact 2).
    if (params.get("corpora") === "drive" || params.has("driveId")) return refusal(403, "teamDriveMembershipRequired");
    const tests = readQuery(params.get("q") ?? "");
    const fields = /^files\(([\w,]+)\)$/.exec(params.get("fields") ?? `files(${DEFAULT_FIELDS.join(",")})`)?.[1].split(",");
    const orderBy = params.get("orderBy");
    if (!tests || !fields || (orderBy !== null && orderBy !== "createdTime" && orderBy !== "createdTime desc")) return refusal(400, "invalid");
    // Without both flags, files in a shared drive are not listed at all (fact 5).
    const seesSharedDrives = params.get("supportsAllDrives") === "true" && params.get("includeItemsFromAllDrives") === "true";
    const found = seesSharedDrives ? [...files].filter(([, file]) => tests.every((test) => test(file))).map(([id]) => id) : [];
    // The map keeps files in the order they were made. Drive promises no order unless asked for one; the fake
    // then gives the newest first, so that a caller who forgot to ask is found out.
    if (orderBy !== "createdTime") found.reverse();
    return Response.json({ files: found.map((id) => report(id, fields)) });
  }

  async function createFile(params: URLSearchParams, headers: Headers, body: BodyInit | null): Promise<Response> {
    const meta = await jsonOf(headers, body);
    if (!meta || typeof meta.name !== "string") return refusal(400, "badRequest");
    const parent = Array.isArray(meta.parents) ? meta.parents[0] : undefined;
    if (params.get("supportsAllDrives") !== "true" || !isOpenFolder(parent)) return refusal(404, "notFound");
    const id = newId();
    files.set(id, { name: meta.name, parents: [parent], sizeBytes: 0, mimeType: typeof meta.mimeType === "string" ? meta.mimeType : "application/octet-stream", trashed: false });
    return Response.json(report(id, params.get("fields")?.split(",") ?? DEFAULT_FIELDS));
  }

  async function oneFile(method: string, id: string, params: URLSearchParams, headers: Headers, body: BodyInit | null): Promise<Response> {
    const file = files.get(id);
    // A file in a shared drive is not there for a caller that does not say it knows about shared drives.
    // And this member may not delete for good: that is answered 404 too (fact 6).
    if (!file || params.get("supportsAllDrives") !== "true" || method === "DELETE") return refusal(404, "notFound");
    if (method === "PATCH") {
      const change = await jsonOf(headers, body);
      if (!change) return refusal(400, "badRequest");
      if (typeof change.name === "string") file.name = change.name;
      if (typeof change.trashed === "boolean") file.trashed = change.trashed;
    } else if (method !== "GET") {
      return refusal(404, "notFound");
    }
    // The file itself and not its facts: as many zero bytes as it has. That the answer says how long it is has
    // not been seen in a real check; a reader must not depend on it.
    if (params.get("alt") === "media") return new Response(new Uint8Array(file.sizeBytes), { status: 200, headers: { "Content-Type": file.mimeType, "Content-Length": String(file.sizeBytes) } });
    return Response.json(report(id, params.get("fields")?.split(",") ?? DEFAULT_FIELDS));
  }

  async function openSession(params: URLSearchParams, headers: Headers, body: BodyInit | null): Promise<Response> {
    const meta = await jsonOf(headers, body);
    const length = headers.get("x-upload-content-length") ?? "";
    if (params.get("uploadType") !== "resumable" || !meta || typeof meta.name !== "string" || !/^\d+$/.test(length)) return refusal(400, "badRequest");
    const parentId = Array.isArray(meta.parents) ? meta.parents[0] : undefined;
    if (params.get("supportsAllDrives") !== "true" || !isOpenFolder(parentId)) return refusal(404, "notFound");
    const origin = headers.get("origin");
    const address = sessionAddress(randomBytes(18).toString("base64url"));
    sessions.set(address, {
      fileId: typeof meta.id === "string" ? meta.id : newId(),
      sizeBytes: Number(length),
      received: 0,
      origin,
      name: meta.name,
      parentId,
      mimeType: typeof meta.mimeType === "string" ? meta.mimeType : (headers.get("x-upload-content-type") ?? "application/octet-stream"),
    });
    return new Response(null, { status: 200, headers: { Location: address, ...(origin ? { "Access-Control-Allow-Origin": origin } : {}) } });
  }

  // A request to a session address. The address is the permission: no token is looked at.
  async function toSession(method: string, address: string, headers: Headers, body: BodyInit | null): Promise<Response> {
    // A page of any origin may ask (fact 10).
    if (method === "OPTIONS") {
      return new Response(null, { status: 200, headers: { "Access-Control-Allow-Origin": headers.get("origin") ?? "null", "Access-Control-Allow-Methods": "PUT", "Access-Control-Allow-Headers": "content-type,content-range" } });
    }
    const session = sessions.get(address);
    if (!session) return new Response(null, { status: 308 }); // an address Drive never gave out is not answered 404 (fact 20)
    if (canceled.has(address)) return new Response(null, { status: 499 });
    if (method === "DELETE") {
      canceled.add(address);
      return new Response(null, { status: 499 }); // what canceling answered (fact 11)
    }
    if (expired.has(address)) return new Response(null, { status: 404 });
    if (method !== "PUT") return refusal(400, "badRequest");

    // A page can read the answer only when the session was opened with its origin (fact 9).
    const cors = { "Access-Control-Allow-Origin": session.origin ?? "null", "Access-Control-Expose-Headers": "Range" };
    const finished = () => session.received === session.sizeBytes;
    const whereItIs = () =>
      finished()
        ? Response.json({ id: session.fileId }, { status: 200, headers: cors })
        : new Response(null, { status: 308, headers: session.received > 0 ? { ...cors, Range: `bytes=0-${session.received - 1}` } : cors });
    const receive = (bytes: number) => {
      session.received += bytes;
      if (finished()) files.set(session.fileId, { name: session.name, parents: [session.parentId], sizeBytes: session.sizeBytes, mimeType: session.mimeType, trashed: false });
    };

    const range = headers.get("content-range") ?? "";
    const question = /^bytes \*\/(\d+)$/.exec(range);
    if (question) return Number(question[1]) === session.sizeBytes ? whereItIs() : refusal(400, "badRequest");
    const part = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
    if (!part) return refusal(400, "badRequest");
    const [from, last, total] = part.slice(1).map(Number);
    const length = last - from + 1;
    const wellFormed = total === session.sizeBytes && last < total && length > 0 && (await sizeOf(body)) === length && (last + 1 === total || length % PIECE_MULTIPLE === 0);
    const inPlace = wellFormed && !finished() && from === session.received; // anything else is a repeat or a gap, and nothing of it is kept
    if (dropAfter !== null) {
      if (inPlace) receive(Math.min(dropAfter, length));
      dropAfter = null;
      throw new TypeError("fetch failed");
    }
    if (!wellFormed) return refusal(400, "badRequest");
    if (inPlace) receive(length);
    return whereItIs();
  }

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const asked = input instanceof Request ? input : null;
    const url = new URL(asked ? asked.url : String(input));
    if (url.host !== TOKEN_HOST && url.host !== API_HOST) throw new Error(`The pretend Drive does not answer ${url.host}.`);
    const method = (init?.method ?? asked?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? asked?.headers);
    const body: BodyInit | null = init?.body ?? (asked?.body ? await asked.arrayBuffer() : null);
    const params = url.searchParams;

    const token = tokens.get(/^Bearer (.+)$/.exec(headers.get("authorization") ?? "")?.[1] ?? "");
    calls.push({ method, path: url.pathname, scope: token?.scope ?? null, origin: headers.get("origin") });

    const planned = failures.findIndex((failure) => failure.match.test(`${method} ${url.pathname}${url.search}`));
    if (planned >= 0) {
      const [failure] = failures.splice(planned, 1);
      return refusal(failure.status, failure.reason);
    }

    if (url.host === TOKEN_HOST) return method === "POST" && url.pathname === "/token" ? issueToken(body) : refusal(404, "notFound");

    const uploadId = url.pathname === "/upload/drive/v3/files" ? params.get("upload_id") : null;
    if (uploadId !== null) return toSession(method, sessionAddress(uploadId), headers, body);

    // Everything else needs a token the fake gave out, not older than an hour; one that can only read may only GET.
    if (!token || clock - token.issuedAt >= TOKEN_LIFE_MS) return refusal(401, "authError");
    if (token.scope !== SCOPE_WRITE && method !== "GET") return refusal(403, "insufficientPermissions");

    if (url.pathname === "/upload/drive/v3/files" && method === "POST") return openSession(params, headers, body);
    if (url.pathname === "/drive/v3/files/generateIds" && method === "GET") return generateIds(params);
    if (url.pathname === "/drive/v3/files" && method === "GET") return list(params);
    if (url.pathname === "/drive/v3/files" && method === "POST") return createFile(params, headers, body);
    const fileId = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname)?.[1];
    if (fileId !== undefined) return oneFile(method, decodeURIComponent(fileId), params, headers, body);
    return refusal(404, "notFound");
  }) as typeof fetch;

  return {
    fetch: fetchFn,
    config,
    files,
    sessions,
    calls,
    failNext: (match, status, reason) => void failures.push({ match, status, reason }),
    dropNextPieceAfter: (bytes) => void (dropAfter = bytes),
    expireSessions: () => {
      for (const [address, session] of sessions) if (session.received < session.sizeBytes) expired.add(address);
    },
    advance: (ms) => void (clock += ms),
    now: () => clock,
  };
}

// One piece of an upload, as a browser sends it: `PUT url` with `Content-Range: bytes <from>-<to - 1>/<size>` and `to - from` zero bytes.
export function piece(fake: FakeDrive, url: string, from: number, to: number, size: number): Promise<Response> {
  return fake.fetch(url, { method: "PUT", headers: { "Content-Range": `bytes ${from}-${to - 1}/${size}` }, body: new Uint8Array(to - from) });
}
