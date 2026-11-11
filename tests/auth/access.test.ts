import { describe, expect, it } from "vitest";
import { addEntry, removeEntry, SEED_ADMIN_EMAIL, seedAdmin } from "@/lib/allowlist/service";
import { meetsRole, resolveCurrentUser } from "@/lib/access-rules";
import { makeTestDb } from "../helpers/db";

const kid = { id: "u1", email: "kid@gmail.com", name: "Kid", image: "https://example.com/kid.png" };

describe("access rules", () => {
  it("an allowlisted editor resolves with role editor", async () => {
    const db = await makeTestDb();
    await seedAdmin(db);
    await addEntry(db, { email: "kid@gmail.com", role: "editor", invitedBy: SEED_ADMIN_EMAIL });
    await expect(resolveCurrentUser(db, kid)).resolves.toEqual({ ...kid, role: "editor" });
  });

  it("a session user without an image resolves with image null", async () => {
    const db = await makeTestDb();
    await seedAdmin(db);
    await expect(
      resolveCurrentUser(db, { id: "a1", email: "Admin@SeattleSolvers.com", name: "Admin" }),
    ).resolves.toEqual({ id: "a1", email: "admin@seattlesolvers.com", name: "Admin", image: null, role: "admin" });
  });

  it("a user removed from the allowlist resolves to null", async () => {
    const db = await makeTestDb();
    await seedAdmin(db);
    await addEntry(db, { email: "kid@gmail.com", role: "editor", invitedBy: SEED_ADMIN_EMAIL });
    await removeEntry(db, "kid@gmail.com");
    await expect(resolveCurrentUser(db, kid)).resolves.toBeNull();
  });

  it("a null session resolves to null", async () => {
    const db = await makeTestDb();
    await seedAdmin(db);
    await expect(resolveCurrentUser(db, null)).resolves.toBeNull();
  });

  it("importing the access guard and the auth route needs no env vars", async () => {
    await expect(import("@/lib/access")).resolves.toHaveProperty("requireUserApi");
    await expect(import("@/app/api/auth/[...all]/route")).resolves.toHaveProperty("POST");
  });

  it("meetsRole compares role ranks", () => {
    expect(meetsRole("admin", "editor")).toBe(true);
    expect(meetsRole("viewer", "editor")).toBe(false);
    expect(meetsRole("editor", "editor")).toBe(true);
  });
});
