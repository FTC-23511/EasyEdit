import { vi } from "vitest";
import { BASE_URL, type ConnectorApp } from "./connector";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// Google's ID token is read without a signature check once it comes straight from Google's token address.
const unsignedJwt = (payload: object) =>
  [{ alg: "RS256", typ: "JWT" }, payload, "sig"].map((part) => typeof part === "string" ? part : Buffer.from(JSON.stringify(part)).toString("base64url")).join(".");

// Who Google says signs in next. Read by the token answer below.
const nextGoogleUser = { email: "", name: "" };

// Answers Google's token address in-process; everything else goes to the app as before.
// The account id matches the one `app.signIn` gives, so a member signed in either way is the same person.
export function answerGoogleInProcess(app: ConnectorApp) {
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.startsWith(GOOGLE_TOKEN_URL)) {
      const { email, name } = nextGoogleUser;
      return Response.json({
        access_token: "google-access", token_type: "Bearer", expires_in: 3600,
        id_token: unsignedJwt({ sub: `g-${email}`, email, email_verified: true, name }),
      });
    }
    return app.fetch(request);
  }) as typeof fetch);
}

let addresses = 0;

// What the browser does when the member presses "Sign in with Google" on /login?<query> and Google sends them back:
// the button's request, then Google's redirect to the callback. Returns where the callback sends the browser, and the
// session cookie it sets.
export async function signInWithGoogle(app: ConnectorApp, input: { email: string; name?: string; loginUrl: URL }): Promise<{ location: URL; cookie: string }> {
  nextGoogleUser.email = input.email;
  nextGoogleUser.name = input.name ?? input.email.slice(0, input.email.indexOf("@"));
  const ip = `198.18.${Math.floor(addresses / 250)}.${(addresses++ % 250) + 1}`;
  const oauthQuery = input.loginUrl.search.slice(1);
  const pressed = await app.send(new Request(`${BASE_URL}/api/auth/sign-in/social`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE_URL, "x-forwarded-for": ip },
    body: JSON.stringify({ provider: "google", callbackURL: "/dashboard", errorCallbackURL: "/login", ...(oauthQuery ? { oauth_query: oauthQuery } : {}) }),
  }));
  const google = (await pressed.json()) as { url?: string };
  if (typeof google.url !== "string") throw new Error(`sign-in did not start: ${pressed.status} ${JSON.stringify(google)}`);
  const state = new URL(google.url).searchParams.get("state");
  if (state === null) throw new Error(`no state in ${google.url}`);
  const cookie = pressed.headers.getSetCookie().map((line) => line.split(";")[0]).join("; ");
  const back = await app.send(new Request(`${BASE_URL}/api/auth/callback/google?code=google-code&state=${encodeURIComponent(state)}`, {
    headers: { cookie, "sec-fetch-mode": "navigate", accept: "text/html", "x-forwarded-for": ip },
  }));
  const location = back.headers.get("location");
  if (location === null) throw new Error(`the callback did not redirect: ${back.status} ${await back.text()}`);
  const session = back.headers.getSetCookie().map((line) => line.split(";")[0]).filter((pair) => pair.includes("session_token=") && !pair.endsWith("="));
  return { location: new URL(location, BASE_URL), cookie: session.join("; ") };
}
