import { expect, it } from "vitest";
import { formatAddedDate } from "@/lib/format-date";

it("formats the Added date in the given time zone, not always UTC", () => {
  const evening = new Date("2026-11-11T05:30:00Z"); // 9:30 pm on Nov 10 in Seattle
  expect(formatAddedDate(evening, "America/Los_Angeles")).toBe("Nov 10, 2026");
  expect(formatAddedDate(evening, "UTC")).toBe("Nov 11, 2026");
});
