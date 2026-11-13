import type { DriveConfig } from "./config";
import { DriveError, type GoogleToken, SCOPE_READ, SCOPE_WRITE, createTokenSource, reach, refusalReason } from "./token";

const API = "https://www.googleapis.com";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const JSON_TYPE = "application/json; charset=UTF-8";
const FILE_FIELDS = "id,name,size,mimeType,md5Checksum,parents,driveId,trashed";
// What a session that is gone answers. Google documents 404; a canceled one answered 499 in the real check.
const DEAD_SESSION = [404, 410, 499];

export type DriveFolder = "Originals" | "Previews";
export type DriveFile = { id: string; name: string; sizeBytes: number; mimeType: string; md5: string | null; parents: string[]; driveId: string | null; trashed: boolean };
export type DriveClient = {
  rootFolderId: string; // the id of the Drive folder that holds EasyEdit media; not a drive's id
  folderId(name: DriveFolder): Promise<string>; // found by name, made when missing, remembered
  newFileId(): Promise<string>;
  // Returns the session address. id: from newFileId; the file's id is always chosen before the upload.
  openUploadSession(input: { id: string; name: string; parentId: string; mimeType: string; sizeBytes: number; origin: string }): Promise<string>;
  // How much of an upload Drive holds. fileId is set when Drive's answer names the finished file.
  uploadOffset(sessionUrl: string, sizeBytes: number): Promise<{ done: boolean; offset: number; fileId: string | null }>;
  cancelSession(sessionUrl: string): Promise<void>; // a session that is already gone is not an error
  getFile(id: string): Promise<DriveFile | null>; // null when Drive has no such file
  trashFile(id: string): Promise<void>; // a file that is already gone is not an error
  readToken(minSecondsLeft: number): Promise<GoogleToken>; // read-only; the only token that may leave the server
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === "string" && value !== "";

// The JSON object in an answer, or an empty one when the answer holds something else.
async function objectIn(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json().catch(() => null);
  return isRecord(body) ? body : {};
}

// A failed call, reduced to which call, the status and Google's short code. The address, the headers and the
// rest of the answer are not kept.
const refused = async (call: string, response: Response) => new DriveError(call, response.status, await refusalReason(response));

// The media folder is a folder inside a shared drive that the service account is not a member of. So every
// request says `supportsAllDrives=true`, and none asks by drive (`corpora=drive`, `driveId`): that is refused.
export function createDriveClient(deps: { config: DriveConfig; fetch?: typeof fetch; now?: () => number }): DriveClient {
  const fetchFn = deps.fetch ?? fetch;
  const { clientEmail, privateKey, rootFolderId } = deps.config;
  const tokens = createTokenSource({ clientEmail, privateKey, fetch: deps.fetch, now: deps.now });
  const folders = new Map<DriveFolder, Promise<string>>();

  // One request to the Drive API, with the token that can change files. `call` names it in the error when Drive gives no answer.
  async function send(call: string, path: string, init: { method?: string; headers?: Record<string, string>; json?: object } = {}): Promise<Response> {
    const { accessToken } = await tokens.tokenFor(SCOPE_WRITE);
    return reach(fetchFn, call, `${API}${path}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${accessToken}`, ...init.headers, ...(init.json ? { "Content-Type": JSON_TYPE } : {}) },
      body: init.json ? JSON.stringify(init.json) : undefined,
    });
  }

  async function findOrMakeFolder(name: DriveFolder): Promise<string> {
    const q = `name = '${name}' and mimeType = '${FOLDER_MIME}' and '${rootFolderId}' in parents and trashed = false`;
    // The oldest folder of that name, or null. Oldest first: if two were ever made, everyone who looks finds the same one.
    const oldest = async (): Promise<string | null> => {
      const listed = await send("folder", `/drive/v3/files?q=${encodeURIComponent(q)}&includeItemsFromAllDrives=true&supportsAllDrives=true&orderBy=createdTime&fields=files(id)`);
      if (!listed.ok) throw await refused("folder", listed);
      const { files } = await objectIn(listed);
      if (!Array.isArray(files)) throw new DriveError("folder", listed.status, "unknown"); // not a list: do not take it for an empty one
      const first: unknown = files[0];
      if (first === undefined) return null;
      if (!isRecord(first) || !isId(first.id)) throw new DriveError("folder", listed.status, "unknown");
      return first.id;
    };

    const found = await oldest();
    if (found !== null) return found;
    const made = await send("folder", "/drive/v3/files?supportsAllDrives=true&fields=id", { method: "POST", json: { name, mimeType: FOLDER_MIME, parents: [rootFolderId] } });
    if (!made.ok) throw await refused("folder", made);
    const { id } = await objectIn(made);
    if (!isId(id)) throw new DriveError("folder", made.status, "unknown");
    // Another server instance may have found no folder at the same moment and made one too. Looking once more
    // settles both on the older one; the other stays in Drive, empty. The folder is made by now, so a second look
    // that shows nothing or fails is no reason to fail.
    try {
      return (await oldest()) ?? id;
    } catch (error) {
      if (!(error instanceof DriveError)) throw error;
      return id;
    }
  }

  return {
    rootFolderId,

    folderId(name) {
      const known = folders.get(name);
      if (known) return known;
      // Calls made while this one is on its way share it. One that fails is forgotten, so the next call asks again.
      const looking = findOrMakeFolder(name);
      folders.set(name, looking);
      looking.catch(() => folders.delete(name));
      return looking;
    },

    async newFileId() {
      const answer = await send("ids", "/drive/v3/files/generateIds?count=1&space=drive&type=files");
      if (!answer.ok) throw await refused("ids", answer);
      const { ids } = await objectIn(answer);
      const id: unknown = Array.isArray(ids) ? ids[0] : undefined;
      if (!isId(id)) throw new DriveError("ids", answer.status, "unknown");
      return id;
    },

    async openUploadSession({ id, name, parentId, mimeType, sizeBytes, origin }) {
      // Without the page's origin here, the page cannot read Drive's answers to the pieces it sends.
      const answer = await send("session", "/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true", {
        method: "POST",
        headers: { Origin: origin, "X-Upload-Content-Type": mimeType, "X-Upload-Content-Length": String(sizeBytes) },
        json: { id, name, parents: [parentId], mimeType },
      });
      if (!answer.ok) throw await refused("session", answer);
      const address = answer.headers.get("location");
      if (!address) throw new DriveError("session", answer.status, "unknown");
      return address;
    },

    async uploadOffset(sessionUrl, sizeBytes) {
      // No token: the address is the permission.
      const answer = await reach(fetchFn, "session", sessionUrl, { method: "PUT", headers: { "Content-Range": `bytes */${sizeBytes}` } });
      if (answer.status === 308) {
        const range = answer.headers.get("range");
        if (range === null) return { done: false, offset: 0, fileId: null }; // Drive holds nothing yet
        const last = /^bytes=0-(\d+)$/.exec(range);
        if (!last) throw new DriveError("session", answer.status, "unknown");
        return { done: false, offset: Number(last[1]) + 1, fileId: null };
      }
      if (answer.status === 200 || answer.status === 201) {
        const { id } = await objectIn(answer);
        return { done: true, offset: sizeBytes, fileId: isId(id) ? id : null };
      }
      if (DEAD_SESSION.includes(answer.status)) throw new DriveError("session", answer.status, "expired");
      throw await refused("session", answer);
    },

    async cancelSession(sessionUrl) {
      // No token: the address is the permission. A canceled session answers 499, and goes on answering it.
      const answer = await reach(fetchFn, "cancel", sessionUrl, { method: "DELETE" });
      if (!answer.ok && !DEAD_SESSION.includes(answer.status)) throw await refused("cancel", answer);
    },

    async getFile(id) {
      if (id === "") return null; // the address without an id is the list of all files
      const answer = await send("file", `/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=${FILE_FIELDS}`);
      if (answer.status === 404) return null;
      if (!answer.ok) throw await refused("file", answer);
      const file = await objectIn(answer);
      if (!isId(file.id) || typeof file.name !== "string" || typeof file.mimeType !== "string") throw new DriveError("file", answer.status, "unknown");
      const size = Number(file.size); // Drive writes a size as a string, and gives none for a folder
      return {
        id: file.id,
        name: file.name,
        sizeBytes: Number.isSafeInteger(size) && size >= 0 ? size : 0,
        mimeType: file.mimeType,
        md5: typeof file.md5Checksum === "string" ? file.md5Checksum : null,
        parents: Array.isArray(file.parents) ? file.parents.filter((parent) => typeof parent === "string") : [],
        driveId: typeof file.driveId === "string" ? file.driveId : null,
        trashed: file.trashed === true,
      };
    },

    async trashFile(id) {
      if (id === "") return;
      // The folder's member may not delete for good: removing a file means moving it to the trash.
      const answer = await send("trash", `/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true`, { method: "PATCH", json: { trashed: true } });
      if (!answer.ok && answer.status !== 404) throw await refused("trash", answer);
    },

    readToken: (minSecondsLeft) => tokens.tokenFor(SCOPE_READ, minSecondsLeft),
  };
}
