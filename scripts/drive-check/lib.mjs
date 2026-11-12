// The Drive calls the media upload design rests on, in plain Node (24 or later).
// Task 4 writes the same requests again in TypeScript for the app; this file is
// the reference they were first run from. If a request changes there, change it
// here too.
//
// Nothing here logs. Errors carry only the name of the call, an HTTP status and
// a short reason code from Google's answer: never a token, the key, a body or a
// request address.

import { readFile } from "node:fs/promises";
import { createHash, sign } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const API = "https://www.googleapis.com";
export const WRITE_SCOPE = "https://www.googleapis.com/auth/drive";
export const READ_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const FILE_FIELDS = "id,name,size,mimeType,md5Checksum,parents,driveId,trashed";

const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const SAFE_REASON = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;

export class GoogleError extends Error {
  constructor(call, status, reason) {
    super(status === 0 ? `${call}: no answer (network error)` : `${call} answered ${status}${reason ? ` ${reason}` : ""}`);
    this.name = "GoogleError";
    this.call = call;
    this.status = status;
    this.reason = reason;
  }
}

// A short reason code from an error answer, or "". Only a plain word is kept,
// so nothing else from the body can reach a message.
async function reasonOf(res) {
  let body;
  try {
    body = await res.json();
  } catch {
    return "";
  }
  const candidates = [
    body?.error?.errors?.[0]?.reason,
    body?.error?.status,
    typeof body?.error === "string" ? body.error : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && SAFE_REASON.test(candidate)) return candidate;
  }
  return "";
}

async function send(call, fetch, url, init) {
  try {
    return await fetch(url, { redirect: "manual", ...init });
  } catch {
    throw new GoogleError(call, 0, "");
  }
}

async function failure(call, res) {
  return new GoogleError(call, res.status, await reasonOf(res));
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

function base64url(text) {
  return Buffer.from(text).toString("base64url");
}

// Reads the service account key file. Returns only the two fields the token
// request needs. No message ever quotes the file.
export async function readKeyFile(path) {
  const full = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  let text;
  try {
    text = await readFile(full, "utf8");
  } catch (error) {
    throw new Error(`cannot read the key file (${error?.code ?? "error"})`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("the key file is not JSON");
  }
  if (typeof json?.client_email !== "string" || typeof json?.private_key !== "string") {
    throw new Error("the key file has no client_email or private_key");
  }
  return { client_email: json.client_email, private_key: json.private_key };
}

// token: a JWT signed RS256 with the key, traded for an access token.
export async function tokenFor(key, scope, fetch) {
  const iat = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({ iss: key.client_email, scope, aud: TOKEN_URL, iat, exp: iat + 3600 }),
  );
  const unsigned = `${header}.${claims}`;
  let signature;
  try {
    signature = sign("sha256", Buffer.from(unsigned), key.private_key).toString("base64url");
  } catch {
    throw new Error("the key's private_key cannot sign");
  }
  const res = await send("token", fetch, TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${JWT_BEARER}&assertion=${unsigned}.${signature}`,
  });
  if (!res.ok) throw await failure("token", res);
  const json = await res.json();
  if (typeof json?.access_token !== "string") throw new GoogleError("token", res.status, "noAccessToken");
  return { accessToken: json.access_token, expiresIn: json.expires_in };
}

// new file id: one id Drive will accept for a file made later.
export async function generateFileId(token, fetch) {
  const res = await send("generateIds", fetch, `${API}/drive/v3/files/generateIds?count=1&space=drive&type=files`, {
    headers: bearer(token),
  });
  if (!res.ok) throw await failure("generateIds", res);
  const json = await res.json();
  const id = json?.ids?.[0];
  if (typeof id !== "string") throw new GoogleError("generateIds", res.status, "noId");
  return id;
}

// make the folder: a folder named `name` inside `parentId`. Returns its id.
export async function createFolder(token, { name, parentId }, fetch) {
  const res = await send("create folder", fetch, `${API}/drive/v3/files?supportsAllDrives=true&fields=id`, {
    method: "POST",
    headers: { ...bearer(token), "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
  if (!res.ok) throw await failure("create folder", res);
  const json = await res.json();
  if (typeof json?.id !== "string") throw new GoogleError("create folder", res.status, "noId");
  return json.id;
}

// open a session: a resumable upload for the preset file `id`. `origin` is the
// page's origin, or null to leave the header out. Returns the session address,
// which grants the upload: never print it.
export async function openSession(token, { id, name, parentId, mimeType, size, origin }, fetch) {
  const headers = {
    ...bearer(token),
    "X-Upload-Content-Type": mimeType,
    "X-Upload-Content-Length": String(size),
    "Content-Type": "application/json; charset=UTF-8",
  };
  if (origin) headers.Origin = origin;
  const res = await send("open session", fetch, `${API}/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true`, {
    method: "POST",
    headers,
    body: JSON.stringify({ id, name, parents: [parentId], mimeType }),
  });
  if (!res.ok) throw await failure("open session", res);
  const location = res.headers.get("location");
  if (!location) throw new GoogleError("open session", res.status, "noLocation");
  return location;
}

// offset question: where a session stopped. No Authorization: the address is
// the credential. 404, 410 and 499 mean the session is gone.
export async function askOffset(sessionUrl, size, fetch) {
  const res = await send("offset question", fetch, sessionUrl, {
    method: "PUT",
    headers: { "Content-Range": `bytes */${size}` },
  });
  if (res.status === 308) {
    const match = /^bytes=0-(\d+)$/.exec(res.headers.get("range") ?? "");
    return { done: false, offset: match ? Number(match[1]) + 1 : 0 };
  }
  if (res.status === 200 || res.status === 201) {
    const json = await res.json().catch(() => null);
    return { done: true, offset: size, id: typeof json?.id === "string" ? json.id : null };
  }
  if (res.status === 404 || res.status === 410 || res.status === 499) {
    throw new GoogleError("offset question", res.status, "sessionGone");
  }
  throw await failure("offset question", res);
}

// file facts.
export async function getFile(token, id, fetch) {
  const res = await send("files.get", fetch, `${API}/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=${FILE_FIELDS}`, {
    headers: bearer(token),
  });
  if (!res.ok) throw await failure("files.get", res);
  return res.json();
}

// trash: moves a file or folder to the trash. Answers the status instead of
// throwing, since a refusal is itself a fact worth recording.
export async function trashFile(token, id, fetch) {
  let res;
  try {
    res = await send("trash", fetch, `${API}/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true`, {
      method: "PATCH",
      headers: { ...bearer(token), "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ trashed: true }),
    });
  } catch (error) {
    return { status: error.status ?? 0, reason: "networkError" };
  }
  if (res.ok) return { status: res.status, reason: "" };
  return { status: res.status, reason: await reasonOf(res) };
}

// The test bytes: byte i is i % 251, so a shifted or repeated piece shows up.
export function patternBytes(size) {
  const period = Buffer.alloc(251);
  for (let i = 0; i < 251; i++) period[i] = i;
  return Buffer.alloc(size, period);
}

export function md5Hex(bytes) {
  return createHash("md5").update(bytes).digest("hex");
}
