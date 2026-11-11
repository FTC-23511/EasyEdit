import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type DB } from "@/db";
import type { CurrentUser } from "@/lib/access-rules";
import { makeAdminActions } from "@/lib/allowlist/admin-actions";
import { connectedEmails } from "@/lib/connector/grants";
import { startConnectorApp, type ConnectorApp } from "../helpers/connector";

let testDb: DB;
vi.mock("@/db", async (original) => ({ ...(await original<typeof import("@/db")>()), getDb: () => testDb }));

let app: ConnectorApp;
beforeAll(async () => {
  app = await startConnectorApp();
  testDb = app.db;
});
afterAll(() => app.stop());

const admin: CurrentUser = { id: "a1", email: "admin@seattlesolvers.com", name: "Admin", image: null, role: "admin" };
const form = (email: string) => {
  const f = new FormData();
  f.set("email", email);
  return f;
};
const LIST = { name: "list_projects", arguments: {} };

describe("disconnecting Claude from the Admin page", () => {
  it("ends one member's connection at once and leaves everyone else alone", async () => {
    const ada = await app.connect("ada@gmail.com");
    const grace = await app.connect("grace@gmail.com");
    const revalidate = vi.fn();
    const actions = makeAdminActions({ db: () => app.db, requireUser: async () => admin, revalidate });
    expect([...(await connectedEmails(app.db))].sort()).toEqual(["ada@gmail.com", "grace@gmail.com"]);

    expect(await actions.disconnectClaude(form(" Ada@Gmail.com "))).toEqual({});
    expect(revalidate).toHaveBeenCalledWith("/admin");
    expect([...(await connectedEmails(app.db))]).toEqual(["grace@gmail.com"]);
    expect((await app.rpc(ada.accessToken, "tools/call", LIST)).status).toBe(401);
    expect((await app.rpc(grace.accessToken, "tools/call", LIST)).status).toBe(200);

    // The member is still signed in on the website, and can connect again.
    expect((await (await import("@/lib/auth")).getAuth().api.getSession({ headers: new Headers({ cookie: ada.cookie }) }))?.user.email).toBe("ada@gmail.com");
    expect((await app.callTool((await app.connect("ada@gmail.com")).accessToken, "list_projects")).isError).toBe(false);
    expect(await actions.disconnectClaude(form("nobody@gmail.com"))).toEqual({});
  });

  it("is for admins only", async () => {
    const linus = await app.connect("linus@gmail.com");
    const requireUser = vi.fn(async () => { throw new Error("FORBIDDEN"); });
    const actions = makeAdminActions({ db: () => app.db, requireUser, revalidate: vi.fn() });
    await expect(actions.disconnectClaude(form("linus@gmail.com"))).rejects.toThrow("FORBIDDEN");
    expect(requireUser).toHaveBeenCalledWith("admin");
    expect((await app.rpc(linus.accessToken, "tools/call", LIST)).status).toBe(200);
  });
});
