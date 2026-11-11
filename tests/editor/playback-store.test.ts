import { describe, expect, it } from "vitest";
import { makeStore } from "./fixtures";

describe("playback in the store", () => {
  it("a viewer can play, pause, step and shuttle, and nothing is edited", () => {
    const store = makeStore({ canEdit: false });
    const st = () => store.getState();
    const { queue, undoStack, doc } = st();
    st().play();
    expect(st().playing).toBe(true);
    st().shuttle("l");
    expect(st().rate).toBe(2);
    st().step(5);
    expect(st()).toMatchObject({ playing: false, playhead: 5 });
    st().shuttle("j");
    expect(st()).toMatchObject({ playing: true, rate: -1 });
    st().pause();
    expect(st().playing).toBe(false);
    expect(st().queue).toBe(queue);
    expect(st().undoStack).toBe(undoStack);
    expect(st().doc).toBe(doc);
  });

  it("J holds at -4x", () => {
    const store = makeStore();
    const rates = [1, 2, 3, 4].map(() => {
      store.getState().shuttle("j");
      return store.getState().rate;
    });
    expect(rates).toEqual([-1, -2, -4, -4]);
  });

  it("stepping forward stops at the end and never pulls back a playhead already past it", () => {
    const store = makeStore(); // 120 frames long
    const st = () => store.getState();
    st().seek(118);
    st().step(5);
    expect(st().playhead).toBe(120);
    st().step(1);
    expect(st().playhead).toBe(120);
    st().seek(150);
    st().step(1);
    expect(st().playhead).toBe(150);
    st().step(-1);
    expect(st().playhead).toBe(149);
  });
});
