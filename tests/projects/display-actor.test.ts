import { describe, expect, it } from "vitest";
import { actorUserId, displayActor } from "@/lib/projects/display-actor";

const names = new Map([["u1", "Ada Lovelace"]]);

describe("displayActor", () => {
  it("shows a known user's name", () => {
    expect(displayActor("u1", names)).toBe("Ada Lovelace");
  });

  it("shows Claude acting for a known user", () => {
    expect(displayActor("claude:u1", names)).toBe("Claude (for Ada Lovelace)");
  });

  it("shows Someone for an unknown user", () => {
    expect(displayActor("u9", names)).toBe("Someone");
  });

  it("shows Claude for a claude actor whose user is unknown", () => {
    expect(displayActor("claude:u9", names)).toBe("Claude");
  });
});

describe("actorUserId", () => {
  it("returns the user id behind an actor", () => {
    expect(actorUserId("u1")).toBe("u1");
    expect(actorUserId("claude:u1")).toBe("u1");
  });
});
