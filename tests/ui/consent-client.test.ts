// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { decideConsent } from "@/lib/connector/consent-client";

// The auth client keeps the fetch it finds when it is created, so the stub must be in place before the import.
const fetchMock = vi.hoisted(() => {
  const mock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
  vi.stubGlobal("fetch", mock);
  return mock;
});

const SIGNED = "client_id=c1&state=s-1&exp=9&ba_param=ba_param&ba_param=client_id&ba_param=exp&ba_param=state&sig=abc";

beforeEach(() => {
  // The consent page's own address, with something added that the sign-in server did not sign.
  window.history.replaceState(null, "", `/consent?${SIGNED}&utm_source=mail`);
  fetchMock.mockReset().mockImplementation(async () => Response.json({ redirect: true, url: "https://claude.ai/api/mcp/auth_callback?code=c1" }));
});

async function sent(): Promise<{ url: string; body: unknown }> {
  const [input, init] = fetchMock.mock.calls[0];
  const request = new Request(input, init);
  return { url: request.url, body: await request.json() };
}

it("posts the choice with the signed request from the page address, and returns where to go", async () => {
  expect(await decideConsent(true)).toEqual({ url: "https://claude.ai/api/mcp/auth_callback?code=c1" });
  const { url, body } = await sent();
  expect(new URL(url).pathname).toBe("/api/auth/oauth2/consent");
  expect(body).toEqual({ accept: true, oauth_query: SIGNED });
});

it("posts a refusal the same way", async () => {
  await decideConsent(false);
  expect((await sent()).body).toEqual({ accept: false, oauth_query: SIGNED });
});

it("reports a refused or failed request as an error", async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ error: "invalid_signature" }, { status: 400 }));
  expect(await decideConsent(true)).toEqual({ error: true });
  fetchMock.mockRejectedValueOnce(new TypeError("offline"));
  expect(await decideConsent(true)).toEqual({ error: true });
  fetchMock.mockResolvedValueOnce(Response.json({ redirect: true }));
  expect(await decideConsent(true)).toEqual({ error: true });
});
