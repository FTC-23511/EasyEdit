import { createSign } from "node:crypto";

export const SCOPE_WRITE = "https://www.googleapis.com/auth/drive";
export const SCOPE_READ = "https://www.googleapis.com/auth/drive.readonly";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const REQUEST_LIFE_SECONDS = 3600;
const DEFAULT_MIN_SECONDS_LEFT = 300;
// Letters, digits and _ only, and short: a reason is a code, never a sentence, an address or a token.
const SHORT_CODE = /^[A-Za-z0-9_]{1,64}$/;

// What every failed Google call becomes: which call, the status, and a short code. Nothing else from the answer is kept.
export class DriveError extends Error {
  name = "DriveError" as const;
  call: string; // "token", "session", "file" …
  status: number;
  reason: string; // a short code from Google's answer, else "unknown"

  constructor(call: string, status: number, reason: string) {
    const code = SHORT_CODE.test(reason) ? reason : "unknown";
    super(`Drive call failed: ${call} ${status} ${code}`);
    this.call = call;
    this.status = status;
    this.reason = code;
  }
}

export type GoogleToken = { accessToken: string; expiresAt: number }; // expiresAt in ms

export type TokenSource = { tokenFor(scope: string, minSecondsLeft?: number): Promise<GoogleToken> };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

// The short code in a refusal from Google: `error` from the token endpoint, `error.errors[0].reason` from the Drive API.
// "unknown" when the answer has neither. The rest of the answer is not kept.
export async function refusalReason(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  const error = isRecord(body) ? body.error : undefined;
  if (typeof error === "string") return error;
  const first: unknown = isRecord(error) && Array.isArray(error.errors) ? error.errors[0] : undefined;
  return isRecord(first) && typeof first.reason === "string" ? first.reason : "unknown";
}

const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

// The request for a token, signed with the service account's key.
function signedRequest(clientEmail: string, privateKey: string, scope: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const unsigned = `${base64url({ alg: "RS256", typ: "JWT" })}.${base64url({ iss: clientEmail, scope, aud: TOKEN_URL, iat, exp: iat + REQUEST_LIFE_SECONDS })}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url")}`;
}

// Tokens for the service account, one kept per scope and asked for again when too little of its time is left.
export function createTokenSource(deps: { clientEmail: string; privateKey: string; fetch?: typeof fetch; now?: () => number }): TokenSource {
  const fetchFn = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const kept = new Map<string, GoogleToken>();
  const asking = new Map<string, Promise<GoogleToken>>();

  async function ask(scope: string): Promise<GoogleToken> {
    const askedAt = now(); // a token's time runs from before the request, so it is never kept too long
    const response = await fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=${GRANT_TYPE}&assertion=${signedRequest(deps.clientEmail, deps.privateKey, scope, askedAt)}`,
    });
    if (!response.ok) throw new DriveError("token", response.status, await refusalReason(response));
    const body: unknown = await response.json().catch(() => null);
    const { access_token: accessToken, expires_in: expiresIn } = isRecord(body) ? body : {};
    if (typeof accessToken !== "string" || accessToken === "" || typeof expiresIn !== "number" || !(expiresIn > 0)) {
      throw new DriveError("token", response.status, "unknown");
    }
    return { accessToken, expiresAt: askedAt + expiresIn * 1000 };
  }

  return {
    tokenFor(scope, minSecondsLeft = DEFAULT_MIN_SECONDS_LEFT) {
      const have = kept.get(scope);
      if (have && have.expiresAt - now() > minSecondsLeft * 1000) return Promise.resolve(have);
      // Calls made while a request is in flight share it. A request that fails is forgotten, so the next call asks again.
      let request = asking.get(scope);
      if (!request) {
        request = ask(scope)
          .then((token) => {
            kept.set(scope, token);
            return token;
          })
          .finally(() => asking.delete(scope));
        asking.set(scope, request);
      }
      return request;
    },
  };
}
