import { describe, expect, it } from "vitest";
import { PLACEHOLDER_FILL, activeClips, drawFrame, fitRect } from "@/lib/render/compositor";
import { SAFE_ZONES } from "@/lib/render/safe-zones";
import { layoutText, wrapLines } from "@/lib/render/text-layout";
import { DEFAULT_TRANSFORM, createEmptyDoc, type Clip, type TextClip, type TimelineDoc } from "@/lib/timeline";
import { text, video } from "../editor/fixtures";
import { fakeCtx, type Call } from "./fake-ctx";

const only = (calls: Call[], ...names: string[]) => calls.filter(([name]) => names.includes(name));
function textDoc(...clips: Clip[]): TimelineDoc {
  const d = createEmptyDoc("short_9x16"); // 1080 × 1920
  d.tracks[1].clips = clips;
  return d;
}
const tenPerChar = (s: string) => s.length * 10;

describe("text layout", () => {
  it("wraps at spaces, cuts a word that is too long, and keeps blank lines", () => {
    expect(wrapLines("go solvers go", 50, tenPerChar)).toEqual(["go", "solve", "rs go"]);
    expect(wrapLines("a\n\nb", 50, tenPerChar)).toEqual(["a", "", "b"]);
    expect(wrapLines("one two", 1000, tenPerChar)).toEqual(["one two"]);
    expect(wrapLines("a\r\nb", 50, tenPerChar)).toEqual(["a", "b"]);
  });

  it("centers the block on the clip and aligns lines inside a box 90% of the frame wide", () => {
    const clip = text("x", 0, 30, { text: "A\nB", style: { fontFamily: "Geist", fontSize: 100, fontWeight: 700, color: "#ffffff", align: "center" } }) as TextClip;
    expect(layoutText(clip, 1080, tenPerChar)).toEqual([{ text: "A", x: 0, y: -60 }, { text: "B", x: 0, y: 60 }]);
    expect(layoutText({ ...clip, style: { ...clip.style, align: "left" } }, 1080, tenPerChar).map((l) => l.x)).toEqual([-486, -486]);
    expect(layoutText({ ...clip, style: { ...clip.style, align: "right" } }, 1080, tenPerChar).map((l) => l.x)).toEqual([486, 486]);
  });
});

describe("drawFrame", () => {
  it("paints black, then a text clip with its transform and style", () => {
    const { ctx, calls } = fakeCtx();
    const clip = text("x", 0, 30, { transform: { ...DEFAULT_TRANSFORM, y: 0.25, scale: 2, rotation: 90, opacity: 0.5 } });
    drawFrame(ctx, textDoc(clip), 10);
    expect(calls).toEqual([
      ["set fillStyle", "#000000"], ["fillRect", 0, 0, 1080, 1920],
      ["save"], ["set globalAlpha", 0.5], ["translate", 540, 480], ["rotate", Math.PI / 2], ["scale", 2, 2],
      ["set font", '700 64px "Geist", sans-serif'], ["set fillStyle", "#ffffff"], ["set textAlign", "center"], ["set textBaseline", "middle"],
      ["fillText", "hi", 0, 0],
      ["restore"],
    ]);
  });

  it("wraps long text with the real font size, and asks the font resolver for the family", () => {
    const { ctx, calls } = fakeCtx(); // 64 px text measures 32 px per character; the box is 972 px, so 30 characters fit
    drawFrame(ctx, textDoc(text("x", 0, 30, { text: "seattle solvers robotics team wins" })), 0, { resolveFont: (family) => `"Loaded ${family}"` });
    expect(only(calls, "set font")).toEqual([["set font", '700 64px "Loaded Geist"']]);
    expect(only(calls, "fillText")).toEqual([["fillText", "seattle solvers robotics team", 0, -38.4], ["fillText", "wins", 0, 38.4]]);
  });

  it("draws only the clips under the playhead, on visible tracks, later tracks on top", () => {
    const d = textDoc(text("a", 0, 30, { text: "below" }), text("b", 30, 30, { text: "later" }));
    d.tracks.push({ id: "t2", kind: "text", name: "Text 2", muted: false, hidden: false, locked: false, clips: [text("c", 0, 30, { text: "above" })] });
    const drawn = (frame: number) => {
      const { ctx, calls } = fakeCtx();
      drawFrame(ctx, d, frame);
      return only(calls, "fillText").map((call) => call[1]);
    };
    expect([drawn(0), drawn(29), drawn(30), drawn(60)]).toEqual([["below", "above"], ["below", "above"], ["later"], []]);
    d.tracks[1].hidden = true;
    expect(drawn(0)).toEqual(["above"]);
    expect(activeClips(d, 0).map((a) => a.clip.id)).toEqual(["c"]);
  });

  it("draws a labeled placeholder for video and image, and nothing for audio", () => {
    const d = createEmptyDoc("short_9x16");
    d.tracks[0].clips = [video("v", 0, 30)];
    d.tracks[3].clips = [video("s", 0, 30, { type: "audio" })];
    const { ctx, calls } = fakeCtx();
    drawFrame(ctx, d, 0);
    expect(only(calls, "set fillStyle", "fillRect", "set font", "fillText")).toEqual([
      ["set fillStyle", "#000000"], ["fillRect", 0, 0, 1080, 1920],
      ["set fillStyle", PLACEHOLDER_FILL.video], ["fillRect", -540, -960, 1080, 1920],
      ["set fillStyle", "#ededed"], ["set font", "500 43px sans-serif"], ["fillText", "Video", 0, 0],
    ]);
  });

  it("draws a resolved source to cover or contain the frame", () => {
    expect(fitRect(1920, 1080, 1080, 1920, "contain")).toEqual({ width: 1080, height: 607.5 });
    const cover = fitRect(1920, 1080, 1080, 1920, "cover");
    expect([Math.round(cover.width), Math.round(cover.height)]).toEqual([3413, 1920]);
    const image = {} as CanvasImageSource;
    const d = createEmptyDoc("short_9x16");
    d.tracks[0].clips = [video("v", 0, 30, { type: "image" })];
    const { ctx, calls } = fakeCtx();
    drawFrame(ctx, d, 0, { resolveSource: (assetId) => (assetId === "a" ? { image, width: 1920, height: 1080 } : null) });
    const [draw] = only(calls, "drawImage");
    expect(draw[1]).toBe(image);
    expect((draw.slice(2) as number[]).map(Math.round)).toEqual([-1707, -960, 3413, 1920]);
    expect(only(calls, "fillText")).toEqual([]);
  });
});

describe("drawFrame with an empty source", () => {
  it("draws the placeholder when the resolved source has no size", () => {
    const d = createEmptyDoc("short_9x16");
    d.tracks[0].clips = [video("v", 0, 30)];
    const { ctx, calls } = fakeCtx();
    drawFrame(ctx, d, 0, { resolveSource: () => ({ image: {} as CanvasImageSource, width: 0, height: 1080 }) });
    expect(only(calls, "drawImage")).toEqual([]);
    expect(only(calls, "fillText")).toEqual([["fillText", "Video", 0, 0]]);
  });
});

describe("safe zones", () => {
  it("has margins for every format", () => {
    expect(SAFE_ZONES.short_9x16).toEqual({ top: 0.14, right: 0.06, bottom: 0.35, left: 0.06, label: "Reels and Shorts safe area" });
    for (const format of ["feed_4x5", "square_1x1", "long_16x9", "long_4k"] as const) {
      expect(SAFE_ZONES[format]).toEqual({ top: 0.05, right: 0.05, bottom: 0.05, left: 0.05, label: "Safe area" });
    }
  });
});
