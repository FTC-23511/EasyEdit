import { describe, expect, it } from "vitest";
import { user } from "@/db/schema";
import { addEntry, removeEntry, SEED_ADMIN_EMAIL, seedAdmin } from "@/lib/allowlist/service";
import { makeSessionCreateBefore, makeUserCreateBefore } from "@/lib/auth-hooks";
import { makeTestDb } from "../helpers/db";

// Better Auth's APIError (better-call) keeps the payload on `.body`, so the message is matched at `body.message`.
describe("auth database hooks", () => {
  it("user.create.before rejects a non-allowlisted email", async () => {
    const db = await makeTestDb();
    await seedAdmin(db);
    await expect(makeUserCreateBefore(db)({ email: "rando@gmail.com" })).rejects.toMatchObject({
      status: "FORBIDDEN",
      body: { message: "NOT_ALLOWLISTED" },
    });
  });

  it("user.create.before accepts and normalizes an allowlisted email", async () => {
    const db = await makeTestDb();
    await seedAdmin(db);
    await expect(makeUserCreateBefore(db)({ email: "Admin@SeattleSolvers.com" })).resolves.toEqual({
      data: { email: "admin@seattlesolvers.com" },
    });
  });

  it("user.create.before keeps the other user fields", async () => {
    const db = await makeTestDb();
    await seedAdmin(db);
    const payload = { email: " Admin@SeattleSolvers.com ", name: "Admin", image: null, emailVerified: true };
    await expect(makeUserCreateBefore(db)(payload)).resolves.toEqual({
      data: { email: "admin@seattlesolvers.com", name: "Admin", image: null, emailVerified: true },
    });
  });

  it("session.create.before allows an allowlisted user", async () => {
    const db = await makeTestDb();
    await seedAdmin(db);
    await addEntry(db, { email: "kid@gmail.com", role: "viewer", invitedBy: SEED_ADMIN_EMAIL });
    await db.insert(user).values({ id: "u1", name: "Kid", email: "kid@gmail.com" });
    await expect(makeSessionCreateBefore(db)({ userId: "u1" })).resolves.toBeUndefined();
  });

  it("session.create.before rejects a user removed from the allowlist", async () => {
    const db = await makeTestDb();
    await seedAdmin(db);
    await addEntry(db, { email: "kid@gmail.com", role: "editor", invitedBy: SEED_ADMIN_EMAIL });
    await db.insert(user).values({ id: "u1", name: "Kid", email: "kid@gmail.com" });
    await removeEntry(db, "kid@gmail.com");
    await expect(makeSessionCreateBefore(db)({ userId: "u1" })).rejects.toMatchObject({
      status: "FORBIDDEN",
      body: { message: "NOT_ALLOWLISTED" },
    });
  });

  it("session.create.before rejects an unknown user id", async () => {
    const db = await makeTestDb();
    await seedAdmin(db);
    await expect(makeSessionCreateBefore(db)({ userId: "missing" })).rejects.toMatchObject({
      body: { message: "NOT_ALLOWLISTED" },
    });
  });
});
