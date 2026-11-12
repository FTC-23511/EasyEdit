import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDriveClient } from "@/lib/drive/client";
import { DriveError, SCOPE_READ, SCOPE_WRITE, createTokenSource } from "@/lib/drive/token";
import { type FakeDrive, makeFakeDrive, piece } from "../helpers/fake-drive";

const MiB = 1024 * 1024;
const B = "https://www.googleapis.com";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const client = (fake = makeFakeDrive()) => ({ fake, drive: createDriveClient({ config: fake.config, fetch: fake.fetch, now: fake.now }) });

type Sent = { method: string; url: string; headers: Record<string, string>; body: unknown };

// A client whose requests are written down as they leave, and can be answered by `answer` instead of by the fake.
function watched(answer: (line: string) => Response | undefined = () => undefined) {
  const fake = makeFakeDrive();
  const sent: Sent[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = new URL(String(input));
    if (url.host === "www.googleapis.com") sent.push({ method, url: url.href, headers: Object.fromEntries(new Headers(init?.headers)), body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body });
    return answer(`${method} ${url.pathname}${url.search}`) ?? fake.fetch(input, init);
  }) as typeof fetch;
  return { fake, sent, drive: createDriveClient({ config: fake.config, fetch: fetchFn, now: fake.now }) };
}

// The header a call to the fake carries when it is made by hand, with a token of the given scope.
async function bearer(fake: FakeDrive, scope: string) {
  const tokens = createTokenSource({ clientEmail: fake.config.clientEmail, privateKey: fake.config.privateKey, fetch: fake.fetch, now: fake.now });
  return { Authorization: `Bearer ${(await tokens.tokenFor(scope)).accessToken}` };
}

const aFolder = (name: string, parents = ["folder1"], trashed = false) => ({ name, parents, sizeBytes: 0, mimeType: FOLDER_MIME, trashed });
const reasonOf = async (response: Response) => ((await response.json()) as { error: { errors: { reason: string }[] } }).error.errors[0]?.reason;

afterEach(() => vi.unstubAllGlobals());

describe("the Drive client", () => {
  it("finds a folder by name, makes it once when missing, and remembers it", async () => {
    const { fake, drive } = client();
    const id = await drive.folderId("Originals");
    expect(await drive.folderId("Originals")).toBe(id);
    expect(fake.calls.filter((c) => c.method === "POST" && c.path === "/drive/v3/files")).toHaveLength(1);
    expect(fake.files.get(id)).toMatchObject({ name: "Originals", parents: ["folder1"] });
    expect(await createDriveClient({ config: fake.config, fetch: fake.fetch }).folderId("Originals")).toBe(id); // a new instance finds it
    expect(await drive.folderId("Previews")).not.toBe(id);
  });

  it("opens an upload session for a chosen file id, with the app's origin", async () => {
    const { fake, drive } = client();
    const parentId = await drive.folderId("Originals");
    const id = await drive.newFileId();
    const url = await drive.openUploadSession({ id, name: "a1__clip.mov", parentId, mimeType: "video/quicktime", sizeBytes: 20 * MiB, origin: "https://app.test" });
    expect(fake.sessions.get(url)).toEqual({ fileId: id, sizeBytes: 20 * MiB, received: 0, origin: "https://app.test", name: "a1__clip.mov", parentId, mimeType: "video/quicktime" });
    expect(fake.calls.at(-1)).toMatchObject({ method: "POST", path: "/upload/drive/v3/files", scope: SCOPE_WRITE, origin: "https://app.test" });
  });

  it("reports how much of an upload Drive holds, and when it is complete", async () => {
    const { fake, drive } = client();
    const id = await drive.newFileId();
    const url = await drive.openUploadSession({ id, name: "n", parentId: await drive.folderId("Originals"), mimeType: "video/mp4", sizeBytes: 20 * MiB, origin: "https://app.test" });
    expect(await drive.uploadOffset(url, 20 * MiB)).toEqual({ done: false, offset: 0, fileId: null });
    await piece(fake, url, 0, 8 * MiB, 20 * MiB);
    expect(await drive.uploadOffset(url, 20 * MiB)).toEqual({ done: false, offset: 8 * MiB, fileId: null });
    expect(await drive.getFile(id)).toBeNull(); // no file until the last byte
    await piece(fake, url, 8 * MiB, 16 * MiB, 20 * MiB);
    await piece(fake, url, 16 * MiB, 20 * MiB, 20 * MiB);
    expect(await drive.uploadOffset(url, 20 * MiB)).toEqual({ done: true, offset: 20 * MiB, fileId: id });
    expect(await drive.getFile(id)).toEqual({ id, name: "n", sizeBytes: 20 * MiB, mimeType: "video/mp4", md5: null, parents: [await drive.folderId("Originals")], driveId: "drive9", trashed: false });
  });

  it("says so when a session has expired", async () => {
    const { fake, drive } = client();
    const url = await drive.openUploadSession({ id: await drive.newFileId(), name: "n", parentId: await drive.folderId("Originals"), mimeType: "video/mp4", sizeBytes: MiB, origin: "https://app.test" });
    fake.expireSessions();
    await expect(drive.uploadOffset(url, MiB)).rejects.toMatchObject({ call: "session", status: 404, reason: "expired" });
    for (const status of [410, 499]) { // 499 is what a canceled session answered in the real check (drive-facts 11)
      fake.failNext(/^PUT \/upload\//, status);
      await expect(drive.uploadOffset(url, MiB)).rejects.toMatchObject({ call: "session", status, reason: "expired" });
    }
  });

  it("moves a file to the trash, and does not mind one that is gone", async () => {
    const { fake, drive } = client();
    const folder = await drive.folderId("Previews");
    await drive.trashFile(folder);
    expect(fake.files.get(folder)!.trashed).toBe(true);
    await expect(drive.trashFile("no-such-file")).resolves.toBeUndefined();
  });

  it("hands out a read-only token that cannot change anything", async () => {
    const { fake, drive } = client();
    const folder = await drive.folderId("Originals");
    const token = await drive.readToken(600);
    expect(token.expiresAt - fake.now()).toBeGreaterThanOrEqual(600_000);
    const refused = await fake.fetch(`https://www.googleapis.com/drive/v3/files/${folder}?supportsAllDrives=true`, { method: "PATCH", headers: { Authorization: `Bearer ${token.accessToken}` }, body: JSON.stringify({ trashed: true }) });
    expect(refused.status).toBe(403);
    expect(fake.calls.at(-1)!.scope).toBe(SCOPE_READ);
  });

  it("reduces a failure to the call, the status and a reason", async () => {
    const { fake, drive } = client();
    fake.failNext(/GET \/drive\/v3\/files\/generateIds/, 403, "rateLimitExceeded");
    const error = await drive.newFileId().catch((e) => e);
    expect(error).toBeInstanceOf(DriveError);
    expect(error.message).toBe("Drive call failed: ids 403 rateLimitExceeded");
    expect(JSON.stringify(error)).not.toMatch(/Bearer|googleapis/);
  });

  // Assumption A9: Node's fetch sends an Origin that code sets.
  it("really sends the Origin it is given", async () => {
    let seen: string | undefined;
    const server = createServer((req, res) => { seen = req.headers.origin; res.writeHead(200, { Location: "http://127.0.0.1/session" }).end(); });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as { port: number };
    try {
      await fetch(`http://127.0.0.1:${port}/`, { method: "POST", headers: { Origin: "https://app.test" }, body: "{}" });
    } finally {
      server.close();
    }
    expect(seen).toBe("https://app.test");
  });

  it("sends each request as Drive was seen to take it", async () => {
    const { fake, sent, drive } = watched();
    const write = { authorization: expect.stringMatching(/^Bearer ya29\./) };
    const json = { ...write, "content-type": "application/json; charset=UTF-8" };
    const id = await drive.newFileId();
    const parentId = await drive.folderId("Originals");
    const url = await drive.openUploadSession({ id, name: "a1__clip.mov", parentId, mimeType: "video/quicktime", sizeBytes: 20 * MiB, origin: "https://app.test" });
    await drive.uploadOffset(url, 20 * MiB);
    await drive.getFile(id);
    await drive.trashFile(id);

    const [ids, list, make, again, open, offset, get, trash] = sent;
    expect(sent).toHaveLength(8);
    expect(ids).toEqual({ method: "GET", url: `${B}/drive/v3/files/generateIds?count=1&space=drive&type=files`, headers: write, body: undefined });
    expect(list).toMatchObject({ method: "GET", headers: write, body: undefined });
    expect(list.url.split("?")[0]).toBe(`${B}/drive/v3/files`);
    expect(Object.fromEntries(new URL(list.url).searchParams)).toEqual({
      q: "name = 'Originals' and mimeType = 'application/vnd.google-apps.folder' and 'folder1' in parents and trashed = false",
      includeItemsFromAllDrives: "true",
      supportsAllDrives: "true",
      orderBy: "createdTime",
      fields: "files(id)",
    });
    expect(make).toEqual({ method: "POST", url: `${B}/drive/v3/files?supportsAllDrives=true&fields=id`, headers: json, body: { name: "Originals", mimeType: FOLDER_MIME, parents: ["folder1"] } });
    expect(again).toEqual(list); // after making the folder, the same list request once more
    expect(open).toEqual({
      method: "POST",
      url: `${B}/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true`,
      headers: { ...json, origin: "https://app.test", "x-upload-content-type": "video/quicktime", "x-upload-content-length": "20971520" },
      body: { id, name: "a1__clip.mov", parents: [parentId], mimeType: "video/quicktime" },
    });
    expect(offset).toEqual({ method: "PUT", url, headers: { "content-range": "bytes */20971520" }, body: undefined }); // the address is the permission: no token
    expect(get).toEqual({ method: "GET", url: `${B}/drive/v3/files/${id}?supportsAllDrives=true&fields=id,name,size,mimeType,md5Checksum,parents,driveId,trashed`, headers: write, body: undefined });
    expect(trash).toEqual({ method: "PATCH", url: `${B}/drive/v3/files/${id}?supportsAllDrives=true`, headers: json, body: { trashed: true } });

    // Every call but the offset question carried the token that can write, and all of them shared one.
    expect(fake.calls.filter((c) => c.path !== "/token").map((c) => c.scope)).toEqual([SCOPE_WRITE, SCOPE_WRITE, SCOPE_WRITE, SCOPE_WRITE, SCOPE_WRITE, null, SCOPE_WRITE, SCOPE_WRITE]);
    expect(fake.calls.filter((c) => c.path === "/token")).toHaveLength(1);
    expect(sent.some((request) => /corpora|driveId=/.test(request.url))).toBe(false);
  });

  it("knows the folder it was set up with", () => {
    expect(client().drive.rootFolderId).toBe("folder1");
  });

  it("makes one folder when two callers ask at once", async () => {
    const { fake, drive } = client();
    const [a, b] = await Promise.all([drive.folderId("Originals"), drive.folderId("Originals")]);
    expect(a).toBe(b);
    expect(fake.calls.filter((c) => c.path === "/drive/v3/files")).toHaveLength(3); // one look, one folder made, one look again
  });

  it("settles two server instances that ask at once on one folder", async () => {
    const fake = makeFakeDrive();
    const instance = () => createDriveClient({ config: fake.config, fetch: fake.fetch, now: fake.now });
    const [a, b] = [instance(), instance()];
    const [idA, idB] = await Promise.all([a.folderId("Originals"), b.folderId("Originals")]);
    expect(idA).toBe(idB);
    expect(await instance().folderId("Originals")).toBe(idA); // a third agrees with both
    // Each found no folder and made one. The older one is the folder; the other is left in Drive, empty.
    const made = [...fake.files].filter(([, file]) => file.name === "Originals").map(([id]) => id);
    expect(made).toHaveLength(2);
    expect(idA).toBe(made[0]);
    // Both remember it: neither asks Drive again.
    const asked = fake.calls.length;
    expect([await a.folderId("Originals"), await b.folderId("Originals")]).toEqual([idA, idA]);
    expect(fake.calls).toHaveLength(asked);
  });

  it("keeps the folder it made when it cannot look again", async () => {
    // What the second look is answered with, for a client whose first look finds nothing.
    const secondLook = async (answer: () => Response) => {
      let looks = 0;
      const { fake, drive } = watched((line) => (line.startsWith("GET /drive/v3/files?") && ++looks === 2 ? answer() : undefined));
      const id = await drive.folderId("Originals");
      expect(looks).toBe(2);
      expect(fake.files.get(id)).toEqual(aFolder("Originals")); // the one it made
      expect(await drive.folderId("Originals")).toBe(id); // and it is remembered
      expect(looks).toBe(2);
    };
    await secondLook(() => Response.json({ error: { code: 500, errors: [{ reason: "backendError" }] } }, { status: 500 }));
    await secondLook(() => Response.json({ files: "none" })); // an answer that cannot be read
    await secondLook(() => Response.json({ files: [{ id: 7 }] }));
    await secondLook(() => Response.json({ files: [] })); // Drive's list does not show the new folder yet
    await secondLook(() => { throw new TypeError("fetch failed"); }); // no answer at all
    // Only a failed Drive call is passed over. Anything else that goes wrong is not hidden.
    const broken = { get ok(): boolean { throw new RangeError("not a Drive failure"); } } as Response;
    await expect(secondLook(() => broken)).rejects.toThrow(RangeError);
  });

  it("takes the oldest folder when there are two of a name", async () => {
    const { fake, drive } = client();
    fake.files.set("older", aFolder("Originals"));
    fake.files.set("newer", aFolder("Originals"));
    expect(await drive.folderId("Originals")).toBe("older");
    expect(fake.calls.some((c) => c.method === "POST" && c.path === "/drive/v3/files")).toBe(false);
  });

  it("does not take a folder in the trash, a folder somewhere else, or a file of that name for the folder", async () => {
    const { fake, drive } = client();
    fake.files.set("trashed", aFolder("Originals", ["folder1"], true));
    fake.files.set("elsewhere", aFolder("Originals", ["some-other-folder"]));
    fake.files.set("a-file", { ...aFolder("Originals"), mimeType: "video/mp4" });
    fake.files.set("another-name", aFolder("Previews"));
    const id = await drive.folderId("Originals");
    expect(["trashed", "elsewhere", "a-file", "another-name"]).not.toContain(id);
    expect(fake.files.get(id)).toEqual(aFolder("Originals"));
  });

  it("does not remember a folder it could not find or make", async () => {
    const { fake, drive } = client();
    fake.failNext(/^GET \/drive\/v3\/files\?/, 500, "backendError");
    await expect(drive.folderId("Originals")).rejects.toMatchObject({ call: "folder", status: 500, reason: "backendError" });
    fake.failNext(/^POST \/drive\/v3\/files\?/, 403, "insufficientFilePermissions");
    await expect(drive.folderId("Originals")).rejects.toMatchObject({ call: "folder", status: 403, reason: "insufficientFilePermissions" });
    expect(fake.files.size).toBe(1); // only the media folder itself
    const id = await drive.folderId("Originals");
    expect(fake.files.get(id)).toEqual(aFolder("Originals"));
  });

  it("names the call that failed", async () => {
    const { fake, drive } = client();
    const parentId = await drive.folderId("Originals");
    fake.failNext(/^POST \/upload\//, 404, "notFound");
    await expect(drive.openUploadSession({ id: "x", name: "n", parentId, mimeType: "video/mp4", sizeBytes: MiB, origin: "https://app.test" })).rejects.toMatchObject({ name: "DriveError", call: "session", status: 404, reason: "notFound" });
    fake.failNext(/^GET \/drive\/v3\/files\/x/, 500, "backendError");
    await expect(drive.getFile("x")).rejects.toMatchObject({ name: "DriveError", call: "file", status: 500, reason: "backendError" });
    fake.failNext(/^GET \/drive\/v3\/files\/x/, 500); // an answer with no reason in it
    await expect(drive.getFile("x")).rejects.toMatchObject({ name: "DriveError", call: "file", status: 500, reason: "unknown" });
    fake.failNext(/^PATCH /, 403, "insufficientFilePermissions");
    await expect(drive.trashFile(parentId)).rejects.toMatchObject({ name: "DriveError", call: "trash", status: 403, reason: "insufficientFilePermissions" });
    expect(fake.files.get(parentId)!.trashed).toBe(false);
    const url = await drive.openUploadSession({ id: "x", name: "n", parentId, mimeType: "video/mp4", sizeBytes: MiB, origin: "https://app.test" });
    fake.failNext(/^PUT \/upload\//, 503, "backendError");
    await expect(drive.uploadOffset(url, MiB)).rejects.toMatchObject({ name: "DriveError", call: "session", status: 503, reason: "backendError" });
    fake.advance(3_600_000); // the token is too old to use, and Google will not give another
    fake.failNext(/^POST \/token/, 400, "invalid_grant");
    await expect(drive.newFileId()).rejects.toMatchObject({ name: "DriveError", call: "token", status: 400, reason: "invalid_grant" });
  });

  it("keeps nothing of Google's answer or of the request in an error", async () => {
    const leak = () => Response.json({ error: { code: 500, message: "PUT https://www.googleapis.com/upload/drive/v3/files?upload_id=abc with Bearer ya29.secret", errors: [{ reason: "https://www.googleapis.com/x?upload_id=abc" }] } }, { status: 500 });
    const { drive } = watched((line) => (line.startsWith("PUT ") || line.includes("generateIds") ? leak() : undefined));
    const url = await drive.openUploadSession({ id: "x", name: "n", parentId: await drive.folderId("Originals"), mimeType: "video/mp4", sizeBytes: MiB, origin: "https://app.test" });
    for (const failing of [() => drive.uploadOffset(url, MiB), () => drive.newFileId()]) {
      const error = await failing().catch((e) => e);
      expect(error).toBeInstanceOf(DriveError);
      expect(error).toMatchObject({ status: 500, reason: "unknown" });
      expect(Object.keys(error).sort()).toEqual(["call", "name", "reason", "status"]);
      expect(inspect(error, { depth: 10 }) + JSON.stringify(error) + error.stack).not.toMatch(/googleapis|upload_id|Bearer|ya29/);
    }
  });

  it("does not name the session in the error for an expired one", async () => {
    const { fake, drive } = client();
    const url = await drive.openUploadSession({ id: "x", name: "n", parentId: await drive.folderId("Originals"), mimeType: "video/mp4", sizeBytes: MiB, origin: "https://app.test" });
    fake.expireSessions();
    const error = await drive.uploadOffset(url, MiB).catch((e) => e);
    expect(error.message).toBe("Drive call failed: session 404 expired");
    expect(inspect(error, { depth: 10 }) + JSON.stringify(error) + error.stack).not.toMatch(/googleapis|upload_id/);
  });

  it("calls a dead session expired whatever reason Drive gives", async () => {
    const { fake, drive } = client();
    const url = await drive.openUploadSession({ id: "x", name: "n", parentId: await drive.folderId("Originals"), mimeType: "video/mp4", sizeBytes: MiB, origin: "https://app.test" });
    for (const status of [404, 410, 499]) {
      fake.failNext(/^PUT \/upload\//, status, "notFound");
      await expect(drive.uploadOffset(url, MiB)).rejects.toMatchObject({ call: "session", status, reason: "expired" });
    }
    for (const status of [400, 403, 409, 500]) {
      fake.failNext(/^PUT \/upload\//, status, "notFound");
      await expect(drive.uploadOffset(url, MiB)).rejects.toMatchObject({ call: "session", status, reason: "notFound" });
    }
  });

  it("asks a session where it is without a token", async () => {
    const { fake, drive } = client();
    const url = await drive.openUploadSession({ id: "x", name: "n", parentId: await drive.folderId("Originals"), mimeType: "video/mp4", sizeBytes: MiB, origin: "https://app.test" });
    await drive.uploadOffset(url, MiB);
    expect(fake.calls.at(-1)).toEqual({ method: "PUT", path: "/upload/drive/v3/files", scope: null, origin: null });
  });

  it("reads the offset from the Range of a 308, and takes 201 for done", async () => {
    let answer = new Response(null, { status: 308, headers: { Range: "bytes=0-524287" } });
    const { drive } = watched((line) => (line.startsWith("PUT ") ? answer : undefined));
    expect(await drive.uploadOffset(`${B}/upload/drive/v3/files?upload_id=a`, MiB)).toEqual({ done: false, offset: 524_288, fileId: null });
    answer = new Response(null, { status: 308, headers: { Range: "bytes=0-0" } });
    expect(await drive.uploadOffset(`${B}/upload/drive/v3/files?upload_id=a`, MiB)).toEqual({ done: false, offset: 1, fileId: null });
    answer = new Response(null, { status: 308 });
    expect(await drive.uploadOffset(`${B}/upload/drive/v3/files?upload_id=a`, MiB)).toEqual({ done: false, offset: 0, fileId: null });
    answer = Response.json({ id: "file7", name: "n" }, { status: 201 });
    expect(await drive.uploadOffset(`${B}/upload/drive/v3/files?upload_id=a`, MiB)).toEqual({ done: true, offset: MiB, fileId: "file7" });
    answer = new Response("", { status: 200 }); // done, but the answer does not name the file
    expect(await drive.uploadOffset(`${B}/upload/drive/v3/files?upload_id=a`, MiB)).toEqual({ done: true, offset: MiB, fileId: null });
    for (const range of ["bytes=5-9", "0-524287", "bytes=0-", "bytes=0-12x"]) {
      answer = new Response(null, { status: 308, headers: { Range: range } });
      await expect(drive.uploadOffset(`${B}/upload/drive/v3/files?upload_id=a`, MiB)).rejects.toMatchObject({ call: "session", status: 308, reason: "unknown" });
    }
  });

  it("reads a file's facts as Drive gives them", async () => {
    let answer: unknown = { id: "f1", name: "a.mov", size: "20971520", mimeType: "video/quicktime", md5Checksum: "0f343b0931126a20f133d67c2b018a3b", parents: ["p1"], driveId: "drive9", trashed: false };
    const { fake, drive } = watched((line) => (line.startsWith("GET /drive/v3/files/f1") ? Response.json(answer) : undefined));
    expect(await drive.getFile("f1")).toEqual({ id: "f1", name: "a.mov", sizeBytes: 20_971_520, mimeType: "video/quicktime", md5: "0f343b0931126a20f133d67c2b018a3b", parents: ["p1"], driveId: "drive9", trashed: false });
    answer = { id: "f1", name: "a.mov", mimeType: "video/quicktime" }; // the least Drive says
    expect(await drive.getFile("f1")).toEqual({ id: "f1", name: "a.mov", sizeBytes: 0, mimeType: "video/quicktime", md5: null, parents: [], driveId: null, trashed: false });
    // A folder has no size, and a file in the trash is still there.
    const folderId = await drive.folderId("Previews");
    await drive.trashFile(folderId);
    expect(await drive.getFile(folderId)).toEqual({ id: folderId, name: "Previews", sizeBytes: 0, mimeType: FOLDER_MIME, md5: null, parents: ["folder1"], driveId: "drive9", trashed: true });
    expect(await drive.getFile("folder1")).toMatchObject({ id: "folder1", driveId: "drive9" }); // the media folder is in a drive whose id is not its own
    expect(await drive.getFile("no-such-file")).toBeNull();
    fake.failNext(/^GET \/drive\/v3\/files\/folder1/, 404, "notFound");
    expect(await drive.getFile("folder1")).toBeNull();
  });

  it("asks for a file by its id and nothing else", async () => {
    const { fake, drive } = client();
    expect(await drive.getFile("a/b?c=d")).toBeNull();
    expect(fake.calls.at(-1)).toMatchObject({ method: "GET", path: "/drive/v3/files/a%2Fb%3Fc%3Dd" });
    await drive.trashFile("../files?q=x");
    expect(fake.calls.at(-1)).toMatchObject({ method: "PATCH", path: "/drive/v3/files/..%2Ffiles%3Fq%3Dx" });
    const before = fake.calls.length;
    expect(await drive.getFile("")).toBeNull(); // no id is no file; the address without one is the list of all files
    await expect(drive.trashFile("")).resolves.toBeUndefined();
    expect(fake.calls).toHaveLength(before);
  });

  it("does not take an answer that lacks what was asked for", async () => {
    let answer: unknown = {};
    const { drive } = watched((line) => (/generateIds|^GET \/drive\/v3\/files\/f1|^POST \/upload\//.test(line) ? Response.json(answer) : undefined));
    for (const bad of [{}, { ids: [] }, { ids: [7] }, { ids: [""] }, { ids: "abc" }, null, "abc"]) {
      answer = bad;
      await expect(drive.newFileId()).rejects.toMatchObject({ name: "DriveError", call: "ids", status: 200, reason: "unknown" });
    }
    for (const bad of [{}, { name: "a", mimeType: "video/mp4" }, { id: "", name: "a", mimeType: "video/mp4" }, { id: "f1", mimeType: "video/mp4" }, { id: "f1", name: "a" }, null, ["f1"]]) {
      answer = bad;
      await expect(drive.getFile("f1")).rejects.toMatchObject({ name: "DriveError", call: "file", status: 200, reason: "unknown" });
    }
    // An opened session with no address
    await expect(drive.openUploadSession({ id: "x", name: "n", parentId: "p", mimeType: "video/mp4", sizeBytes: MiB, origin: "https://app.test" })).rejects.toMatchObject({ name: "DriveError", call: "session", status: 200, reason: "unknown" });
  });

  it("does not make a folder when the list cannot be read, or take a folder without an id", async () => {
    let listed: unknown = {};
    let made: unknown = { id: "made0" }; // what a list wrongly taken for empty would lead to
    const { fake, drive } = watched((line) => (line.startsWith("GET /drive/v3/files?") ? Response.json(listed) : line.startsWith("POST /drive/v3/files?") ? Response.json(made) : undefined));
    for (const bad of [{}, { files: "none" }, { files: [{}] }, { files: [{ id: 7 }] }, { files: [{ id: "" }] }, null]) {
      listed = bad;
      await expect(drive.folderId("Originals")).rejects.toMatchObject({ name: "DriveError", call: "folder", status: 200, reason: "unknown" });
    }
    listed = { files: [] };
    for (const bad of [{}, { id: 7 }, { id: "" }, null]) {
      made = bad;
      await expect(drive.folderId("Originals")).rejects.toMatchObject({ name: "DriveError", call: "folder", status: 200, reason: "unknown" });
    }
    expect(fake.calls.filter((c) => c.path !== "/token")).toHaveLength(0); // nothing reached Drive
    made = { id: "made1" };
    expect(await drive.folderId("Originals")).toBe("made1");
    listed = { files: [{ id: "found1" }, { id: "found2" }] };
    expect(await drive.folderId("Previews")).toBe("found1");
  });

  it("asks for a read token with as much time left as the caller needs", async () => {
    const { fake, drive } = client();
    const first = await drive.readToken(600);
    fake.advance(3_600_000 - 500_000); // 500 s left
    expect(await drive.readToken(300)).toEqual(first);
    const second = await drive.readToken(600);
    expect(second.accessToken).not.toBe(first.accessToken);
    expect(second.expiresAt - fake.now()).toBeGreaterThanOrEqual(600_000);
    expect(fake.calls.map((c) => c.path)).toEqual(["/token", "/token"]); // a read token is not a Drive call
    const asked = await fake.fetch(`${B}/drive/v3/files/folder1?supportsAllDrives=true`, { headers: { Authorization: `Bearer ${second.accessToken}` } });
    expect(asked.status).toBe(200); // it can read
    expect(fake.calls.at(-1)!.scope).toBe(SCOPE_READ);
  });

  it("says Drive could not be reached when a request gets no answer, whichever call it was", async () => {
    let down: RegExp | null = null;
    // What fetch throws can quote what it was sending: here the request line, a token and a session address.
    const { fake, drive } = watched((line) => {
      if (!down?.test(line)) return undefined;
      throw Object.assign(new TypeError(`fetch failed: ${line} with Bearer ya29.secret`), { cause: new Error(`ECONNRESET ${B}/upload/drive/v3/files?upload_id=abc`) });
    });
    const parentId = await drive.folderId("Originals");
    const id = await drive.newFileId();
    const session = { id, name: "n", parentId, mimeType: "video/mp4", sizeBytes: MiB, origin: "https://app.test" };
    const url = await drive.openUploadSession(session);
    // The request that gets no answer, the call it belongs to, and how many requests Drive answered before it.
    const calls: [RegExp, string, number, () => Promise<unknown>][] = [
      [/generateIds/, "ids", 0, () => drive.newFileId()],
      [/^GET \/drive\/v3\/files\?q=/, "folder", 0, () => drive.folderId("Previews")], // looking for the folder
      [/^POST \/drive\/v3\/files\?/, "folder", 1, () => drive.folderId("Previews")], // making it
      [/^POST \/upload\//, "session", 0, () => drive.openUploadSession(session)],
      [/^PUT \/upload\//, "session", 0, () => drive.uploadOffset(url, MiB)],
      [/^GET \/drive\/v3\/files\/[^?]+\?/, "file", 0, () => drive.getFile(id)],
      [/^PATCH /, "trash", 0, () => drive.trashFile(parentId)],
    ];
    for (const [match, call, answered, ask] of calls) {
      const seen = fake.calls.length;
      down = match;
      const error = (await ask().catch((e: unknown) => e)) as DriveError;
      expect(error, call).toBeInstanceOf(DriveError);
      expect(error, call).toMatchObject({ call, status: 0, reason: "unreachable" }); // no answer, so no status
      expect(error.message).toBe(`Drive call failed: ${call} 0 unreachable`);
      expect(Object.keys(error).sort()).toEqual(["call", "name", "reason", "status"]);
      expect(inspect(error, { depth: 10 }) + JSON.stringify(error) + error.stack, call).not.toMatch(/fetch failed|ECONNRESET|googleapis|upload_id|Bearer|ya29/);
      down = null;
      expect(fake.calls.length - seen, call).toBe(answered);
    }
    // Nothing of a failure is remembered: each call works once Drive answers again.
    expect(await drive.folderId("Previews")).toMatch(/\w/);
    expect(await drive.uploadOffset(url, MiB)).toEqual({ done: false, offset: 0, fileId: null });
    expect((await drive.getFile(parentId))?.trashed).toBe(false);
  });

  it("says Google could not be reached when the token request gets no answer", async () => {
    let down = true;
    const { fake, drive } = watched((line) => {
      if (down && line === "POST /token") throw new TypeError("fetch failed");
      return undefined;
    });
    await expect(drive.newFileId()).rejects.toMatchObject({ name: "DriveError", call: "token", status: 0, reason: "unreachable" });
    await expect(drive.readToken(600)).rejects.toMatchObject({ name: "DriveError", call: "token", status: 0, reason: "unreachable" });
    expect(fake.calls).toEqual([]);
    down = false;
    expect(await drive.newFileId()).toMatch(/^[\w-]{20,}$/);
    expect((await drive.readToken(600)).accessToken).toMatch(/\w/);
  });

  it("uses the real fetch and the real clock when none is given", async () => {
    const fake = makeFakeDrive();
    vi.stubGlobal("fetch", fake.fetch);
    const before = Date.now();
    const drive = createDriveClient({ config: fake.config });
    expect(await drive.newFileId()).toMatch(/^[\w-]{20,}$/);
    await drive.uploadOffset(`${B}/upload/drive/v3/files?uploadType=resumable&upload_id=none`, MiB);
    expect(fake.calls.map((c) => c.path)).toEqual(["/token", "/drive/v3/files/generateIds", "/upload/drive/v3/files"]);
    expect((await drive.readToken(600)).expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
  });
});

describe("the server's Drive", () => {
  const settings = (fake: FakeDrive) => Buffer.from(JSON.stringify({ client_email: fake.config.clientEmail, private_key: fake.config.privateKey })).toString("base64");
  const load = async () => {
    vi.resetModules();
    return (await import("@/lib/drive")).getDrive;
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    delete (globalThis as { __easyEditDrive?: unknown }).__easyEditDrive;
  });

  it("is null when media is not set up", async () => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_KEY", "");
    vi.stubEnv("DRIVE_FOLDER_ID", "");
    const getDrive = await load();
    expect(getDrive()).toBeNull();
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_KEY", settings(makeFakeDrive()));
    expect(getDrive()).toBeNull(); // a key with no folder is not set up either
  });

  it("is one client for the whole server, made from the settings", async () => {
    const fake = makeFakeDrive();
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_KEY", settings(fake));
    vi.stubEnv("DRIVE_FOLDER_ID", "folder1");
    vi.stubGlobal("fetch", fake.fetch);
    const getDrive = await load();
    const drive = getDrive()!;
    expect(drive.rootFolderId).toBe("folder1");
    expect(getDrive()).toBe(drive);
    expect((await load())()).toBe(drive); // the module loaded a second time, as a bundler may, hands out the same one
    const id = await drive.folderId("Originals"); // it works with the key from the settings
    expect(fake.files.get(id)).toEqual(aFolder("Originals"));
  });

  it("reads the settings on first use, not when the module loads", async () => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_KEY", "not a key");
    vi.stubEnv("DRIVE_FOLDER_ID", "folder1");
    const getDrive = await load(); // loading does not throw
    expect(() => getDrive()).toThrow("GOOGLE_SERVICE_ACCOUNT_KEY is not a service account key. Encode the JSON key file with base64 (see the README).");
    const fake = makeFakeDrive();
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_KEY", settings(fake));
    expect(getDrive()!.rootFolderId).toBe("folder1"); // a failure is not remembered
  });
});

describe("the pretend Drive", () => {
  const open = async (fake: FakeDrive, sizeBytes: number, headers: Record<string, string> = { Origin: "https://app.test" }) => {
    const answer = await fake.fetch(`${B}/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true`, {
      method: "POST",
      headers: { ...(await bearer(fake, SCOPE_WRITE)), "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Length": String(sizeBytes), ...headers },
      body: JSON.stringify({ id: "file1", name: "n", parents: ["folder1"], mimeType: "video/mp4" }),
    });
    expect(answer.status).toBe(200);
    return { url: answer.headers.get("location")!, answer };
  };
  const ask = (fake: FakeDrive, url: string, sizeBytes: number) => fake.fetch(url, { method: "PUT", headers: { "Content-Range": `bytes */${sizeBytes}` } });

  it("answers only Google's two hosts", async () => {
    const fake = makeFakeDrive();
    await expect(fake.fetch("https://example.com/drive/v3/files")).rejects.toThrow("The pretend Drive does not answer example.com.");
    await expect(fake.fetch("https://googleapis.com/drive/v3/files")).rejects.toThrow();
    expect(fake.calls).toEqual([]);
    expect((await fake.fetch(`${B}/drive/v3/about`, { headers: await bearer(fake, SCOPE_WRITE) })).status).toBe(404);
  });

  it("has the media folder, with a real key to sign for it", () => {
    const fake = makeFakeDrive();
    expect(fake.config.rootFolderId).toBe("folder1");
    expect(fake.config.privateKey).toContain("BEGIN PRIVATE KEY");
    expect([...fake.files.keys()]).toEqual(["folder1"]);
  });

  it("gives a token only for a request signed with its key, for a scope it knows", async () => {
    const fake = makeFakeDrive();
    const other = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
    const { clientEmail, privateKey } = fake.config;
    await expect(createTokenSource({ clientEmail, privateKey: other, fetch: fake.fetch }).tokenFor(SCOPE_WRITE)).rejects.toMatchObject({ call: "token", status: 400, reason: "invalid_grant" });
    await expect(createTokenSource({ clientEmail: "someone@else.test", privateKey, fetch: fake.fetch }).tokenFor(SCOPE_WRITE)).rejects.toMatchObject({ call: "token", status: 400, reason: "invalid_grant" });
    await expect(createTokenSource({ clientEmail, privateKey, fetch: fake.fetch }).tokenFor("https://www.googleapis.com/auth/gmail")).rejects.toMatchObject({ call: "token", status: 400, reason: "invalid_scope" });
    const token = await createTokenSource({ clientEmail, privateKey, fetch: fake.fetch, now: fake.now }).tokenFor(SCOPE_READ);
    expect(token.expiresAt).toBe(fake.now() + 3_600_000);
    expect(fake.calls).toEqual(Array.from({ length: 4 }, () => ({ method: "POST", path: "/token", scope: null, origin: null })));
  });

  it("refuses a call with no token, a token it did not give, or one older than an hour", async () => {
    const fake = makeFakeDrive();
    const get = (headers: Record<string, string>) => fake.fetch(`${B}/drive/v3/files/folder1?supportsAllDrives=true`, { headers });
    const none = await get({});
    expect([none.status, await reasonOf(none)]).toEqual([401, "authError"]);
    expect((await get({ Authorization: "Bearer ya29.made-up" })).status).toBe(401);
    const read = await bearer(fake, SCOPE_READ);
    expect((await get(read)).status).toBe(200);
    fake.advance(3_599_999);
    expect((await get(read)).status).toBe(200);
    fake.advance(1);
    expect((await get(read)).status).toBe(401);
    expect(fake.calls.at(-1)).toEqual({ method: "GET", path: "/drive/v3/files/folder1", scope: SCOPE_READ, origin: null });
  });

  it("lets a read-only token do nothing but GET", async () => {
    const fake = makeFakeDrive();
    const read = await bearer(fake, SCOPE_READ);
    const json = { ...read, "Content-Type": "application/json" };
    const refused = [
      await fake.fetch(`${B}/drive/v3/files?supportsAllDrives=true`, { method: "POST", headers: json, body: JSON.stringify({ name: "x", parents: ["folder1"] }) }),
      await fake.fetch(`${B}/drive/v3/files/folder1?supportsAllDrives=true`, { method: "PATCH", headers: json, body: JSON.stringify({ name: "x" }) }),
      await fake.fetch(`${B}/drive/v3/files/folder1?supportsAllDrives=true`, { method: "DELETE", headers: read }),
      await fake.fetch(`${B}/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true`, { method: "POST", headers: { ...json, "X-Upload-Content-Length": "10" }, body: JSON.stringify({ name: "x", parents: ["folder1"] }) }),
    ];
    for (const answer of refused) expect([answer.status, await reasonOf(answer)]).toEqual([403, "insufficientPermissions"]);
    expect(fake.files.size).toBe(1);
    expect(fake.files.get("folder1")!.name).toBe("EasyEdit");
    expect(fake.sessions.size).toBe(0);
    for (const path of ["/drive/v3/files/folder1?supportsAllDrives=true", "/drive/v3/files?supportsAllDrives=true&includeItemsFromAllDrives=true", "/drive/v3/files/generateIds?count=1"]) {
      expect((await fake.fetch(`${B}${path}`, { headers: read })).status).toBe(200);
    }
  });

  it("lists a folder's files only for a caller that asks across shared drives, and never by drive", async () => {
    const fake = makeFakeDrive();
    const write = await bearer(fake, SCOPE_WRITE);
    fake.files.set("sub1", aFolder("Originals"));
    fake.files.set("sub2", aFolder("Previews"));
    const list = async (extra: string) => {
      const answer = await fake.fetch(`${B}/drive/v3/files?q=${encodeURIComponent("'folder1' in parents and trashed = false")}&fields=files(id,name,driveId)${extra}`, { headers: write });
      return answer.ok ? ((await answer.json()) as { files: unknown[] }).files : `${answer.status} ${await reasonOf(answer)}`;
    };
    const both = [{ id: "sub1", name: "Originals", driveId: "drive9" }, { id: "sub2", name: "Previews", driveId: "drive9" }];
    expect(await list("&supportsAllDrives=true&includeItemsFromAllDrives=true&orderBy=createdTime")).toEqual(both);
    expect(await list("&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives&orderBy=createdTime")).toEqual(both);
    expect(await list("&supportsAllDrives=true&includeItemsFromAllDrives=true&orderBy=createdTime%20desc")).toEqual([...both].reverse());
    expect(await list("&supportsAllDrives=true&includeItemsFromAllDrives=true")).toEqual([...both].reverse()); // no order was asked for, so none is promised
    expect(await list("")).toEqual([]);
    expect(await list("&supportsAllDrives=true")).toEqual([]);
    expect(await list("&includeItemsFromAllDrives=true")).toEqual([]);
    expect(await list("&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=drive&driveId=drive9")).toBe("403 teamDriveMembershipRequired");
    expect(await list("&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=drive")).toBe("403 teamDriveMembershipRequired");
    expect(await list("&supportsAllDrives=true&includeItemsFromAllDrives=true&driveId=drive9")).toBe("403 teamDriveMembershipRequired");
    expect(await list("&supportsAllDrives=true&includeItemsFromAllDrives=true&orderBy=name")).toBe("400 invalid");
    const odd = await fake.fetch(`${B}/drive/v3/files?q=${encodeURIComponent("name contains 'x'")}&supportsAllDrives=true&includeItemsFromAllDrives=true`, { headers: write });
    expect(odd.status).toBe(400); // a question the fake cannot answer is not answered with everything
    const named = await fake.fetch(`${B}/drive/v3/files?q=${encodeURIComponent(`name = 'Previews' and mimeType = '${FOLDER_MIME}' and 'folder1' in parents and trashed = false`)}&supportsAllDrives=true&includeItemsFromAllDrives=true`, { headers: write });
    expect(await named.json()).toEqual({ files: [{ kind: "drive#file", id: "sub2", name: "Previews", mimeType: FOLDER_MIME }] });
  });

  it("makes, renames and trashes files as the folder's member may, and deletes none", async () => {
    const fake = makeFakeDrive();
    const json = { ...(await bearer(fake, SCOPE_WRITE)), "Content-Type": "application/json" };
    const made = await fake.fetch(`${B}/drive/v3/files?supportsAllDrives=true&fields=id,name,parents,driveId`, { method: "POST", headers: json, body: JSON.stringify({ name: "drive-check", mimeType: FOLDER_MIME, parents: ["folder1"] }) });
    const { id, ...rest } = (await made.json()) as { id: string };
    expect(rest).toEqual({ name: "drive-check", parents: ["folder1"], driveId: "drive9" });
    const unseen = await fake.fetch(`${B}/drive/v3/files?fields=id`, { method: "POST", headers: json, body: JSON.stringify({ name: "x", parents: ["folder1"] }) });
    const nowhere = await fake.fetch(`${B}/drive/v3/files?supportsAllDrives=true`, { method: "POST", headers: json, body: JSON.stringify({ name: "x", parents: ["no-such-folder"] }) });
    const untyped = await fake.fetch(`${B}/drive/v3/files?supportsAllDrives=true`, { method: "POST", headers: { Authorization: json.Authorization }, body: JSON.stringify({ name: "x", parents: ["folder1"] }) });
    expect([unseen.status, nowhere.status, untyped.status]).toEqual([404, 404, 400]);
    expect(fake.files.size).toBe(2);

    const file = (init?: RequestInit, query = "?supportsAllDrives=true&fields=id,name,trashed,size") => fake.fetch(`${B}/drive/v3/files/${id}${query}`, { headers: json, ...init });
    expect(await (await file({ method: "PATCH", body: JSON.stringify({ name: "renamed" }) })).json()).toEqual({ id, name: "renamed", trashed: false });
    expect(await (await file({ method: "PATCH", body: JSON.stringify({ trashed: true }) })).json()).toEqual({ id, name: "renamed", trashed: true });
    expect(await (await file()).json()).toEqual({ id, name: "renamed", trashed: true }); // still there, in the trash
    expect(await (await file(undefined, "?supportsAllDrives=true")).json()).toEqual({ kind: "drive#file", id, name: "renamed", mimeType: FOLDER_MIME }); // what Drive says when not asked for more
    expect((await file(undefined, "")).status).toBe(404); // a caller that does not know about shared drives sees nothing
    expect((await file({ method: "PATCH", body: JSON.stringify({ trashed: false }) }, "")).status).toBe(404);
    expect((await file({ method: "DELETE" })).status).toBe(404);
    expect((await file({ method: "PATCH", headers: { Authorization: json.Authorization }, body: JSON.stringify({ trashed: false }) })).status).toBe(400);
    expect(fake.files.get(id)).toEqual({ ...aFolder("renamed"), trashed: true });
  });

  it("opens a session at an address of its own, for a folder it can see", async () => {
    const fake = makeFakeDrive();
    const { url, answer } = await open(fake, 10);
    expect(url).toMatch(/^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?uploadType=resumable&upload_id=[\w-]{16,}$/);
    expect(answer.headers.get("access-control-allow-origin")).toBe("https://app.test");
    expect((await open(fake, 10)).url).not.toBe(url);
    expect(fake.sessions.get(url)).toEqual({ fileId: "file1", sizeBytes: 10, received: 0, origin: "https://app.test", name: "n", parentId: "folder1", mimeType: "video/mp4" });
    const write = await bearer(fake, SCOPE_WRITE);
    const post = (query: string, headers: Record<string, string>, body: object) => fake.fetch(`${B}/upload/drive/v3/files${query}`, { method: "POST", headers: { ...write, ...headers }, body: JSON.stringify(body) });
    const good = { "Content-Type": "application/json", "X-Upload-Content-Length": "10" };
    const meta = { name: "n", parents: ["folder1"] };
    expect((await post("?uploadType=resumable", good, meta)).status).toBe(404);
    expect((await post("?uploadType=resumable&supportsAllDrives=true", good, { ...meta, parents: ["nowhere"] })).status).toBe(404);
    expect((await post("?uploadType=multipart&supportsAllDrives=true", good, meta)).status).toBe(400);
    expect((await post("?uploadType=resumable&supportsAllDrives=true", { "Content-Type": "application/json" }, meta)).status).toBe(400);
    expect((await post("?uploadType=resumable&supportsAllDrives=true", { "X-Upload-Content-Length": "10" }, meta)).status).toBe(400);
    expect(fake.sessions.size).toBe(2);
    // Without a chosen id the session gets one, and the kind of file may come from the header alone.
    const plain = await post("?uploadType=resumable&supportsAllDrives=true", { ...good, "X-Upload-Content-Type": "audio/mpeg" }, meta);
    expect(fake.sessions.get(plain.headers.get("location")!)).toMatchObject({ fileId: expect.stringMatching(/^[\w-]{20,}$/), origin: null, mimeType: "audio/mpeg" });
    expect(plain.headers.has("access-control-allow-origin")).toBe(false);
  });

  it("takes pieces in order, in multiples of 256 KiB, and makes the file with the last byte", async () => {
    const fake = makeFakeDrive();
    const size = 3 * MiB + 5;
    const { url } = await open(fake, size);
    const empty = await ask(fake, url, size);
    expect([empty.status, empty.headers.has("range")]).toEqual([308, false]); // nothing held: no Range at all
    const early = await piece(fake, url, MiB, 2 * MiB, size); // not where the session is
    expect([early.status, early.headers.has("range")]).toEqual([308, false]);

    const first = await piece(fake, url, 0, MiB, size);
    expect([first.status, first.headers.get("range")]).toEqual([308, "bytes=0-1048575"]);
    expect(first.headers.get("access-control-allow-origin")).toBe("https://app.test");
    expect(first.headers.get("access-control-expose-headers")).toContain("Range");
    const again = await piece(fake, url, 0, MiB, size); // the same piece after a lost answer
    expect([again.status, again.headers.get("range")]).toEqual([308, "bytes=0-1048575"]);
    const gap = await piece(fake, url, 2 * MiB, 3 * MiB, size);
    expect([gap.status, gap.headers.get("range")]).toEqual([308, "bytes=0-1048575"]);
    const where = await ask(fake, url, size);
    expect([where.status, where.headers.get("range")]).toEqual([308, "bytes=0-1048575"]);

    const ragged = await piece(fake, url, MiB, MiB + 262_143, size); // not the last, and not a multiple of 262,144
    const halfBlock = await piece(fake, url, MiB, MiB + 131_072, size);
    expect([ragged.status, halfBlock.status]).toEqual([400, 400]);
    const short = await fake.fetch(url, { method: "PUT", headers: { "Content-Range": `bytes ${MiB}-${2 * MiB - 1}/${size}` }, body: new Uint8Array(10) });
    const otherSize = await piece(fake, url, MiB, 2 * MiB, size + 1);
    const pastTheEnd = await fake.fetch(url, { method: "PUT", headers: { "Content-Range": `bytes ${MiB}-${size}/${size}` }, body: new Uint8Array(size - MiB + 1) });
    const noRange = await fake.fetch(url, { method: "PUT", body: new Uint8Array(MiB) });
    const wrongQuestion = await ask(fake, url, size + 1);
    expect([short.status, otherSize.status, pastTheEnd.status, noRange.status, wrongQuestion.status]).toEqual([400, 400, 400, 400, 400]);
    expect(fake.sessions.get(url)!.received).toBe(MiB);

    expect((await piece(fake, url, MiB, MiB + 262_144, size)).headers.get("range")).toBe("bytes=0-1310719");
    expect(fake.files.has("file1")).toBe(false); // before the last byte, no file
    const last = await piece(fake, url, MiB + 262_144, size, size);
    expect([last.status, await last.json()]).toEqual([200, { id: "file1" }]);
    expect(fake.files.get("file1")).toEqual({ name: "n", parents: ["folder1"], sizeBytes: size, mimeType: "video/mp4", trashed: false });

    // A finished session stays, and still says where it is.
    expect(fake.sessions.get(url)).toMatchObject({ fileId: "file1", received: size, sizeBytes: size });
    const done = await ask(fake, url, size);
    expect([done.status, await done.json()]).toEqual([200, { id: "file1" }]);
    const repeat = await piece(fake, url, MiB + 262_144, size, size);
    expect([repeat.status, await repeat.json()]).toEqual([200, { id: "file1" }]);
    expect(fake.sessions.get(url)!.received).toBe(size);
  });

  it("takes a whole file in one piece, with no token", async () => {
    const fake = makeFakeDrive();
    const { url } = await open(fake, MiB);
    const before = await fake.fetch(`${B}/drive/v3/files/file1?supportsAllDrives=true`, { headers: await bearer(fake, SCOPE_WRITE) });
    expect(before.status).toBe(404);
    const put = await piece(fake, url, 0, MiB, MiB);
    expect([put.status, await put.json()]).toEqual([200, { id: "file1" }]);
    expect(fake.calls.at(-1)).toEqual({ method: "PUT", path: "/upload/drive/v3/files", scope: null, origin: null });
    const after = await fake.fetch(`${B}/drive/v3/files/file1?supportsAllDrives=true&fields=id,size,parents,mimeType,driveId,md5Checksum`, { headers: await bearer(fake, SCOPE_WRITE) });
    expect(await after.json()).toEqual({ id: "file1", size: "1048576", parents: ["folder1"], mimeType: "video/mp4", driveId: "drive9" }); // a size is a string; the fake holds no bytes, so no md5
  });

  it("writes down every request when it arrives, also one it fails or drops", async () => {
    const fake = makeFakeDrive();
    const { url } = await open(fake, 20 * MiB);
    const before = fake.calls.length;
    fake.dropNextPieceAfter(3 * MiB);
    await ask(fake, url, 20 * MiB); // a question is not a piece
    await expect(piece(fake, url, 0, 8 * MiB, 20 * MiB)).rejects.toThrow("fetch failed");
    expect(fake.sessions.get(url)!.received).toBe(3 * MiB); // what arrived before the connection failed is kept
    expect((await ask(fake, url, 20 * MiB)).headers.get("range")).toBe("bytes=0-3145727");
    expect((await piece(fake, url, 3 * MiB, 11 * MiB, 20 * MiB)).headers.get("range")).toBe("bytes=0-11534335"); // only the next piece was dropped
    fake.dropNextPieceAfter(16 * MiB); // more than the piece holds: all of it arrived and only the answer was lost
    await expect(piece(fake, url, 11 * MiB, 19 * MiB, 20 * MiB)).rejects.toThrow("fetch failed");
    expect(fake.sessions.get(url)!.received).toBe(19 * MiB);
    fake.dropNextPieceAfter(MiB);
    await expect(piece(fake, url, 0, 8 * MiB, 20 * MiB)).rejects.toThrow("fetch failed"); // a piece in the wrong place leaves nothing behind
    expect(fake.sessions.get(url)!.received).toBe(19 * MiB);
    fake.failNext(/^PUT \/upload\/.*upload_id=/, 503, "backendError");
    const failed = await piece(fake, url, 19 * MiB, 20 * MiB, 20 * MiB);
    expect([failed.status, await reasonOf(failed)]).toEqual([503, "backendError"]);
    expect(fake.sessions.get(url)!.received).toBe(19 * MiB); // a call that was failed did nothing
    expect(fake.calls.slice(before)).toEqual(Array.from({ length: 7 }, () => ({ method: "PUT", path: "/upload/drive/v3/files", scope: null, origin: null })));
  });

  it("fails the calls it was told to fail, once each, in the order they were asked for", async () => {
    const fake = makeFakeDrive();
    const write = await bearer(fake, SCOPE_WRITE);
    const ids = () => fake.fetch(`${B}/drive/v3/files/generateIds?count=2`, { headers: write });
    fake.failNext(/generateIds/, 500, "backendError");
    fake.failNext(/generateIds/, 403);
    fake.failNext(/^PATCH /, 500);
    fake.failNext(/^GET .*count=2$/, 429, "rateLimitExceeded");
    const answers = [await ids(), await ids(), await ids(), await ids()];
    expect(answers.map((a) => a.status)).toEqual([500, 403, 429, 200]);
    expect(await reasonOf(answers[0])).toBe("backendError");
    expect(await reasonOf(answers[1])).toBeUndefined();
    expect(((await answers[3].json()) as { ids: string[] }).ids).toHaveLength(2);
    expect(fake.calls.filter((c) => c.path === "/drive/v3/files/generateIds")).toHaveLength(4);
  });

  it("answers 404 for sessions that expired and 499 for one that was canceled", async () => {
    const fake = makeFakeDrive();
    const finished = await open(fake, MiB);
    await piece(fake, finished.url, 0, MiB, MiB);
    const half = await open(fake, 2 * MiB);
    await piece(fake, half.url, 0, MiB, 2 * MiB);
    const untouched = await open(fake, MiB);
    fake.expireSessions();
    expect((await ask(fake, half.url, 2 * MiB)).status).toBe(404);
    expect((await piece(fake, half.url, MiB, 2 * MiB, 2 * MiB)).status).toBe(404);
    expect((await ask(fake, untouched.url, MiB)).status).toBe(404);
    expect((await ask(fake, finished.url, MiB)).status).toBe(200); // it was not open any more
    expect(fake.sessions.size).toBe(3);
    expect(fake.sessions.get(half.url)!.received).toBe(MiB);
    const later = await open(fake, MiB); // a session opened afterwards is a new one
    expect((await ask(fake, later.url, MiB)).status).toBe(308);

    const canceled = await fake.fetch(later.url, { method: "DELETE" });
    expect(canceled.status).toBe(499);
    expect((await ask(fake, later.url, MiB)).status).toBe(499);
    expect((await piece(fake, later.url, 0, MiB, MiB)).status).toBe(499);
    expect(fake.files.has("file1")).toBe(true); // from the finished one only
    expect(fake.sessions.get(later.url)!.received).toBe(0);

    // An address Drive never gave out is not answered 404 (drive-facts 20).
    const unknown = await ask(fake, `${later.url}x`, MiB);
    expect([unknown.status, unknown.headers.has("range")]).toEqual([308, false]);
  });

  it("lets a page of any origin ask before it sends, and read the answer only when the session was opened for an origin", async () => {
    const fake = makeFakeDrive();
    const { url } = await open(fake, MiB);
    for (const origin of ["https://app.test", "https://evil.example"]) {
      const preflight = await fake.fetch(url, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "content-type,content-range" } });
      expect([preflight.status, preflight.headers.get("access-control-allow-origin"), preflight.headers.get("access-control-allow-methods"), preflight.headers.get("access-control-allow-headers")]).toEqual([200, origin, "PUT", "content-type,content-range"]);
    }
    const blind = await open(fake, MiB, {}); // opened with no Origin
    expect(fake.sessions.get(blind.url)!.origin).toBeNull();
    const put = await piece(fake, blind.url, 0, MiB, MiB);
    expect([put.status, put.headers.get("access-control-allow-origin")]).toEqual([200, "null"]); // the file is made, but a page could not read this
  });

  it("starts its clock at the real time and moves it only when told", () => {
    const before = Date.now();
    const fake = makeFakeDrive();
    const start = fake.now();
    expect(start).toBeGreaterThanOrEqual(before);
    expect(start).toBeLessThanOrEqual(Date.now());
    fake.advance(90_000);
    expect(fake.now()).toBe(start + 90_000);
  });
});
