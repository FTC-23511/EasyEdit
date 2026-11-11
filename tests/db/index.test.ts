import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rowsOf } from "@/db";

describe("without DATABASE_URL", () => {
  const saved = process.env.DATABASE_URL;
  beforeEach(() => {
    delete process.env.DATABASE_URL;
  });
  afterEach(() => {
    if (saved !== undefined) process.env.DATABASE_URL = saved;
  });

  it("importing the db and auth modules does not throw", async () => {
    await expect(import("@/db")).resolves.toHaveProperty("getDb");
    await expect(import("@/lib/auth")).resolves.toHaveProperty("getAuth");
  });

  it("getDb fails with a clear error", async () => {
    const { getDb } = await import("@/db");
    expect(() => getDb()).toThrow("DATABASE_URL is not set");
  });
});

describe("rowsOf", () => {
  it("returns the rows of a neon-http style result", () => {
    const result = { command: "SELECT", rowCount: 1, fields: [], rows: [{ version: 3 }] };
    expect(rowsOf<{ version: number }>(result)).toEqual([{ version: 3 }]);
  });

  it("throws on a result without rows", () => {
    expect(() => rowsOf({})).toThrow("no rows array");
  });
});
