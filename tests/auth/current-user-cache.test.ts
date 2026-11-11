import { expect, it, vi } from "vitest";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn(async () => null) }));
vi.mock("react", async (orig) => ({
  ...(await orig<typeof import("react")>()),
  // Stands in for React's per-request cache: the first call's result is reused.
  cache: <F extends (...args: never[]) => unknown>(fn: F) => {
    let hit: { value: unknown } | undefined;
    return ((...args: Parameters<F>) => (hit ??= { value: fn(...args) }).value) as F;
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth", () => ({ getAuth: () => ({ api: { getSession } }) }));
vi.mock("@/db", () => ({ getDb: () => ({}) })); // a null session never reaches the database

it("getCurrentUser is wrapped in React cache, so one request looks the user up once", async () => {
  const { getCurrentUser } = await import("@/lib/access");
  await getCurrentUser();
  await getCurrentUser();
  expect(getSession).toHaveBeenCalledTimes(1);
});
