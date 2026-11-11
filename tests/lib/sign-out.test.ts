import { expect, it, vi } from "vitest";
import { signOutAndLeave } from "@/lib/sign-out";

it("leaves only when sign-out worked", async () => {
  const leave = vi.fn();
  expect(await signOutAndLeave({ signOut: async () => ({ error: null }), leave })).toBe(true);
  expect(leave).toHaveBeenCalledTimes(1);
  expect(await signOutAndLeave({ signOut: async () => ({ error: { status: 500 } }), leave })).toBe(false);
  expect(await signOutAndLeave({ signOut: async () => { throw new TypeError("Failed to fetch"); }, leave })).toBe(false);
  expect(leave).toHaveBeenCalledTimes(1);
});
