import { describe, expect, it } from "vitest";
import { user } from "@/db/schema";
import { getUserNames } from "@/lib/projects/user-names";
import { makeTestDb } from "../helpers/db";

describe("getUserNames", () => {
  it("maps each requested user id that exists to its name", async () => {
    const db = await makeTestDb();
    await db.insert(user).values([
      { id: "u1", name: "Ada Lovelace", email: "ada@gmail.com", emailVerified: true },
      { id: "u2", name: "Grace Hopper", email: "grace@gmail.com", emailVerified: true },
      { id: "u3", name: "Katherine Johnson", email: "kj@gmail.com", emailVerified: true },
    ]);
    const names = await getUserNames(db, ["u1", "u2", "u1", "missing"]);
    expect(names).toEqual(
      new Map([
        ["u1", "Ada Lovelace"],
        ["u2", "Grace Hopper"],
      ]),
    );
  });

  it("returns an empty map for no ids", async () => {
    const db = await makeTestDb();
    expect(await getUserNames(db, [])).toEqual(new Map());
  });
});
