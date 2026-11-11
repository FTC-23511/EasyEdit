import { describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/access-rules";
import { makeAdminActions } from "@/lib/allowlist/admin-actions";
import { addEntry, listEntries, seedAdmin } from "@/lib/allowlist/service";
import { makeTestDb } from "../helpers/db";

const admin: CurrentUser = {
  id: "u1",
  email: "admin@seattlesolvers.com",
  name: "Admin",
  image: null,
  role: "admin",
};

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function setup(requireUser: (min: string) => Promise<CurrentUser> = async () => admin) {
  const db = await makeTestDb();
  await seedAdmin(db);
  const revalidate = vi.fn();
  const requireSpy = vi.fn(requireUser);
  const actions = makeAdminActions({ db: () => db, requireUser: requireSpy, revalidate });
  return { db, revalidate, requireSpy, actions };
}

describe("admin actions", () => {
  it("adding an existing member returns an error and leaves their role alone", async () => {
    const { db, revalidate, actions } = await setup();
    await addEntry(db, { email: "kid@gmail.com", role: "viewer", invitedBy: admin.email });
    expect(await actions.addMember(form({ email: "Kid@gmail.com", role: "admin" })))
      .toEqual({ error: "That email is already a member. Change their role in the table." });
    expect((await listEntries(db)).find((e) => e.email === "kid@gmail.com")?.role).toBe("viewer");
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("rejects every action for a non-admin and leaves the allowlist unchanged", async () => {
    const { db, revalidate, requireSpy, actions } = await setup(async () => {
      throw new Error("FORBIDDEN");
    });
    await addEntry(db, { email: "kid@gmail.com", role: "viewer", invitedBy: admin.email });
    const before = await listEntries(db);

    await expect(actions.addMember(form({ email: "x@gmail.com", role: "admin" }))).rejects.toThrow("FORBIDDEN");
    await expect(actions.setRole(form({ email: "kid@gmail.com", role: "admin" }))).rejects.toThrow("FORBIDDEN");
    await expect(actions.removeMember(form({ email: "kid@gmail.com" }))).rejects.toThrow("FORBIDDEN");

    expect(requireSpy).toHaveBeenCalledTimes(3);
    expect(requireSpy).toHaveBeenCalledWith("admin");
    expect(await listEntries(db)).toEqual(before);
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("returns the last-admin error when demoting the only admin", async () => {
    const { db, revalidate, actions } = await setup();
    const result = await actions.setRole(form({ email: admin.email, role: "viewer" }));
    expect(result).toEqual({ error: "There must always be at least one admin." });
    expect((await listEntries(db))[0].role).toBe("admin");
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("returns the last-admin error when removing the only admin", async () => {
    const { db, actions } = await setup();
    const result = await actions.removeMember(form({ email: admin.email }));
    expect(result).toEqual({ error: "There must always be at least one admin." });
    expect(await listEntries(db)).toHaveLength(1);
  });

  it("adds a normalized email invited by the acting admin and revalidates /admin", async () => {
    const { db, revalidate, actions } = await setup();
    const result = await actions.addMember(form({ email: " Kid@Gmail.com", role: "editor" }));
    expect(result).toEqual({});
    const kid = (await listEntries(db)).find((e) => e.email === "kid@gmail.com");
    expect(kid?.role).toBe("editor");
    expect(kid?.invitedBy).toBe("admin@seattlesolvers.com");
    expect(revalidate).toHaveBeenCalledWith("/admin");
  });

  it("changes a role and removes a member", async () => {
    const { db, revalidate, actions } = await setup();
    await actions.addMember(form({ email: "kid@gmail.com", role: "viewer" }));
    expect(await actions.setRole(form({ email: "kid@gmail.com", role: "editor" }))).toEqual({});
    expect((await listEntries(db)).find((e) => e.email === "kid@gmail.com")?.role).toBe("editor");
    expect(await actions.removeMember(form({ email: "kid@gmail.com" }))).toEqual({});
    expect((await listEntries(db)).map((e) => e.email)).toEqual(["admin@seattlesolvers.com"]);
    expect(revalidate).toHaveBeenCalledTimes(3);
  });

  it("returns the invalid-email error", async () => {
    const { db, revalidate, actions } = await setup();
    const result = await actions.addMember(form({ email: "not-an-email", role: "editor" }));
    expect(result).toEqual({ error: "That doesn't look like an email address." });
    expect(await listEntries(db)).toHaveLength(1);
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("rejects an unknown role and changes nothing", async () => {
    const { db, revalidate, actions } = await setup();
    await addEntry(db, { email: "kid@gmail.com", role: "viewer", invitedBy: admin.email });
    const before = await listEntries(db);
    expect(await actions.addMember(form({ email: "new@gmail.com", role: "owner" }))).toEqual({ error: "Unknown role." });
    expect(await actions.setRole(form({ email: "kid@gmail.com", role: "superuser" }))).toEqual({ error: "Unknown role." });
    expect(await actions.addMember(form({ email: "new@gmail.com" }))).toEqual({ error: "Unknown role." });
    expect(await listEntries(db)).toEqual(before);
    expect(revalidate).not.toHaveBeenCalled();
  });
});
