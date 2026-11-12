import { afterEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/access-rules";
import type { Actor } from "@/lib/actor";
import { SCOPE_READ } from "@/lib/drive/token";
import { LIMITS } from "@/lib/limits";
import { NOT_SET_UP_BODY, STORAGE_DOWN_BODY, makeMediaHandlers, makeReadTokenHandler, type MediaHandlerDeps } from "@/lib/media/handlers";
import { openUpload } from "@/lib/media/service";
import { sources } from "../helpers/sources";
import { AUDIO, IMAGE, VIDEO, mediaContext, readyAsset, sendAll, type MediaContext } from "./context";

const APP = "https://app.test";
const DRIVE = "https://www.googleapis.com";
const POSTER_BYTES = 50_000;
const FORBIDDEN = { code: "FORBIDDEN", message: "Your role doesn't allow this." };
const GONE = { code: "NOT_FOUND", message: "That file is no longer in the library." };

const memberOf = (actor: Actor): CurrentUser => ({ id: actor.userId, email: actor.email, name: actor.email, image: null, role: actor.role });

// The handlers of every route, as one member calls them.
function handlersFor(ctx: MediaContext, actor: Actor, over: Partial<MediaHandlerDeps> = {}) {
  const deps: MediaHandlerDeps = { db: () => ctx.db, auth: async () => memberOf(actor), drive: () => ctx.deps.drive, origin: () => APP, ...over };
  return { ...makeMediaHandlers(deps), readToken: makeReadTokenHandler(deps) };
}

function request(method: string, path = "/api/media", body?: unknown, origin = APP): Request {
  const text = body === undefined || typeof body === "string" ? body : JSON.stringify(body);
  return new Request(`${APP}${path}`, { method, headers: { "content-type": "application/json", origin }, body: text });
}

const at = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (path: string, body?: unknown) => request("POST", path, body);
const tokenRequest = () => post("/api/drive/read-token");

// What an answer holds, and its status.
async function answer(response: Response): Promise<{ status: number; body: unknown }> {
  const text = await response.text();
  return { status: response.status, body: text === "" ? null : JSON.parse(text) };
}

const refusedAs = (status: number, body: object) => ({ status, body });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the media API", () => {
  it("an upload from open to ready, over HTTP", async () => {
    const ctx = await mediaContext();
    const api = handlersFor(ctx, ctx.ada);

    const opened = await api.open(post("/api/media", VIDEO));
    expect(opened.status).toBe(201);
    const { asset, uploadUrl, offset, ...rest } = await opened.json();
    expect(rest).toEqual({});
    expect(offset).toBe(0);
    expect(asset).toMatchObject({ kind: "video", name: "IMG_4821", status: "uploading", uploadedByName: "Ada Lovelace" });
    expect(ctx.fake.sessions.get(uploadUrl)).toMatchObject({ origin: APP, sizeBytes: VIDEO.sizeBytes });

    // Before a byte is sent, and with every byte in Drive.
    const path = `/api/media/${asset.id}`;
    expect(await answer(await api.offset(post(`${path}/offset`), at(asset.id)))).toEqual({ status: 200, body: { uploadUrl, offset: 0, done: false } });
    await sendAll(ctx.fake, uploadUrl, VIDEO.sizeBytes);
    expect(await answer(await api.offset(post(`${path}/offset`), at(asset.id)))).toEqual({ status: 200, body: { uploadUrl, offset: VIDEO.sizeBytes, done: true } });

    const completed = await answer(await api.complete(post(`${path}/complete`), at(asset.id)));
    expect(completed).toEqual({ status: 200, body: { asset: { ...asset, status: "ready", originalFileId: expect.any(String) } } });
    const ready = (completed.body as { asset: unknown }).asset;

    expect(await answer(await api.list(request("GET")))).toEqual({ status: 200, body: { assets: [ready], setUp: true } });
    expect(await answer(await api.list(request("GET", `/api/media?ids=${asset.id}`)))).toEqual({ status: 200, body: { assets: [ready], setUp: true } });
  });

  it("takes an image and an audio file, whose facts are partly null", async () => {
    const ctx = await mediaContext();
    const api = handlersFor(ctx, ctx.ada);
    const image = await answer(await api.open(post("/api/media", { ...IMAGE, event: "Regionals" })));
    expect(image).toMatchObject({ status: 201, body: { offset: 0, asset: { kind: "image", name: "field", durationMs: null, width: 4032, height: 3024, fps: null, event: "Regionals" } } });
    const audio = await answer(await api.open(post("/api/media", AUDIO)));
    expect(audio).toMatchObject({ status: 201, body: { offset: 0, asset: { kind: "audio", name: "theme", durationMs: 95_000, width: null, height: null, hasAudio: true, event: null } } });
    // The same file again is the same upload, taken up where it stopped.
    const again = await answer(await api.open(post("/api/media", AUDIO)));
    expect(again).toEqual({ ...audio, status: 201 });
  });

  it("lists the assets asked for by id, and none for an empty list", async () => {
    const ctx = await mediaContext();
    const api = handlersFor(ctx, ctx.ada);
    const video = await readyAsset(ctx);
    const image = await readyAsset(ctx, ctx.grace, IMAGE);
    const idsOf = async (query: string) => {
      const { status, body } = await answer(await api.list(request("GET", `/api/media${query}`)));
      expect(status).toBe(200);
      return (body as { assets: { id: string }[] }).assets.map((asset) => asset.id).sort();
    };
    const both = [video.id, image.id].sort();
    expect(await idsOf("")).toEqual(both);
    expect(await idsOf(`?ids=${video.id},${image.id}`)).toEqual(both);
    expect(await idsOf(`?ids=${image.id}`)).toEqual([image.id]);
    expect(await idsOf(`?ids=,${image.id},,nobody,`)).toEqual([image.id]);
    expect(await idsOf("?ids=")).toEqual([]); // no ids is not the whole library
    expect(await idsOf("?other=1")).toEqual(both);
  });

  it("refuses more ids than one request may name", async () => {
    const ctx = await mediaContext();
    const api = handlersFor(ctx, ctx.ada);
    const ids = (count: number) => Array.from({ length: count }, (_, i) => `id${i}`).join(",");
    expect(LIMITS.mediaIdsPerRequest).toBe(200);
    expect((await api.list(request("GET", `/api/media?ids=${ids(200)}`))).status).toBe(200);
    expect((await api.list(request("GET", `/api/media?ids=,${ids(200)},`))).status).toBe(200); // an empty place names no file
    const refused = await answer(await api.list(request("GET", `/api/media?ids=${ids(201)}`)));
    expect(refused).toEqual(refusedAs(400, { code: "INVALID", message: "Ask for up to 200 files at a time." }));
    // The handler counts what was sent, before anything is asked of the database.
    const unasked = handlersFor(ctx, ctx.ada, { db: () => { throw new Error("the database was asked"); } });
    expect((await unasked.list(request("GET", `/api/media?ids=${"a,".repeat(201)}`))).status).toBe(400);
  });

  it("renames, removes and marks a preview as failed", async () => {
    const ctx = await mediaContext();
    const api = handlersFor(ctx, ctx.ada);
    const asset = await readyAsset(ctx);
    const path = `/api/media/${asset.id}`;

    const renamed = await answer(await api.update(request("PATCH", path, { name: " Kickoff ", event: "Regionals" }), at(asset.id)));
    expect(renamed).toEqual({ status: 200, body: { asset: { ...asset, name: "Kickoff", event: "Regionals" } } });
    const cleared = await answer(await api.update(request("PATCH", path, { event: null }), at(asset.id)));
    expect(cleared).toEqual({ status: 200, body: { asset: { ...asset, name: "Kickoff", event: null } } });
    expect((await answer(await api.update(request("PATCH", path, {}), at(asset.id)))).body).toEqual(cleared.body);

    const failed = await answer(await api.previewFailed(post(`${path}/preview-failed`), at(asset.id)));
    expect(failed).toEqual({ status: 200, body: { asset: { ...asset, name: "Kickoff", previewStatus: "failed" } } });

    const removed = await api.remove(request("DELETE", path), at(asset.id));
    expect(removed.status).toBe(204);
    expect(await removed.text()).toBe("");
    expect(ctx.fake.files.get(asset.originalFileId!)!.trashed).toBe(true);
    expect(await answer(await api.list(request("GET")))).toEqual({ status: 200, body: { assets: [], setUp: true } });
    expect(await answer(await api.remove(request("DELETE", path), at(asset.id)))).toEqual(refusedAs(404, GONE));
  });

  it("takes a still picture and a preview copy for an asset", async () => {
    const ctx = await mediaContext();
    const api = handlersFor(ctx, ctx.ada);
    const asset = await readyAsset(ctx);
    const path = `/api/media/${asset.id}/files`;

    const opened = await answer(await api.openFile(post(path, { role: "poster", sizeBytes: POSTER_BYTES }), at(asset.id)));
    expect(opened).toEqual({ status: 201, body: { uploadUrl: expect.stringContaining("upload_id=") } });
    const { uploadUrl } = opened.body as { uploadUrl: string };
    expect(ctx.fake.sessions.get(uploadUrl)).toMatchObject({ origin: APP, sizeBytes: POSTER_BYTES, name: `${asset.id}.poster.jpg` });
    await sendAll(ctx.fake, uploadUrl, POSTER_BYTES);
    const withPoster = await answer(await api.completeFile(post(`${path}/complete`, { role: "poster" }), at(asset.id)));
    expect(withPoster).toEqual({ status: 200, body: { asset: { ...asset, posterFileId: expect.any(String) } } });

    const preview = await answer(await api.openFile(post(path, { role: "preview", sizeBytes: 2_000_000 }), at(asset.id)));
    expect(preview.status).toBe(201);
    await sendAll(ctx.fake, (preview.body as { uploadUrl: string }).uploadUrl, 2_000_000);
    const withPreview = await answer(await api.completeFile(post(`${path}/complete`, { role: "preview" }), at(asset.id)));
    expect(withPreview.body).toMatchObject({ asset: { previewStatus: "ready", previewFileId: expect.any(String) } });
    // What the service refuses keeps the service's status and sentence.
    expect(await answer(await api.completeFile(post(`${path}/complete`, { role: "preview" }), at(asset.id)))).toEqual(refusedAs(409, { code: "CONFLICT", message: "The upload is not finished." }));
  });

  it("a viewer can list and get a read token, and nothing else", async () => {
    const ctx = await mediaContext();
    const asset = await readyAsset(ctx);
    const api = handlersFor(ctx, ctx.vera);
    const path = `/api/media/${asset.id}`;

    expect(await answer(await api.list(request("GET")))).toEqual({ status: 200, body: { assets: [asset], setUp: true } });
    const token = await answer(await api.readToken(tokenRequest()));
    expect(token).toEqual({ status: 200, body: { accessToken: expect.stringMatching(/^ya29\./), expiresAt: expect.any(Number) } });

    const refusals = [
      await api.open(post("/api/media", VIDEO)),
      await api.update(request("PATCH", path, { name: "Mine now" }), at(asset.id)),
      await api.remove(request("DELETE", path), at(asset.id)),
      await api.openFile(post(`${path}/files`, { role: "poster", sizeBytes: POSTER_BYTES }), at(asset.id)),
      await api.offset(post(`${path}/offset`), at(asset.id)),
      await api.complete(post(`${path}/complete`), at(asset.id)),
      await api.completeFile(post(`${path}/files/complete`, { role: "poster" }), at(asset.id)),
      await api.previewFailed(post(`${path}/preview-failed`), at(asset.id)),
    ];
    for (const refusal of refusals) expect(await answer(refusal)).toEqual(refusedAs(403, FORBIDDEN));
    expect(await answer(await api.list(request("GET")))).toEqual({ status: 200, body: { assets: [asset], setUp: true } }); // nothing changed
    expect(ctx.fake.sessions.size).toBe(1); // and no session was opened for the viewer
  });

  it("the read token cannot be cached and holds only the token and its expiry", async () => {
    const ctx = await mediaContext();
    const api = handlersFor(ctx, ctx.ada);
    const response = await api.readToken(tokenRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["accessToken", "expiresAt"]);
    expect(body.expiresAt - ctx.fake.now()).toBeGreaterThanOrEqual(600_000);

    const asked = await ctx.fake.fetch(`${DRIVE}/drive/v3/files/folder1?supportsAllDrives=true`, { headers: { Authorization: `Bearer ${body.accessToken}` } });
    expect(asked.status).toBe(200);
    expect(ctx.fake.calls.at(-1)!.scope).toBe(SCOPE_READ);
  });

  it("the read token always has ten minutes left", async () => {
    const ctx = await mediaContext();
    const api = handlersFor(ctx, ctx.ada);
    expect(LIMITS.mediaReadTokenMinSeconds).toBe(600);
    const first = await (await api.readToken(tokenRequest())).json();
    ctx.fake.advance(3_600_000 - 601_000); // 601 s left: still enough
    expect(await (await api.readToken(tokenRequest())).json()).toEqual(first);
    ctx.fake.advance(2_000); // 599 s left
    const second = await (await api.readToken(tokenRequest())).json();
    expect(second.accessToken).not.toBe(first.accessToken);
    expect(second.expiresAt - ctx.fake.now()).toBeGreaterThanOrEqual(600_000);
  });

  it("says uploads are not set up when there is no Drive", async () => {
    const ctx = await mediaContext();
    const asset = await readyAsset(ctx);
    const api = handlersFor(ctx, ctx.ada, { drive: () => null });
    const path = `/api/media/${asset.id}`;

    expect(await answer(await api.list(request("GET")))).toEqual({ status: 200, body: { assets: [asset], setUp: false } });
    const refusals = [
      await api.open(post("/api/media", VIDEO)),
      await api.offset(post(`${path}/offset`), at(asset.id)),
      await api.complete(post(`${path}/complete`), at(asset.id)),
      await api.openFile(post(`${path}/files`, { role: "poster", sizeBytes: POSTER_BYTES }), at(asset.id)),
      await api.completeFile(post(`${path}/files/complete`, { role: "poster" }), at(asset.id)),
      await api.remove(request("DELETE", path), at(asset.id)),
      await api.readToken(tokenRequest()),
    ];
    expect(NOT_SET_UP_BODY).toEqual({ code: "MEDIA_NOT_SET_UP", message: "Uploads are not set up yet." });
    for (const refusal of refusals) expect(await answer(refusal)).toEqual(refusedAs(503, NOT_SET_UP_BODY));
    // Whatever was sent: the body is not read.
    expect(await answer(await api.open(post("/api/media", {})))).toEqual(refusedAs(503, NOT_SET_UP_BODY));
    expect(await answer(await api.completeFile(post(`${path}/files/complete`, "{"), at(asset.id)))).toEqual(refusedAs(503, NOT_SET_UP_BODY));

    // What needs no Drive still works.
    const renamed = await answer(await api.update(request("PATCH", path, { name: "Kickoff" }), at(asset.id)));
    expect(renamed).toEqual({ status: 200, body: { asset: { ...asset, name: "Kickoff" } } });
    const failed = await answer(await api.previewFailed(post(`${path}/preview-failed`), at(asset.id)));
    expect(failed).toEqual({ status: 200, body: { asset: { ...asset, name: "Kickoff", previewStatus: "failed" } } });
    expect(await answer(await api.list(request("GET", `/api/media?ids=${asset.id}`)))).toEqual({ status: 200, body: { assets: [(failed.body as { asset: unknown }).asset], setUp: false } });
  });

  it("a Drive failure is a 502 that says nothing about Drive", async () => {
    const ctx = await mediaContext();
    const api = handlersFor(ctx, ctx.ada);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    ctx.fake.failNext(/generateIds/, 500, "backendError");
    const response = await api.open(post("/api/media", VIDEO));
    const text = await response.text();
    expect(response.status).toBe(502);
    expect(JSON.parse(text)).toEqual(STORAGE_DOWN_BODY);
    expect(STORAGE_DOWN_BODY).toEqual({ code: "STORAGE_UNAVAILABLE", message: "Google Drive didn't answer. Try again." });
    expect(text).not.toMatch(/googleapis|generateIds|backendError|ya29|500/);
    expect(log.mock.calls).toEqual([["Drive call failed", "ids", 500, "backendError"]]);
    expect(await answer(await api.list(request("GET")))).toEqual({ status: 200, body: { assets: [], setUp: true } }); // nothing was recorded
  });

  it("a Drive failure in any handler is the same 502 and one line", async () => {
    const ctx = await mediaContext();
    const api = handlersFor(ctx, ctx.ada);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const ready = await readyAsset(ctx);
    const { asset: unfinished } = await openUpload(ctx.deps, ctx.ada, IMAGE);
    const path = `/api/media/${ready.id}`;
    const failing: [RegExp, string, number, string, () => Promise<Response>][] = [
      [/upload_id/, "session", 503, "backendError", () => api.offset(post(`/api/media/${unfinished.id}/offset`), at(unfinished.id))],
      [/GET \/drive\/v3\/files\/[^?]+\?/, "file", 403, "rateLimitExceeded", () => api.complete(post(`/api/media/${unfinished.id}/complete`), at(unfinished.id))],
      [/generateIds/, "ids", 500, "internalError", () => api.openFile(post(`${path}/files`, { role: "poster", sizeBytes: POSTER_BYTES }), at(ready.id))],
      [/POST \/token/, "token", 500, "unknown", () => api.readToken(tokenRequest())],
    ];
    for (const [match, call, status, reason, ask] of failing) {
      log.mockClear();
      ctx.fake.failNext(match, status, reason === "unknown" ? undefined : reason);
      expect(await answer(await ask()), call).toEqual(refusedAs(502, STORAGE_DOWN_BODY));
      expect(log.mock.calls, call).toEqual([["Drive call failed", call, status, reason]]);
    }
  });

  it("a failure that is not Drive's is still a 500", async () => {
    const ctx = await mediaContext();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = new Error("the database is away");
    const api = handlersFor(ctx, ctx.ada, { db: () => { throw broken; } });
    expect(await answer(await api.list(request("GET")))).toEqual(refusedAs(500, { code: "INTERNAL", message: "Something went wrong. Try again." }));
    expect(log.mock.calls).toEqual([["Unhandled API error", broken]]);
  });

  it("refuses a malformed body and a request from another site", async () => {
    const ctx = await mediaContext();
    const api = handlersFor(ctx, ctx.ada);
    const invalid = async (response: Response) => {
      const { status, body } = await answer(response);
      expect(body).toEqual({ code: "INVALID", message: expect.any(String) });
      return status;
    };
    expect(await invalid(await api.open(post("/api/media", {})))).toBe(400);
    expect(await invalid(await api.open(post("/api/media", { ...VIDEO, extra: 1 })))).toBe(400);

    const elsewhere = await api.open(request("POST", "/api/media", VIDEO, "https://evil.test"));
    expect(await answer(elsewhere)).toEqual(refusedAs(403, { code: "FORBIDDEN", message: "This request came from another site." }));
    const stolen = await api.readToken(request("POST", "/api/drive/read-token", undefined, "https://evil.test"));
    expect(await answer(stolen)).toEqual(refusedAs(403, { code: "FORBIDDEN", message: "This request came from another site." }));
    expect(ctx.fake.calls).toEqual([]); // nothing was asked of Drive for any of them
  });

  it("checks the shape of every body before the service sees it", async () => {
    const ctx = await mediaContext();
    const api = handlersFor(ctx, ctx.ada);
    const asset = await readyAsset(ctx);
    const path = `/api/media/${asset.id}`;
    const before = ctx.fake.calls.length;
    const messageOf = async (response: Response) => {
      const { status, body } = await answer(response);
      expect(status).toBe(400);
      expect(body).toMatchObject({ code: "INVALID" });
      return (body as { message: string }).message;
    };
    const open = (body: unknown) => api.open(post("/api/media", body));
    const update = (body: unknown) => api.update(request("PATCH", path, body), at(asset.id));
    const openFile = (body: unknown) => api.openFile(post(`${path}/files`, body), at(asset.id));
    const completeFile = (body: unknown) => api.completeFile(post(`${path}/files/complete`, body), at(asset.id));

    // Each is refused for its shape, at the place named: the service's own sentences are not what comes back.
    const refusedAt = async (ask: (body: unknown) => Promise<Response>, cases: [unknown, string][]) => {
      for (const [wrong, place] of cases) {
        const message = await messageOf(await ask(wrong));
        expect(message, JSON.stringify(wrong)).toMatch(place === "" ? /^Invalid input: expected object/ : new RegExp(`^${place.replace(".", "\\.")}: Invalid (input|option)`));
      }
    };
    const notJson = async (ask: (body: unknown) => Promise<Response>, bodies: (string | undefined)[]) => {
      for (const body of bodies) expect(await messageOf(await ask(body)), body).toBe("Body must be valid JSON");
    };

    await notJson(open, ["{not json", "", undefined]);
    expect(await messageOf(await open({ ...VIDEO, extra: 1 }))).toBe('Unrecognized key: "extra"');
    expect(await messageOf(await open({ ...VIDEO, probe: { ...VIDEO.probe, extra: 1 } }))).toBe('probe: Unrecognized key: "extra"');
    const { fileName, ...unnamed } = VIDEO;
    const { hasAudio, ...unheard } = VIDEO.probe;
    expect([fileName, hasAudio]).toEqual(["IMG_4821.MOV", true]);
    await refusedAt(open, [
      [null, ""],
      [[VIDEO], ""],
      [unnamed, "fileName"],
      [{ ...VIDEO, fileName: 7 }, "fileName"],
      [{ ...VIDEO, sizeBytes: "20000000" }, "sizeBytes"],
      [{ ...VIDEO, mimeType: null }, "mimeType"],
      [{ ...VIDEO, lastModifiedMs: "1762800000000" }, "lastModifiedMs"],
      [{ ...VIDEO, event: 5 }, "event"],
      [{ ...VIDEO, event: null }, "event"],
      [{ ...VIDEO, probe: null }, "probe"],
      [{ ...VIDEO, probe: unheard }, "probe.hasAudio"],
      [{ ...VIDEO, probe: { ...VIDEO.probe, kind: "document" } }, "probe.kind"],
      [{ ...VIDEO, probe: { ...VIDEO.probe, durationMs: "12500" } }, "probe.durationMs"],
      [{ ...VIDEO, probe: { ...VIDEO.probe, width: "1080" } }, "probe.width"],
      [{ ...VIDEO, probe: { ...VIDEO.probe, height: true } }, "probe.height"],
      [{ ...VIDEO, probe: { ...VIDEO.probe, fps: "30" } }, "probe.fps"],
      [{ ...VIDEO, probe: { ...VIDEO.probe, hasAudio: "yes" } }, "probe.hasAudio"],
      [{ ...VIDEO, probe: { ...VIDEO.probe, videoCodec: 264 } }, "probe.videoCodec"],
      [{ ...VIDEO, probe: { ...VIDEO.probe, videoCodec: undefined } }, "probe.videoCodec"],
    ]);

    await notJson(update, ["Kickoff", "{"]);
    expect(await messageOf(await update({ name: "Kickoff", by: "ada" }))).toBe('Unrecognized key: "by"');
    await refusedAt(update, [[{ name: 7 }, "name"], [{ name: null }, "name"], [{ event: 7 }, "event"], [[], ""], [null, ""]]);

    await notJson(openFile, ["poster", undefined]);
    expect(await messageOf(await openFile({ role: "poster", sizeBytes: POSTER_BYTES, name: "x.jpg" }))).toBe('Unrecognized key: "name"');
    await refusedAt(openFile, [
      [{}, "role"],
      [{ role: "poster" }, "sizeBytes"],
      [{ sizeBytes: POSTER_BYTES }, "role"],
      [{ role: "original", sizeBytes: POSTER_BYTES }, "role"],
      [{ role: "__proto__", sizeBytes: 1 }, "role"],
      [{ role: "poster", sizeBytes: "50000" }, "sizeBytes"],
      [{ role: "poster", sizeBytes: null }, "sizeBytes"],
    ]);

    await notJson(completeFile, ["poster", undefined]);
    expect(await messageOf(await completeFile({ role: "poster", sizeBytes: POSTER_BYTES }))).toBe('Unrecognized key: "sizeBytes"');
    await refusedAt(completeFile, [[{}, "role"], [{ role: "original" }, "role"], [{ role: 1 }, "role"], [{ role: "toString" }, "role"], [null, ""]]);

    expect(ctx.fake.calls.length).toBe(before); // none of them reached Drive
    expect(await answer(await api.list(request("GET")))).toEqual({ status: 200, body: { assets: [asset], setUp: true } }); // or changed anything
  });

  it("leaves the values to the service", async () => {
    const ctx = await mediaContext();
    const api = handlersFor(ctx, ctx.ada);
    const asset = await readyAsset(ctx);
    const path = `/api/media/${asset.id}`;
    const refusals: [Response, string][] = [
      [await api.open(post("/api/media", { ...VIDEO, sizeBytes: 0 })), "This file is empty."],
      [await api.open(post("/api/media", { ...VIDEO, fileName: "notes.txt" })), "This file type isn't supported. Use MP4, MOV, WebM, JPEG, PNG, WebP, MP3, M4A, WAV or AAC."],
      [await api.open(post("/api/media", { ...VIDEO, probe: { ...VIDEO.probe, width: 0.5 } })), "This file couldn't be read. It may be damaged."],
      [await api.update(request("PATCH", path, { name: "   " }), at(asset.id)), "Enter a name up to 120 characters."],
      [await api.openFile(post(`${path}/files`, { role: "poster", sizeBytes: 0.5 }), at(asset.id)), "That file is empty or too large."],
    ];
    for (const [refusal, message] of refusals) expect(await answer(refusal)).toEqual(refusedAs(400, { code: "INVALID", message }));
    // A body nobody reads is not looked at.
    const failed = await api.previewFailed(post(`${path}/preview-failed`, "{not json"), at(asset.id));
    expect(failed.status).toBe(200);
  });

  it("signed out", async () => {
    const ctx = await mediaContext();
    const refusal = Response.json({ code: "UNAUTHENTICATED", message: "Sign in to continue." }, { status: 401 });
    const untouched = () => { throw new Error("asked before the member was known"); };
    const api = handlersFor(ctx, ctx.ada, { auth: async () => refusal, db: untouched, drive: untouched, origin: untouched });
    const path = "/api/media/a1";
    const answers = [
      await api.list(request("GET")),
      await api.open(post("/api/media", VIDEO)),
      await api.update(request("PATCH", path, { name: "Kickoff" }), at("a1")),
      await api.remove(request("DELETE", path), at("a1")),
      await api.offset(post(`${path}/offset`), at("a1")),
      await api.complete(post(`${path}/complete`), at("a1")),
      await api.openFile(post(`${path}/files`, { role: "poster", sizeBytes: POSTER_BYTES }), at("a1")),
      await api.completeFile(post(`${path}/files/complete`, { role: "poster" }), at("a1")),
      await api.previewFailed(post(`${path}/preview-failed`), at("a1")),
      await api.readToken(tokenRequest()),
    ];
    expect(answers).toHaveLength(10);
    for (const response of answers) expect(response).toBe(refusal);
    expect(await answer(refusal)).toEqual(refusedAs(401, { code: "UNAUTHENTICATED", message: "Sign in to continue." }));
    // A malformed body from someone signed out is not read either.
    expect(await api.open(post("/api/media", "{"))).toBe(refusal);
  });

  it("asks who is calling with the request itself", async () => {
    const ctx = await mediaContext();
    const auth = vi.fn(async (req: Request) => (void req, memberOf(ctx.ada)));
    const api = handlersFor(ctx, ctx.ada, { auth });
    const listing = request("GET");
    const asking = tokenRequest();
    await api.list(listing);
    await api.readToken(asking);
    expect(auth.mock.calls.map((call) => call.length)).toEqual([1, 1]);
    expect(auth.mock.calls[0][0]).toBe(listing);
    expect(auth.mock.calls[1][0]).toBe(asking);
  });

  it("the session address appears only where it must", async () => {
    const ctx = await mediaContext();
    const api = handlersFor(ctx, ctx.ada);
    const text = async (response: Response | Promise<Response>) => {
      const answered = await response;
      expect(answered.status).toBeLessThan(300);
      return answered.text();
    };
    const without: string[] = [];
    const withAddress: string[] = [];

    const opened = await text(api.open(post("/api/media", VIDEO)));
    withAddress.push(opened);
    const { asset, uploadUrl } = JSON.parse(opened) as { asset: { id: string }; uploadUrl: string };
    const path = `/api/media/${asset.id}`;
    // While the upload is unfinished, its row holds the address.
    without.push(await text(api.list(request("GET"))));
    without.push(await text(api.list(request("GET", `/api/media?ids=${asset.id}`))));
    without.push(await text(api.update(request("PATCH", path, { name: "Kickoff" }), at(asset.id))));
    without.push(await text(api.previewFailed(post(`${path}/preview-failed`), at(asset.id))));
    withAddress.push(await text(api.offset(post(`${path}/offset`), at(asset.id))));
    await sendAll(ctx.fake, uploadUrl, VIDEO.sizeBytes);
    without.push(await text(api.complete(post(`${path}/complete`), at(asset.id))));
    without.push(await text(api.offset(post(`${path}/offset`), at(asset.id)))); // a finished upload has none

    const file = await text(api.openFile(post(`${path}/files`, { role: "poster", sizeBytes: POSTER_BYTES }), at(asset.id)));
    withAddress.push(file);
    await sendAll(ctx.fake, (JSON.parse(file) as { uploadUrl: string }).uploadUrl, POSTER_BYTES);
    without.push(await text(api.completeFile(post(`${path}/files/complete`, { role: "poster" }), at(asset.id))));
    without.push(await text(api.update(request("PATCH", path, { event: "Regionals" }), at(asset.id))));
    without.push(await text(api.previewFailed(post(`${path}/preview-failed`), at(asset.id))));
    without.push(await text(api.list(request("GET"))));
    without.push(await text(api.readToken(tokenRequest())));
    without.push(await text(api.remove(request("DELETE", path), at(asset.id))));

    expect(withAddress).toHaveLength(3);
    for (const answered of withAddress) expect(answered).toContain("upload_id");
    expect(without).toHaveLength(12);
    for (const answered of without) {
      expect(answered).not.toContain("upload_id");
      expect(answered).not.toContain("uploadType");
    }
  });

  it("an admin is told how far another member's upload has come, without its address", async () => {
    const ctx = await mediaContext();
    const { asset } = await openUpload(ctx.deps, ctx.ada, VIDEO);
    const api = handlersFor(ctx, ctx.root);
    const asked = await answer(await api.offset(post(`/api/media/${asset.id}/offset`), at(asset.id)));
    expect(asked).toEqual({ status: 200, body: { uploadUrl: null, offset: 0, done: false } });
    const other = handlersFor(ctx, ctx.grace);
    expect(await answer(await other.offset(post(`/api/media/${asset.id}/offset`), at(asset.id)))).toEqual(refusedAs(403, FORBIDDEN));
    expect(await answer(await other.complete(post("/api/media/nobody/complete"), at("nobody")))).toEqual(refusedAs(404, GONE));
  });
});

describe("the route files", () => {
  // Each file, the methods it answers, and the handler each method goes to.
  const ROUTES: [string, () => Promise<Record<string, unknown>>, Record<string, string>][] = [
    ["media/route.ts", () => import("@/app/api/media/route"), { GET: "list", POST: "open" }],
    ["media/[id]/route.ts", () => import("@/app/api/media/[id]/route"), { PATCH: "update", DELETE: "remove" }],
    ["media/[id]/offset/route.ts", () => import("@/app/api/media/[id]/offset/route"), { POST: "offset" }],
    ["media/[id]/complete/route.ts", () => import("@/app/api/media/[id]/complete/route"), { POST: "complete" }],
    ["media/[id]/files/route.ts", () => import("@/app/api/media/[id]/files/route"), { POST: "openFile" }],
    ["media/[id]/files/complete/route.ts", () => import("@/app/api/media/[id]/files/complete/route"), { POST: "completeFile" }],
    ["media/[id]/preview-failed/route.ts", () => import("@/app/api/media/[id]/preview-failed/route"), { POST: "previewFailed" }],
    ["drive/read-token/route.ts", () => import("@/app/api/drive/read-token/route"), { POST: "readToken" }],
  ];

  afterEach(() => {
    vi.doUnmock("@/lib/media/handlers");
    vi.doUnmock("@/lib/access");
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("there are eight, and each sends its methods to the handlers of the table", async () => {
    const files = [...sources("src/app/api/media"), ...sources("src/app/api/drive")].map(([file]) => file);
    expect(files.sort()).toEqual(ROUTES.map(([file]) => `src/app/api/${file}`).sort());

    // No setting is there to be read while the files load.
    for (const name of ["DATABASE_URL", "BETTER_AUTH_URL", "BETTER_AUTH_SECRET", "GOOGLE_SERVICE_ACCOUNT_KEY", "DRIVE_FOLDER_ID"]) vi.stubEnv(name, "");
    vi.resetModules();
    const handlerNames = ["list", "open", "update", "remove", "offset", "complete", "openFile", "completeFile", "previewFailed"];
    const handlers: Record<string, unknown> = Object.fromEntries(handlerNames.map((name) => [name, vi.fn()]));
    const readToken = vi.fn();
    const makeMediaHandlers = vi.fn<(deps: MediaHandlerDeps) => unknown>(() => handlers);
    const makeReadTokenHandler = vi.fn<(deps: MediaHandlerDeps) => unknown>(() => readToken);
    const requireUserApi = vi.fn(async () => memberOf({ userId: "u1", email: "u1@gmail.com", role: "viewer" }));
    vi.doMock("@/lib/media/handlers", () => ({ makeMediaHandlers, makeReadTokenHandler }));
    vi.doMock("@/lib/access", () => ({ requireUserApi }));

    const all: Record<string, unknown> = { ...handlers, readToken };
    for (const [file, load, methods] of ROUTES) {
      const route = await load();
      expect(Object.keys(route).sort(), file).toEqual(Object.keys(methods).sort());
      for (const [method, handler] of Object.entries(methods)) expect(route[method], `${method} ${file}`).toBe(all[handler]);
    }

    // Every file hands over the same four things, and none of them was called to load it.
    const { getDb } = await import("@/db");
    const { getDrive } = await import("@/lib/drive");
    const { appBaseUrl } = await import("@/lib/connector/config");
    expect(makeMediaHandlers).toHaveBeenCalledTimes(7);
    expect(makeReadTokenHandler).toHaveBeenCalledTimes(1);
    for (const [deps] of [...makeMediaHandlers.mock.calls, ...makeReadTokenHandler.mock.calls]) {
      expect(Object.keys(deps).sort()).toEqual(["auth", "db", "drive", "origin"]);
      expect(deps.db).toBe(getDb);
      expect(deps.drive).toBe(getDrive);
      expect(deps.origin).toBe(appBaseUrl);
      const asked = request("GET");
      requireUserApi.mockClear();
      await deps.auth(asked);
      expect(requireUserApi.mock.calls).toEqual([[asked, "viewer"]]); // signed in is enough; the service checks the role
    }
  });
});
