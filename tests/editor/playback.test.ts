import { describe, expect, it } from "vitest";
import { makeFontResolver } from "@/lib/editor/fonts";
import { advance, shuttle } from "@/lib/editor/playback";
import { fitBox, previewSize } from "@/lib/editor/preview-size";
import { createEmptyDoc } from "@/lib/timeline";
import { makeStore } from "./fixtures";

describe("shuttle", () => {
  it("L speeds up forward, J backward, K stops", () => {
    expect(shuttle({ playing: false, rate: 1 }, "l")).toEqual({ playing: true, rate: 1 });
    expect(shuttle({ playing: true, rate: 1 }, "l")).toEqual({ playing: true, rate: 2 });
    expect(shuttle({ playing: true, rate: 4 }, "l")).toEqual({ playing: true, rate: 4 });
    expect(shuttle({ playing: true, rate: 2 }, "j")).toEqual({ playing: true, rate: -1 });
    expect(shuttle({ playing: true, rate: -2 }, "j")).toEqual({ playing: true, rate: -4 });
    expect(shuttle({ playing: true, rate: -4 }, "k")).toEqual({ playing: false, rate: 1 });
  });
});

describe("the frame clock", () => {
  it("advances by whole frames at the playing rate", () => {
    expect(advance({ frame: 10, at: 1000 }, 2000, 1, 30, 900)).toEqual({ frame: 40, ended: false });
    expect(advance({ frame: 10, at: 1000 }, 2000, 2, 30, 900)).toEqual({ frame: 70, ended: false });
    expect(advance({ frame: 10, at: 1000 }, 1016, 1, 30, 900)).toEqual({ frame: 10, ended: false });
    expect(advance({ frame: 100, at: 0 }, 1000, -2, 30, 900)).toEqual({ frame: 40, ended: false });
  });

  it("stops at the end, and at the start when playing backward", () => {
    expect(advance({ frame: 890, at: 0 }, 1000, 1, 30, 900)).toEqual({ frame: 900, ended: true });
    expect(advance({ frame: 10, at: 0 }, 1000, -1, 30, 900)).toEqual({ frame: 0, ended: true });
  });

  it("counts from the end when playing backward from a playhead past it", () => {
    expect(advance({ frame: 180, at: 0 }, 1000, -1, 30, 120)).toEqual({ frame: 90, ended: false });
  });
});

describe("playback in the store", () => {
  it("play restarts from the beginning at the end; stepping pauses; seeking does not", () => {
    const store = makeStore(); // 120 frames long
    const st = () => store.getState();
    st().seek(120);
    st().play();
    expect(st()).toMatchObject({ playing: true, rate: 1, playhead: 0 });
    st().shuttle("l");
    expect(st().rate).toBe(2);
    st().seek(50);
    expect(st().playing).toBe(true);
    st().step(10);
    expect(st()).toMatchObject({ playing: false, rate: 1, playhead: 60 });
    st().shuttle("j");
    expect(st()).toMatchObject({ playing: true, rate: -1 });
    st().pause();
    st().toggleSafeZones();
    expect(st()).toMatchObject({ playing: false, showSafeZones: false });
  });

  it("does not play an empty project", () => {
    const store = makeStore({ doc: createEmptyDoc("short_9x16") });
    store.getState().play();
    store.getState().shuttle("l");
    expect(store.getState().playing).toBe(false);
  });
});

describe("preview size and fonts", () => {
  it("caps the canvas at 1920 px on its long side and fits it in a box", () => {
    expect(previewSize({ width: 3840, height: 2160 })).toEqual({ width: 1920, height: 1080, scale: 0.5 });
    expect(previewSize({ width: 1080, height: 1920 })).toEqual({ width: 1080, height: 1920, scale: 1 });
    expect(fitBox(9 / 16, 800, 600)).toEqual({ width: 337.5, height: 600 });
    expect(fitBox(2, 800, 600)).toEqual({ width: 800, height: 400 });
  });

  it("maps the app font to its loaded CSS family, and anything else to a plain fallback", () => {
    const resolve = makeFontResolver((name) => (name === "--font-geist-sans" ? ' "Geist", "Geist Fallback" ' : ""));
    expect(resolve("Geist")).toBe('"Geist", "Geist Fallback"');
    expect(resolve("Geist Mono")).toBe('"Geist Mono", sans-serif');
    expect(resolve("Inter")).toBe('"Inter", sans-serif');
  });
});
