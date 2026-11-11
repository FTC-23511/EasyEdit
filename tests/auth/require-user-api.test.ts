import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import { addEntry, SEED_ADMIN_EMAIL, seedAdmin } from "@/lib/allowlist/service";
import { makeTestDb } from "../helpers/db";

const getSession = vi.fn();
let testDb: DB;

vi.mock("@/lib/auth", () => ({ getAuth: () => ({ api: { getSession } }) }));
vi.mock("@/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db")>()),
  getDb: () => testDb,
}));

const req = () => new Request("http://x/api/projects");

beforeEach(async () => {
  getSession.mockReset();
  testDb = await makeTestDb();
  await seedAdmin(testDb);
  await addEntry(testDb, { email: "viewer@gmail.com", role: "viewer", invitedBy: SEED_ADMIN_EMAIL });
  await addEntry(testDb, { email: "editor@gmail.com", role: "editor", invitedBy: SEED_ADMIN_EMAIL });
});

describe("requireUserApi", () => {
  it("no session returns 401 UNAUTHENTICATED", async () => {
    getSession.mockResolvedValue(null);
    const { requireUserApi } = await import("@/lib/access");
    const res = (await requireUserApi(req(), "viewer")) as Response;
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: "UNAUTHENTICATED" });
  });

  it("a session whose email is not on the allowlist returns 401 UNAUTHENTICATED", async () => {
    getSession.mockResolvedValue({ user: { id: "u9", email: "stranger@gmail.com", name: "S" } });
    const { requireUserApi } = await import("@/lib/access");
    const res = (await requireUserApi(req(), "viewer")) as Response;
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: "UNAUTHENTICATED" });
  });

  it("a viewer asking for editor returns 403 FORBIDDEN", async () => {
    getSession.mockResolvedValue({ user: { id: "u1", email: "viewer@gmail.com", name: "V" } });
    const { requireUserApi } = await import("@/lib/access");
    const res = (await requireUserApi(req(), "editor")) as Response;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: "FORBIDDEN" });
  });

  it("an editor asking for editor returns the user with role editor", async () => {
    getSession.mockResolvedValue({ user: { id: "u2", email: "Editor@gmail.com", name: "E" } });
    const { requireUserApi } = await import("@/lib/access");
    expect(await requireUserApi(req(), "editor")).toEqual({
      id: "u2",
      email: "editor@gmail.com",
      name: "E",
      image: null,
      role: "editor",
    });
  });
});
