import { describe, expect, it } from "vitest";
import type { DB } from "@/db";
import { user } from "@/db/schema";
import { LIMITS } from "@/lib/limits";
import { listAssetsTool } from "@/lib/mcp/tools/list-assets";
import { makeTestDb } from "../helpers/db";
import { insertAsset } from "../media/context";
import { toolContext } from "./context";

const NOW = new Date("2026-11-12T12:00:00Z");
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

async function setup() {
  const db = await makeTestDb();
  const ctx = { ...(await toolContext(db)), now: () => NOW };
  await db.insert(user).values({ id: "u2", name: "Grace Hopper", email: "u2@gmail.com", emailVerified: true });
  return { db, ctx };
}

const IMAGE_ROW = { kind: "image", fileName: "field.jpg", mimeType: "image/jpeg", durationMs: null, width: 4032, height: 3024, fps: null, videoCodec: null, hasAudio: false, previewStatus: "none" } as const;
const AUDIO_ROW = { kind: "audio", fileName: "theme.mp3", mimeType: "audio/mpeg", width: null, height: null, fps: null, videoCodec: null, hasAudio: true, previewStatus: "none" } as const;

// The three assets of the example: an image just now by Grace, audio 3 hours ago and a video 2 days ago by Ada.
async function threeAssets(db: DB) {
  const video = await insertAsset(db, { durationMs: 12_500, event: "Qualifier 2026-11-08", createdAt: ago(48 * HOUR) });
  const audio = await insertAsset(db, { ...AUDIO_ROW, name: "theme", durationMs: 95_000, createdAt: ago(3 * HOUR) });
  const image = await insertAsset(db, { ...IMAGE_ROW, name: "field", uploadedBy: "u2", createdAt: NOW });
  return {
    video,
    audio,
    image,
    lines: {
      image: `${image}  image  "field"  4032x3024  uploaded just now by Grace Hopper`,
      audio: `${audio}  audio  "theme"  95.00s (2850 frames at 30 fps)  uploaded 3 hours ago by Ada Lovelace`,
      video: `${video}  video  "IMG_4821"  12.50s (375 frames at 30 fps)  1080x1920  with sound  event "Qualifier 2026-11-08"  uploaded 2 days ago by Ada Lovelace`,
    },
  };
}

const CLOSING = "Put one on a timeline with add_media. You cannot see inside footage yet: go by names, events and lengths, and ask the person when unsure.";
const assetLines = (text: string) => text.split("\n").filter((line) => /^\S+ {2}(video|image|audio) {2}"/.test(line));

describe("list_assets", () => {
  it("lists assets newest first, one line each", async () => {
    const { db, ctx } = await setup();
    const { lines } = await threeAssets(db);
    const result = await listAssetsTool(ctx, {});
    expect(result).toEqual({ isError: false, text: ["3 assets, newest first:", lines.image, lines.audio, lines.video, CLOSING].join("\n") });
  });

  it("filters by kind and by a word in the name or event", async () => {
    const { db, ctx } = await setup();
    const { lines } = await threeAssets(db);
    expect((await listAssetsTool(ctx, { kind: "image" })).text).toBe(["1 asset:", lines.image, CLOSING].join("\n"));
    expect((await listAssetsTool(ctx, { search: "QUALI" })).text).toBe(["1 asset:", lines.video, CLOSING].join("\n"));
    expect((await listAssetsTool(ctx, { search: "ThEmE" })).text).toBe(["1 asset:", lines.audio, CLOSING].join("\n"));
    expect((await listAssetsTool(ctx, { kind: "audio", search: "field" })).text).toBe(
      "No assets match. The library has 3 in all; call list_assets with no filter to see them.",
    );
    expect(await listAssetsTool(ctx, { search: "zzz" })).toEqual({
      isError: false,
      text: "No assets match. The library has 3 in all; call list_assets with no filter to see them.",
    });
  });

  it("says when the library is empty", async () => {
    const { ctx } = await setup();
    const empty = { isError: false, text: "The library is empty. A person uploads media in the editor's Media tab." };
    expect(await listAssetsTool(ctx, {})).toEqual(empty);
    expect(await listAssetsTool(ctx, { kind: "video", search: "intake" })).toEqual(empty);
  });

  it("pages at 50", async () => {
    const { db, ctx } = await setup();
    for (let i = 0; i < 120; i++) await insertAsset(db, { name: `clip ${i}`, createdAt: ago(i * 1000) });
    const first = await listAssetsTool(ctx, {});
    const lines = first.text.split("\n");
    expect(lines[0]).toBe("120 assets, newest first:");
    expect(assetLines(first.text)).toHaveLength(50);
    expect(assetLines(first.text)[0]).toContain('"clip 0"');
    expect(lines.slice(-2)).toEqual(["Showing 1–50 of 120. Call list_assets with cursor 50 for more.", CLOSING]);

    const second = await listAssetsTool(ctx, { cursor: 50 });
    expect(assetLines(second.text)[0]).toContain('"clip 50"');
    expect(second.text).toContain("Showing 51–100 of 120. Call list_assets with cursor 100 for more.");

    const last = await listAssetsTool(ctx, { cursor: 100 });
    expect(assetLines(last.text)).toHaveLength(20);
    expect(assetLines(last.text)[19]).toContain('"clip 119"');
    expect(last.text).not.toContain("Showing");
    expect(last.text.split("\n").at(-1)).toBe(CLOSING);
  });

  it("names the filter in the paging line, so the next page is of the same list", async () => {
    const { db, ctx } = await setup();
    for (let i = 0; i < 60; i++) {
      await insertAsset(db, { name: `intake ${i}`, createdAt: ago(i * 2000) });
      await insertAsset(db, { ...IMAGE_ROW, name: `pit ${i}`, event: 'Day "2"', createdAt: ago(i * 2000 + 1000) });
    }
    const paging = (text: string) => text.split("\n").at(-2);
    expect(paging((await listAssetsTool(ctx, { kind: "video" })).text)).toBe('Showing 1–50 of 60. Call list_assets with kind "video" and cursor 50 for more.');
    expect(paging((await listAssetsTool(ctx, { search: "pit" })).text)).toBe('Showing 1–50 of 60. Call list_assets with search "pit" and cursor 50 for more.');
    expect(paging((await listAssetsTool(ctx, { kind: "image", search: 'day "2' })).text)).toBe('Showing 1–50 of 60. Call list_assets with kind "image", search "day \\"2" and cursor 50 for more.');
    expect(paging((await listAssetsTool(ctx, {})).text)).toBe("Showing 1–50 of 120. Call list_assets with cursor 50 for more.");
    // Doing what the line says gives the rest of the same list.
    const next = await listAssetsTool(ctx, { kind: "video", cursor: 50 });
    expect(next.text.split("\n")[0]).toBe("60 assets, newest first:");
    expect(assetLines(next.text)).toHaveLength(10);
    expect(assetLines(next.text).every((line) => line.includes('video  "intake'))).toBe(true);
  });

  it("never lists removed or unfinished assets, and a viewer may call it", async () => {
    const { db, ctx } = await setup();
    const ready = await insertAsset(db, { name: "ready" });
    const removed = await insertAsset(db, { name: "removed", removedAt: NOW, removedBy: "u1" });
    // An unfinished upload of the caller's own: the library service lists those to the member who is uploading.
    const uploading = await insertAsset(db, { name: "uploading", status: "uploading", readyAt: null, uploadUrl: "https://upload.test/s", uploadedBy: ctx.actor.userId });
    const result = await listAssetsTool(ctx, {});
    expect(result.text.split("\n")[0]).toBe("1 asset:");
    expect(result.text).toContain(ready);
    expect(result.text).not.toContain(removed);
    expect(result.text).not.toContain(uploading);

    const viewer = await toolContext(db, { id: "u9", role: "viewer" });
    const seen = await listAssetsTool(viewer, {});
    expect(seen.isError).toBe(false);
    expect(seen.text).toContain(ready);
  });

  it("says when a video has no sound, and shows an image's event", async () => {
    const { db, ctx } = await setup();
    const silent = await insertAsset(db, { name: "drone", durationMs: 2_000, hasAudio: false, width: 1920, height: 1080 });
    const image = await insertAsset(db, { ...IMAGE_ROW, name: "pit", width: 800, height: 600, event: "Worlds" });
    const text = (await listAssetsTool(ctx, { kind: "video" })).text;
    expect(text).toContain(`${silent}  video  "drone"  2.00s (60 frames at 30 fps)  1920x1080  no sound  uploaded just now by Ada Lovelace`);
    expect((await listAssetsTool(ctx, { kind: "image" })).text).toContain(`${image}  image  "pit"  800x600  event "Worlds"  uploaded just now by Ada Lovelace`);
  });

  it("prints a name with a line break on one line, in quotes", async () => {
    const { db, ctx } = await setup();
    await insertAsset(db, { name: 'a"b\nc', event: 'x\ny"' });
    const text = (await listAssetsTool(ctx, {})).text;
    expect(text).toContain(`video  "a\\"b c"  12.50s`);
    expect(text).toContain(`event "x y\\""  uploaded`);
    expect(text.split("\n")).toHaveLength(3);
  });

  it("a full page of assets with the longest names and no events fits in a page of a read", async () => {
    const { db, ctx } = await setup();
    for (let i = 0; i < 50; i++) await insertAsset(db, { name: `${"x".repeat(115)}${String(i).padStart(5, "0")}` });
    const text = (await listAssetsTool(ctx, {})).text;
    expect(assetLines(text)).toHaveLength(50);
    expect(assetLines(text)[0]).toContain(`"${"x".repeat(115)}`);
    expect(text.length).toBeLessThan(LIMITS.connectorReadChars);
  });
});
