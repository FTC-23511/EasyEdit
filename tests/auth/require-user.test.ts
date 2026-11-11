import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import { addEntry, SEED_ADMIN_EMAIL, seedAdmin } from "@/lib/allowlist/service";
import { makeTestDb } from "../helpers/db";

const { getSession, redirect, forbidden } = vi.hoisted(() => ({
  getSession: vi.fn(),
  redirect: vi.fn((path: string) => { throw new Error(`REDIRECT ${path}`); }),
  forbidden: vi.fn(() => { throw new Error("FORBIDDEN"); }),
}));
let testDb: DB;
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect, forbidden }));
vi.mock("@/lib/auth", () => ({ getAuth: () => ({ api: { getSession } }) }));
vi.mock("@/db", async (orig) => ({ ...(await orig<typeof import("@/db")>()), getDb: () => testDb }));

beforeEach(async () => {
  vi.clearAllMocks();
  testDb = await makeTestDb();
  await seedAdmin(testDb);
  await addEntry(testDb, { email: "viewer@gmail.com", role: "viewer", invitedBy: SEED_ADMIN_EMAIL });
});

describe("requireUser", () => {
  it("sends a signed-out visitor to /login", async () => {
    getSession.mockResolvedValue(null);
    const { requireUser } = await import("@/lib/access");
    await expect(requireUser()).rejects.toThrow("REDIRECT /login");
    expect(redirect).toHaveBeenCalledWith("/login");
  });

  it("shows the forbidden page to a role below the minimum", async () => {
    getSession.mockResolvedValue({ user: { id: "u1", email: "viewer@gmail.com", name: "V" } });
    const { requireUser } = await import("@/lib/access");
    await expect(requireUser("editor")).rejects.toThrow("FORBIDDEN");
    expect(forbidden).toHaveBeenCalledTimes(1);
    await expect(requireUser("viewer")).resolves.toMatchObject({ email: "viewer@gmail.com", role: "viewer" });
  });
});
