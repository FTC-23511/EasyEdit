// Sends a file to a Drive upload session, a piece at a time. The session address is the permission: the
// server opened it, and nothing sent here carries a token. It is a secret, so no error here holds it.

// The Content-Range of the piece that holds bytes `start` up to, not including, `end` of a file of `total` bytes.
export function contentRange(start: number, end: number, total: number): string {
  return `bytes ${start}-${end - 1}/${total}`;
}

// What storage holds after a piece: more to send, from byte `next`, or the whole file.
export type PieceResult = { state: "more"; next: number } | { state: "done" };

// Why a piece did not get through. It holds the kind and nothing of the request.
export class PieceError extends Error {
  kind: "network" | "server" | "expired" | "refused";

  constructor(kind: PieceError["kind"]) {
    super(`The piece was not sent (${kind}).`);
    this.name = "PieceError";
    this.kind = kind;
  }
}

// How bytes reach storage. The fallback of "What the first real check settles" is another one of these.
export type UploadTransport = {
  sendPiece(input: { uploadUrl: string; piece: Blob; start: number; total: number; signal: AbortSignal }): Promise<PieceResult>;
};

const DEAD_SESSION = [404, 410, 499]; // a session that expired or was canceled

// Straight to Drive: one PUT per piece to the session address.
export function createDriveTransport(fetchFn?: typeof fetch): UploadTransport {
  const doFetch: typeof fetch = fetchFn ?? ((input, init) => fetch(input, init));
  return {
    async sendPiece({ uploadUrl, piece, start, total, signal }) {
      let answer: Response;
      try {
        answer = await doFetch(uploadUrl, { method: "PUT", headers: { "Content-Range": contentRange(start, start + piece.size, total) }, body: piece, signal });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new PieceError("network");
      }
      const { status } = answer;
      if (status === 308) {
        // Drive says how far it has come in `Range: bytes=0-<last>`. A page that may not read the header counts the piece it sent.
        const last = /-(\d+)$/.exec(answer.headers.get("range") ?? "");
        return { state: "more", next: last ? Number(last[1]) + 1 : start + piece.size };
      }
      if (status === 200 || status === 201) return { state: "done" };
      if (DEAD_SESSION.includes(status)) throw new PieceError("expired");
      if (status === 429 || (status >= 500 && status <= 599)) throw new PieceError("server");
      throw new PieceError("refused");
    },
  };
}

// The wait before asking again, by the number of failures since the last piece that got through.
export const PIECE_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000] as const; // not the editor's RETRY_DELAYS_MS in src/lib/editor/sync.ts

export type SendDeps = {
  transport: UploadTransport;
  askOffset(): Promise<{ offset: number; done: boolean } | null>; // from our server; null when it could not be asked
  sleep(ms: number): Promise<void>;
  chunkBytes: number;
  signal: AbortSignal;
  onProgress(sentBytes: number): void;
};

export type SendResult = { ok: true } | { ok: false; reason: "expired" | "refused" | "gave-up" | "canceled" };

const SENT: SendResult = { ok: true };
const CANCELED: SendResult = { ok: false, reason: "canceled" };
const GAVE_UP: SendResult = { ok: false, reason: "gave-up" };

// Sends the bytes of `file` that storage does not hold yet, from `opened.offset` on, in pieces of `chunkBytes`.
export async function sendFile(file: Blob, opened: { uploadUrl: string; offset: number }, deps: SendDeps): Promise<SendResult> {
  const { transport, askOffset, sleep, chunkBytes, signal, onProgress } = deps;
  const total = file.size;
  let offset = opened.offset; // the first byte storage does not hold
  let failures = 0; // since the last piece that got through

  for (;;) {
    if (signal.aborted) return CANCELED;

    // After a failure only the server knows how much arrived. It is also asked when there is nothing left to send
    // and storage has not said the file is whole.
    if (failures > 0 || offset >= total) {
      if (failures > 0) {
        if (failures > PIECE_RETRY_DELAYS_MS.length) return GAVE_UP;
        await sleep(PIECE_RETRY_DELAYS_MS[failures - 1]);
        if (signal.aborted) return CANCELED;
      }
      const held = await askOffset();
      if (signal.aborted) return CANCELED;
      if (held === null) {
        failures += 1;
        continue;
      }
      if (held.done) return SENT;
      // Every byte was sent, or storage holds as many as the file has, and still the file is not whole.
      if (offset >= total || held.offset >= total) return GAVE_UP;
      offset = held.offset;
    }

    let result: PieceResult;
    try {
      result = await transport.sendPiece({ uploadUrl: opened.uploadUrl, piece: file.slice(offset, offset + chunkBytes), start: offset, total, signal });
    } catch (error) {
      if (signal.aborted) return CANCELED;
      if (!(error instanceof PieceError)) throw error;
      if (error.kind === "expired" || error.kind === "refused") return { ok: false, reason: error.kind };
      failures += 1;
      continue;
    }
    if (result.state === "done") {
      onProgress(total);
      return SENT;
    }
    // Storage took nothing of the piece. Sent again at once it could go round for ever, so it counts as a failure.
    if (result.next === offset) {
      failures += 1;
      continue;
    }
    failures = 0;
    offset = result.next; // where storage is, even when that is less than was sent: no byte is skipped
    onProgress(offset);
  }
}
