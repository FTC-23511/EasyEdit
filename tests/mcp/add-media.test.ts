import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { addMediaTool } from "@/lib/mcp/tools/add-media";
import { editTimelineTool } from "@/lib/mcp/tools/edit-timeline";
import { applyProjectOps, createProject, getProject } from "@/lib/projects/service";
import type { OpInput } from "@/lib/timeline";
import { makeTestDb } from "../helpers/db";
import { CLIP_TRANSFORM as T, insertAsset, mediaClip } from "../media/context";
import { toolContext } from "./context";

async function setup() {
  const db = await makeTestDb();
  const ctx = await toolContext(db);
  const video = await insertAsset(db, { name: "intake", durationMs: 12_500 }); // 375 frames
  const second = await insertAsset(db, { name: "climb", durationMs: 4_000 }); // 120 frames
  const { id } = await createProject(db, ctx.actor, { name: "Recap", format: "short_9x16" });
  const clips = async () => (await getProject(db, ctx.actor, id))!.doc.tracks.find((t) => t.id === "v1")!.clips;
  return { db, ctx, video, second, id, clips };
}

describe("add_media", () => {
  it("lays clips end to end, each for the time asked", async () => {
    const { ctx, video, second, id, clips } = await setup();
    const result = await addMediaTool(ctx, { project_id: id, expected_version: 0, items: [{ asset_id: video, duration_seconds: 3 }, { asset_id: second, duration_seconds: 3 }] });
    expect(result.isError).toBe(false);
    expect(result.text.split("\n")[0]).toBe("Added 2 clips as version 1.");
    expect((await clips()).map((c) => [c.type, "assetId" in c && c.assetId, c.start, c.duration])).toEqual([["video", video, 0, 90], ["video", second, 90, 90]]);
  });

  it("goes after what is already on the track, and can begin partway into the footage", async () => {
    const { ctx, video, id, clips } = await setup();
    await addMediaTool(ctx, { project_id: id, expected_version: 0, items: [{ asset_id: video, duration_seconds: 2 }] });
    await addMediaTool(ctx, { project_id: id, expected_version: 1, items: [{ asset_id: video, in_seconds: 10 }] });
    expect((await clips()).map((c) => [c.start, c.duration, "in" in c && c.in])).toEqual([[0, 60, 0], [60, 75, 300]]);
  });

  it("the same call sent twice lands once", async () => {
    const { ctx, video, id, clips } = await setup();
    const args = { project_id: id, expected_version: 0, items: [{ asset_id: video }] };
    const first = await addMediaTool(ctx, args);
    expect(await addMediaTool(ctx, args)).toEqual(first);
    expect(await clips()).toHaveLength(1);
  });

  it("refuses an asset that does not exist, and a range outside the footage, and applies nothing", async () => {
    const { ctx, video, id, clips } = await setup();
    const missing = await addMediaTool(ctx, { project_id: id, expected_version: 0, items: [{ asset_id: video }, { asset_id: "made-up-id" }] });
    expect(missing).toEqual({ isError: true, text: 'items[1]: No asset with id "made-up-id". Call list_assets to see the ids.\nNothing was applied.' });
    const outside = await addMediaTool(ctx, { project_id: id, expected_version: 0, items: [{ asset_id: video, in_seconds: 13 }] });
    expect(outside.text).toBe("items[0]: in_seconds is past the end of the media, which is 12.50 s long.\nNothing was applied.");
    const second = await addMediaTool(ctx, { project_id: id, expected_version: 0, items: [{ asset_id: video }, { asset_id: video, in_seconds: 12.5 }] });
    expect(second.text.split("\n")[0]).toBe("items[1]: in_seconds is past the end of the media, which is 12.50 s long.");
    expect(await clips()).toEqual([]);
  });

  it("is refused for a viewer and on an old version", async () => {
    const { db, ctx, video, id } = await setup();
    const viewer = await toolContext(db, { id: "u9", role: "viewer" });
    expect((await addMediaTool(viewer, { project_id: id, expected_version: 0, items: [{ asset_id: video }] })).text).toMatch(/^Your role is viewer\./);
    await addMediaTool(ctx, { project_id: id, expected_version: 0, items: [{ asset_id: video }] });
    const stale = await addMediaTool(ctx, { project_id: id, expected_version: 0, items: [{ asset_id: video, start_seconds: 20 }] });
    expect(stale.text).toContain("It is now at version 1.");
  });

  it("starts where it is told, and the next item goes after it", async () => {
    const { ctx, video, second, id, clips } = await setup();
    await addMediaTool(ctx, { project_id: id, expected_version: 0, items: [{ asset_id: video, start_seconds: 19.99, duration_seconds: 1 }, { asset_id: second }] });
    expect((await clips()).map((c) => [c.start, c.duration])).toEqual([[600, 30], [630, 120]]);
  });

  it("goes after the last clip of the track it names, or of the first track of its kind", async () => {
    const { db, ctx, video, second, id } = await setup();
    const music = await insertAsset(db, { kind: "audio", name: "theme", durationMs: 10_000, width: null, height: null, fps: null, videoCodec: null, previewStatus: "none" });
    await applyProjectOps(db, ctx.actor, { projectId: id, baseVersion: 0, ops: [
      { op: "add_track", track: { id: "o1", kind: "overlay", name: "Overlay 1" } },
      { op: "add_clip", trackId: "o1", clip: { ...mediaClip(second), id: "m1", duration: 45 } },
      { op: "add_clip", trackId: "a1", clip: { ...mediaClip(music, { type: "audio" }), id: "m2", duration: 50 } },
    ] as OpInput[] });
    await addMediaTool(ctx, { project_id: id, expected_version: 1, items: [{ asset_id: video, duration_seconds: 1, track_id: "o1" }] });
    await addMediaTool(ctx, { project_id: id, expected_version: 2, items: [{ asset_id: video, duration_seconds: 1 }] });
    await addMediaTool(ctx, { project_id: id, expected_version: 3, items: [{ asset_id: music, duration_seconds: 1 }] });
    const tracks = (await getProject(db, ctx.actor, id))!.doc.tracks;
    const spans = (trackId: string) => tracks.find((t) => t.id === trackId)!.clips.map((c) => [c.type, c.start, c.duration]);
    expect(spans("o1")).toEqual([["video", 0, 45], ["video", 45, 30]]);
    expect(spans("v1")).toEqual([["video", 0, 30]]);
    expect(spans("a1")).toEqual([["audio", 0, 50], ["audio", 50, 30]]);
  });

  it("says when an asset was removed or is still uploading", async () => {
    const { db, ctx, video, id } = await setup();
    const removed = await insertAsset(db, { removedAt: new Date(), removedBy: "u1" });
    const uploading = await insertAsset(db, { status: "uploading", readyAt: null, uploadUrl: "https://upload.test/s" });
    expect((await addMediaTool(ctx, { project_id: id, expected_version: 0, items: [{ asset_id: removed }] })).text).toBe(
      `items[0]: Asset "${removed}" was removed from the library. Call list_assets to see what is there.\nNothing was applied.`,
    );
    expect((await addMediaTool(ctx, { project_id: id, expected_version: 0, items: [{ asset_id: video }, { asset_id: uploading }] })).text).toBe(
      `items[1]: Asset "${uploading}" is still uploading. Try again once list_assets shows it.\nNothing was applied.`,
    );
  });

  it("is refused for too many items, an unknown project, and a project with no room", async () => {
    const { db, ctx, video, id } = await setup();
    const few = await toolContext(db, { limits: { connectorMediaItems: 2 } });
    const items = [{ asset_id: video }, { asset_id: video }, { asset_id: video }];
    expect(await addMediaTool(few, { project_id: id, expected_version: 0, items })).toEqual({ isError: true, text: "At most 2 clips per call." });
    // The role and the version come before the assets.
    const viewer = await toolContext(db, { id: "u9", role: "viewer" });
    expect((await addMediaTool(viewer, { project_id: id, expected_version: 0, items: [{ asset_id: "made-up-id" }] })).text).toMatch(/^Your role is viewer\./);
    expect((await addMediaTool(ctx, { project_id: id, expected_version: 5, items: [{ asset_id: "made-up-id" }] })).text).toMatch(/^Edit refused: expected_version 5 is ahead/);
    expect((await addMediaTool(ctx, { project_id: "no-such-project", expected_version: 0, items: [{ asset_id: video }] })).text).toBe(
      'No project with id "no-such-project". It may have been deleted. Call list_projects to see the ids.',
    );
    // 20 tracks, and the only one that takes video is locked.
    const textTracks = Array.from({ length: 16 }, (_, i) => ({ op: "add_track", track: { id: `x${i}`, kind: "text", name: `Text ${i + 2}` } }));
    await applyProjectOps(db, ctx.actor, { projectId: id, baseVersion: 0, ops: [...textTracks, { op: "update_track", trackId: "v1", patch: { locked: true } }] as OpInput[] });
    expect(await addMediaTool(ctx, { project_id: id, expected_version: 1, items: [{ asset_id: video }] })).toEqual({
      isError: true,
      text: "There is no room for that media: the project has 20 tracks and none is free at that time. Remove a track or pick another time.",
    });
  });
});

describe("media through edit_timeline", () => {
  const clip = mediaClip;

  it("a made-up asset id is refused before anything is read", async () => {
    const { ctx, id } = await setup();
    const result = await editTimelineTool(ctx, { project_id: "no-such-project", expected_version: 0, ops: [{ op: "add_clip", trackId: "v1", clip: clip("made-up-id") }] });
    expect(result.text).toBe('Edit refused: ops[0] (add_clip) names media that can\'t be used.\nNo asset with id "made-up-id". Call list_assets to see the ids.\nNothing was applied.');
    expect((await getProject(ctx.db, ctx.actor, id))!.version).toBe(0);
  });

  it("a wrong batch is refused whole and the corrected one lands", async () => {
    const { ctx, video, id } = await setup();
    const tooLong = await editTimelineTool(ctx, { project_id: id, expected_version: 0, ops: [{ op: "add_clip", trackId: "v1", clip: clip(video, { duration: 400 }) }] });
    expect(tooLong.isError).toBe(true);
    expect(tooLong.text.split("\n").slice(0, 3)).toEqual([
      "Edit refused: ops[0] (add_clip) failed with TRIM_OUT_OF_RANGE.",
      expect.stringContaining("would run past the end of its media, which is 375 frames long"),
      "How to fix: The new edge must leave at least one frame and stay inside the clip's source.",
    ]);
    const right = await editTimelineTool(ctx, { project_id: id, expected_version: 0, ops: [{ op: "add_clip", trackId: "v1", clip: clip(video, { duration: 375 }) }] });
    expect(right.text.split("\n")[0]).toBe("Applied 1 op as version 1.");
  });

  it("says which kind an asset is when the clip's type is wrong", async () => {
    const { db, ctx, id } = await setup();
    const image = await insertAsset(db, { kind: "image", name: "field", durationMs: null });
    const result = await editTimelineTool(ctx, { project_id: id, expected_version: 0, ops: [{ op: "add_clip", trackId: "v1", clip: clip(image) }] });
    expect(result.text).toContain(`Asset "${image}" is an image. Set the clip's "type" to "image" and put it on a track that takes it.`);
  });

  it("still refuses replace_track", async () => {
    const { ctx, id } = await setup();
    const result = await editTimelineTool(ctx, { project_id: id, expected_version: 0, ops: [{ op: "replace_track", track: {}, index: 0 }] });
    expect(result.text).toContain("is not available here.");
  });

  it("a text-only batch makes no asset query", async () => {
    const { db, ctx, id } = await setup();
    await db.execute(sql`drop table assets`);
    const text = { type: "text", start: 0, duration: 30, text: "GO SOLVERS", transform: { ...T, fit: "contain" }, style: { fontFamily: "Geist", fontSize: 96, fontWeight: 700, color: "#ffffff", align: "center" } };
    const result = await editTimelineTool(ctx, { project_id: id, expected_version: 0, ops: [{ op: "add_clip", trackId: "t1", clip: text }] });
    expect(result.text.split("\n")[0]).toBe("Applied 1 op as version 1.");
  });
  it("names the first op whose media can't be used, and each reason", async () => {
    const { db, ctx, video, id } = await setup();
    const removed = await insertAsset(db, { removedAt: new Date(), removedBy: "u1" });
    const uploading = await insertAsset(db, { status: "uploading", readyAt: null, uploadUrl: "https://upload.test/s" });
    const music = await insertAsset(db, { kind: "audio", name: "theme", width: null, height: null, fps: null, videoCodec: null, previewStatus: "none" });
    const edit = (ops: unknown[]) => editTimelineTool(ctx, { project_id: id, expected_version: 0, ops });
    const lines = async (ops: unknown[]) => (await edit(ops)).text.split("\n");
    expect(await lines([{ op: "add_clip", trackId: "v1", clip: clip(video) }, { op: "update_clip", clipId: "c1", patch: { assetId: removed } }])).toEqual([
      "Edit refused: ops[1] (update_clip) names media that can't be used.",
      `Asset "${removed}" was removed from the library. Call list_assets to see what is there.`,
      "Nothing was applied.",
    ]);
    expect((await lines([{ op: "add_clip", trackId: "v1", clip: clip(uploading) }, { op: "add_clip", trackId: "v1", clip: clip("made-up-id") }]))[1]).toBe(
      `Asset "${uploading}" is still uploading. Try again once list_assets shows it.`,
    );
    expect((await lines([{ op: "add_clip", trackId: "v1", clip: clip(music) }]))[1]).toBe(
      `Asset "${music}" is audio. Set the clip's "type" to "audio" and put it on a track that takes it.`,
    );
    expect((await lines([{ op: "add_clip", trackId: "a1", clip: clip(video, { type: "audio" }) }]))[1]).toBe(
      `Asset "${video}" is a video. Set the clip's "type" to "video" and put it on a track that takes it.`,
    );
    // An update_clip is not checked for kind: its clip's type is known only once the project is read.
    expect(await lines([{ op: "update_clip", clipId: "c1", patch: { assetId: music } }])).toEqual([
      "Edit refused: ops[0] (update_clip) failed with NOT_FOUND.",
      expect.any(String),
      expect.any(String),
      "Nothing was applied.",
    ]);
    expect((await getProject(db, ctx.actor, id))!.version).toBe(0);
  });

  it("prints an id it was sent on one line", async () => {
    const { ctx, id } = await setup();
    const result = await editTimelineTool(ctx, { project_id: id, expected_version: 0, ops: [{ op: "add_clip", trackId: "v1", clip: clip("made\nup") }] });
    expect(result.text.split("\n")).toEqual([
      "Edit refused: ops[0] (add_clip) names media that can't be used.",
      'No asset with id "made up". Call list_assets to see the ids.',
      "Nothing was applied.",
    ]);
  });

  it("leaves ops of another shape to the engine, with no asset query", async () => {
    const { db, ctx, id } = await setup();
    await db.execute(sql`drop table assets`);
    const text = { type: "text", start: 0, duration: 30, text: "GO SOLVERS", assetId: "made-up-id", transform: { ...T, fit: "contain" }, style: { fontFamily: "Geist", fontSize: 96, fontWeight: 700, color: "#ffffff", align: "center" } };
    const result = await editTimelineTool(ctx, { project_id: id, expected_version: 0, ops: [{ op: "add_clip", trackId: "t1", clip: text }] });
    expect(result.text.split("\n")[0]).toBe("Applied 1 op as version 1.");
    const numbered = await editTimelineTool(ctx, { project_id: id, expected_version: 1, ops: [{ op: "add_clip", trackId: "v1", clip: clip("x", { assetId: 42 }) }, { op: "update_clip", clipId: "c1", patch: { assetId: null } }] });
    expect(numbered.text.split("\n")[0]).toBe("Edit refused: ops[0] (add_clip) failed with INVALID.");
  });
});
