import { describe, expect, it, vi } from "vitest";
import { apiRoute } from "@/lib/api-route";
import { makeProjectHandlers } from "@/lib/projects/handlers";

const user = { id: "u1", email: "u1@gmail.com", name: "U1", image: null, role: "editor" as const };
const noContent = async () => new Response(null, { status: 204 });

describe("apiRoute", () => {
  it("turns an unexpected error into a 500 INTERNAL body that leaks nothing", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await apiRoute(async () => { throw new Error("password=hunter2 at db.internal:5432"); })(new Request("http://app.test/api/x"));
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ code: "INTERNAL", message: "Something went wrong. Try again." });
    expect(body).not.toContain("hunter2");
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("lets same-origin and Origin-less writes through, and never checks reads", async () => {
    const route = apiRoute(noContent);
    for (const req of [
      new Request("https://easyedit-pi.vercel.app/api/projects", { method: "POST", headers: { origin: "https://easyedit-pi.vercel.app" } }),
      new Request("http://localhost:3000/api/projects/p1", { method: "PATCH", headers: { origin: "http://localhost:3000" } }),
      new Request("http://localhost:3000/api/projects/p1", { method: "DELETE" }),
      new Request("http://localhost:3000/api/projects", { headers: { origin: "https://elsewhere.example" } }),
    ]) {
      expect((await route(req)).status, `${req.method} ${req.headers.get("origin")}`).toBe(204);
    }
  });

  it("refuses a write whose Origin differs: another site, port, scheme, or null", async () => {
    const handler = vi.fn(noContent);
    const route = apiRoute(handler);
    for (const [method, origin] of [
      ["POST", "https://evil.example"], ["PATCH", "https://easyedit-pi.vercel.app:8443"],
      ["POST", "http://easyedit-pi.vercel.app"], ["DELETE", "null"],
    ]) {
      const res = await route(new Request("https://easyedit-pi.vercel.app/api/projects/p1", { method, headers: { origin } }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ code: "FORBIDDEN", message: "This request came from another site." });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("project handlers answer a failure they did not expect with INTERNAL JSON", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const handlers = makeProjectHandlers({ db: () => { throw new Error("DATABASE_URL is not set"); }, auth: async () => user });
    const res = await handlers.list(new Request("http://app.test/api/projects"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ code: "INTERNAL", message: "Something went wrong. Try again." });
    vi.restoreAllMocks();
  });

  describe("origin check behind another address or a proxy", () => {
    const FWD = { "x-forwarded-host": "easyedit.example.com", "x-forwarded-proto": "https" };
    const run = async (url: string, headers: Record<string, string>) => {
      const handler = vi.fn(noContent);
      const res = await apiRoute(handler)(new Request(url, { method: "POST", headers }));
      return { res, handler };
    };

    it("passes when the host header names the address the browser used", async () => {
      const { res, handler } = await run("http://localhost:3200/api/x", { host: "127.0.0.1:3200", origin: "http://127.0.0.1:3200" });
      expect(res.status).toBe(204);
      expect(handler).toHaveBeenCalled();
    });

    it("passes when forwarded host and proto match the Origin", async () => {
      const { res, handler } = await run("http://localhost:3000/api/x", { ...FWD, origin: "https://easyedit.example.com" });
      expect(res.status).toBe(204);
      expect(handler).toHaveBeenCalled();
    });

    it("refuses another site, or the wrong scheme, behind a proxy", async () => {
      for (const origin of ["https://evil.example", "http://easyedit.example.com"]) {
        const { res, handler } = await run("http://localhost:3000/api/x", { ...FWD, origin });
        expect(res.status, origin).toBe(403);
        expect(handler).not.toHaveBeenCalled();
      }
    });

    it("uses the first value of a comma-separated forwarded list", async () => {
      const { res } = await run("http://localhost:3000/api/x", {
        "x-forwarded-host": "easyedit.example.com, internal.local",
        "x-forwarded-proto": "https, http",
        origin: "https://easyedit.example.com",
      });
      expect(res.status).toBe(204);
    });

    it("refuses an Origin on another port than the host header", async () => {
      const { res, handler } = await run("http://localhost:3200/api/x", { host: "localhost:3200", origin: "http://localhost:3000" });
      expect(res.status).toBe(403);
      expect(handler).not.toHaveBeenCalled();
    });

    it("passes a matching Origin with a host header and no forwarded headers", async () => {
      const { res } = await run("http://localhost:3200/api/x", { host: "localhost:3200", origin: "http://localhost:3200" });
      expect(res.status).toBe(204);
    });
  });
});
