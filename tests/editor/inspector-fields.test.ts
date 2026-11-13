import { describe, expect, it } from "vitest";
import { clipFieldOps, clipFieldValue, FIELD_LABEL, type ClipField } from "@/lib/editor/inspector-fields";
import { findClip } from "@/lib/editor/store";
import { applyOps, prepareOps, type OpInput } from "@/lib/timeline";
import { sampleDoc, text, video } from "./fixtures";

const clip = (id: string) => findClip(sampleDoc(), id)!.clip;
const patch = (p: Record<string, unknown>): OpInput[] => [{ op: "update_clip", clipId: "x1", patch: p }];

describe("inspector fields", () => {
  it.each<[ClipField, string, OpInput[] | null]>([
    ["text", "Hello", patch({ text: "Hello" })],
    ["fontSize", "72.6", patch({ style: { fontSize: 73 } })],
    ["fontSize", "2", patch({ style: { fontSize: 8 } })],
    ["fontSize", "abc", null],
    ["fontWeight", "500", patch({ style: { fontWeight: 500 } })],
    ["color", "#FF0000", patch({ style: { color: "#ff0000" } })],
    ["color", "red", null],
    ["align", "left", patch({ style: { align: "left" } })],
    ["x", "25", patch({ transform: { x: 0.25 } })],
    ["scale", "150", patch({ transform: { scale: 1.5 } })],
    ["scale", "0", null],
    ["rotation", "-45", patch({ transform: { rotation: -45 } })],
    ["opacity", "140", patch({ transform: { opacity: 1 } })],
    ["start", "0.5", [{ op: "move_clip", clipId: "x1", start: 15 }]],
    ["start", "-1", null],
    ["duration", "0.5", [{ op: "trim_clip", clipId: "x1", edge: "end", to: 15 }]],
    ["duration", "0", [{ op: "trim_clip", clipId: "x1", edge: "end", to: 1 }]],
  ])("%s = %s", (field, raw, ops) => {
    expect(clipFieldOps(clip("x1"), field, raw, 30)).toEqual(ops);
    if (ops) expect(() => applyOps(sampleDoc(), prepareOps(ops))).not.toThrow();
  });

  it("shows values in the inspector's units", () => {
    const x2 = clip("x2"); // starts at frame 90, 30 frames long
    expect((["start", "duration", "x", "scale", "opacity", "fontSize", "color"] as const).map((f) => clipFieldValue(x2, f, 30)))
      .toEqual(["3.00", "1.00", "50", "100", "100", "64", "#ffffff"]);
    expect(clipFieldValue(text("t", 0, 30, { transform: { ...x2.transform, x: 1 / 3 } }), "x", 30)).toBe("33.3");
  });

  it("has no text or style fields for a clip that is not text, and labels each change", () => {
    expect(clipFieldOps(clip("c1"), "text", "x", 30)).toBeNull();
    expect(clipFieldOps(clip("c1"), "color", "#ffffff", 30)).toBeNull();
    expect(clipFieldOps(clip("c1"), "x", "25", 30)).toEqual([{ op: "update_clip", clipId: "c1", patch: { transform: { x: 0.25 } } }]);
    expect([FIELD_LABEL.text, FIELD_LABEL.color, FIELD_LABEL.scale, FIELD_LABEL.duration]).toEqual(["text edit", "style change", "position change", "timing change"]);
  });
});

describe("inspector fields, fix round 1", () => {
  it("a time that rounds to the current frame is nothing to do, not invalid", () => {
    const x2 = clip("x2"); // frames 90 to 120
    expect(clipFieldOps(x2, "start", "3.01", 30)).toEqual([]);
    expect(clipFieldOps(x2, "duration", "0.99", 30)).toEqual([]);
    expect(clipFieldOps(x2, "start", "3.1", 30)).toEqual([{ op: "move_clip", clipId: "x2", start: 93 }]);
  });

  it("accepts only plain decimal numbers", () => {
    expect(clipFieldOps(clip("x1"), "start", "0x10", 30)).toBeNull();
    expect(clipFieldOps(clip("x1"), "start", "1e2", 30)).toBeNull();
    expect(clipFieldOps(clip("x1"), "rotation", "Infinity", 30)).toBeNull();
    expect(clipFieldOps(clip("x1"), "rotation", " +1.5 ", 30)).toEqual(patch({ transform: { rotation: 1.5 } }));
    expect(clipFieldOps(clip("x1"), "rotation", "-.5", 30)).toEqual(patch({ transform: { rotation: -0.5 } }));
    expect(clipFieldOps(clip("x1"), "rotation", "2.", 30)).toEqual(patch({ transform: { rotation: 2 } }));
    expect(clipFieldOps(clip("x1"), "rotation", ".", 30)).toBeNull();
  });

  it.each([24, 60])("converts seconds and frames at %i fps, both ways", (fps) => {
    const t = text("t", 2 * fps, fps / 2); // starts at 2 s, half a second long
    expect(clipFieldValue(t, "start", fps)).toBe("2.00");
    expect(clipFieldValue(t, "duration", fps)).toBe("0.50");
    expect(clipFieldOps(t, "start", "1.5", fps)).toEqual([{ op: "move_clip", clipId: "t", start: 1.5 * fps }]);
    expect(clipFieldOps(t, "duration", "1.25", fps)).toEqual([{ op: "trim_clip", clipId: "t", edge: "end", to: 2 * fps + 1.25 * fps }]);
  });

  it("writes y to y, keeps the font size at most 1000, lower-cases the color and rounds the weight", () => {
    expect(clipFieldOps(clip("x1"), "y", "75", 30)).toEqual(patch({ transform: { y: 0.75 } }));
    expect(clipFieldOps(clip("x1"), "fontSize", "5000", 30)).toEqual(patch({ style: { fontSize: 1000 } }));
    const shouty = text("t", 0, 30, { style: { fontFamily: "Geist", fontSize: 64, fontWeight: 700, color: "#FFAA00", align: "center" } });
    expect(clipFieldValue(shouty, "color", 30)).toBe("#ffaa00");
    expect(clipFieldOps(clip("x1"), "fontWeight", "550.4", 30)).toEqual(patch({ style: { fontWeight: 550 } }));
  });
});

describe("a media clip's length", () => {
  // 90 frames at 100, from frame 60 of a 375-frame video: it can end at 415 at the latest.
  const media = video("m", 100, 90, { in: 60 });

  it("a typed length stops at the end of the media", () => {
    expect(clipFieldOps(media, "duration", "60", 30, 375)).toEqual([{ op: "trim_clip", clipId: "m", edge: "end", to: 415 }]);
    expect(clipFieldOps(media, "duration", "60", 30)).toEqual([{ op: "trim_clip", clipId: "m", edge: "end", to: 1900 }]);
    expect(clipFieldOps(video("m", 100, 315, { in: 60 }), "duration", "60", 30, 375)).toEqual([]);
    // A length inside the media is taken as typed.
    expect(clipFieldOps(media, "duration", "5", 30, 375)).toEqual([{ op: "trim_clip", clipId: "m", edge: "end", to: 250 }]);
    // A clip that already starts past the end of its media keeps at least one frame, as a trim on the timeline does.
    expect(clipFieldOps(video("m", 100, 90, { in: 400 }), "duration", "60", 30, 375)).toEqual([{ op: "trim_clip", clipId: "m", edge: "end", to: 101 }]);
  });

  it("is not held for text or an image", () => {
    expect(clipFieldOps(text("t", 100, 90), "duration", "60", 30, 375)).toEqual([{ op: "trim_clip", clipId: "t", edge: "end", to: 1900 }]);
    const image = video("i", 100, 90, { type: "image", in: 0 });
    expect(clipFieldOps(image, "duration", "60", 30, 375)).toEqual([{ op: "trim_clip", clipId: "i", edge: "end", to: 1900 }]);
  });
});
