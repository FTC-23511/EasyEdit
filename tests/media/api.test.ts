import { afterEach, describe, expect, it, vi } from "vitest";
import { CROSS_ORIGIN_BODY, FORBIDDEN_BODY, INTERNAL_BODY, UNAUTHENTICATED_BODY } from "@/lib/api-errors";
import { createMediaApi, type MediaApi, type MediaResult } from "@/lib/media/api";
import { NOT_SET_UP_BODY, STORAGE_DOWN_BODY } from "@/lib/media/handlers";
import type { AssetView } from "@/lib/media/types";
import { piece } from "../helpers/fake-drive";
import { VIDEO, handlersFetch, insertAsset, mediaContext, sendAll } from "./context";

const SESSION = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=abc";

const ASSET: AssetView = {
  id: "a1", kind: "video", name: "IMG_4821", fileName: "IMG_4821.MOV", sizeBytes: 20_000_000, status: "ready", removed: false,
  durationMs: 12_500, width: 1080, height: 1920, fps: 30, hasAudio: true, originalFileId: "o1", previewStatus: "pending",
  previewFileId: null, posterFileId: null, event: null, uploadedBy: "user-ada", uploadedByName: "Ada Lovelace", createdAt: "2026-11-10T18:40:00.000Z",
};

type Call = {
  name: string;
  run: (api: MediaApi) => Promise<MediaResult<object>>;
  request: { method: string; url: string; body?: unknown }; // what it sends
  status: number; // what a working server answers it
  answer: Record<string, unknown> | null; // null: no body
};

// Every call the client has.
const CALLS: Call[] = [
  { name: "list", run: (api) => api.list(), request: { method: "GET", url: "/api/media" }, status: 200, answer: { assets: [ASSET], setUp: true } },
  { name: "list by id", run: (api) => api.list(["a1", "a2"]), request: { method: "GET", url: "/api/media?ids=a1,a2" }, status: 200, answer: { assets: [ASSET], setUp: false } },
  { name: "open", run: (api) => api.open(VIDEO), request: { method: "POST", url: "/api/media", body: VIDEO }, status: 201, answer: { asset: ASSET, uploadUrl: SESSION, offset: 0 } },
  { name: "offset", run: (api) => api.offset("a1"), request: { method: "POST", url: "/api/media/a1/offset" }, status: 200, answer: { uploadUrl: SESSION, offset: 8_388_608, done: false } },
  { name: "complete", run: (api) => api.complete("a1"), request: { method: "POST", url: "/api/media/a1/complete" }, status: 200, answer: { asset: ASSET } },
  { name: "openFile", run: (api) => api.openFile("a1", "poster", 50_000), request: { method: "POST", url: "/api/media/a1/files", body: { role: "poster", sizeBytes: 50_000 } }, status: 201, answer: { uploadUrl: SESSION } },
  { name: "completeFile", run: (api) => api.completeFile("a1", "preview"), request: { method: "POST", url: "/api/media/a1/files/complete", body: { role: "preview" } }, status: 200, answer: { asset: ASSET } },
  { name: "previewFailed", run: (api) => api.previewFailed("a1"), request: { method: "POST", url: "/api/media/a1/preview-failed" }, status: 200, answer: { asset: ASSET } },
  { name: "update", run: (api) => api.update("a1", { name: "Kickoff", event: null }), request: { method: "PATCH", url: "/api/media/a1", body: { name: "Kickoff", event: null } }, status: 200, answer: { asset: ASSET } },
  { name: "remove", run: (api) => api.remove("a1"), request: { method: "DELETE", url: "/api/media/a1" }, status: 204, answer: null },
  { name: "readToken", run: (api) => api.readToken(), request: { method: "POST", url: "/api/drive/read-token" }, status: 200, answer: { accessToken: "ya29.token", expiresAt: 1_762_900_000_000 } },
];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const page = (status: number) => new Response("<html>Not ours</html>", { status, headers: { "content-type": "text/html" } });
const answered = (call: Call, body: unknown = call.answer) => (body === null ? new Response(null, { status: call.status }) : json(call.status, body));

// The client over a server that gives every request the same answer (built anew each time: a Response can be read once).
const apiAnswering = (respond: () => Response) => createMediaApi((async () => respond()) as typeof fetch);

// What every call makes of one answer.
async function everyCall(respond: () => Response): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const call of CALLS) results.push(await call.run(apiAnswering(respond)));
  return results;
}

const all = (result: unknown) => CALLS.map(() => result);

function got<T>(result: MediaResult<T>): { ok: true } & T {
  if (!result.ok) throw new Error(`${result.kind}: ${result.message}`);
  return result;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the browser's media API client", () => {
  it("a failed fetch is a network failure, and no call throws", async () => {
    const network = { ok: false, kind: "network", message: "" };
    const rejecting = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
    const throwing = (() => { throw new TypeError("Failed to fetch"); }) as typeof fetch; // not even a promise
    // An answer that breaks off while it is read.
    const cutOff = (async () => new Response(new ReadableStream({ start: (stream) => stream.error(new TypeError("terminated")) }), { status: 200 })) as typeof fetch;
    for (const fetchFn of [rejecting, throwing, cutOff]) {
      for (const call of CALLS) expect(await call.run(createMediaApi(fetchFn)), call.name).toEqual(network);
    }
    // An id that cannot be written in an address is not sent, and is not thrown either.
    const fetchFn = vi.fn<typeof fetch>(async () => json(200, {}));
    expect(await createMediaApi(fetchFn).offset("\uD800")).toEqual(network);
    expect(await createMediaApi(fetchFn).list(["\uD800"])).toEqual(network);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("401 is signed out", async () => {
    expect(await everyCall(() => json(401, UNAUTHENTICATED_BODY))).toEqual(all({ ok: false, kind: "signed-out", message: "Sign in to continue." }));
    expect(await everyCall(() => page(401))).toEqual(all({ ok: false, kind: "signed-out", message: "" }));
  });

  it("403 is forbidden", async () => {
    expect(await everyCall(() => json(403, FORBIDDEN_BODY))).toEqual(all({ ok: false, kind: "forbidden", message: "Your role doesn't allow this." }));
    expect(await everyCall(() => json(403, CROSS_ORIGIN_BODY))).toEqual(all({ ok: false, kind: "forbidden", message: "This request came from another site." }));
  });

  it("503 with MEDIA_NOT_SET_UP is not set up", async () => {
    expect(NOT_SET_UP_BODY.code).toBe("MEDIA_NOT_SET_UP");
    expect(await everyCall(() => json(503, NOT_SET_UP_BODY))).toEqual(all({ ok: false, kind: "not-set-up", message: "Uploads are not set up yet." }));
    // Any other 503 is not ours to explain.
    expect(await everyCall(() => json(503, { code: "BUSY", message: "Try later." }))).toEqual(all({ ok: false, kind: "refused", message: "Try later." }));
    expect(await everyCall(() => page(503))).toEqual(all({ ok: false, kind: "refused", message: "" }));
    // And the code means nothing under another status.
    expect(await everyCall(() => json(400, NOT_SET_UP_BODY))).toEqual(all({ ok: false, kind: "refused", message: "Uploads are not set up yet." }));
  });

  it("502 is a storage failure", async () => {
    expect(await everyCall(() => json(502, STORAGE_DOWN_BODY))).toEqual(all({ ok: false, kind: "storage", message: "Google Drive didn't answer. Try again." }));
    expect(await everyCall(() => page(502))).toEqual(all({ ok: false, kind: "storage", message: "" }));
  });

  it.each([
    [400, { code: "INVALID", message: "This file is empty." }, "This file is empty."],
    [400, { code: "LIMIT_EXCEEDED", message: "You have 20 unfinished uploads. Finish or cancel one first." }, "You have 20 unfinished uploads. Finish or cancel one first."],
    [404, { code: "NOT_FOUND", message: "That file is no longer in the library." }, "That file is no longer in the library."],
    [409, { code: "CONFLICT", message: "This upload expired. Choose the file again." }, "This upload expired. Choose the file again."],
    [500, INTERNAL_BODY, "Something went wrong. Try again."],
    [429, { code: "SLOW_DOWN" }, ""], // no sentence
    [400, { code: "INVALID", message: 7 }, ""], // not a sentence
    [405, ["message"], ""],
    [504, null, ""],
  ])("any other refusal is refused, with the server's sentence (%i %j)", async (status, body, message) => {
    expect(await everyCall(() => (body === null ? page(status) : json(status, body)))).toEqual(all({ ok: false, kind: "refused", message }));
  });

  it("a success without the fields its call names is an unexpected answer", async () => {
    const unexpected = { ok: false, kind: "refused", message: "Unexpected answer." };
    const withBody = CALLS.filter((call) => call.answer !== null);
    expect(withBody).toHaveLength(CALLS.length - 1);
    for (const call of withBody) {
      const answer = call.answer!;
      const wrong: unknown[] = [null, [], "ok", 1, {}, [answer]];
      for (const key of Object.keys(answer)) {
        const without = { ...answer };
        delete without[key];
        wrong.push(without, { ...answer, [key]: {} }, { ...answer, [key]: [answer[key]] });
        if (!(call.name === "offset" && key === "uploadUrl")) wrong.push({ ...answer, [key]: null }); // an offset may come with no address
      }
      for (const body of wrong) expect(await call.run(apiAnswering(() => answered(call, body))), `${call.name} ${JSON.stringify(body)}`).toEqual(unexpected);
      // An answer that is not JSON, and one with nothing in it.
      expect(await call.run(apiAnswering(() => new Response("<html>", { status: 200 }))), call.name).toEqual(unexpected);
      expect(await call.run(apiAnswering(() => new Response(null, { status: 204 }))), call.name).toEqual(unexpected);
    }
  });

  it("checks each field of an answer, not only that it is there", async () => {
    const unexpected = { ok: false, kind: "refused", message: "Unexpected answer." };
    const opening = (body: unknown) => apiAnswering(() => json(201, body)).open(VIDEO);
    const asking = (body: unknown) => apiAnswering(() => json(200, body)).offset("a1");
    const listing = (body: unknown) => apiAnswering(() => json(200, body)).list();
    const token = (body: unknown) => apiAnswering(() => json(200, body)).readToken();

    expect(await opening({ asset: ASSET, uploadUrl: 5, offset: 0 })).toEqual(unexpected);
    expect(await opening({ asset: ASSET, uploadUrl: SESSION, offset: "0" })).toEqual(unexpected);
    expect(await asking({ uploadUrl: SESSION, offset: 0, done: "no" })).toEqual(unexpected);
    expect(await asking({ uploadUrl: 5, offset: 0, done: false })).toEqual(unexpected);
    expect(await asking({ uploadUrl: null, offset: 20_000_000, done: true })).toEqual({ ok: true, uploadUrl: null, offset: 20_000_000, done: true }); // no address is an answer
    expect(await listing({ assets: [ASSET], setUp: "yes" })).toEqual(unexpected);
    expect(await listing({ assets: [ASSET, { id: "a2" }], setUp: true })).toEqual(unexpected);
    expect(await listing({ assets: [], setUp: false })).toEqual({ ok: true, assets: [], setUp: false });
    expect(await token({ accessToken: "ya29.token", expiresAt: "soon" })).toEqual(unexpected);
    expect(await token({ accessToken: 1, expiresAt: 1 })).toEqual(unexpected);

    // Every field of an asset is looked at.
    for (const key of Object.keys(ASSET) as (keyof AssetView)[]) {
      const without: Record<string, unknown> = { ...ASSET };
      delete without[key];
      expect(await listing({ assets: [without], setUp: true }), key).toEqual(unexpected);
      expect(await opening({ asset: { ...ASSET, [key]: typeof ASSET[key] === "number" ? "7" : 7 }, uploadUrl: SESSION, offset: 0 }), key).toEqual(unexpected);
    }
    for (const change of [{ kind: "gif" }, { status: "gone" }, { previewStatus: "soon" }, { hasAudio: null }, { sizeBytes: null }, { name: null }]) {
      expect(await listing({ assets: [{ ...ASSET, ...change }], setUp: true }), JSON.stringify(change)).toEqual(unexpected);
    }
    // What may be null, as for an image that is still on its way.
    const image = { ...ASSET, kind: "image", status: "uploading", durationMs: null, width: null, height: null, fps: null, originalFileId: null, previewStatus: "none", event: "Regionals" };
    expect(await listing({ assets: [image], setUp: true })).toEqual({ ok: true, assets: [image], setUp: true });
  });

  it("passes on the fields its call names and nothing else", async () => {
    for (const call of CALLS) {
      const extra = call.answer === null ? null : { ...call.answer, secret: "x", ...("asset" in call.answer ? { asset: { ...ASSET, uploadUrl: SESSION } } : {}) };
      expect(await call.run(apiAnswering(() => answered(call, extra))), call.name).toEqual({ ok: true, ...call.answer });
    }
    // Removing answers with no body. Whatever a server put there is not passed on.
    expect(await apiAnswering(() => json(200, { asset: ASSET })).remove("a1")).toEqual({ ok: true });
    expect(await apiAnswering(() => new Response("<html>", { status: 200 })).remove("a1")).toEqual({ ok: true });
  });

  it("requests are same-origin and say they carry JSON", async () => {
    for (const call of CALLS) {
      const fetchFn = vi.fn<typeof fetch>(async () => answered(call));
      expect(await call.run(createMediaApi(fetchFn)), call.name).toMatchObject({ ok: true });
      expect(fetchFn, call.name).toHaveBeenCalledTimes(1);
      const [url, init] = fetchFn.mock.calls[0];
      expect(url, call.name).toBe(call.request.url); // a path: the page's own origin
      expect(init!.method, call.name).toBe(call.request.method);
      expect([...new Headers(init!.headers)], call.name).toEqual([["content-type", "application/json"]]);
      if (call.request.body === undefined) expect(init!.body, call.name).toBeUndefined();
      else expect(JSON.parse(String(init!.body)), call.name).toEqual(call.request.body);
      expect(init!.credentials ?? "same-origin", call.name).toBe("same-origin");
      expect(init!.cache, call.name).toBe("no-store"); // the answer is the server's, not a kept copy
    }
  });

  it("uses the page's own fetch when it is given none", async () => {
    const pages = vi.fn<typeof fetch>(async () => json(200, { assets: [ASSET], setUp: true }));
    vi.stubGlobal("fetch", pages);
    try {
      expect(await createMediaApi().list()).toEqual({ ok: true, assets: [ASSET], setUp: true });
      expect(pages).toHaveBeenCalledTimes(1);
      expect(pages.mock.calls[0][0]).toBe("/api/media");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("writes ids into an address so that they stay ids", async () => {
    const urls: string[] = [];
    const api = createMediaApi((async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return json(200, { assets: [], setUp: true });
    }) as typeof fetch);
    await api.list([]);
    await api.list(["a1"]);
    await api.list(["a&b=c", "d#e"]);
    await api.remove("a/b?c");
    await api.offset("../x y");
    await api.update("a1", {});
    expect(urls).toEqual(["/api/media?ids=", "/api/media?ids=a1", "/api/media?ids=a%26b%3Dc,d%23e", "/api/media/a%2Fb%3Fc", "/api/media/..%2Fx%20y/offset", "/api/media/a1"]);
  });

  it("open sends the facts and returns the session", async () => {
    const ctx = await mediaContext();
    const api = createMediaApi(handlersFetch(ctx, ctx.ada));
    const opened = got(await api.open({ ...VIDEO, event: "Regionals" }));
    expect(opened).toEqual({ ok: true, asset: expect.any(Object), uploadUrl: expect.stringContaining("upload_id="), offset: 0 });
    expect(opened.asset).toMatchObject({
      kind: "video", name: "IMG_4821", fileName: "IMG_4821.MOV", sizeBytes: 20_000_000, status: "uploading", durationMs: 12_500, width: 1080, height: 1920,
      fps: 30, hasAudio: true, originalFileId: null, previewStatus: "pending", event: "Regionals", uploadedBy: ctx.ada.userId, uploadedByName: "Ada Lovelace",
    });
    expect(ctx.fake.sessions.get(opened.uploadUrl)).toMatchObject({ origin: "https://app.test", sizeBytes: VIDEO.sizeBytes, mimeType: VIDEO.mimeType });
    // The same facts again are the same upload, taken up where it stopped: the last-modified time was sent too.
    expect((await piece(ctx.fake, opened.uploadUrl, 0, 8 * 1024 * 1024, VIDEO.sizeBytes)).status).toBe(308);
    expect(await api.open(VIDEO)).toEqual({ ok: true, asset: opened.asset, uploadUrl: opened.uploadUrl, offset: 8 * 1024 * 1024 });
    expect(got(await api.open({ ...VIDEO, lastModifiedMs: VIDEO.lastModifiedMs + 1 })).asset.id).not.toBe(opened.asset.id);
  });

  it("every call reaches its own route of the real server", async () => {
    const ctx = await mediaContext();
    const api = createMediaApi(handlersFetch(ctx, ctx.ada));
    expect(await api.list()).toEqual({ ok: true, assets: [], setUp: true });

    const opened = got(await api.open(VIDEO));
    const id = opened.asset.id;
    expect(await api.offset(id)).toEqual({ ok: true, uploadUrl: opened.uploadUrl, offset: 0, done: false });
    await sendAll(ctx.fake, opened.uploadUrl, VIDEO.sizeBytes);
    expect(await api.offset(id)).toEqual({ ok: true, uploadUrl: opened.uploadUrl, offset: VIDEO.sizeBytes, done: true });
    const ready = { ...opened.asset, status: "ready", originalFileId: expect.any(String) };
    expect(await api.complete(id)).toEqual({ ok: true, asset: ready });
    expect(await api.offset(id)).toEqual({ ok: true, uploadUrl: null, offset: VIDEO.sizeBytes, done: true });

    const poster = got(await api.openFile(id, "poster", 50_000));
    expect(poster).toEqual({ ok: true, uploadUrl: expect.stringContaining("upload_id=") });
    expect(ctx.fake.sessions.get(poster.uploadUrl)).toMatchObject({ sizeBytes: 50_000, name: `${id}.poster.jpg` });
    await sendAll(ctx.fake, poster.uploadUrl, 50_000);
    const withPoster = { ...ready, posterFileId: expect.any(String) };
    expect(await api.completeFile(id, "poster")).toEqual({ ok: true, asset: withPoster });
    const preview = got(await api.openFile(id, "preview", 2_000_000));
    expect(ctx.fake.sessions.get(preview.uploadUrl)).toMatchObject({ sizeBytes: 2_000_000 });
    expect(await api.completeFile(id, "preview")).toEqual({ ok: false, kind: "refused", message: "The upload is not finished." });

    expect(await api.previewFailed(id)).toEqual({ ok: true, asset: { ...withPoster, previewStatus: "failed" } });
    const renamed = { ...withPoster, previewStatus: "failed", name: "Kickoff", event: "Regionals" };
    expect(await api.update(id, { name: " Kickoff ", event: "Regionals" })).toEqual({ ok: true, asset: renamed });
    expect(await api.update(id, { event: null })).toEqual({ ok: true, asset: { ...renamed, event: null } });

    const listed = got(await api.list());
    expect(listed).toEqual({ ok: true, assets: [{ ...renamed, event: null }], setUp: true });
    expect(await api.list([id, "nobody"])).toEqual(listed);
    expect(await api.list([])).toEqual({ ok: true, assets: [], setUp: true }); // no ids is not the whole library

    const token = got(await api.readToken());
    expect(token).toEqual({ ok: true, accessToken: expect.any(String), expiresAt: expect.any(Number) });
    expect(token.expiresAt - ctx.fake.now()).toBeGreaterThanOrEqual(600_000);

    expect(await api.remove(id)).toEqual({ ok: true });
    expect(await api.list()).toEqual({ ok: true, assets: [], setUp: true });
    expect(await api.list([id])).toEqual({ ok: true, assets: [{ ...listed.assets[0], removed: true }], setUp: true });
    expect(await api.remove(id)).toEqual({ ok: false, kind: "refused", message: "That file is no longer in the library." });
  });

  it("says what the real server refuses, in the server's words", async () => {
    const ctx = await mediaContext();
    const viewer = createMediaApi(handlersFetch(ctx, ctx.vera));
    expect(await viewer.open(VIDEO)).toEqual({ ok: false, kind: "forbidden", message: "Your role doesn't allow this." });
    expect(await viewer.list()).toEqual({ ok: true, assets: [], setUp: true });
    expect(await viewer.readToken()).toMatchObject({ ok: true });

    const api = createMediaApi(handlersFetch(ctx, ctx.ada));
    expect(await api.open({ ...VIDEO, fileName: "photo.heic" })).toEqual({ ok: false, kind: "refused", message: "HEIC photos aren't supported yet. Save the photo as JPEG first." });
    expect(await api.complete("nobody")).toEqual({ ok: false, kind: "refused", message: "That file is no longer in the library." });
    expect(await api.openFile("nobody", "poster", 50_000)).toEqual({ ok: false, kind: "refused", message: "That file is no longer in the library." });

    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    ctx.fake.failNext(/generateIds/, 500, "backendError");
    expect(await api.open(VIDEO)).toEqual({ ok: false, kind: "storage", message: "Google Drive didn't answer. Try again." });
    expect(logged).toHaveBeenCalledTimes(1);
  });
});

describe("handlersFetch", () => {
  it("throws for a path, a method or a site that has no route", async () => {
    const ctx = await mediaContext();
    const fetchFn = handlersFetch(ctx, ctx.ada);
    await expect(fetchFn("/api/projects/p1")).rejects.toThrow("No route for GET /api/projects/p1");
    await expect(fetchFn("/api/media/a1/offset")).rejects.toThrow("No route for GET /api/media/a1/offset");
    await expect(fetchFn("/api/media", { method: "DELETE" })).rejects.toThrow("No route for DELETE /api/media");
    await expect(fetchFn("/api/media/a1/files/else", { method: "POST" })).rejects.toThrow("No route");
    await expect(fetchFn("/api/drive/read-token")).rejects.toThrow("No route for GET /api/drive/read-token");
    await expect(fetchFn("https://elsewhere.example/api/media")).rejects.toThrow("No route");
    expect((await fetchFn("/api/media")).status).toBe(200);
    expect((await fetchFn("https://app.test/api/media?ids=")).status).toBe(200);
  });

  it("sends each request as the app's own page would, and the id as it was written", async () => {
    const ctx = await mediaContext();
    const fetchFn = handlersFetch(ctx, ctx.ada);
    // The request names the app as the site it comes from. So one that claims to be for another host is refused as cross-site.
    const init = { method: "POST", body: JSON.stringify(VIDEO) };
    const elsewhere = await fetchFn("/api/media", { ...init, headers: { "content-type": "application/json", "x-forwarded-host": "elsewhere.example" } });
    expect([elsewhere.status, await elsewhere.json()]).toEqual([403, CROSS_ORIGIN_BODY]);
    expect((await fetchFn("/api/media", { ...init, headers: { "content-type": "application/json" } })).status).toBe(201);

    // An id that had to be escaped in the address reaches the route whole.
    const id = await insertAsset(ctx.db, { id: "a b/c?d", uploadedBy: ctx.ada.userId });
    expect(await createMediaApi(fetchFn).update(id, { name: "Kickoff" })).toMatchObject({ ok: true, asset: { id: "a b/c?d", name: "Kickoff" } });
  });
});
