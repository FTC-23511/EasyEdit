import type { MediaApi } from "./api";

// How the browser reads a file from Drive: with a read-only token our server hands out. The token is kept in
// this module's memory and nowhere else, and is sent in one header and never in an address.

export const TOKEN_MARGIN_MS = 60_000; // a token with less than this left is not used for a new read

export type ReadTokens = { get(): Promise<string | null>; invalidate(): void }; // null: no token could be had

export function createReadTokens(deps: { api: Pick<MediaApi, "readToken">; now?: () => number }): ReadTokens {
  const now = deps.now ?? Date.now;
  let held: { accessToken: string; expiresAt: number } | null = null;
  let asking: Promise<string | null> | null = null; // the request on its way, shared by everyone who asks meanwhile

  async function ask(): Promise<string | null> {
    try {
      const answer = await deps.api.readToken();
      if (!answer.ok) return null;
      held = { accessToken: answer.accessToken, expiresAt: answer.expiresAt };
      return held.accessToken;
    } catch {
      return null;
    }
  }

  return {
    async get() {
      if (held && held.expiresAt - now() >= TOKEN_MARGIN_MS) return held.accessToken;
      // A failure is not remembered: once the request has ended, the next call asks again.
      asking ??= ask().finally(() => (asking = null));
      return asking;
    },
    // Drive refused the token that is held. One that is on its way is newer, and is kept.
    invalidate() {
      held = null;
    },
  };
}

export function driveFileUrl(fileId: string): string {
  return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
}

// Why a file could not be read. offline: try again later. missing: Drive has no such file. refused: Drive will not give it to us.
export type ReadProblem = "offline" | "missing" | "refused";

type DriveRead = { ok: true; response: Response } | { ok: false; problem: ReadProblem };

const problem = (which: ReadProblem): DriveRead => ({ ok: false, problem: which });

// Asks Drive for a file's bytes. The answer's body has not been read yet. It never throws.
export async function readDriveFile(fileId: string, deps: { tokens: ReadTokens; fetch?: typeof fetch; signal?: AbortSignal }): Promise<DriveRead> {
  const doFetch: typeof fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  for (let attempt = 1; ; attempt += 1) {
    const token = await deps.tokens.get();
    if (token === null) return problem("offline");
    let response: Response;
    try {
      response = await doFetch(driveFileUrl(fileId), { headers: { Authorization: `Bearer ${token}` }, signal: deps.signal });
    } catch {
      return problem("offline");
    }
    if (response.ok) return { ok: true, response };
    if (response.status === 404) return problem("missing");
    if (response.status === 403) return problem("refused");
    if (response.status !== 401) return problem("offline");
    // The token was not taken: it ran out early, or the clock here is behind. A new one is tried, once.
    if (attempt === 2) return problem("refused");
    deps.tokens.invalidate();
  }
}
