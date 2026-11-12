import { createVerify, generateKeyPairSync } from "node:crypto";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DriveError, SCOPE_READ, SCOPE_WRITE, createTokenSource } from "@/lib/drive/token";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const EMAIL = "easyedit-media@easyedit-test.iam.gserviceaccount.com";
const part = (jwt: string, i: number) => JSON.parse(Buffer.from(jwt.split(".")[i], "base64url").toString());

function google(answer: (scope: string) => Response = (scope) => Response.json({ access_token: `tok:${scope}`, expires_in: 3600, token_type: "Bearer" })) {
  const requests: { url: string; jwt: string }[] = [];
  const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const jwt = body.get("assertion")!;
    requests.push({ url: String(url), jwt });
    return answer(part(jwt, 1).scope);
  }) as typeof fetch;
  return { fetchFn, requests };
}

afterEach(() => vi.unstubAllGlobals());

describe("the service account's token", () => {
  it("has one scope that can change files and one that can only read them", () => {
    expect(SCOPE_WRITE).toBe("https://www.googleapis.com/auth/drive");
    expect(SCOPE_READ).toBe("https://www.googleapis.com/auth/drive.readonly");
  });

  it("asks Google with a request signed by the key, good for one hour", async () => {
    const { fetchFn, requests } = google();
    const tokens = createTokenSource({ clientEmail: EMAIL, privateKey, fetch: fetchFn, now: () => 1_000_000_000_000 });
    expect(await tokens.tokenFor(SCOPE_WRITE)).toEqual({ accessToken: `tok:${SCOPE_WRITE}`, expiresAt: 1_000_000_000_000 + 3_600_000 });
    const { url, jwt } = requests[0];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(part(jwt, 0)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(part(jwt, 1)).toEqual({ iss: EMAIL, scope: SCOPE_WRITE, aud: "https://oauth2.googleapis.com/token", iat: 1_000_000_000, exp: 1_000_003_600 });
    const [head, claims, signature] = jwt.split(".");
    expect(createVerify("RSA-SHA256").update(`${head}.${claims}`).verify(publicKey, signature, "base64url")).toBe(true);
  });

  it("keeps a token per scope and asks again only when too little time is left", async () => {
    let now = 0;
    const { fetchFn, requests } = google();
    const tokens = createTokenSource({ clientEmail: EMAIL, privateKey, fetch: fetchFn, now: () => now });
    await Promise.all([tokens.tokenFor(SCOPE_WRITE), tokens.tokenFor(SCOPE_WRITE)]);
    expect(requests).toHaveLength(1); // two calls at once share one request
    await tokens.tokenFor(SCOPE_READ);
    expect(requests).toHaveLength(2); // another scope is another token
    now = 3_600_000 - 301_000;
    await tokens.tokenFor(SCOPE_WRITE);
    expect(requests).toHaveLength(2); // 301 s left: still good
    await tokens.tokenFor(SCOPE_WRITE, 600);
    expect(requests).toHaveLength(3); // the caller needs 600 s
  });

  it("turns a refusal into a short error that holds nothing secret, and does not remember it", async () => {
    let refuse = true;
    const { fetchFn, requests } = google((scope) => (refuse ? Response.json({ error: "invalid_grant", error_description: `bad ${privateKey}` }, { status: 400 }) : Response.json({ access_token: `tok:${scope}`, expires_in: 3600 })));
    const tokens = createTokenSource({ clientEmail: EMAIL, privateKey, fetch: fetchFn });
    const error = await tokens.tokenFor(SCOPE_WRITE).catch((e) => e);
    expect(error).toBeInstanceOf(DriveError);
    expect(error.message).toBe("Drive call failed: token 400 invalid_grant");
    expect(JSON.stringify(error) + error.stack).not.toContain("PRIVATE KEY");
    refuse = false;
    expect((await tokens.tokenFor(SCOPE_WRITE)).accessToken).toBe(`tok:${SCOPE_WRITE}`);
    expect(requests).toHaveLength(2);
  });

  it("sends the request as a form post, with nothing in it but the grant and the signed request", async () => {
    const seen: RequestInit[] = [];
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init!);
      return Response.json({ access_token: "tok", expires_in: 3600 });
    }) as typeof fetch;
    await createTokenSource({ clientEmail: EMAIL, privateKey, fetch: fetchFn }).tokenFor(SCOPE_READ);
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("POST");
    expect(Object.fromEntries(new Headers(seen[0].headers))).toEqual({ "content-type": "application/x-www-form-urlencoded" });
    const body = String(seen[0].body);
    expect(body).toMatch(/^grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(part(body.split("assertion=")[1], 1).scope).toBe(SCOPE_READ);
  });

  it("uses the real clock and the real fetch when none is given", async () => {
    const before = Date.now();
    const { fetchFn, requests } = google();
    vi.stubGlobal("fetch", fetchFn);
    const token = await createTokenSource({ clientEmail: EMAIL, privateKey }).tokenFor(SCOPE_WRITE);
    const after = Date.now();
    expect(requests).toHaveLength(1);
    const { iat, exp } = part(requests[0].jwt, 1);
    expect(iat).toBeGreaterThanOrEqual(Math.floor(before / 1000));
    expect(iat).toBeLessThanOrEqual(Math.floor(after / 1000));
    expect(exp).toBe(iat + 3600);
    expect(token.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(token.expiresAt).toBeLessThanOrEqual(after + 3_600_000);
  });

  it("believes Google about how long a token lasts", async () => {
    const { fetchFn } = google((scope) => Response.json({ access_token: `tok:${scope}`, expires_in: 3599 }));
    const tokens = createTokenSource({ clientEmail: EMAIL, privateKey, fetch: fetchFn, now: () => 5_000 });
    expect(await tokens.tokenFor(SCOPE_WRITE)).toEqual({ accessToken: `tok:${SCOPE_WRITE}`, expiresAt: 5_000 + 3_599_000 });
  });

  it("counts a token's life from when it was asked for, not from when the answer came", async () => {
    let now = 10_000;
    const fetchFn = (async () => {
      now += 4_000; // the answer takes four seconds
      return Response.json({ access_token: "tok", expires_in: 3600 });
    }) as typeof fetch;
    const token = await createTokenSource({ clientEmail: EMAIL, privateKey, fetch: fetchFn, now: () => now }).tokenFor(SCOPE_WRITE);
    expect(token.expiresAt).toBe(10_000 + 3_600_000);
  });

  it("asks again at exactly the time the caller needs, and hands the same token back until then", async () => {
    let now = 0;
    let n = 0;
    const { fetchFn, requests } = google(() => Response.json({ access_token: `tok${++n}`, expires_in: 3600 }));
    const tokens = createTokenSource({ clientEmail: EMAIL, privateKey, fetch: fetchFn, now: () => now });
    const first = await tokens.tokenFor(SCOPE_WRITE);
    now = 3_600_000 - 300_001;
    expect(await tokens.tokenFor(SCOPE_WRITE)).toEqual(first); // 300.001 s left: more than 300
    expect(await tokens.tokenFor(SCOPE_WRITE, 0)).toEqual(first);
    expect(requests).toHaveLength(1);
    now = 3_600_000 - 300_000;
    expect(await tokens.tokenFor(SCOPE_WRITE)).toEqual({ accessToken: "tok2", expiresAt: now + 3_600_000 }); // exactly 300 s left: not more than 300
    expect(requests).toHaveLength(2);
    expect(await tokens.tokenFor(SCOPE_WRITE)).toEqual({ accessToken: "tok2", expiresAt: now + 3_600_000 }); // the new one is the one kept
    expect(requests).toHaveLength(2);
    now += 3_600_000;
    expect((await tokens.tokenFor(SCOPE_WRITE, 0)).accessToken).toBe("tok3"); // none left: not more than 0
    expect(requests).toHaveLength(3);
  });

  it("shares a request only between calls for the same scope", async () => {
    const { fetchFn, requests } = google();
    const tokens = createTokenSource({ clientEmail: EMAIL, privateKey, fetch: fetchFn, now: () => 0 });
    const [write, read, writeAgain, readLonger] = await Promise.all([tokens.tokenFor(SCOPE_WRITE), tokens.tokenFor(SCOPE_READ), tokens.tokenFor(SCOPE_WRITE), tokens.tokenFor(SCOPE_READ, 600)]);
    expect(requests.map((r) => part(r.jwt, 1).scope)).toEqual([SCOPE_WRITE, SCOPE_READ]);
    expect(write.accessToken).toBe(`tok:${SCOPE_WRITE}`);
    expect(read.accessToken).toBe(`tok:${SCOPE_READ}`);
    expect(writeAgain).toEqual(write);
    expect(readLonger).toEqual(read);
  });

  it("keeps separate sources apart", async () => {
    const { fetchFn, requests } = google();
    const deps = { clientEmail: EMAIL, privateKey, fetch: fetchFn, now: () => 0 };
    await createTokenSource(deps).tokenFor(SCOPE_WRITE);
    await createTokenSource(deps).tokenFor(SCOPE_WRITE);
    expect(requests).toHaveLength(2);
  });

  it("fails every call that shared a refused request, and keeps the token it already had", async () => {
    let now = 0;
    let refuse = false;
    const { fetchFn, requests } = google((scope) => (refuse ? Response.json({ error: "invalid_grant" }, { status: 400 }) : Response.json({ access_token: `tok:${scope}`, expires_in: 3600 })));
    const tokens = createTokenSource({ clientEmail: EMAIL, privateKey, fetch: fetchFn, now: () => now });
    const first = await tokens.tokenFor(SCOPE_WRITE);
    now = 3_000_000; // 600 s left
    refuse = true;
    const results = await Promise.allSettled([tokens.tokenFor(SCOPE_WRITE, 900), tokens.tokenFor(SCOPE_WRITE, 900)]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(requests).toHaveLength(2); // one request for the two calls
    expect(await tokens.tokenFor(SCOPE_WRITE)).toEqual(first); // still good for a caller that needs 300 s
    expect(requests).toHaveLength(2);
    await expect(tokens.tokenFor(SCOPE_WRITE, 900)).rejects.toBeInstanceOf(DriveError); // asked again, not answered from memory
    expect(requests).toHaveLength(3);
  });

  it("reads the reason from either shape of Google's answer, and says unknown for anything else", async () => {
    const reasonOf = async (answer: Response) => {
      const { fetchFn } = google(() => answer);
      const error = await createTokenSource({ clientEmail: EMAIL, privateKey, fetch: fetchFn }).tokenFor(SCOPE_WRITE).catch((e) => e);
      expect(error).toBeInstanceOf(DriveError);
      expect(error.message).toBe(`Drive call failed: token ${answer.status} ${error.reason}`);
      return error.reason;
    };
    expect(await reasonOf(Response.json({ error: "invalid_scope" }, { status: 400 }))).toBe("invalid_scope");
    expect(await reasonOf(Response.json({ error: { code: 403, message: "Rate limit", errors: [{ domain: "usageLimits", reason: "rateLimitExceeded" }] } }, { status: 403 }))).toBe("rateLimitExceeded");
    expect(await reasonOf(Response.json({ error: { errors: [{ reason: "storageQuotaExceeded" }, { reason: "backendError" }] } }, { status: 403 }))).toBe("storageQuotaExceeded");
    expect(await reasonOf(Response.json({ error: "has spaces in it" }, { status: 400 }))).toBe("unknown");
    expect(await reasonOf(Response.json({ error: "ya29.a0-token" }, { status: 400 }))).toBe("unknown");
    expect(await reasonOf(Response.json({ error: "" }, { status: 400 }))).toBe("unknown");
    expect(await reasonOf(Response.json({ error: "x".repeat(65) }, { status: 400 }))).toBe("unknown");
    expect(await reasonOf(Response.json({ error: "x".repeat(64) }, { status: 400 }))).toBe("x".repeat(64));
    expect(await reasonOf(Response.json({ error: { message: "no list" } }, { status: 500 }))).toBe("unknown");
    expect(await reasonOf(Response.json({ error: { errors: [] } }, { status: 500 }))).toBe("unknown");
    expect(await reasonOf(Response.json({ error: { errors: [{ reason: 7 }] } }, { status: 500 }))).toBe("unknown");
    expect(await reasonOf(Response.json({ error_description: "no code" }, { status: 400 }))).toBe("unknown");
    expect(await reasonOf(Response.json(null, { status: 500 }))).toBe("unknown");
    expect(await reasonOf(Response.json(["invalid_grant"], { status: 500 }))).toBe("unknown");
    expect(await reasonOf(new Response("<html>Bad gateway</html>", { status: 502 }))).toBe("unknown");
    expect(await reasonOf(new Response(null, { status: 503 }))).toBe("unknown");
  });

  it("does not take an answer without a token for one", async () => {
    let answer: unknown;
    const { fetchFn, requests } = google(() => Response.json(answer));
    const tokens = createTokenSource({ clientEmail: EMAIL, privateKey, fetch: fetchFn });
    const notTokens = [{ expires_in: 3600 }, { access_token: "", expires_in: 3600 }, { access_token: 7, expires_in: 3600 }, { access_token: "tok" }, { access_token: "tok", expires_in: "3600" }, { access_token: "tok", expires_in: 0 }, { access_token: "tok", expires_in: -5 }, null, "tok"];
    for (const bad of notTokens) {
      answer = bad;
      await expect(tokens.tokenFor(SCOPE_WRITE)).rejects.toMatchObject({ name: "DriveError", call: "token", status: 200, reason: "unknown" });
    }
    answer = { access_token: "tok", expires_in: 3600 };
    expect((await tokens.tokenFor(SCOPE_WRITE)).accessToken).toBe("tok");
    expect(requests).toHaveLength(10); // none of the nine was remembered
  });

  it("passes on a request that never reached Google, and does not remember it", async () => {
    let down = true;
    const fetchFn = (async () => {
      if (down) throw new TypeError("fetch failed");
      return Response.json({ access_token: "tok", expires_in: 3600 });
    }) as typeof fetch;
    const tokens = createTokenSource({ clientEmail: EMAIL, privateKey, fetch: fetchFn });
    await expect(tokens.tokenFor(SCOPE_WRITE)).rejects.toThrow("fetch failed");
    down = false;
    expect((await tokens.tokenFor(SCOPE_WRITE)).accessToken).toBe("tok");
  });

  it("fails without a request, and without showing the key, when the key cannot sign", async () => {
    const { fetchFn, requests } = google();
    const badKey = "-----BEGIN PRIVATE KEY-----\nSECRETMARKER\n-----END PRIVATE KEY-----\n";
    const tokens = createTokenSource({ clientEmail: EMAIL, privateKey: badKey, fetch: fetchFn });
    const error = await tokens.tokenFor(SCOPE_WRITE).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(inspect(error, { depth: 10 }) + JSON.stringify(error) + error.stack).not.toContain("SECRETMARKER");
    await expect(tokens.tokenFor(SCOPE_WRITE)).rejects.toBeInstanceOf(Error);
    expect(requests).toHaveLength(0);
  });
});

describe("a Drive error", () => {
  it("holds the call, the status and the reason, and nothing else", () => {
    const error = new DriveError("session", 404, "expired");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("DriveError");
    expect(error.message).toBe("Drive call failed: session 404 expired");
    expect({ ...error }).toEqual({ name: "DriveError", call: "session", status: 404, reason: "expired" });
    expect(String(error)).toBe("DriveError: Drive call failed: session 404 expired");
  });

  it("never carries a reason that is not a short code", () => {
    for (const reason of ["https://www.googleapis.com/upload?upload_id=abc", "Bearer ya29.abc", "two words", "", "x".repeat(65), "-----BEGIN PRIVATE KEY-----"]) {
      const error = new DriveError("file", 500, reason);
      expect(error.reason).toBe("unknown");
      expect(error.message).toBe("Drive call failed: file 500 unknown");
    }
    expect(new DriveError("file", 403, "insufficientPermissions").reason).toBe("insufficientPermissions");
    expect(new DriveError("token", 400, "invalid_grant").reason).toBe("invalid_grant");
  });
});
