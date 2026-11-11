import { expect, it } from "vitest";
import { makeStore } from "./fixtures";

it("each fit request is counted and sets the fit zoom; other zooms are not counted", () => {
  const store = makeStore(); // 120 frames long
  const st = () => store.getState();
  st().setViewport(990);
  expect(st().fitRequest).toBe(0);
  st().zoomToFit();
  expect(st()).toMatchObject({ fitRequest: 1 });
  expect(st().zoom).toBeCloseTo(3.3);
  st().zoomToFit(); // the same zoom again still counts
  expect(st().fitRequest).toBe(2);
  expect(st().zoom).toBeCloseTo(3.3);
  st().zoomBy(2);
  st().setZoom(1);
  expect(st().fitRequest).toBe(2);
  expect(st().zoom).toBe(1);
});
