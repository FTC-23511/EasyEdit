import { describe, expect, it, vi } from "vitest";
import { openUpload, uploadOffset } from "@/lib/media/service";
import { PieceError, PIECE_RETRY_DELAYS_MS, contentRange, createDriveTransport, sendFile, type SendDeps, type UploadTransport } from "@/lib/media/uploader";
import { VIDEO, mediaContext } from "./context";

const MiB = 1024 * 1024;
const SIZE = 20_000_000;
const file = () => new Blob([new Uint8Array(SIZE)]);

async function setup(over: Partial<SendDeps> = {}) {
  const ctx = await mediaContext();
  const opened = await openUpload(ctx.deps, ctx.ada, VIDEO);
  const sleeps: number[] = [];
  const progress: number[] = [];
  const deps: SendDeps = {
    transport: createDriveTransport(ctx.fake.fetch),
    askOffset: async () => uploadOffset(ctx.deps, ctx.ada, opened.asset.id),
    sleep: async (ms) => void sleeps.push(ms),
    chunkBytes: 8 * MiB,
    signal: new AbortController().signal,
    onProgress: (sent) => void progress.push(sent),
    ...over,
  };
  const pieces = () => ctx.fake.calls.filter((c) => c.method === "PUT" && c.path.startsWith("/upload/"));
  return { ctx, opened, deps, sleeps, progress, pieces };
}

describe("sending a file to Drive in pieces", () => {
  it("writes the range header Drive expects", () => {
    expect(contentRange(0, 8 * MiB, SIZE)).toBe("bytes 0-8388607/20000000");
    expect(contentRange(16 * MiB, SIZE, SIZE)).toBe("bytes 16777216-19999999/20000000");
  });

  it("sends 8 MiB pieces in order and reports progress after each", async () => {
    const { ctx, opened, deps, progress, sleeps } = await setup();
    const result = await sendFile(file(), opened, deps);
    expect(result.ok).toBe(true);
    expect(progress).toEqual([8 * MiB, 16 * MiB, SIZE]);
    expect(sleeps).toEqual([]);
    expect(ctx.fake.sessions.get(opened.uploadUrl)!.received).toBe(SIZE);
    expect(ctx.fake.calls.filter((c) => c.path.startsWith("/upload/") && c.scope !== null)).toHaveLength(1); // only the server's opening call carried a token
  });

  it("goes on from the offset the server reports after a dropped piece", async () => {
    const { ctx, opened, deps, progress, sleeps, pieces } = await setup();
    let sent = 0;
    const flaky: UploadTransport = {
      sendPiece: async (input) => {
        if (++sent === 2) ctx.fake.dropNextPieceAfter(3 * MiB); // the second piece dies after 3 MiB reached Drive
        return deps.transport.sendPiece(input);
      },
    };
    const result = await sendFile(file(), opened, { ...deps, transport: flaky });
    expect(result.ok).toBe(true);
    expect(sleeps).toEqual([1000]);
    expect(progress).toEqual([8 * MiB, 19 * MiB, SIZE]); // resumed at 11 MiB, not at 8 and not at 0
    expect(ctx.fake.sessions.get(opened.uploadUrl)!.received).toBe(SIZE);
    expect(pieces()).toHaveLength(5); // three pieces, the dropped one, and the server's one offset question
  });

  it("starts in the middle when the upload was begun earlier", async () => {
    const { ctx, opened, deps, progress } = await setup();
    await ctx.fake.fetch(opened.uploadUrl, { method: "PUT", headers: { "Content-Range": contentRange(0, 8 * MiB, SIZE) }, body: new Uint8Array(8 * MiB) });
    const again = await openUpload(ctx.deps, ctx.ada, VIDEO);
    expect(again.offset).toBe(8 * MiB);
    expect((await sendFile(file(), again, deps)).ok).toBe(true);
    expect(progress).toEqual([16 * MiB, SIZE]);
  });

  it("an upload that is already whole asks once and sends nothing", async () => {
    const { opened, deps, pieces } = await setup();
    let asked = 0;
    const askOffset = async () => { asked += 1; return { offset: SIZE, done: true }; };
    expect(await sendFile(file(), { uploadUrl: opened.uploadUrl, offset: SIZE }, { ...deps, askOffset })).toEqual({ ok: true });
    expect(asked).toBe(1);
    expect(pieces()).toHaveLength(0);
  });

  it("gives up after five waits without progress", async () => {
    const down: UploadTransport = { sendPiece: async () => { throw new PieceError("network"); } };
    const { opened, deps, sleeps } = await setup({ transport: down, askOffset: async () => null });
    expect(await sendFile(file(), opened, deps)).toEqual({ ok: false, reason: "gave-up" });
    expect(sleeps).toEqual([...PIECE_RETRY_DELAYS_MS]);
  });

  it("stops at once when the session has expired, and when Drive refuses", async () => {
    const { ctx, opened, deps, sleeps } = await setup();
    ctx.fake.failNext(/^PUT \/upload\//, 499);
    expect(await sendFile(file(), opened, deps)).toEqual({ ok: false, reason: "expired" });
    ctx.fake.expireSessions();
    expect(await sendFile(file(), opened, deps)).toEqual({ ok: false, reason: "expired" });
    const refusing: UploadTransport = { sendPiece: async () => { throw new PieceError("refused"); } };
    expect(await sendFile(file(), opened, { ...deps, transport: refusing })).toEqual({ ok: false, reason: "refused" });
    expect(sleeps).toEqual([]);
  });

  it("stops when it is canceled, and sends nothing more", async () => {
    const abort = new AbortController();
    const { opened, deps, pieces } = await setup({ signal: abort.signal });
    const result = await sendFile(file(), opened, { ...deps, onProgress: () => abort.abort() });
    expect(result).toEqual({ ok: false, reason: "canceled" });
    expect(pieces()).toHaveLength(1);
  });

  it("does not need to read Drive's headers or body", async () => {
    // A browser that may read only the status: 308 with no Range header, then 200 with a body it cannot read.
    const statuses = [308, 308, 200];
    const blind = (async () => new Response(null, { status: statuses.shift()! })) as unknown as typeof fetch;
    const { opened, deps, progress } = await setup({ transport: createDriveTransport(blind) });
    expect(await sendFile(file(), opened, deps)).toEqual({ ok: true });
    expect(progress).toEqual([8 * MiB, 16 * MiB, SIZE]);
  });
});

describe("one piece, straight to Drive", () => {
  const SESSION = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=abc";
  const part = new Blob([new Uint8Array(1024)]);
  const input = (signal = new AbortController().signal) => ({ uploadUrl: SESSION, piece: part, start: 4096, total: 9000, signal });
  const answering = (status: number, headers?: Record<string, string>) => (async () => new Response(null, { status, headers })) as unknown as typeof fetch;
  const failure = (sending: Promise<unknown>) => sending.then(() => { throw new Error("The piece got through."); }, (error: unknown) => error);

  it("is one PUT with the range of the piece and no other header", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 308 }));
    const signal = new AbortController().signal;
    await createDriveTransport(fetchFn).sendPiece(input(signal));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(SESSION);
    expect(Object.keys(init!).sort()).toEqual(["body", "headers", "method", "signal"]); // no credentials, no token, nothing else
    expect(init!.method).toBe("PUT");
    expect([...new Headers(init!.headers)]).toEqual([["content-range", "bytes 4096-5119/9000"]]);
    expect(init!.body).toBe(part);
    expect(init!.signal).toBe(signal);
  });

  it("reads how far Drive has come from the Range header, and counts the piece when it cannot read one", async () => {
    const next = (headers?: Record<string, string>) => createDriveTransport(answering(308, headers)).sendPiece(input());
    expect(await next({ Range: "bytes=0-5119" })).toEqual({ state: "more", next: 5120 });
    expect(await next({ Range: "bytes=0-4607" })).toEqual({ state: "more", next: 4608 }); // Drive kept less than was sent
    expect(await next({ Range: "bytes=0-0" })).toEqual({ state: "more", next: 1 });
    expect(await next()).toEqual({ state: "more", next: 5120 });
    expect(await next({ Range: "" })).toEqual({ state: "more", next: 5120 });
  });

  it.each([200, 201])("%i means Drive holds the whole file", async (status) => {
    expect(await createDriveTransport(answering(status)).sendPiece(input())).toEqual({ state: "done" });
  });

  it.each([
    [404, "expired"], [410, "expired"], [499, "expired"],
    [429, "server"], [500, "server"], [502, "server"], [503, "server"], [504, "server"], [599, "server"],
    [202, "refused"], [204, "refused"], [301, "refused"], [400, "refused"], [401, "refused"], [403, "refused"], [409, "refused"], [416, "refused"], [428, "refused"], [430, "refused"], [498, "refused"],
  ])("%i is a piece that failed as %s", async (status, kind) => {
    const error = await failure(createDriveTransport(answering(status)).sendPiece(input()));
    expect(error).toBeInstanceOf(PieceError);
    expect(error).toMatchObject({ name: "PieceError", kind });
  });

  it("a fetch that fails is a network failure, and the error holds nothing of the request", async () => {
    const failing = (async () => { throw new TypeError(`fetch failed: PUT ${SESSION}`); }) as unknown as typeof fetch;
    const throwing = (() => { throw new TypeError(`fetch failed: PUT ${SESSION}`); }) as unknown as typeof fetch; // not even a promise
    for (const fetchFn of [failing, throwing]) {
      const error = await failure(createDriveTransport(fetchFn).sendPiece(input()));
      expect(error).toBeInstanceOf(PieceError);
      expect(error).toMatchObject({ kind: "network", message: "The piece was not sent (network)." });
      expect(Object.keys(error as object)).toEqual(["name", "kind"]);
      expect((error as Error).cause).toBeUndefined();
      expect(String((error as Error).stack)).not.toContain("upload_id");
    }
  });

  it("uses the page's own fetch when it is given none", async () => {
    const pages = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", pages);
    try {
      expect(await createDriveTransport().sendPiece(input())).toEqual({ state: "done" });
      expect(pages).toHaveBeenCalledTimes(1);
      expect(pages.mock.calls[0][0]).toBe(SESSION);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("an abort is passed on as it is", async () => {
    const abort = new AbortController();
    const whileSending = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      abort.abort();
      throw init!.signal!.reason;
    }) as typeof fetch;
    const error = await failure(createDriveTransport(whileSending).sendPiece(input(abort.signal)));
    expect(error).toBe(abort.signal.reason);
    expect(error).toMatchObject({ name: "AbortError" });
    // Whatever fetch threw once the piece was canceled is not called a network failure.
    const broken = new TypeError("terminated");
    expect(await failure(createDriveTransport((async () => { throw broken; }) as unknown as typeof fetch).sendPiece(input(abort.signal)))).toBe(broken);
  });
});

// A pretend storage for a file of ten bytes sent four at a time. It keeps a piece that starts where it is, and each
// entry of `script` says how the next piece goes instead: it fails as that kind and nothing is kept, only `keep`
// bytes of it are kept, or it is kept whole and the answer is `lost` on its way back.
type Step = PieceError["kind"] | { keep: number } | "lost";

function pretend(script: Step[] = [], over: Partial<SendDeps> = {}) {
  const bytes = new Blob([new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])]);
  const total = bytes.size;
  const state = { held: 0, log: [] as string[], progress: [] as number[] };
  const transport: UploadTransport = {
    sendPiece: async ({ piece, start }) => {
      state.log.push(`piece ${start}+${piece.size}`);
      const step = script.shift();
      if (typeof step === "string" && step !== "lost") throw new PieceError(step);
      if (start === state.held) state.held += typeof step === "object" ? step.keep : piece.size;
      if (step === "lost") throw new PieceError("network");
      return state.held === total ? { state: "done" } : { state: "more", next: state.held };
    },
  };
  const deps: SendDeps = {
    transport,
    askOffset: async () => {
      state.log.push("ask");
      return { offset: state.held, done: state.held === total };
    },
    sleep: async (ms) => void state.log.push(`wait ${ms}`),
    chunkBytes: 4,
    signal: new AbortController().signal,
    onProgress: (sent) => void state.progress.push(sent),
    ...over,
  };
  const send = (offset = 0) => sendFile(bytes, { uploadUrl: "https://session.test/upload", offset }, deps);
  return { state, deps, bytes, total, send };
}

describe("sending a file, rule by rule", () => {
  it("hands the transport the file's own bytes, the last piece shorter", async () => {
    const seen: { uploadUrl: string; start: number; total: number; bytes: number[]; type: string; signal: AbortSignal }[] = [];
    const signal = new AbortController().signal;
    const { deps, send, state } = pretend([], { signal });
    const storage = deps.transport;
    deps.transport = {
      sendPiece: async (input) => {
        seen.push({ uploadUrl: input.uploadUrl, start: input.start, total: input.total, bytes: [...new Uint8Array(await input.piece.arrayBuffer())], type: input.piece.type, signal: input.signal });
        return storage.sendPiece(input);
      },
    };
    expect(await send()).toEqual({ ok: true });
    const each = { uploadUrl: "https://session.test/upload", total: 10, type: "", signal };
    expect(seen).toEqual([{ ...each, start: 0, bytes: [0, 1, 2, 3] }, { ...each, start: 4, bytes: [4, 5, 6, 7] }, { ...each, start: 8, bytes: [8, 9] }]);
    expect(seen.every((piece) => piece.signal === signal)).toBe(true);
    expect(state.progress).toEqual([4, 8, 10]);
  });

  it("starts at the offset the upload was opened with", async () => {
    const { state, send } = pretend();
    state.held = 6;
    expect(await send(6)).toEqual({ ok: true });
    expect(state.log).toEqual(["piece 6+4"]);
    expect(state.progress).toEqual([10]);
  });

  it("goes on from where storage says it is, not from where the piece ended", async () => {
    const { state, send } = pretend([{ keep: 3 }]);
    expect(await send()).toEqual({ ok: true });
    expect(state.log).toEqual(["piece 0+4", "piece 3+4", "piece 7+3"]); // byte 3 was sent again, not skipped
    expect(state.progress).toEqual([3, 7, 10]);
  });

  it("goes back when storage holds less than the page thought", async () => {
    const { state, send } = pretend();
    state.held = 2;
    expect(await send(4)).toEqual({ ok: true });
    expect(state.log).toEqual(["piece 4+4", "piece 2+4", "piece 6+4"]); // the first piece was out of place, and storage said where it is
    expect(state.progress).toEqual([2, 6, 10]);
    // And after a failure the server's offset is taken, also when it is behind the page's own.
    const failing = pretend(["network"]);
    failing.state.held = 2;
    expect(await failing.send(4)).toEqual({ ok: true });
    expect(failing.state.log).toEqual(["piece 4+4", "wait 1000", "ask", "piece 2+4", "piece 6+4"]);
    expect(failing.state.progress).toEqual([6, 10]);
  });

  it("a piece that storage took nothing of is a failure, not something to send again at once", async () => {
    const once = pretend([{ keep: 0 }]);
    expect(await once.send()).toEqual({ ok: true });
    expect(once.state.log).toEqual(["piece 0+4", "wait 1000", "ask", "piece 0+4", "piece 4+4", "piece 8+2"]);
    expect(once.state.progress).toEqual([4, 8, 10]);
    const never = pretend([{ keep: 4 }, ...Array.from({ length: 6 }, () => ({ keep: 0 }))]);
    expect(await never.send()).toEqual({ ok: false, reason: "gave-up" });
    expect(never.state.log.filter((entry) => entry.startsWith("wait"))).toEqual(["wait 1000", "wait 2000", "wait 4000", "wait 8000", "wait 16000"]);
    expect(never.state.log.filter((entry) => entry.startsWith("piece"))).toEqual(["piece 0+4", ...Array.from({ length: 6 }, () => "piece 4+4")]);
    expect(never.state.progress).toEqual([4]);
  });

  it("waits longer after each failure in a row, and starts over once a piece gets through", async () => {
    const { state, send } = pretend(["network", "server", { keep: 4 }, "network"]);
    expect(await send()).toEqual({ ok: true });
    expect(state.log).toEqual([
      "piece 0+4", "wait 1000", "ask", "piece 0+4", "wait 2000", "ask", "piece 0+4", // got through
      "piece 4+4", "wait 1000", "ask", "piece 4+4", "piece 8+2",
    ]);
    expect(state.progress).toEqual([4, 8, 10]); // an answer from the server is not progress
  });

  it("goes on from the offset the server gives after a failure, not from its own count", async () => {
    // The first piece failed as far as the page can tell, yet two of its bytes reached storage.
    const { state, deps, send } = pretend(["network"]);
    const ask = deps.askOffset;
    let unknown = true;
    deps.askOffset = async () => {
      if (unknown) state.held = 2;
      unknown = false;
      return ask();
    };
    expect(await send()).toEqual({ ok: true });
    expect(state.log).toEqual(["piece 0+4", "wait 1000", "ask", "piece 2+4", "piece 6+4"]);
    expect(state.progress).toEqual([6, 10]);
  });

  it("a server that cannot be asked counts as another failure, and no piece is sent until it answers", async () => {
    let unanswered = 2;
    const { state, deps, send } = pretend(["server"]);
    const ask = deps.askOffset;
    deps.askOffset = async () => (unanswered-- > 0 ? (state.log.push("ask: no answer"), null) : ask());
    expect(await send()).toEqual({ ok: true });
    expect(state.log).toEqual(["piece 0+4", "wait 1000", "ask: no answer", "wait 2000", "ask: no answer", "wait 4000", "ask", "piece 0+4", "piece 4+4", "piece 8+2"]);
  });

  it("gives up after the fifth wait, also when the server answers every time", async () => {
    const { state, send } = pretend(["server", "network", "server", "network", "server", "network", "server"]);
    expect(await send()).toEqual({ ok: false, reason: "gave-up" });
    const again = ["ask", "piece 0+4"];
    expect(state.log).toEqual(["piece 0+4", "wait 1000", ...again, "wait 2000", ...again, "wait 4000", ...again, "wait 8000", ...again, "wait 16000", ...again]);
    expect(state.progress).toEqual([]);
    // One failure fewer and it gets there.
    const fifth = pretend(["server", "network", "server", "network", "server"]);
    expect(await fifth.send()).toEqual({ ok: true });
    expect(fifth.state.log.filter((entry) => entry.startsWith("wait"))).toEqual(["wait 1000", "wait 2000", "wait 4000", "wait 8000", "wait 16000"]);
  });

  it("finds out by asking that the last piece arrived when its answer was lost", async () => {
    const { state, send } = pretend([{ keep: 4 }, { keep: 4 }, "lost"]);
    expect(await send()).toEqual({ ok: true });
    expect(state.log).toEqual(["piece 0+4", "piece 4+4", "piece 8+2", "wait 1000", "ask"]); // nothing is sent twice
  });

  it.each(["expired", "refused"] as const)("%s ends at once: no wait, no question, no further piece", async (kind) => {
    const first = pretend([kind]);
    expect(await first.send()).toEqual({ ok: false, reason: kind });
    expect(first.state.log).toEqual(["piece 0+4"]);
    const later = pretend([{ keep: 4 }, "network", kind]);
    expect(await later.send()).toEqual({ ok: false, reason: kind });
    expect(later.state.log).toEqual(["piece 0+4", "piece 4+4", "wait 1000", "ask", "piece 4+4"]);
    expect(later.state.progress).toEqual([4]);
  });

  it("canceled before it starts: nothing is sent or asked", async () => {
    const abort = new AbortController();
    abort.abort();
    const { state, send } = pretend([], { signal: abort.signal });
    expect(await send()).toEqual({ ok: false, reason: "canceled" });
    expect(await send(10)).toEqual({ ok: false, reason: "canceled" });
    expect(state.log).toEqual([]);
  });

  it("canceled while a piece is on its way: no wait and no question follow", async () => {
    const abort = new AbortController();
    const { state, deps, send } = pretend([], { signal: abort.signal });
    deps.transport = {
      sendPiece: async ({ start, signal }) => {
        state.log.push(`piece ${start}`);
        abort.abort();
        throw signal.reason;
      },
    };
    expect(await send()).toEqual({ ok: false, reason: "canceled" });
    expect(state.log).toEqual(["piece 0"]);

    // Also when what the transport threw then was its own kind of failure.
    const other = new AbortController();
    const second = pretend([], { signal: other.signal });
    second.deps.transport = {
      sendPiece: async () => {
        other.abort();
        throw new PieceError("network");
      },
    };
    expect(await second.send()).toEqual({ ok: false, reason: "canceled" });
    expect(second.state.log).toEqual([]);
  });

  it("canceled during a wait: the server is not asked. Canceled while it is asked: no piece follows", async () => {
    const waiting = new AbortController();
    const first = pretend(["network"], { signal: waiting.signal });
    first.deps.sleep = async (ms) => {
      first.state.log.push(`wait ${ms}`);
      waiting.abort();
    };
    expect(await first.send()).toEqual({ ok: false, reason: "canceled" });
    expect(first.state.log).toEqual(["piece 0+4", "wait 1000"]);

    const asking = new AbortController();
    const second = pretend(["network"], { signal: asking.signal });
    second.deps.askOffset = async () => {
      second.state.log.push("ask");
      asking.abort();
      return { offset: 0, done: false };
    };
    expect(await second.send()).toEqual({ ok: false, reason: "canceled" });
    expect(second.state.log).toEqual(["piece 0+4", "wait 1000", "ask"]);

    // And when the answer that came too late was no answer: no second wait.
    const late = new AbortController();
    const third = pretend(["network"], { signal: late.signal });
    third.deps.askOffset = async () => {
      third.state.log.push("ask");
      late.abort();
      return null;
    };
    expect(await third.send()).toEqual({ ok: false, reason: "canceled" });
    expect(third.state.log).toEqual(["piece 0+4", "wait 1000", "ask"]);
  });

  it("an error that is not the transport's own is not swallowed", async () => {
    const bug = new RangeError("a bug in a transport");
    const { state, deps, send } = pretend();
    deps.transport = { sendPiece: async () => { throw bug; } };
    await expect(send()).rejects.toBe(bug);
    expect(state.log).toEqual([]);
  });

  it("with nothing left to send it asks the server: whole is success, and anything else gives up", async () => {
    // Opened with every byte in, and the server says the file is not whole.
    const short = pretend();
    short.state.held = 6;
    expect(await short.send(10)).toEqual({ ok: false, reason: "gave-up" });
    expect(short.state.log).toEqual(["ask"]);

    // Every piece answered "more" to the end, as for a page that cannot read how far Drive is.
    const blind: UploadTransport = { sendPiece: async ({ piece, start }) => ({ state: "more", next: start + piece.size }) };
    const whole = pretend([], { transport: blind });
    whole.state.held = 10;
    expect(await whole.send()).toEqual({ ok: true });
    expect(whole.state.log).toEqual(["ask"]);
    expect(whole.state.progress).toEqual([4, 8, 10]);
    const behind = pretend([], { transport: blind });
    behind.state.held = 4;
    expect(await behind.send()).toEqual({ ok: false, reason: "gave-up" }); // it does not go round again
    expect(behind.state.log).toEqual(["ask"]);

    // The server cannot be asked: that is a failure like any other, waited out and asked again.
    let unanswered = 2;
    const later = pretend();
    later.state.held = 10;
    const ask = later.deps.askOffset;
    later.deps.askOffset = async () => (unanswered-- > 0 ? (later.state.log.push("ask: no answer"), null) : ask());
    expect(await later.send(10)).toEqual({ ok: true });
    expect(later.state.log).toEqual(["ask: no answer", "wait 1000", "ask: no answer", "wait 2000", "ask"]);
    const never = pretend([], { askOffset: async () => null });
    expect(await never.send(10)).toEqual({ ok: false, reason: "gave-up" });
    expect(never.state.log).toEqual(["wait 1000", "wait 2000", "wait 4000", "wait 8000", "wait 16000"]);
    // After a failure too: a server that counts every byte in and still does not call the file whole.
    const odd = pretend(["network"], { askOffset: async () => ({ offset: 10, done: false }) });
    expect(await odd.send()).toEqual({ ok: false, reason: "gave-up" });
    expect(odd.state.log).toEqual(["piece 0+4", "wait 1000"]);
    // Not whole after a wait either: still no going round again.
    unanswered = 1;
    const stillShort = pretend();
    stillShort.state.held = 6;
    const askShort = stillShort.deps.askOffset;
    stillShort.deps.askOffset = async () => (unanswered-- > 0 ? null : askShort());
    expect(await stillShort.send(10)).toEqual({ ok: false, reason: "gave-up" });
    expect(stillShort.state.log).toEqual(["wait 1000", "ask"]);
  });

  it("a 503 or a 429 from Drive is waited out, and a lost last answer is found out, against the pretend Drive", async () => {
    for (const status of [503, 429]) {
      const { ctx, opened, deps, sleeps, progress } = await setup();
      ctx.fake.failNext(/^PUT \/upload\//, status);
      expect(await sendFile(file(), opened, deps)).toEqual({ ok: true });
      expect(sleeps).toEqual([1000]);
      expect(progress).toEqual([8 * MiB, 16 * MiB, SIZE]);
    }
    const { ctx, opened, deps, sleeps, progress, pieces } = await setup();
    let sent = 0;
    const losing: UploadTransport = {
      sendPiece: async (input) => {
        if (++sent === 3) ctx.fake.dropNextPieceAfter(SIZE); // every byte of the last piece arrives; its answer does not
        return deps.transport.sendPiece(input);
      },
    };
    expect(await sendFile(file(), opened, { ...deps, transport: losing })).toEqual({ ok: true });
    expect(sleeps).toEqual([1000]);
    expect(progress).toEqual([8 * MiB, 16 * MiB]);
    expect(pieces()).toHaveLength(4); // three pieces and the server's question
    expect(ctx.fake.sessions.get(opened.uploadUrl)!.received).toBe(SIZE);
  });
});
