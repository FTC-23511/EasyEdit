import { afterEach, describe, expect, it, vi } from "vitest";
import { createDriveClient } from "@/lib/drive/client";
import { SCOPE_READ, SCOPE_WRITE, createTokenSource } from "@/lib/drive/token";
import { LIMITS } from "@/lib/limits";
import { createMediaApi, type MediaApi, type MediaFailure } from "@/lib/media/api";
import { pickEvictions } from "@/lib/media/cache-plan";
import { createMediaFiles, createMemoryStore, type FileStore } from "@/lib/media/media-files";
import { PLACEHOLDER_LABELS, playbackFileFor } from "@/lib/media/playback";
import { TOKEN_MARGIN_MS, createReadTokens, driveFileUrl, readDriveFile, type ReadTokens } from "@/lib/media/read-tokens";
import type { AssetView } from "@/lib/media/types";
import { makeFakeDrive } from "../helpers/fake-drive";
import { sources } from "../helpers/sources";
import { handlersFetch, mediaContext, readyAsset } from "./context";

const MB = 1_000_000;
const NO_TOKEN: MediaFailure = { ok: false, kind: "network", message: "" };
const zeros = (bytes: number) => new Blob([new Uint8Array(bytes)]);

afterEach(() => vi.unstubAllGlobals());

// tokensHarness(options?): createReadTokens over a pretend api.readToken that counts calls and answers
//   { accessToken: `t${n}`, expiresAt: now + 3_600_000 } on a clock the test moves with advance(ms).
function tokensHarness(options: { failFirst?: boolean } = {}) {
  let at = 1_762_900_000_000;
  let calls = 0;
  const api: Pick<MediaApi, "readToken"> = {
    async readToken() {
      calls += 1;
      if (options.failFirst && calls === 1) return NO_TOKEN;
      return { ok: true, accessToken: `t${calls}`, expiresAt: at + 3_600_000 };
    },
  };
  return { tokens: createReadTokens({ api, now: () => at }), calls: () => calls, advance: (ms: number) => void (at += ms) };
}

// readHarness(): mediaContext(), one ready VIDEO asset, and createReadTokens over createMediaApi(handlersFetch(ctx, ctx.vera)):
//   the real read-token handler of Task 7, signed in as vera (a viewer); handlersFetch is in tests/media/context.ts
//   since Task 9. tokenRequests() counts the requests to /api/drive/read-token. The browser's clock is its own:
//   createReadTokens gets `now: () => t0`, where t0 is ctx.fake.now() read once when the harness is made, so
//   fake.advance moves Drive's clock and the server's, and not the browser's.
async function readHarness() {
  const ctx = await mediaContext();
  const asset = await readyAsset(ctx);
  const t0 = ctx.fake.now();
  const server = handlersFetch(ctx, ctx.vera);
  let requests = 0;
  const counted = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/drive/read-token") requests += 1;
    return server(input, init);
  }) as typeof fetch;
  const tokens = createReadTokens({ api: createMediaApi(counted), now: () => t0 });
  return { ctx, asset, tokens, tokenRequests: () => requests };
}

// Tokens that are always the same one, or never there, and that write down what was asked of them.
function fixedTokens(token: string | null = "tok-1") {
  const asked: string[] = [];
  let n = 1;
  const tokens: ReadTokens = {
    async get() {
      asked.push("get");
      return token === null ? null : `tok-${n}`;
    },
    invalidate() {
      asked.push("invalidate");
      n += 1;
    },
  };
  return { tokens, asked };
}

// A fetch that answers with the given statuses in turn, and writes down what it was asked.
function answering(...statuses: number[]) {
  const sent: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), init });
    const status = statuses[sent.length - 1];
    return new Response(status === 204 ? null : "x", { status });
  }) as typeof fetch;
  return { fetch: fetchFn, sent };
}

describe("the read token in the browser", () => {
  it("asks once, reuses it, and shares a request in flight", async () => {
    const h = tokensHarness();
    expect(await Promise.all([h.tokens.get(), h.tokens.get()])).toEqual(["t1", "t1"]);
    expect(await h.tokens.get()).toBe("t1");
    expect(h.calls()).toBe(1);
  });

  it("asks for a new token when the old one is about to expire", async () => {
    const h = tokensHarness();
    await h.tokens.get();
    h.advance(3_600_000 - 60_001);
    expect(await h.tokens.get()).toBe("t1"); // 60.001 s left
    h.advance(2);
    expect(await h.tokens.get()).toBe("t2"); // under a minute left
  });

  it("gives null when no token can be had, and tries again next time", async () => {
    const h = tokensHarness({ failFirst: true });
    expect(await h.tokens.get()).toBeNull();
    expect(await h.tokens.get()).toBe("t2");
  });

  it("keeps a token until a minute before its end, and no longer", async () => {
    expect(TOKEN_MARGIN_MS).toBe(60_000);
    const h = tokensHarness();
    await h.tokens.get();
    h.advance(3_600_000 - 60_000);
    expect(await h.tokens.get()).toBe("t1"); // a minute left, to the millisecond
    h.advance(1);
    expect(await h.tokens.get()).toBe("t2");
    expect(await h.tokens.get()).toBe("t2"); // the new one is the one kept
    expect(h.calls()).toBe(2);
  });

  it("two calls that share a failed request both get null, and it is not remembered", async () => {
    const h = tokensHarness({ failFirst: true });
    expect(await Promise.all([h.tokens.get(), h.tokens.get()])).toEqual([null, null]);
    expect(h.calls()).toBe(1);
    expect(await Promise.all([h.tokens.get(), h.tokens.get()])).toEqual(["t2", "t2"]);
    expect(h.calls()).toBe(2);
  });

  it("a request that throws is null too, and is not remembered", async () => {
    let calls = 0;
    const api: Pick<MediaApi, "readToken"> = {
      readToken() {
        calls += 1;
        if (calls === 1) throw new TypeError("Failed to fetch"); // before it has begun
        if (calls === 2) return Promise.reject(new TypeError("Failed to fetch"));
        return Promise.resolve({ ok: true, accessToken: "t3", expiresAt: Date.now() + 3_600_000 });
      },
    };
    const tokens = createReadTokens({ api });
    expect(await tokens.get()).toBeNull();
    expect(await tokens.get()).toBeNull();
    expect(await tokens.get()).toBe("t3");
    expect(await tokens.get()).toBe("t3");
    expect(calls).toBe(3);
  });

  it("forgets a token that was refused", async () => {
    const h = tokensHarness();
    expect(await h.tokens.get()).toBe("t1");
    h.tokens.invalidate();
    expect(await h.tokens.get()).toBe("t2");
    expect(await h.tokens.get()).toBe("t2");
    expect(h.calls()).toBe(2);
  });

  it("keeps the token that is on its way when the old one is refused", async () => {
    const h = tokensHarness();
    const first = h.tokens.get();
    h.tokens.invalidate(); // nothing is held yet
    const second = h.tokens.get();
    expect(await Promise.all([first, second])).toEqual(["t1", "t1"]);
    expect(await h.tokens.get()).toBe("t1");
    expect(h.calls()).toBe(1);
  });

  it("goes by the clock of the page when it is given none", async () => {
    let calls = 0;
    const lasting = (ms: number) => createReadTokens({ api: { readToken: async () => ({ ok: true, accessToken: `t${(calls += 1)}`, expiresAt: Date.now() + ms }) } });
    const long = lasting(TOKEN_MARGIN_MS + 30_000);
    expect([await long.get(), await long.get()]).toEqual(["t1", "t1"]);
    const short = lasting(TOKEN_MARGIN_MS - 30_000);
    expect([await short.get(), await short.get()]).toEqual(["t2", "t3"]); // each is handed out once, and not kept
  });

  it("keeps the token in memory and nowhere else", () => {
    const browserFiles = sources("src/lib/media").filter(([file]) => /\/(?:read-tokens|media-files|playback|cache-plan)\.ts$/.test(file));
    expect(browserFiles.map(([file]) => file).sort()).toEqual(["src/lib/media/cache-plan.ts", "src/lib/media/media-files.ts", "src/lib/media/playback.ts", "src/lib/media/read-tokens.ts"]);
    for (const [file, code] of browserFiles) expect(code, file).not.toMatch(/localStorage|sessionStorage|indexedDB|cookie|console/i);
  });
});

describe("reading a file from Drive", () => {
  it("reads a file with the token", async () => {
    const h = await readHarness();
    const read = await readDriveFile(h.asset.originalFileId!, { tokens: h.tokens, fetch: h.ctx.fake.fetch });
    expect(read.ok && (await read.response.blob()).size).toBe(20_000_000);
    expect(h.ctx.fake.calls.at(-1)).toMatchObject({ method: "GET", scope: SCOPE_READ });
  });

  it("a refused read gets one new token and one retry", async () => {
    const h = await readHarness();
    await h.tokens.get();
    h.ctx.fake.advance(3_700_000); // Drive now refuses the token the browser still holds
    const read = await readDriveFile(h.asset.originalFileId!, { tokens: h.tokens, fetch: h.ctx.fake.fetch });
    expect(read.ok).toBe(true);
    expect(h.tokenRequests()).toBe(2);
    h.ctx.fake.failNext(/GET .*alt=media/, 401);
    h.ctx.fake.failNext(/GET .*alt=media/, 401);
    expect(await readDriveFile(h.asset.originalFileId!, { tokens: h.tokens, fetch: h.ctx.fake.fetch })).toEqual({ ok: false, problem: "refused" });
    expect(h.tokenRequests()).toBe(3); // the first 401 got a new token and a retry; the second did not
  });

  it("says missing, refused or offline", async () => {
    const h = await readHarness();
    expect(await readDriveFile("no-such-file", { tokens: h.tokens, fetch: h.ctx.fake.fetch })).toEqual({ ok: false, problem: "missing" });
    h.ctx.fake.failNext(/GET .*alt=media/, 403);
    expect(await readDriveFile(h.asset.originalFileId!, { tokens: h.tokens, fetch: h.ctx.fake.fetch })).toEqual({ ok: false, problem: "refused" });
    const down = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
    expect(await readDriveFile(h.asset.originalFileId!, { tokens: h.tokens, fetch: down })).toEqual({ ok: false, problem: "offline" });
  });

  it("the pretend Drive gives a file's bytes to a token of either kind, and to no other", async () => {
    const fake = makeFakeDrive();
    fake.files.set("f1", { name: "f1", parents: ["folder1"], sizeBytes: 3 * MB, mimeType: "video/mp4", trashed: false });
    const source = createTokenSource({ clientEmail: fake.config.clientEmail, privateKey: fake.config.privateKey, fetch: fake.fetch, now: fake.now });
    const read = (fileId: string, token: string) => fake.fetch(driveFileUrl(fileId), { headers: { Authorization: `Bearer ${token}` } });
    for (const scope of [SCOPE_READ, SCOPE_WRITE]) {
      const answer = await read("f1", (await source.tokenFor(scope)).accessToken);
      expect(answer.status, scope).toBe(200);
      const bytes = new Uint8Array(await answer.arrayBuffer());
      expect(bytes.byteLength).toBe(3 * MB);
      expect(bytes.every((byte) => byte === 0)).toBe(true);
    }
    const token = (await source.tokenFor(SCOPE_READ)).accessToken;
    expect((await read("no-such-file", token)).status).toBe(404);
    expect((await read("f1", "ya29.not-from-here")).status).toBe(401);
    expect((await fake.fetch(driveFileUrl("f1"))).status).toBe(401);
    fake.advance(3_599_999);
    expect((await read("f1", token)).status).toBe(200);
    fake.advance(1); // 3,600 s old
    expect((await read("f1", token)).status).toBe(401);
    // Without alt=media the same address still gives the file's facts.
    const fresh = (await source.tokenFor(SCOPE_READ)).accessToken;
    expect(await (await fake.fetch("https://www.googleapis.com/drive/v3/files/f1?supportsAllDrives=true", { headers: { Authorization: `Bearer ${fresh}` } })).json()).toMatchObject({ id: "f1", name: "f1" });
  });

  it("has one address for a file", () => {
    expect(driveFileUrl("1AbC_d-9")).toBe("https://www.googleapis.com/drive/v3/files/1AbC_d-9?alt=media&supportsAllDrives=true");
    expect(driveFileUrl("a/b?c=d#e")).toBe("https://www.googleapis.com/drive/v3/files/a%2Fb%3Fc%3Dd%23e?alt=media&supportsAllDrives=true");
  });

  it("is one GET with the token in one header, and nothing else of ours", async () => {
    const { tokens } = fixedTokens();
    const net = answering(200);
    const signal = new AbortController().signal;
    const read = await readDriveFile("f1", { tokens, fetch: net.fetch, signal });
    expect(read.ok && read.response.status).toBe(200);
    expect(net.sent).toHaveLength(1);
    expect(net.sent[0].url).toBe(driveFileUrl("f1"));
    expect(net.sent[0].url).not.toContain("tok-1");
    expect(Object.keys(net.sent[0].init!).sort()).toEqual(["headers", "signal"]);
    expect([...new Headers(net.sent[0].init!.headers)]).toEqual([["authorization", "Bearer tok-1"]]);
    expect(net.sent[0].init!.signal).toBe(signal);
  });

  it("uses the page's own fetch when it is given none", async () => {
    const net = answering(200);
    vi.stubGlobal("fetch", net.fetch);
    const read = await readDriveFile("f1", { tokens: fixedTokens().tokens });
    expect(read.ok).toBe(true);
    expect(net.sent.map((one) => one.url)).toEqual([driveFileUrl("f1")]);
  });

  it("asks nothing of Drive when it has no token", async () => {
    const net = answering(200);
    const { tokens, asked } = fixedTokens(null);
    expect(await readDriveFile("f1", { tokens, fetch: net.fetch })).toEqual({ ok: false, problem: "offline" });
    expect(net.sent).toEqual([]);
    expect(asked).toEqual(["get"]);
  });

  it.each([
    [[200], "ok"],
    [[204], "ok"],
    [[206], "ok"],
    [[299], "ok"],
    [[404], "missing"],
    [[403], "refused"],
    [[429], "offline"],
    [[500], "offline"],
    [[503], "offline"],
    [[400], "offline"],
    [[410], "offline"],
    [[301], "offline"],
    [[401, 200], "ok"],
    [[401, 401], "refused"],
    [[401, 403], "refused"],
    [[401, 404], "missing"],
    [[401, 500], "offline"],
  ] as const)("Drive answering %j is %s", async (statuses, outcome) => {
    const net = answering(...statuses);
    const { tokens, asked } = fixedTokens();
    const read = await readDriveFile("f1", { tokens, fetch: net.fetch });
    expect(read.ok ? "ok" : read.problem).toBe(outcome);
    if (read.ok) expect(read.response.status).toBe(statuses.at(-1));
    expect(net.sent).toHaveLength(statuses.length);
    // Only a 401 costs the token, and only the first one.
    expect(asked).toEqual(statuses.length === 2 ? ["get", "invalidate", "get"] : ["get"]);
    expect(net.sent.map((one) => new Headers(one.init!.headers).get("authorization"))).toEqual(statuses.length === 2 ? ["Bearer tok-1", "Bearer tok-2"] : ["Bearer tok-1"]);
  });

  it("is offline when the token was refused and no new one can be had", async () => {
    const net = answering(401, 200);
    let gets = 0;
    const tokens: ReadTokens = { get: async () => ((gets += 1) === 1 ? "tok-1" : null), invalidate: () => undefined };
    expect(await readDriveFile("f1", { tokens, fetch: net.fetch })).toEqual({ ok: false, problem: "offline" });
    expect(net.sent).toHaveLength(1);
  });

  it("a read that was called off is offline, like any read that did not get through", async () => {
    const calledOff = new AbortController();
    calledOff.abort();
    const net = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      init!.signal!.throwIfAborted();
      return new Response("x");
    }) as typeof fetch;
    expect(await readDriveFile("f1", { tokens: fixedTokens().tokens, fetch: net, signal: calledOff.signal })).toEqual({ ok: false, problem: "offline" });
  });
});

describe("which file plays", () => {
  const video = { kind: "video", status: "ready", removed: false, sizeBytes: 300_000_000, originalFileId: "o1", previewStatus: "ready", previewFileId: "p1" } as AssetView;
  it("a video plays its preview copy, not the original", () => {
    expect(playbackFileFor(video)).toEqual({ fileId: "p1", from: "preview" });
  });
  it("waits while the preview copy is being made", () => {
    expect(playbackFileFor({ ...video, previewStatus: "pending", previewFileId: null })).toEqual({ fileId: null, why: "preparing" });
  });
  it("falls back to a small original when there is no preview copy", () => {
    expect(playbackFileFor({ ...video, previewStatus: "failed", previewFileId: null, sizeBytes: 200 * 1024 * 1024 })).toEqual({ fileId: "o1", from: "original" });
    expect(playbackFileFor({ ...video, previewStatus: "failed", previewFileId: null, sizeBytes: 200 * 1024 * 1024 + 1 })).toEqual({ fileId: null, why: "no-preview" });
  });
  it("images and audio play the original; missing, removed and unfinished media say why", () => {
    expect(playbackFileFor({ ...video, kind: "image", previewStatus: "none", previewFileId: null })).toEqual({ fileId: "o1", from: "original" });
    expect(playbackFileFor({ ...video, kind: "audio", previewStatus: "none", previewFileId: null })).toEqual({ fileId: "o1", from: "original" });
    expect(playbackFileFor(undefined)).toEqual({ fileId: null, why: "unknown" });
    expect(playbackFileFor({ ...video, removed: true })).toEqual({ fileId: null, why: "removed" });
    expect(playbackFileFor({ ...video, status: "uploading", originalFileId: null })).toEqual({ fileId: null, why: "uploading" });
  });

  it("the limit for playing an original is the one in LIMITS", () => {
    const noCopy = { ...video, previewStatus: "failed", previewFileId: null } as AssetView;
    expect(playbackFileFor({ ...noCopy, sizeBytes: LIMITS.mediaDirectPlayBytes })).toEqual({ fileId: "o1", from: "original" });
    expect(playbackFileFor({ ...noCopy, sizeBytes: LIMITS.mediaDirectPlayBytes + 1 })).toEqual({ fileId: null, why: "no-preview" });
    expect(playbackFileFor({ ...noCopy, sizeBytes: 1 })).toEqual({ fileId: "o1", from: "original" });
  });

  it("a video waits for its preview copy however small it is", () => {
    expect(playbackFileFor({ ...video, previewStatus: "pending", previewFileId: null, sizeBytes: 1 })).toEqual({ fileId: null, why: "preparing" });
  });

  it("a large image or audio file still plays its original, whatever its preview says", () => {
    for (const kind of ["image", "audio"] as const) {
      for (const previewStatus of ["none", "pending", "ready", "failed"] as const) {
        expect(playbackFileFor({ ...video, kind, previewStatus, sizeBytes: 2_000_000_000 }), `${kind} ${previewStatus}`).toEqual({ fileId: "o1", from: "original" });
      }
    }
  });

  it("removed comes before unfinished, and unfinished before the kind of file", () => {
    expect(playbackFileFor({ ...video, removed: true, status: "uploading", originalFileId: null })).toEqual({ fileId: null, why: "removed" });
    expect(playbackFileFor({ ...video, kind: "image", removed: true })).toEqual({ fileId: null, why: "removed" });
    expect(playbackFileFor({ ...video, kind: "image", status: "uploading", originalFileId: null })).toEqual({ fileId: null, why: "uploading" });
    expect(playbackFileFor({ ...video, kind: "audio", status: "uploading", originalFileId: null })).toEqual({ fileId: null, why: "uploading" });
    expect(playbackFileFor({ ...video, status: "uploading" })).toEqual({ fileId: null, why: "uploading" }); // not ready, whatever ids it has
  });

  it("never names a file that is not there", () => {
    // Neither should happen: a ready asset has its original, and a ready preview has its file.
    expect(playbackFileFor({ ...video, originalFileId: null })).toEqual({ fileId: null, why: "uploading" });
    expect(playbackFileFor({ ...video, previewFileId: null })).toEqual({ fileId: null, why: "no-preview" });
    expect(playbackFileFor({ ...video, previewFileId: null, sizeBytes: 1000 })).toEqual({ fileId: "o1", from: "original" });
    // A video with no preview status behaves as one whose preview was not made.
    expect(playbackFileFor({ ...video, previewStatus: "none", previewFileId: null, sizeBytes: 1000 })).toEqual({ fileId: "o1", from: "original" });
  });

  it("a preview copy that is not ready is not played, even when it names a file", () => {
    expect(playbackFileFor({ ...video, previewStatus: "pending" })).toEqual({ fileId: null, why: "preparing" });
    expect(playbackFileFor({ ...video, previewStatus: "failed" })).toEqual({ fileId: null, why: "no-preview" });
    expect(playbackFileFor({ ...video, previewStatus: "failed", sizeBytes: 1000 })).toEqual({ fileId: "o1", from: "original" });
  });

  it("has a label for every placeholder", () => {
    expect(PLACEHOLDER_LABELS).toEqual({
      uploading: "Uploading",
      preparing: "Preparing preview",
      "no-preview": "No preview",
      removed: "Media removed",
      unknown: "Media not found",
      loading: "Loading",
      failed: "Can't load media",
    });
  });
});

describe("what the local copy keeps", () => {
  const entries = [{ fileId: "a", bytes: 600, usedAt: 1 }, { fileId: "b", bytes: 300, usedAt: 3 }, { fileId: "c", bytes: 100, usedAt: 2 }];
  it("drops the least recently used until the new file fits", () => {
    expect(pickEvictions(entries, 100, 1100, new Set())).toEqual([]);
    expect(pickEvictions(entries, 200, 1100, new Set())).toEqual(["a"]);
    expect(pickEvictions(entries, 900, 1100, new Set())).toEqual(["a", "c", "b"]);
  });
  it("never drops a file that is in use", () => {
    expect(pickEvictions(entries, 200, 1100, new Set(["a"]))).toEqual(["c"]);
    expect(pickEvictions(entries, 500, 1100, new Set(["a"]))).toEqual(["c", "b"]);
  });

  it("drops nothing when room cannot be made", () => {
    expect(pickEvictions(entries, 1101, 1100, new Set())).toEqual([]); // larger than the cap
    expect(pickEvictions(entries, 501, 1100, new Set(["a"]))).toEqual([]); // the file in use leaves 500
    expect(pickEvictions(entries, 101, 1100, new Set(["a", "b", "c"]))).toEqual([]);
    expect(pickEvictions(entries, 1100, 1100, new Set())).toEqual(["a", "c", "b"]); // exactly the cap
    expect(pickEvictions([], 1, 0, new Set())).toEqual([]);
    expect(pickEvictions([], 0, 0, new Set())).toEqual([]);
  });

  it("goes by when a file was last used, not by where it is in the list, and leaves the list alone", () => {
    const list = [{ fileId: "new", bytes: 400, usedAt: 9 }, { fileId: "old", bytes: 400, usedAt: 2 }, { fileId: "twin", bytes: 400, usedAt: 2 }];
    const before = structuredClone(list);
    expect(pickEvictions(list, 400, 1200, new Set())).toEqual(["old"]); // of two used at the same time, the first listed
    expect(pickEvictions(list, 800, 1200, new Set())).toEqual(["old", "twin"]);
    expect(pickEvictions(list, 800, 1200, new Set(["old"]))).toEqual(["twin", "new"]);
    expect(list).toEqual(before);
  });
});

describe("the store in memory", () => {
  it("keeps a file written whole, and says how large it is and when it was used", async () => {
    const store = createMemoryStore();
    expect(await store.read("a")).toBeNull();
    expect(await store.entries()).toEqual([]);
    const blob = new Blob(["hello"]);
    expect(await store.write("a", blob)).toBe(blob);
    expect(await (await store.read("a"))!.text()).toBe("hello");
    await store.write("b", zeros(3 * MB));
    expect(await store.entries()).toEqual([{ fileId: "a", bytes: 5, usedAt: 0 }, { fileId: "b", bytes: 3 * MB, usedAt: 0 }]);
    await store.touch("b", 42);
    await store.touch("nothing", 43); // a file it does not have
    expect(await store.entries()).toEqual([{ fileId: "a", bytes: 5, usedAt: 0 }, { fileId: "b", bytes: 3 * MB, usedAt: 42 }]);
    await store.remove("a");
    await store.remove("a");
    expect(await store.read("a")).toBeNull();
    expect((await store.entries()).map((entry) => entry.fileId)).toEqual(["b"]);
    expect(await createMemoryStore().entries()).toEqual([]); // two stores share nothing
  });

  it("keeps a body that arrives in parts once all of it has arrived", async () => {
    const store = createMemoryStore();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hel"));
        controller.enqueue(new TextEncoder().encode("lo"));
        controller.close();
      },
    });
    const written = await store.write("a", body);
    expect(await written.text()).toBe("hello");
    expect(await (await store.read("a"))!.text()).toBe("hello");
    expect(await store.entries()).toEqual([{ fileId: "a", bytes: 5, usedAt: 0 }]);
  });

  it("keeps nothing of a body that fails part way", async () => {
    const store = createMemoryStore();
    await expect(store.write("a", cutOffBody())).rejects.toThrow();
    expect(await store.read("a")).toBeNull();
    expect(await store.entries()).toEqual([]);
  });
});

// A body that gives 1 MB and then fails, as a download does when the connection drops.
function cutOffBody(): ReadableStream<Uint8Array> {
  let given = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (given) controller.error(new TypeError("network error"));
      else controller.enqueue(new Uint8Array(MB));
      given = true;
    },
  });
}

const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
};

// filesHarness(held): a pretend Drive that holds the files named in `held` (id: bytes), read tokens the server
// would hand out for it, and an empty store in memory. `fetch` is the Drive's, and writes the id of every file
// read into `reads`. `net.fetch` can be swapped by a test. `clock.at` is the browser's time.
function filesHarness(held: Record<string, number> = {}) {
  const fake = makeFakeDrive();
  for (const [id, bytes] of Object.entries(held)) fake.files.set(id, { name: id, parents: ["folder1"], sizeBytes: bytes, mimeType: "video/mp4", trashed: false });
  const drive = createDriveClient({ config: fake.config, fetch: fake.fetch, now: fake.now });
  let tokenRequests = 0;
  const api: Pick<MediaApi, "readToken"> = {
    async readToken() {
      tokenRequests += 1;
      return { ok: true, ...(await drive.readToken(LIMITS.mediaReadTokenMinSeconds)) };
    },
  };
  const tokens = createReadTokens({ api, now: fake.now });
  const reads: string[] = [];
  const net = { fetch: fake.fetch };
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    reads.push(decodeURIComponent(new URL(String(input)).pathname.split("/").at(-1)!));
    return net.fetch(input, init);
  }) as typeof fetch;
  const clock = { at: 1000 };
  const store = createMemoryStore();
  const stored = async () => (await store.entries()).map((entry) => entry.fileId).sort();
  return { fake, tokens, store, stored, reads, net, fetch: fetchFn, clock, now: () => clock.at, tokenRequests: () => tokenRequests };
}

// The Drive's answer without the header that says how long the file is.
const withoutLength = (fetchFn: typeof fetch) =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    const answer = await fetchFn(input, init);
    const headers = new Headers(answer.headers);
    headers.delete("content-length");
    return new Response(answer.body, { status: answer.status, headers });
  }) as typeof fetch;

// A store whose write of one file waits to be let through: before the store has any of it, or, with `holding`,
// when the store has all of it and has not said so yet.
function slowWrite(store: FileStore, slowId: string, holding = false) {
  const writing = gate();
  const mayFinish = gate();
  const slow: FileStore = {
    ...store,
    async write(fileId, body) {
      if (fileId !== slowId) return store.write(fileId, body);
      const blob = holding ? await store.write(fileId, body) : null;
      writing.open();
      await mayFinish.opened;
      return blob ?? store.write(fileId, body);
    },
  };
  return { store: slow, writing: writing.opened, finish: mayFinish.open };
}

// A store that writes down what kind of body each write was given.
function watching(store: FileStore) {
  const writes: [string, "blob" | "stream"][] = [];
  const watched: FileStore = {
    ...store,
    write(fileId, body) {
      writes.push([fileId, body instanceof Blob ? "blob" : "stream"]);
      return store.write(fileId, body);
    },
  };
  return { store: watched, writes };
}

describe("the files this browser keeps", () => {
  it("downloads a file once and serves it from the store after", async () => {
    const h = filesHarness({ f1: 20 * MB });
    const files = createMediaFiles({ tokens: h.tokens, store: h.store, fetch: h.fetch, now: h.now });
    const [one, two] = await Promise.all([files.get("f1"), files.get("f1")]);
    expect(one.ok && one.blob.size).toBe(20 * MB);
    expect(two.ok && two.blob.size).toBe(20 * MB);
    expect(h.reads).toEqual(["f1"]);
    const kept = await h.store.read("f1");
    expect(kept?.size).toBe(20 * MB);
    const third = await files.get("f1");
    expect(third.ok && third.blob).toBe(kept);
    expect(h.reads).toEqual(["f1"]);
    expect(h.tokenRequests()).toBe(1);
    expect(h.fake.calls.at(-1)).toMatchObject({ method: "GET", path: "/drive/v3/files/f1", scope: SCOPE_READ });
  });

  it("keeps what this browser made", async () => {
    const h = filesHarness();
    const files = createMediaFiles({ tokens: h.tokens, store: h.store, fetch: h.fetch, now: h.now });
    await files.put("made", new Blob(["a preview copy"]));
    const got = await files.get("made");
    expect(got.ok && (await got.blob.text())).toBe("a preview copy");
    expect(h.reads).toEqual([]);
    expect(h.tokenRequests()).toBe(0);
    expect(await h.store.entries()).toEqual([{ fileId: "made", bytes: 14, usedAt: 1000 }]);
  });

  it("makes room, least recently used first", async () => {
    for (const [older, newer] of [["a", "b"], ["b", "a"]]) {
      const h = filesHarness({ c: 20 * MB });
      await h.store.write("a", zeros(20 * MB));
      await h.store.write("b", zeros(20 * MB));
      await h.store.touch(older, 1);
      await h.store.touch(newer, 2);
      const files = createMediaFiles({ tokens: h.tokens, store: h.store, fetch: h.fetch, now: h.now, capBytes: 50 * MB });
      const got = await files.get("c");
      expect(got.ok && got.blob.size).toBe(20 * MB);
      expect(await h.store.read(older)).toBeNull();
      expect((await h.store.read(newer))?.size).toBe(20 * MB);
      expect(await h.stored()).toEqual([newer, "c"].sort());
    }
  });

  it("never drops a file it handed out", async () => {
    const h = filesHarness({ a: 20 * MB, b: 20 * MB, c: 20 * MB });
    const files = createMediaFiles({ tokens: h.tokens, store: h.store, fetch: h.fetch, now: h.now, capBytes: 50 * MB });
    for (const id of ["a", "b", "c"]) {
      h.clock.at += 1;
      const got = await files.get(id);
      expect(got.ok && got.blob.size, id).toBe(20 * MB);
    }
    expect(await h.stored()).toEqual(["a", "b"]);
    expect(await h.store.read("c")).toBeNull();
    // The one that was not stored is read from Drive each time it is wanted.
    const again = await files.get("c");
    expect(again.ok && again.blob.size).toBe(20 * MB);
    expect(h.reads).toEqual(["a", "b", "c", "c"]);
    expect(await h.stored()).toEqual(["a", "b"]);
    // What a page handed out binds that page only: the next one makes room as usual.
    const nextPage = createMediaFiles({ tokens: h.tokens, store: h.store, fetch: h.fetch, now: h.now, capBytes: 50 * MB });
    expect((await nextPage.get("c")).ok).toBe(true);
    expect(await h.stored()).toEqual(["b", "c"]);
  });

  it("never drops a file it handed out from the store either", async () => {
    const h = filesHarness({ c: 20 * MB });
    await h.store.write("a", zeros(20 * MB));
    await h.store.write("b", zeros(20 * MB));
    const files = createMediaFiles({ tokens: h.tokens, store: h.store, fetch: h.fetch, now: h.now, capBytes: 50 * MB });
    expect((await files.get("a")).ok).toBe(true);
    expect((await files.get("c")).ok).toBe(true);
    expect(await h.stored()).toEqual(["a", "c"]); // b went, though a was written first
    expect(h.reads).toEqual(["c"]);
  });

  it("a failed read is not remembered", async () => {
    const h = filesHarness({ f1: 20 * MB });
    const files = createMediaFiles({ tokens: h.tokens, store: h.store, fetch: h.fetch, now: h.now });
    h.fake.failNext(/GET .*alt=media/, 404);
    expect(await files.get("f1")).toEqual({ ok: false, problem: "missing" });
    expect(await h.store.entries()).toEqual([]);
    const got = await files.get("f1");
    expect(got.ok && got.blob.size).toBe(20 * MB);
    expect(h.reads).toEqual(["f1", "f1"]);
    h.fake.failNext(/GET .*alt=media/, 403);
    expect(await files.get("f2")).toEqual({ ok: false, problem: "refused" });
  });

  it("a 500 is offline and is not stored", async () => {
    const h = filesHarness({ f1: 20 * MB });
    const files = createMediaFiles({ tokens: h.tokens, store: h.store, fetch: h.fetch, now: h.now });
    h.fake.failNext(/GET .*alt=media/, 500);
    expect(await files.get("f1")).toEqual({ ok: false, problem: "offline" });
    expect(await h.store.read("f1")).toBeNull();
    const got = await files.get("f1");
    expect(got.ok && got.blob.size).toBe(20 * MB);
    expect((await h.store.read("f1"))?.size).toBe(20 * MB);
  });

  it("a download cut off part way leaves nothing in the store", async () => {
    // Once as Drive answers, with the file's length, and once without it.
    for (const headers of [{ "Content-Length": String(20 * MB) }, undefined]) {
      const h = filesHarness({ f1: 20 * MB });
      const { store, writes } = watching(h.store);
      const files = createMediaFiles({ tokens: h.tokens, store, fetch: h.fetch, now: h.now });
      h.net.fetch = (async () => new Response(cutOffBody(), { status: 200, headers })) as typeof fetch;
      expect(await files.get("f1")).toEqual({ ok: false, problem: "offline" });
      expect(await h.store.read("f1")).toBeNull();
      expect(await h.store.entries()).toEqual([]);
      expect(writes).toEqual(headers ? [["f1", "stream"]] : []);
      h.net.fetch = h.fake.fetch;
      const got = await files.get("f1");
      expect(got.ok && got.blob.size).toBe(20 * MB);
      expect((await h.store.read("f1"))?.size).toBe(20 * MB);
      expect(h.reads).toEqual(["f1", "f1"]);
    }
  });

  it("a download cut off part way holds no room afterwards", async () => {
    const h = filesHarness({ f1: 20 * MB, f2: 20 * MB });
    await h.store.write("old", zeros(20 * MB));
    const files = createMediaFiles({ tokens: h.tokens, store: h.store, fetch: h.fetch, now: h.now, capBytes: 50 * MB });
    h.net.fetch = (async () => new Response(cutOffBody(), { status: 200, headers: { "Content-Length": String(20 * MB) } })) as typeof fetch;
    expect(await files.get("f1")).toEqual({ ok: false, problem: "offline" });
    h.net.fetch = h.fake.fetch;
    expect((await files.get("f2")).ok).toBe(true);
    expect(await h.stored()).toEqual(["f2", "old"]); // 40 MB of 50: nothing had to go
    expect((await files.get("f1")).ok).toBe(true); // and the file that failed is not taken for one being written
    expect(await h.stored()).toEqual(["f1", "f2"]);
  });

  it("a file goes to the store as it arrives when Drive says how long it is, and whole when it does not", async () => {
    const h = filesHarness({ f1: 3 * MB, f2: 3 * MB });
    const { store, writes } = watching(h.store);
    const files = createMediaFiles({ tokens: h.tokens, store, fetch: h.fetch, now: h.now });
    expect((await files.get("f1")).ok).toBe(true);
    h.net.fetch = withoutLength(h.fake.fetch);
    const got = await files.get("f2");
    expect(got.ok && got.blob.size).toBe(3 * MB);
    expect(writes).toEqual([["f1", "stream"], ["f2", "blob"]]);
    expect(await h.store.entries()).toEqual([{ fileId: "f1", bytes: 3 * MB, usedAt: 1000 }, { fileId: "f2", bytes: 3 * MB, usedAt: 1000 }]);
    // An answer with no body at all is an empty file.
    h.net.fetch = (async () => new Response(null, { status: 204, headers: { "Content-Length": "0" } })) as typeof fetch;
    const empty = await files.get("f3");
    expect(empty.ok && empty.blob.size).toBe(0);
  });

  it("a file larger than the cap is returned and not stored, and nothing is dropped for it", async () => {
    for (const fetchOf of [(fetchFn: typeof fetch) => fetchFn, withoutLength]) {
      const h = filesHarness({ big: 40 * MB, exact: 30 * MB });
      await h.store.write("old", zeros(20 * MB));
      const files = createMediaFiles({ tokens: h.tokens, store: h.store, fetch: h.fetch, now: h.now, capBytes: 30 * MB });
      h.net.fetch = fetchOf(h.fake.fetch);
      const got = await files.get("big");
      expect(got.ok && got.blob.size).toBe(40 * MB);
      expect(await h.stored()).toEqual(["old"]);
      const fits = await files.get("exact"); // as large as the cap, and no larger
      expect(fits.ok && fits.blob.size).toBe(30 * MB);
      expect(await h.stored()).toEqual(["exact"]);
    }
  });

  it("a file there is no room for without dropping one in use is returned and not stored, and nothing is dropped for it", async () => {
    for (const fetchOf of [(fetchFn: typeof fetch) => fetchFn, withoutLength]) {
      const h = filesHarness({ used: 20 * MB, next: 25 * MB });
      await h.store.write("idle", zeros(10 * MB));
      const files = createMediaFiles({ tokens: h.tokens, store: h.store, fetch: h.fetch, now: h.now, capBytes: 40 * MB });
      h.net.fetch = fetchOf(h.fake.fetch);
      expect((await files.get("used")).ok).toBe(true);
      const got = await files.get("next"); // dropping "idle" would leave 20 + 25 MB
      expect(got.ok && got.blob.size).toBe(25 * MB);
      expect(await h.stored()).toEqual(["idle", "used"]);
    }
  });

  it("a file served from the store counts as used then", async () => {
    const h = filesHarness({ c: 20 * MB });
    await h.store.write("a", zeros(20 * MB));
    await h.store.write("b", zeros(20 * MB));
    await h.store.touch("a", 1);
    await h.store.touch("b", 2);
    h.clock.at = 5;
    const got = await createMediaFiles({ tokens: h.tokens, store: h.store, fetch: h.fetch, now: h.now, capBytes: 50 * MB }).get("a");
    expect(got.ok && got.blob.size).toBe(20 * MB);
    expect(await h.store.entries()).toEqual([{ fileId: "a", bytes: 20 * MB, usedAt: 5 }, { fileId: "b", bytes: 20 * MB, usedAt: 2 }]);
    // On the next page it is b that goes.
    h.clock.at = 6;
    expect((await createMediaFiles({ tokens: h.tokens, store: h.store, fetch: h.fetch, now: h.now, capBytes: 50 * MB }).get("c")).ok).toBe(true);
    expect(await h.store.entries()).toEqual([{ fileId: "a", bytes: 20 * MB, usedAt: 5 }, { fileId: "c", bytes: 20 * MB, usedAt: 6 }]);
  });

  it("keeps up to the limit in LIMITS, and goes by the clock and the fetch of the page, when it is given none", async () => {
    const h = filesHarness({ f1: 20 * MB, f2: 20 * MB });
    // A store that says it already holds one large file.
    const holding = (bytes: number): FileStore => ({ ...h.store, entries: async () => [{ fileId: "large", bytes, usedAt: 1 }, ...(await h.store.entries())] });
    const removed: string[] = [];
    const noting = (store: FileStore): FileStore => ({ ...store, remove: async (fileId) => void removed.push(fileId) });
    vi.stubGlobal("fetch", h.fetch);
    const before = Date.now();
    expect((await createMediaFiles({ tokens: h.tokens, store: noting(holding(LIMITS.mediaCacheBytes - 20 * MB)) }).get("f1")).ok).toBe(true);
    expect(removed).toEqual([]); // it fits exactly
    expect((await createMediaFiles({ tokens: h.tokens, store: noting(holding(LIMITS.mediaCacheBytes - 40 * MB + 1)) }).get("f2")).ok).toBe(true);
    expect(removed).toEqual(["large"]); // one byte too many
    expect(h.reads).toEqual(["f1", "f2"]);
    for (const entry of await h.store.entries()) {
      expect(entry.usedAt).toBeGreaterThanOrEqual(before);
      expect(entry.usedAt).toBeLessThanOrEqual(Date.now());
    }
  });

  it("two files arriving at once do not overfill the store", async () => {
    const h = filesHarness({ b: 20 * MB, c: 20 * MB });
    await h.store.write("old", zeros(20 * MB));
    const files = createMediaFiles({ tokens: h.tokens, store: h.store, fetch: h.fetch, now: h.now, capBytes: 50 * MB });
    const got = await Promise.all([files.get("b"), files.get("c")]);
    expect(got.map((one) => one.ok && one.blob.size)).toEqual([20 * MB, 20 * MB]);
    expect(await h.stored()).toEqual(["b", "c"]);
  });

  it("three files arriving at once: the store takes the two it has room for", async () => {
    const h = filesHarness({ b: 20 * MB, c: 20 * MB, d: 20 * MB });
    const files = createMediaFiles({ tokens: h.tokens, store: h.store, fetch: h.fetch, now: h.now, capBytes: 50 * MB });
    const got = await Promise.all([files.get("b"), files.get("c"), files.get("d")]);
    expect(got.map((one) => one.ok && one.blob.size)).toEqual([20 * MB, 20 * MB, 20 * MB]);
    expect(await h.stored()).toHaveLength(2); // the third was handed out and not stored
    expect(h.reads.sort()).toEqual(["b", "c", "d"]);
  });

  it("room is held for a file that is on its way, and it is not written twice", async () => {
    const h = filesHarness({ b: 20 * MB, c: 20 * MB });
    await h.store.write("old", zeros(20 * MB));
    const slow = slowWrite(h.store, "b");
    const { store, writes } = watching(slow.store);
    const files = createMediaFiles({ tokens: h.tokens, store, fetch: h.fetch, now: h.now, capBytes: 50 * MB });
    const b = files.get("b");
    await slow.writing;
    expect(await h.stored()).toEqual(["old"]); // nothing of b is in the store yet
    const c = await files.get("c");
    expect(c.ok && c.blob.size).toBe(20 * MB);
    expect(await h.stored()).toEqual(["c"]); // beside b there is no room for the old file
    await files.put("b", new Blob(["made here meanwhile"]));
    const same = files.get("b");
    slow.finish();
    const [gotB, gotSame] = await Promise.all([b, same]);
    expect(gotB.ok && gotB.blob.size).toBe(20 * MB);
    expect(gotSame).toBe(gotB);
    expect(await h.stored()).toEqual(["b", "c"]);
    expect((await h.store.read("b"))?.size).toBe(20 * MB);
    expect(writes).toEqual([["b", "stream"], ["c", "stream"]]);
    expect(h.reads).toEqual(["b", "c"]);
  });

  it("a file that is still being written is not dropped for another one", async () => {
    const h = filesHarness({ b: 20 * MB, c: 20 * MB, d: 30 * MB });
    const slow = slowWrite(h.store, "b", true);
    const files = createMediaFiles({ tokens: h.tokens, store: slow.store, fetch: h.fetch, now: h.now, capBytes: 50 * MB });
    const b = files.get("b");
    await slow.writing;
    const c = await files.get("c");
    expect(c.ok && c.blob.size).toBe(20 * MB);
    expect(await h.stored()).toEqual(["b"]);
    slow.finish();
    const gotB = await b;
    expect(gotB.ok && gotB.blob).toBe(await h.store.read("b"));
    // Once b is in, its room is counted once: a file of 30 MB fits beside it.
    expect((await files.get("d")).ok).toBe(true);
    expect(await h.stored()).toEqual(["b", "d"]);
  });

  it("a file being dropped is read from Drive again, not handed out from the store", async () => {
    const h = filesHarness({ x: 20 * MB, y: 20 * MB });
    await h.store.write("x", zeros(20 * MB));
    const dropping = gate();
    const mayDrop = gate();
    const slow: FileStore = {
      ...h.store,
      async remove(fileId) {
        dropping.open();
        await mayDrop.opened;
        return h.store.remove(fileId);
      },
    };
    const files = createMediaFiles({ tokens: h.tokens, store: slow, fetch: h.fetch, now: h.now, capBytes: 30 * MB });
    const y = files.get("y");
    await dropping.opened; // room is being made for y: x is on its way out
    const x = files.get("x");
    await new Promise((resolve) => setTimeout(resolve, 20));
    mayDrop.open();
    const [gotY, gotX] = await Promise.all([y, x]);
    expect(gotY.ok && gotY.blob.size).toBe(20 * MB);
    expect(gotX.ok && gotX.blob.size).toBe(20 * MB);
    expect(h.reads).toEqual(["y", "x"]);
    expect(await h.stored()).toEqual(["y"]);
  });

  it("what this browser made takes room like any other file, and is left out when there is none", async () => {
    const h = filesHarness({ used: 20 * MB });
    await h.store.write("a", zeros(20 * MB));
    await h.store.write("b", zeros(20 * MB));
    await h.store.touch("a", 2);
    await h.store.touch("b", 1);
    const files = createMediaFiles({ tokens: h.tokens, store: h.store, fetch: h.fetch, now: h.now, capBytes: 50 * MB });
    await files.put("made", zeros(20 * MB));
    expect(await h.stored()).toEqual(["a", "made"]);
    expect((await h.store.entries()).find((entry) => entry.fileId === "made")).toEqual({ fileId: "made", bytes: 20 * MB, usedAt: 1000 });
    // It was not handed out, so it can go again: here for a file that is read.
    expect((await files.get("a")).ok).toBe(true);
    expect((await files.get("used")).ok).toBe(true);
    expect(await h.stored()).toEqual(["a", "used"]);
    // Both are in use now, and there is no room for a third.
    await files.put("more", zeros(20 * MB));
    await files.put("huge", zeros(60 * MB));
    expect(await h.stored()).toEqual(["a", "used"]);
    expect(h.reads).toEqual(["used"]);
  });

  it("does not write a file the store already has again", async () => {
    const h = filesHarness();
    const { store, writes } = watching(h.store);
    const files = createMediaFiles({ tokens: h.tokens, store, fetch: h.fetch, now: h.now });
    await files.put("made", new Blob(["first"]));
    const got = await files.get("made");
    await files.put("made", new Blob(["again"])); // the copy that was handed out is left as it is
    expect(got.ok && (await got.blob.text())).toBe("first");
    expect(await (await h.store.read("made"))!.text()).toBe("first");
    expect(writes).toEqual([["made", "blob"]]);
  });

  it("a store that fails does not stop a file from being read, or what the browser made from being used", async () => {
    const h = filesHarness({ f1: 3 * MB });
    const broken = async (): Promise<never> => {
      throw new Error("The store is broken.");
    };
    // Each store, and how often Drive is read for the two files below. A store that lists and reads but cannot
    // write is what a full disk looks like: the bytes it was being given as they arrived are read once more.
    const rows: [string, FileStore, number][] = [
      ["read", { ...h.store, read: broken }, 2],
      ["entries", { ...h.store, entries: broken }, 2],
      ["write", { ...h.store, write: broken }, 3],
      ["touch", { ...h.store, touch: broken }, 2],
      ["all of it", { ...h.store, read: broken, entries: broken, write: broken, remove: broken, touch: broken }, 2],
    ];
    for (const [what, store, driveReads] of rows) {
      h.reads.length = 0;
      // Once as Drive answers, with the file's length, and once without it.
      for (const net of [h.fake.fetch, withoutLength(h.fake.fetch)]) {
        h.net.fetch = net;
        const files = createMediaFiles({ tokens: h.tokens, store, fetch: h.fetch, now: h.now });
        const got = await files.get("f1");
        expect(got.ok && got.blob.size, what).toBe(3 * MB);
        await expect(files.put("made", new Blob(["x"])), what).resolves.toBeUndefined();
        await h.store.remove("f1");
        await h.store.remove("made");
      }
      expect(h.reads, what).toHaveLength(driveReads);
    }
  });

  it("a store that cannot take a file as it arrives is left out: the file is read once more, and no file is offered to it again", async () => {
    const h = filesHarness({ f1: 3 * MB, f2: 3 * MB, f3: 3 * MB });
    await h.store.write("kept", zeros(MB));
    const offered: string[] = [];
    const full: FileStore = {
      ...h.store,
      async write(fileId) {
        offered.push(fileId);
        throw new DOMException("The disk is full.", "QuotaExceededError");
      },
    };
    const files = createMediaFiles({ tokens: h.tokens, store: full, fetch: h.fetch, now: h.now });
    const first = await files.get("f1");
    expect(first.ok && first.blob.size).toBe(3 * MB);
    expect(h.reads).toEqual(["f1", "f1"]); // once into the store, which lost it, and once more without the store
    // From here on a file is read once, and the store is not asked to take it, whichever way it comes.
    const second = await files.get("f2");
    expect(second.ok && second.blob.size).toBe(3 * MB);
    h.net.fetch = withoutLength(h.fake.fetch);
    const third = await files.get("f3");
    expect(third.ok && third.blob.size).toBe(3 * MB);
    await files.put("made", new Blob(["x"]));
    expect(h.reads).toEqual(["f1", "f1", "f2", "f3"]);
    expect(offered).toEqual(["f1"]);
    // What the store already holds is still served from it.
    const kept = await files.get("kept");
    expect(kept.ok && kept.blob).toBe(await h.store.read("kept"));
    expect(h.reads).toHaveLength(4);
    expect(await h.stored()).toEqual(["kept"]);
    // That is this page's doing only: the next page tries the store again.
    h.net.fetch = h.fake.fetch;
    expect((await createMediaFiles({ tokens: h.tokens, store: h.store, fetch: h.fetch, now: h.now }).get("f1")).ok).toBe(true);
    expect(await h.stored()).toEqual(["f1", "kept"]);
  });

  it("a store that cannot take a whole file does not lose it: the bytes are here already", async () => {
    const h = filesHarness({ f1: 3 * MB, f2: 3 * MB });
    const offered: string[] = [];
    const full: FileStore = {
      ...h.store,
      async write(fileId) {
        offered.push(fileId);
        throw new DOMException("The disk is full.", "QuotaExceededError");
      },
    };
    h.net.fetch = withoutLength(h.fake.fetch);
    const files = createMediaFiles({ tokens: h.tokens, store: full, fetch: h.fetch, now: h.now, capBytes: 5 * MB });
    for (const id of ["f1", "f2", "f1"]) {
      const got = await files.get(id);
      expect(got.ok && got.blob.size, id).toBe(3 * MB);
    }
    expect(h.reads).toEqual(["f1", "f2", "f1"]); // never twice for one get
    // A write that failed holds no room afterwards: there was room to offer each file.
    expect(offered).toEqual(["f1", "f2", "f1"]);
  });

  it("when the store loses a file and Drive cannot give it again, the read says what Drive said", async () => {
    const answers: [() => Response, { ok: false; problem: string }][] = [
      [() => new Response("gone", { status: 404 }), { ok: false, problem: "missing" }],
      [() => new Response("no", { status: 403 }), { ok: false, problem: "refused" }],
      [() => new Response("later", { status: 503 }), { ok: false, problem: "offline" }],
      [() => new Response(cutOffBody(), { status: 200, headers: { "Content-Length": String(3 * MB) } }), { ok: false, problem: "offline" }],
    ];
    for (const [secondAnswer, problem] of answers) {
      const h = filesHarness({ f1: 3 * MB });
      const files = createMediaFiles({ tokens: h.tokens, store: { ...h.store, write: () => Promise.reject(new Error("The store is broken.")) }, fetch: h.fetch, now: h.now });
      h.net.fetch = ((input: RequestInfo | URL, init?: RequestInit) => (h.reads.length === 2 ? Promise.resolve(secondAnswer()) : h.fake.fetch(input, init))) as typeof fetch;
      expect(await files.get("f1")).toEqual(problem);
      expect(h.reads).toEqual(["f1", "f1"]);
      // Not remembered, and the store stays out of it: the next read is one read.
      const got = await files.get("f1");
      expect(got.ok && got.blob.size).toBe(3 * MB);
      expect(h.reads).toEqual(["f1", "f1", "f1"]);
    }
  });

  it("a store that gives up on a file as it arrives stops that download", async () => {
    const h = filesHarness({ f1: 3 * MB });
    const stopped: unknown[] = [];
    const endless = new ReadableStream<Uint8Array>({ pull: (controller) => controller.enqueue(new Uint8Array(MB)), cancel: (reason) => void stopped.push(reason) });
    const store: FileStore = {
      ...h.store,
      async write(_fileId, body) {
        if (!(body instanceof Blob)) await body.cancel("no room");
        throw new Error("The store is broken.");
      },
    };
    const files = createMediaFiles({ tokens: h.tokens, store, fetch: h.fetch, now: h.now });
    h.net.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      h.reads.length === 1 ? Promise.resolve(new Response(endless, { status: 200, headers: { "Content-Length": String(3 * MB) } })) : h.fake.fetch(input, init)) as typeof fetch;
    const got = await files.get("f1");
    expect(got.ok && got.blob.size).toBe(3 * MB);
    expect(stopped).toEqual(["no room"]);
    expect(h.reads).toEqual(["f1", "f1"]);
  });

  it("a store that cannot say when a file was used still hands it out, and keeps it", async () => {
    // Once as Drive answers, with the file's length, and once without it.
    for (const fetchOf of [(fetchFn: typeof fetch) => fetchFn, withoutLength]) {
      const h = filesHarness({ f1: 3 * MB });
      let touches = 0;
      const store: FileStore = {
        ...h.store,
        async touch() {
          touches += 1;
          throw new Error("The store is broken.");
        },
      };
      h.net.fetch = fetchOf(h.fake.fetch);
      const files = createMediaFiles({ tokens: h.tokens, store, fetch: h.fetch, now: h.now, capBytes: 4 * MB });
      const first = await files.get("f1");
      expect(first.ok && first.blob.size).toBe(3 * MB);
      const kept = await h.store.read("f1");
      expect(kept?.size).toBe(3 * MB);
      // The stored file is served from the store from then on: Drive was read once.
      for (let n = 0; n < 2; n += 1) {
        const again = await files.get("f1");
        expect(again.ok && again.blob).toBe(kept);
      }
      expect(h.reads).toEqual(["f1"]);
      expect(touches).toBe(3);
      // And it counts as handed out, whether it came from Drive or from the store: nothing drops it.
      await files.put("other", zeros(2 * MB));
      expect(await h.stored()).toEqual(["f1"]);
      const nextPage = createMediaFiles({ tokens: h.tokens, store, fetch: h.fetch, now: h.now, capBytes: 4 * MB });
      expect((await nextPage.get("f1")).ok).toBe(true);
      await nextPage.put("other", zeros(2 * MB));
      expect(await h.stored()).toEqual(["f1"]);
      expect(h.reads).toEqual(["f1"]);
    }
  });

  it("a store whose touch throws at once, instead of rejecting, is no different", async () => {
    const h = filesHarness({ f1: 3 * MB });
    const store = {
      ...h.store,
      touch() {
        throw new Error("The store is broken.");
      },
    } as FileStore;
    const files = createMediaFiles({ tokens: h.tokens, store, fetch: h.fetch, now: h.now });
    expect((await files.get("f1")).ok).toBe(true);
    expect((await files.get("f1")).ok).toBe(true);
    expect(h.reads).toEqual(["f1"]);
  });
});
