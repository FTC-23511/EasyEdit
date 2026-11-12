import { describe, expect, it } from "vitest";
import { IMAGE_MAX_SIDE, POSTER, PREVIEW, posterSize, posterTime, previewFps, previewSize } from "@/lib/media/preview-spec";

describe("the preview copy's size", () => {
  it("an upright 4K phone clip becomes 720 by 1280", () => {
    expect(previewSize(2160, 3840)).toEqual({ width: 720, height: 1280 });
  });
  it("brings the shorter side to 720, keeps the shape, and keeps both sides even", () => {
    expect(previewSize(3840, 2160)).toEqual({ width: 1280, height: 720 });
    expect(previewSize(1920, 1080)).toEqual({ width: 1280, height: 720 });
    expect(previewSize(4032, 3024)).toEqual({ width: 960, height: 720 });
    expect(previewSize(2560, 1080)).toEqual({ width: 1706, height: 720 });
    expect(previewSize(1000, 1000)).toEqual({ width: 720, height: 720 });
  });
  it("never enlarges", () => {
    expect(previewSize(1280, 720)).toEqual({ width: 1280, height: 720 });
    expect(previewSize(640, 360)).toEqual({ width: 640, height: 360 });
    expect(previewSize(641, 361)).toEqual({ width: 640, height: 360 });
  });
  it("plays at the source's rate up to 30 frames a second", () => {
    expect(previewFps(29.97)).toBe(29.97);
    expect(previewFps(60)).toBe(30);
    expect(previewFps(240)).toBe(30);
    expect(previewFps(null)).toBe(30);
  });
  // The one place these numbers are pinned: the worker that uses the bitrates, key frame interval, audio settings and quality has no unit test.
  it("has the settings the plan fixed", () => {
    expect(PREVIEW).toEqual({ shortSide: 720, videoBitrate: 2_500_000, maxFps: 30, keyFrameSeconds: 1, audioBitrate: 128_000, audioChannels: 2, audioSampleRate: 48_000 });
    expect(POSTER).toEqual({ width: 320, quality: 0.8, atSeconds: 1 });
  });
  it("gives the shorter side exactly 720 whatever the other side is", () => {
    expect(previewSize(2166, 3850)).toEqual({ width: 720, height: 1278 });
    expect(previewSize(3850, 2166)).toEqual({ width: 1278, height: 720 });
    expect(previewSize(722, 1284)).toEqual({ width: 720, height: 1280 });
    expect(previewSize(721, 721)).toEqual({ width: 720, height: 720 });
    // Sizes where multiplying by 720 / the shorter side lands just under a whole number, and would lose two pixels.
    expect(previewSize(1284, 2778)).toEqual({ width: 720, height: 1556 }); // a phone's screen recording
    expect(previewSize(1142, 2030)).toEqual({ width: 720, height: 1278 });
    expect(previewSize(1208, 906)).toEqual({ width: 960, height: 720 });
  });
  it("gives an odd side the even number below it", () => {
    expect(previewSize(1279, 719)).toEqual({ width: 1278, height: 718 });
    expect(previewSize(719, 1279)).toEqual({ width: 718, height: 1278 });
    expect(previewSize(3839, 2160)).toEqual({ width: 1278, height: 720 });
  });
  it("never gives a side an encoder cannot take", () => {
    expect(previewSize(1, 1)).toEqual({ width: 2, height: 2 });
    expect(previewSize(16_384, 3)).toEqual({ width: 16_384, height: 2 });
  });
  it("reads a rate that is not a real rate as unknown", () => {
    expect(previewFps(0)).toBe(30);
    expect(previewFps(-24)).toBe(30);
    expect(previewFps(Number.NaN)).toBe(30);
    expect(previewFps(Number.POSITIVE_INFINITY)).toBe(30);
    expect(previewFps(30)).toBe(30);
    expect(previewFps(12.5)).toBe(12.5);
  });
});

describe("the still picture", () => {
  it("is 320 wide, in the video's shape, never enlarged", () => {
    expect(posterSize(1080, 1920)).toEqual({ width: 320, height: 568 });
    expect(posterSize(3840, 2160)).toEqual({ width: 320, height: 180 });
    expect(posterSize(200, 100)).toEqual({ width: 200, height: 100 });
  });
  it("is taken one second in, or in the middle of a very short video", () => {
    expect(posterTime(12_500)).toBe(1);
    expect(posterTime(1_200)).toBe(0.6);
  });
  it("has even sides of at least 2", () => {
    expect(posterSize(201, 101)).toEqual({ width: 200, height: 100 });
    expect(posterSize(320, 181)).toEqual({ width: 320, height: 180 });
    expect(posterSize(321, 181)).toEqual({ width: 320, height: 180 });
    expect(posterSize(1, 1)).toEqual({ width: 2, height: 2 });
    expect(posterSize(16_000, 10)).toEqual({ width: 320, height: 2 });
    expect(posterSize(3, 900)).toEqual({ width: 2, height: 900 });
  });
  it("is taken at one second from a video of two seconds or more", () => {
    expect(posterTime(2_000)).toBe(1);
    expect(posterTime(1_999)).toBe(0.9995);
    expect(posterTime(1)).toBe(0.0005);
  });
});

it("an image is decoded for the preview at no more than 2160 on its longer side", () => {
  expect(IMAGE_MAX_SIDE).toBe(2160);
});
