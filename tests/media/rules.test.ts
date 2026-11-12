import { describe, expect, it } from "vitest";
import { LIMITS } from "@/lib/limits";
import { FILE_REFUSALS } from "@/lib/media/messages";
import { checkFile, cleanName, driveName, kindFromName, probeFits, sourceFrames } from "@/lib/media/rules";
import type { AssetProbe } from "@/lib/media/types";

const GB = 1024 ** 3;
const video: AssetProbe = { kind: "video", durationMs: 12_500, width: 1080, height: 1920, fps: 30, hasAudio: true, videoCodec: "hevc" };

describe("which files the library takes", () => {
  it("knows a file's kind from its extension, in any case", () => {
    for (const n of ["IMG_4821.MOV", "a.mp4", "a.m4v", "a.webm"]) expect(kindFromName(n), n).toBe("video");
    for (const n of ["a.jpg", "a.JPEG", "a.png", "a.webp"]) expect(kindFromName(n), n).toBe("image");
    for (const n of ["a.mp3", "a.m4a", "a.wav", "a.aac"]) expect(kindFromName(n), n).toBe("audio");
    for (const n of ["a.gif", "a.pdf", "a", "a.mp4.exe", ".mp4"]) expect(kindFromName(n), n).toBeNull();
  });

  it("reads the extension after the last dot", () => {
    expect(kindFromName("climb.final.take2.MP4")).toBe("video");
    expect(kindFromName("team.photo.png")).toBe("image");
    expect(kindFromName("a.mp4.")).toBeNull();
  });

  it("takes a file of exactly 2 GB and refuses one byte more", () => {
    expect(LIMITS.mediaFileBytes).toBe(2 * GB);
    expect(checkFile({ name: "a.mp4", sizeBytes: 2 * GB })).toEqual({ ok: true, kind: "video" });
    expect(checkFile({ name: "a.mp4", sizeBytes: 2 * GB + 1 })).toEqual({ ok: false, reason: "too-large" });
  });

  it("gives an empty file, a HEIC photo and an unknown type their own reasons", () => {
    expect(checkFile({ name: "a.mp4", sizeBytes: 0 })).toEqual({ ok: false, reason: "empty" });
    expect(checkFile({ name: "IMG_1.HEIC", sizeBytes: 9 })).toEqual({ ok: false, reason: "heic" });
    expect(checkFile({ name: "a.heif", sizeBytes: 9 })).toEqual({ ok: false, reason: "heic" });
    expect(checkFile({ name: "a.gif", sizeBytes: 9 })).toEqual({ ok: false, reason: "unsupported" });
    expect(FILE_REFUSALS["too-large"]).toBe("This file is larger than 2 GB.");
  });

  it("believes a read of the file only when it fits the extension and makes sense", () => {
    expect(probeFits("video", video)).toBe(true);
    expect(probeFits("image", video)).toBe(false); // a video named .jpg
    expect(probeFits("video", { ...video, durationMs: 0 })).toBe(false);
    expect(probeFits("video", { ...video, width: 20_000 })).toBe(false);
    expect(probeFits("image", { kind: "image", durationMs: null, width: 4032, height: 3024, fps: null, hasAudio: false, videoCodec: null })).toBe(true);
    expect(probeFits("audio", { kind: "audio", durationMs: 95_000, width: null, height: null, fps: null, hasAudio: true, videoCodec: null })).toBe(true);
  });

  it("refuses in a fixed order: empty, then too large, then HEIC, then an unknown type", () => {
    expect(checkFile({ name: "a.gif", sizeBytes: 0 })).toEqual({ ok: false, reason: "empty" });
    expect(checkFile({ name: "a.heic", sizeBytes: 0 })).toEqual({ ok: false, reason: "empty" });
    expect(checkFile({ name: "a.gif", sizeBytes: 2 * GB + 1 })).toEqual({ ok: false, reason: "too-large" });
    expect(checkFile({ name: "a.heic", sizeBytes: 2 * GB + 1 })).toEqual({ ok: false, reason: "too-large" });
    expect(checkFile({ name: "a.jpg", sizeBytes: 1 })).toEqual({ ok: true, kind: "image" });
    expect(checkFile({ name: "a.wav", sizeBytes: 1 })).toEqual({ ok: true, kind: "audio" });
  });

  it("has one sentence for each reason", () => {
    expect(FILE_REFUSALS).toEqual({
      empty: "This file is empty.",
      "too-large": "This file is larger than 2 GB.",
      heic: "HEIC photos aren't supported yet. Save the photo as JPEG first.",
      unsupported: "This file type isn't supported. Use MP4, MOV, WebM, JPEG, PNG, WebP, MP3, M4A, WAV or AAC.",
      unreadable: "This file couldn't be read. It may be damaged.",
    });
  });

  it("wants a length of at least 1 ms from a video and from audio, and none from an image", () => {
    const audio: AssetProbe = { kind: "audio", durationMs: 1, width: null, height: null, fps: null, hasAudio: true, videoCodec: null };
    expect(probeFits("video", { ...video, durationMs: 1 })).toBe(true);
    expect(probeFits("video", { ...video, durationMs: null })).toBe(false);
    expect(probeFits("audio", audio)).toBe(true);
    expect(probeFits("audio", { ...audio, durationMs: 0 })).toBe(false);
    expect(probeFits("audio", { ...audio, durationMs: null })).toBe(false);
    expect(probeFits("video", { ...video, kind: "audio" })).toBe(false); // a sound named .mp4
  });

  it("wants each side of a video or an image to be 1 to 16,384 px, and no size from audio", () => {
    const image: AssetProbe = { kind: "image", durationMs: null, width: 16_384, height: 1, fps: null, hasAudio: false, videoCodec: null };
    expect(probeFits("image", image)).toBe(true);
    expect(probeFits("image", { ...image, width: 16_385 })).toBe(false);
    expect(probeFits("image", { ...image, height: 0 })).toBe(false);
    expect(probeFits("image", { ...image, width: null })).toBe(false);
    expect(probeFits("video", { ...video, width: 1, height: 16_384 })).toBe(true);
    expect(probeFits("video", { ...video, height: 16_385 })).toBe(false);
    expect(probeFits("video", { ...video, width: 0 })).toBe(false);
    expect(probeFits("video", { ...video, height: null })).toBe(false);
  });

  it("believes only whole numbers that the database can hold", () => {
    const audio: AssetProbe = { kind: "audio", durationMs: 95_000, width: null, height: null, fps: null, hasAudio: true, videoCodec: null };
    const image: AssetProbe = { kind: "image", durationMs: null, width: 4032, height: 3024, fps: null, hasAudio: false, videoCodec: null };
    expect(probeFits("video", { ...video, durationMs: 1.5 })).toBe(false);
    expect(probeFits("audio", { ...audio, durationMs: 95_000.25 })).toBe(false);
    expect(probeFits("video", { ...video, durationMs: Number.NaN })).toBe(false);
    expect(probeFits("video", { ...video, durationMs: JSON.parse("1e400") })).toBe(false); // Infinity, as a request can carry it
    expect(probeFits("audio", { ...audio, durationMs: 2_147_483_647 })).toBe(true); // the most an integer column holds, about 24 days
    expect(probeFits("audio", { ...audio, durationMs: 2_147_483_648 })).toBe(false);
    expect(probeFits("video", { ...video, durationMs: 3e9 })).toBe(false);
    expect(probeFits("video", { ...video, width: 1080.5 })).toBe(false);
    expect(probeFits("video", { ...video, height: 1919.5 })).toBe(false);
    expect(probeFits("image", { ...image, width: 4032.5 })).toBe(false);
    expect(probeFits("image", { ...image, height: Number.NaN })).toBe(false);
  });

  it("calls a size that is not a whole number unreadable, after empty and too large and before the name is looked at", () => {
    expect(checkFile({ name: "a.mp4", sizeBytes: 1.5 })).toEqual({ ok: false, reason: "unreadable" });
    expect(checkFile({ name: "a.mp4", sizeBytes: Number.NaN })).toEqual({ ok: false, reason: "unreadable" });
    expect(checkFile({ name: "a.gif", sizeBytes: 1.5 })).toEqual({ ok: false, reason: "unreadable" });
    expect(checkFile({ name: "a.heic", sizeBytes: 1.5 })).toEqual({ ok: false, reason: "unreadable" });
    expect(checkFile({ name: "a.mp4", sizeBytes: -0.5 })).toEqual({ ok: false, reason: "empty" });
    expect(checkFile({ name: "a.mp4", sizeBytes: 2 * GB + 0.5 })).toEqual({ ok: false, reason: "too-large" });
    expect(checkFile({ name: "a.mp4", sizeBytes: JSON.parse("1e400") })).toEqual({ ok: false, reason: "too-large" });
  });
});

describe("names", () => {
  it("makes a display name from a file name", () => {
    expect(cleanName("IMG_4821.MOV")).toBe("IMG_4821");
    expect(cleanName("  climb   final.take2.mp4 ")).toBe("climb final.take2");
    expect(cleanName(".mp4")).toBe("Untitled");
    expect([...cleanName(`${"x".repeat(300)}.mp4`)]).toHaveLength(LIMITS.mediaNameChars);
  });

  it("counts a display name's characters as a person does, and leaves no space at the cut", () => {
    const family = "👨‍👩‍👧‍👦"; // one character to a person, eleven to a string
    expect(cleanName(`${family.repeat(121)}.mov`)).toBe(family.repeat(120));
    expect(cleanName(`${"x".repeat(119)} yz.mp4`)).toBe("x".repeat(119));
    expect(cleanName("match\t3\n final.mov")).toBe("match 3 final");
    expect(cleanName("notes")).toBe("notes");
  });

  it("calls a file Untitled when its name is only white space or cannot be stored", () => {
    expect(cleanName("   .mp4")).toBe("Untitled");
    expect(cleanName("")).toBe("Untitled");
    expect(cleanName("a\u0000b.mp4")).toBe("Untitled");
    expect(cleanName("a\ud83db.mp4")).toBe("Untitled"); // half of an emoji
  });

  it("makes a Drive file name a person can match to the asset", () => {
    expect(driveName("a1B2c3D4e5F6", "my/clip:1.mov")).toBe("a1B2c3D4e5F6__my_clip_1.mov");
    const long = driveName("a1B2c3D4e5F6", `${"y".repeat(300)}.mov`);
    expect(long).toHaveLength(120);
    expect(long.endsWith(".mov")).toBe(true);
  });

  it("keeps letters, digits, spaces, dots, dashes and underscores in a Drive file name, and nothing else", () => {
    expect(driveName("a1B2c3D4e5F6", "Año 2026 - run_3.final.MP4")).toBe("a1B2c3D4e5F6__Año 2026 - run_3.final.MP4");
    expect(driveName("a1B2c3D4e5F6", "a'b\"c\\d\te?.png")).toBe("a1B2c3D4e5F6__a_b_c_d_e_.png");
    expect(driveName("a1B2c3D4e5F6", "win 🏆.mov")).toBe("a1B2c3D4e5F6__win _.mov"); // one character, one "_"
    expect(driveName("a1B2c3D4e5F6", "a\ud83db.mov")).toBe("a1B2c3D4e5F6__a_b.mov");
    expect(driveName("a1B2c3D4e5F6", "notes")).toBe("a1B2c3D4e5F6__notes");
  });

  it("never makes a Drive file name longer than 120 characters or cuts a character in half", () => {
    expect(driveName("a1B2c3D4e5F6", `a.${"z".repeat(300)}`)).toHaveLength(120);
    expect(driveName("a1B2c3D4e5F6", `${"s".repeat(200)}.${"z".repeat(300)}`)).toBe(`a1B2c3D4e5F6__.${"z".repeat(105)}`);
    expect(driveName("a1B2c3D4e5F6", "y".repeat(300))).toBe(`a1B2c3D4e5F6__${"y".repeat(106)}`);
    const wide = driveName("a1B2c3D4e5F6", `${"𠀀".repeat(300)}.mov`); // a letter that takes two places in a string
    expect(wide).toBe(`a1B2c3D4e5F6__${"𠀀".repeat(102)}.mov`);
    expect(wide.isWellFormed()).toBe(true);
  });
});

describe("a media length in frames", () => {
  it("rounds down, and is never less than one frame", () => {
    expect(sourceFrames(12_500, 30)).toBe(375);
    expect(sourceFrames(10_010, 30)).toBe(300);
    expect(sourceFrames(10, 30)).toBe(1);
  });

  it("does not count a part of a frame", () => {
    expect(sourceFrames(1_050, 30)).toBe(31); // 31.5 frames
    expect(sourceFrames(999, 60)).toBe(59); // 59.94 frames
  });
});
