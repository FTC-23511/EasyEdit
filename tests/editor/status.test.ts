import { expect, it } from "vitest";
import { saveStatusLabel } from "@/lib/editor/messages";

it("labels the save status", () => {
  expect(saveStatusLabel("saved", 0, true)).toBe("Saved");
  expect(saveStatusLabel("saved", 0, false)).toBe("Up to date");
  expect(saveStatusLabel("saving", 2, true)).toBe("Saving…");
  expect(saveStatusLabel("offline", 2, true)).toBe("Offline. Changes will save when you reconnect.");
  expect(saveStatusLabel("offline", 0, true)).toBe("Offline");
  expect(saveStatusLabel("signed-out", 1, true)).toBe("Signed out");
  expect(saveStatusLabel("deleted", 0, true)).toBe("Deleted");
});
