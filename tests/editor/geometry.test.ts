import { describe, expect, it } from "vitest";
import {
  MAX_CONTENT_PX, ROW_HEIGHT, clampZoom, clipsInBox, contentFrames, displayRows, fitZoom, formatClock, formatTimecode,
  frameToPx, pxToFrame, revealScroll, rowAt, rulerTicks, trackToggles, visibleClips, zoomAt,
} from "@/lib/editor/geometry";
import { makeStore, sampleDoc, video } from "./fixtures";

describe("frames, pixels and zoom", () => {
  it("converts both ways and never returns a negative frame", () => {
    expect(frameToPx(45, 2)).toBe(90);
    expect(pxToFrame(91, 2)).toBe(46);
    expect(pxToFrame(-30, 2)).toBe(0);
  });

  it("formats timecodes and clock times", () => {
    expect(formatTimecode(0, 30)).toBe("0:00:00");
    expect(formatTimecode(105, 30)).toBe("0:03:15");
    expect(formatTimecode(108_105, 30)).toBe("1:00:03:15");
    expect(formatClock(1800, 30)).toBe("1:00");
    expect(formatClock(108_000, 30)).toBe("1:00:00");
  });

  it("keeps the frame under the pointer still when zooming, and fits a project with a margin", () => {
    expect(zoomAt({ scrollLeft: 1000, anchorPx: 200, zoom: 2, nextZoom: 4 })).toBe(2200);
    expect(zoomAt({ scrollLeft: 0, anchorPx: 200, zoom: 4, nextZoom: 2 })).toBe(0);
    expect(fitZoom(900, 30, 990)).toBeCloseTo(1);
    expect(fitZoom(0, 30, 1000)).toBeCloseTo(1000 / 300);
  });

  it("picks a tick step that keeps labels at least 80 px apart", () => {
    expect(rulerTicks({ zoom: 2, fps: 30, fromFrame: 0, toFrame: 300 })).toEqual({
      step: 60,
      ticks: [0, 60, 120, 180, 240, 300].map((frame, i) => ({ frame, label: `0:${String(i * 2).padStart(2, "0")}` })),
    });
    expect(rulerTicks({ zoom: 40, fps: 30, fromFrame: 0, toFrame: 10 }).ticks.map((t) => t.label)).toEqual(["0:00:00", "0:00:05", "0:00:10"]);
    expect(rulerTicks({ zoom: 0.02, fps: 30, fromFrame: 0, toFrame: 20_000 }).ticks.map((t) => t.label)).toEqual(["0:00", "5:00", "10:00"]);
  });

  it("the store's zoom actions stay inside the allowed range", () => {
    const store = makeStore(); // 120 frames long
    store.getState().setViewport(990);
    store.getState().zoomToFit();
    expect(store.getState().zoom).toBeCloseTo(3.3);
    store.getState().zoomBy(1000);
    expect(store.getState().zoom).toBe(40);
    store.getState().zoomBy(0.000001);
    expect(store.getState().zoom).toBe(0.02);
  });
});

describe("a very long timeline", () => {
  const threeHours = 3 * 60 * 60 * 30;

  it("never makes the scroll area wider than 8,000,000 px", () => {
    for (const duration of [900, threeHours, 2_000_000_000]) {
      expect(Math.floor(contentFrames(duration, 30) * clampZoom(40, duration, 30)), `${duration} frames`).toBeLessThanOrEqual(MAX_CONTENT_PX);
    }
    expect(clampZoom(40, 900, 30)).toBe(40);
    expect(clampZoom(0.001, 900, 30)).toBe(0.02);
  });

  it("draws a bounded number of ruler ticks at any zoom, starting at the visible range", () => {
    for (const zoom of [0.02, 0.1, 1, 7, 40]) {
      const fromFrame = 123_456;
      const { ticks } = rulerTicks({ zoom, fps: 30, fromFrame, toFrame: fromFrame + 1400 / zoom });
      expect(ticks.length, `zoom ${zoom}`).toBeLessThanOrEqual(19);
      expect(ticks[0].frame).toBeGreaterThanOrEqual(fromFrame);
    }
  });

  it("returns only the clips in view out of 1,000", () => {
    const clips = Array.from({ length: 1000 }, (_, i) => video(`k${i}`, i * 30, 30));
    expect(visibleClips(clips, 3000, 3600).map((c) => c.id)).toEqual(Array.from({ length: 20 }, (_, i) => `k${100 + i}`));
    expect(visibleClips(clips, 40_000, 50_000)).toEqual([]);
  });
});

describe("rows", () => {
  it("shows the front-most layer on top and audio at the bottom", () => {
    expect(displayRows(sampleDoc()).map((t) => t.id)).toEqual(["cap", "t1", "v1", "a1"]);
    const d = sampleDoc();
    d.tracks.unshift({ id: "a0", kind: "audio", name: "Music", muted: false, hidden: false, locked: false, clips: [] });
    expect(displayRows(d).map((t) => t.id)).toEqual(["cap", "t1", "v1", "a0", "a1"]);
  });

  it("finds the row under a y position and the clips inside a box", () => {
    expect([rowAt(-5, 4), rowAt(ROW_HEIGHT * 2 + 1, 4), rowAt(9999, 4)]).toEqual([0, 2, 3]);
    const rows = displayRows(sampleDoc()); // cap, t1, v1, a1
    expect(clipsInBox(rows, { fromFrame: 50, toFrame: 100, fromRow: 1, toRow: 2 })).toEqual(["x1", "x2", "c2"]);
    expect(clipsInBox(rows, { fromFrame: 100, toFrame: 50, fromRow: 2, toRow: 1 })).toEqual(["x1", "x2", "c2"]);
    expect(clipsInBox(rows, { fromFrame: 60, toFrame: 90, fromRow: 1, toRow: 1 })).toEqual([]);
  });

  it("offers hide and mute by track kind", () => {
    expect((["video", "overlay", "text", "caption", "audio"] as const).map(trackToggles)).toEqual([
      ["hidden", "muted"], ["hidden", "muted"], ["hidden"], ["hidden"], ["muted"],
    ]);
  });
});

describe("following the playhead", () => {
  it("scrolls only when the playhead is out of view, putting it 10% in from the left", () => {
    expect(revealScroll({ playheadPx: 500, scrollLeft: 0, viewportPx: 1000 })).toBeNull();
    expect(revealScroll({ playheadPx: 2000, scrollLeft: 2000, viewportPx: 1000 })).toBeNull();
    expect(revealScroll({ playheadPx: 1000, scrollLeft: 0, viewportPx: 1000 })).toBe(900);
    expect(revealScroll({ playheadPx: 5000, scrollLeft: 0, viewportPx: 1000 })).toBe(4900);
    expect(revealScroll({ playheadPx: 1500, scrollLeft: 2000, viewportPx: 1000 })).toBe(1400);
    expect(revealScroll({ playheadPx: 50, scrollLeft: 2000, viewportPx: 1000 })).toBe(0);
  });
});
