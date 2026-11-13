import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { assetIdsToCheck, assetTrouble, findMediaProblem, mediaProblemMessage, type MediaProblem } from "@/lib/media/refs";
import { openUpload, removeAsset, type AssetFact } from "@/lib/media/service";
import { applyProjectOps, createProject, getProject } from "@/lib/projects/service";
import { applyOps, createEmptyDoc, prepareOps, type OpInput, type TimelineDoc } from "@/lib/timeline";
import { AUDIO, CLIP_TRANSFORM as T, IMAGE, VIDEO, insertAsset, mediaClip, mediaContext, readyAsset } from "../media/context";

const clip = (type: string, assetId: string, over: Record<string, unknown> = {}) => mediaClip(assetId, { id: "c1", type, ...over });
const add = (c: unknown, trackId = "v1") => ({ op: "add_clip", trackId, clip: c });

async function setup() {
  const ctx = await mediaContext();
  const video = await readyAsset(ctx, ctx.ada, VIDEO); // 12.5 s: 375 frames at 30 fps
  const { id } = await createProject(ctx.db, ctx.ada, { name: "Recap", format: "short_9x16" });
  const send = (ops: unknown[], baseVersion: number) => applyProjectOps(ctx.db, ctx.ada, { projectId: id, baseVersion, ops: ops as OpInput[] });
  return { ctx, video, id, send };
}

describe("a project's media must exist", () => {
  it("1. takes a clip of a ready asset of the same kind", async () => {
    const { video, send } = await setup();
    expect((await send([add(clip("video", video.id))], 0)).version).toBe(1);
  });

  it("1. refuses a clip whose asset is not in the library", async () => {
    const { ctx, id, send } = await setup();
    await expect(send([{ op: "update_track", trackId: "t1", patch: { name: "Titles" } }, add(clip("video", "made-up-id"))], 0)).rejects.toMatchObject({
      code: "INVALID", status: 400, opIndex: 1, message: 'add_clip (op 1): asset "made-up-id" is not in the library',
    });
    expect((await getProject(ctx.db, ctx.ada, id))!.version).toBe(0); // nothing was applied, not even the first op
  });

  it("1. refuses a removed asset, an unfinished upload and the wrong kind", async () => {
    const { ctx, send } = await setup();
    const image = await readyAsset(ctx, ctx.ada, IMAGE);
    const gone = await readyAsset(ctx, ctx.ada, AUDIO);
    await removeAsset(ctx.deps, ctx.ada, gone.id);
    const pending = await openUpload(ctx.deps, ctx.ada, { ...VIDEO, fileName: "later.mov" });
    await expect(send([add(clip("audio", gone.id), "a1")], 0)).rejects.toMatchObject({ code: "INVALID", message: `add_clip (op 0): asset "${gone.id}" was removed from the library` });
    await expect(send([add(clip("video", pending.asset.id))], 0)).rejects.toMatchObject({ message: `add_clip (op 0): asset "${pending.asset.id}" is still uploading` });
    await expect(send([add(clip("video", image.id))], 0)).rejects.toMatchObject({ message: `add_clip (op 0): asset "${image.id}" is an image, so it cannot be used by a video clip` });
    expect((await send([add(clip("image", image.id))], 0)).version).toBe(1);
  });

  it("1. checks an update_clip that points a clip at another asset", async () => {
    const { video, send } = await setup();
    await send([add(clip("video", video.id))], 0);
    await expect(send([{ op: "update_clip", clipId: "c1", patch: { assetId: "made-up-id" } }], 1)).rejects.toMatchObject({ code: "INVALID", opIndex: 0, message: 'update_clip (op 0): asset "made-up-id" is not in the library' });
  });

  it("2. refuses a clip that runs past the end of its media", async () => {
    const { video, send } = await setup();
    await expect(send([add(clip("video", video.id, { duration: 376 }))], 0)).rejects.toMatchObject({
      code: "TRIM_OUT_OF_RANGE", opIndex: 0, message: 'add_clip (op 0): clip "c1" would run past the end of its media, which is 375 frames long',
    });
    await expect(send([add(clip("video", video.id, { in: 100, duration: 276 }))], 0)).rejects.toMatchObject({ code: "TRIM_OUT_OF_RANGE" });
    await expect(send([add(clip("video", video.id, { speed: 2, duration: 188 }))], 0)).rejects.toMatchObject({ code: "TRIM_OUT_OF_RANGE" }); // 376 source frames
    expect((await send([add(clip("video", video.id, { speed: 2, duration: 187 }))], 0)).version).toBe(1); // 374
  });

  it("2. checks a trim and a speed change, and names the op that did it", async () => {
    const { video, send } = await setup();
    await send([add(clip("video", video.id, { duration: 375 }))], 0);
    await expect(send([{ op: "trim_clip", clipId: "c1", edge: "end", to: 376 }], 1)).rejects.toMatchObject({ code: "TRIM_OUT_OF_RANGE", opIndex: 0, message: 'trim_clip (op 0): clip "c1" would run past the end of its media, which is 375 frames long' });
    await expect(send([{ op: "trim_clip", clipId: "c1", edge: "end", to: 200 }, { op: "update_clip", clipId: "c1", patch: { speed: 2 } }], 1)).rejects.toMatchObject({ code: "TRIM_OUT_OF_RANGE", opIndex: 1 }); // 400
    expect((await send([{ op: "trim_clip", clipId: "c1", edge: "end", to: 180 }, { op: "update_clip", clipId: "c1", patch: { speed: 2 } }], 1)).version).toBe(2); // 360
  });

  it("2. an image has no length", async () => {
    const { ctx, send } = await setup();
    const image = await readyAsset(ctx, ctx.ada, IMAGE);
    expect((await send([add(clip("image", image.id, { duration: 9000 }))], 0)).version).toBe(1);
  });

  it("2. refuses one frame over at a speed that is not whole", async () => {
    const { video, send } = await setup();
    await send([add(clip("video", video.id, { speed: 1.5, duration: 250 }))], 0); // 375 source frames
    expect((await send([{ op: "trim_clip", clipId: "c1", edge: "start", to: 1 }], 1)).version).toBe(2); // in 1 (the clip ends at 375, and 249 × 1.5 rounds to 374), so it still ends at 375
    expect((await send([{ op: "update_clip", clipId: "c1", patch: { volume: 0 } }], 2)).version).toBe(3); // a patch without assetId, in or speed is not checked
    await expect(send([{ op: "trim_clip", clipId: "c1", edge: "end", to: 251 }], 3)).rejects.toMatchObject({ code: "TRIM_OUT_OF_RANGE" }); // 1 + 375 = 376
  });

  it("3. does not check a split, a move or a delete", async () => {
    const { video, send } = await setup();
    await send([add(clip("video", video.id, { speed: 1.5, duration: 250 }))], 0); // 375 source frames
    expect((await send([{ op: "split_clip", clipId: "c1", at: 3 }], 1)).version).toBe(2); // neither half uses more than the clip did
    expect((await send([{ op: "move_clip", clipId: "c1", start: 600 }], 2)).version).toBe(3);
  });

  it("3. a deleted clip cannot be brought back once its media is removed", async () => {
    const { ctx, video, send } = await setup();
    await send([add(clip("video", video.id))], 0);
    const removed = await send([{ op: "remove_clip", clipId: "c1" }], 1);
    await removeAsset(ctx.deps, ctx.ada, video.id);
    await expect(send(removed.inverse, 2)).rejects.toMatchObject({ code: "INVALID" });
  });

  it("3. a deleted track comes back with its clips, even one whose media is removed", async () => {
    const { ctx, video, id, send } = await setup();
    await send([add(clip("video", video.id))], 0);
    const removed = await send([{ op: "remove_track", trackId: "v1" }], 1);
    await removeAsset(ctx.deps, ctx.ada, video.id); // allowed: no project uses the asset once the track is gone
    expect((await send(removed.inverse, 2)).version).toBe(3);
    const doc = (await getProject(ctx.db, ctx.ada, id))!.doc;
    expect(doc.tracks.find((t) => t.id === "v1")!.clips[0]).toMatchObject({ id: "c1", assetId: video.id });
  });

  it("4. a change that touches no media never reads the assets table", async () => {
    const { ctx, video, send } = await setup();
    await send([add(clip("video", video.id))], 0);
    await ctx.db.execute(sql`drop table assets`);
    const textClip = { type: "text", start: 0, duration: 30, text: "GO SOLVERS", transform: { ...T, fit: "contain" }, style: { fontFamily: "Geist", fontSize: 96, fontWeight: 700, color: "#ffffff", align: "center" } };
    expect((await send([add(textClip, "t1"), { op: "move_clip", clipId: "c1", start: 30 }], 1)).version).toBe(2);
    await expect(send([{ op: "trim_clip", clipId: "c1", edge: "end", to: 60 }], 2)).rejects.toThrow(); // this one needs the table
  });
});

// Beyond the brief's cases: the same rules, numbered the same way.
describe("a project's media must exist: more of each rule", () => {
  const splits = (n: number) => Array.from({ length: n }, (_, i) => ({ op: "split_clip", clipId: `s${i}`, at: i + 1, newClipId: `s${i + 1}` }));
  const track = (clips: unknown[]) => ({ id: "v1", kind: "video", name: "Video 1", muted: false, hidden: false, locked: false, clips });

  it("1. checks the kind, and the rest, when an update_clip points a clip at another asset", async () => {
    const { ctx, video, send } = await setup();
    const image = await readyAsset(ctx, ctx.ada, IMAGE);
    const other = await insertAsset(ctx.db);
    const removed = await insertAsset(ctx.db, { removedAt: new Date(), removedBy: "u1" });
    const pending = await insertAsset(ctx.db, { status: "uploading", readyAt: null });
    await send([add(clip("video", video.id))], 0);
    const point = (assetId: string) => send([{ op: "update_clip", clipId: "c1", patch: { assetId } }], 1);
    await expect(point(image.id)).rejects.toMatchObject({ code: "INVALID", opIndex: 0, message: `update_clip (op 0): asset "${image.id}" is an image, so it cannot be used by a video clip` });
    await expect(point(removed)).rejects.toMatchObject({ code: "INVALID", message: `update_clip (op 0): asset "${removed}" was removed from the library` });
    await expect(point(pending)).rejects.toMatchObject({ code: "INVALID", message: `update_clip (op 0): asset "${pending}" is still uploading` });
    expect((await point(other)).version).toBe(2);
  });

  it("2. checks an update_clip that sets in, or points the clip at shorter media", async () => {
    const { ctx, video, send } = await setup();
    const short = await insertAsset(ctx.db, { durationMs: 4_000 }); // 120 frames
    await send([add(clip("video", video.id, { duration: 375 }))], 0);
    await expect(send([{ op: "update_clip", clipId: "c1", patch: { in: 1 } }], 1)).rejects.toMatchObject({
      code: "TRIM_OUT_OF_RANGE", status: 400, opIndex: 0, message: 'update_clip (op 0): clip "c1" would run past the end of its media, which is 375 frames long',
    });
    await expect(send([{ op: "update_clip", clipId: "c1", patch: { assetId: short } }], 1)).rejects.toMatchObject({
      code: "TRIM_OUT_OF_RANGE", opIndex: 0, message: 'update_clip (op 0): clip "c1" would run past the end of its media, which is 120 frames long',
    });
    expect((await send([{ op: "trim_clip", clipId: "c1", edge: "end", to: 120 }, { op: "update_clip", clipId: "c1", patch: { assetId: short } }], 1)).version).toBe(2);
  });

  it("2. rounds the frames a clip uses to the nearest whole one, and allows none over at any speed", async () => {
    const { video, send } = await setup();
    const past = { code: "TRIM_OUT_OF_RANGE", status: 400, opIndex: 0, message: 'add_clip (op 0): clip "c1" would run past the end of its media, which is 375 frames long' };
    await expect(send([add(clip("video", video.id, { speed: 1.5, duration: 251 }))], 0)).rejects.toMatchObject(past); // 376.5 rounds to 377
    await expect(send([add(clip("video", video.id, { speed: 0.9, duration: 418 }))], 0)).rejects.toMatchObject(past); // 376.2 rounds to 376: one frame over
    await expect(send([add(clip("video", video.id, { speed: 0.7, duration: 537 }))], 0)).rejects.toMatchObject(past); // 375.9 rounds up to 376
    await expect(send([add(clip("video", video.id, { speed: 1.5, duration: 250, in: 1 }))], 0)).rejects.toMatchObject(past); // 1 + 375
    await expect(send([add(clip("video", video.id, { speed: 0.5, duration: 751 }))], 0)).rejects.toMatchObject(past); // 375.5 rounds up to 376
    expect((await send([add(clip("video", video.id, { speed: 0.9, duration: 417 }))], 0)).version).toBe(1); // 375.3 rounds down to 375
    await expect(send([{ op: "trim_clip", clipId: "c1", edge: "end", to: 418 }], 1)).rejects.toMatchObject({ code: "TRIM_OUT_OF_RANGE", opIndex: 0 }); // 376.2
    await expect(send([{ op: "update_clip", clipId: "c1", patch: { in: 1 } }], 1)).rejects.toMatchObject({ code: "TRIM_OUT_OF_RANGE", opIndex: 0 }); // 1 + 375
    await expect(send([{ op: "update_clip", clipId: "c1", patch: { speed: 0.901 } }], 1)).rejects.toMatchObject({ code: "TRIM_OUT_OF_RANGE", opIndex: 0 }); // 375.7
  });

  it("2. checks an audio clip", async () => {
    const { ctx, send } = await setup();
    const audio = await readyAsset(ctx, ctx.ada, AUDIO); // 95 s: 2,850 frames
    await expect(send([add(clip("audio", audio.id, { duration: 2851 }), "a1")], 0)).rejects.toMatchObject({
      code: "TRIM_OUT_OF_RANGE", message: 'add_clip (op 0): clip "c1" would run past the end of its media, which is 2850 frames long',
    });
    expect((await send([add(clip("audio", audio.id, { duration: 2850 }), "a1")], 0)).version).toBe(1);
  });

  it("2. does not check media with no known length, or an image clip whatever its asset says", async () => {
    const { ctx, send } = await setup();
    const unknown = await insertAsset(ctx.db, { durationMs: null });
    const image = await insertAsset(ctx.db, { kind: "image", durationMs: 1_000 });
    expect((await send([add(clip("video", unknown, { duration: 9000 }))], 0)).version).toBe(1);
    expect((await send([add(clip("image", image, { id: "c2", start: 9000, duration: 9000 }))], 1)).version).toBe(2);
    expect((await send([{ op: "trim_clip", clipId: "c2", edge: "end", to: 27_000 }], 2)).version).toBe(3);
  });

  it("2. does not check the length of a clip that the batch removes again", async () => {
    const { video, send } = await setup();
    expect((await send([add(clip("video", video.id, { duration: 376 })), { op: "remove_clip", clipId: "c1" }], 0)).version).toBe(1);
  });

  it("2. a clip of removed media can still be trimmed, within the media's length", async () => {
    const { ctx, video, send } = await setup();
    await send([add(clip("video", video.id))], 0);
    const removed = await send([{ op: "remove_track", trackId: "v1" }], 1);
    await removeAsset(ctx.deps, ctx.ada, video.id);
    await send(removed.inverse, 2);
    expect((await send([{ op: "trim_clip", clipId: "c1", edge: "end", to: 60 }], 3)).version).toBe(4);
    await expect(send([{ op: "trim_clip", clipId: "c1", edge: "end", to: 376 }], 4)).rejects.toMatchObject({ code: "TRIM_OUT_OF_RANGE", opIndex: 0 });
  });

  // A split and a start trim count a clip's new `in` back from where the clip ends in its media, so cutting and
  // trimming a clip that ends on the last frame of its media leaves the piece ending on that same frame, however
  // often it is done.
  const fullAt = async (speed: number, duration: number) => {
    const made = await setup();
    await made.send([add(clip("video", made.video.id, { duration: 375 }))], 0);
    await made.send([{ op: "trim_clip", clipId: "c1", edge: "end", to: duration }, { op: "update_clip", clipId: "c1", patch: { speed } }], 1); // the whole 375 frames, re-timed
    const clips = async () => (await getProject(made.ctx.db, made.ctx.ada, made.id))!.doc.tracks.flatMap((t) => t.clips);
    const uses = async () => (await clips()).map((c) => (c.type === "text" ? 0 : c.in + Math.round(c.duration * c.speed)));
    return { ...made, clips, uses };
  };

  it("2. three cuts of a whole clip at speed 1.5 leave every piece inside its media, still trimmable and undoable", async () => {
    const { send, clips, uses } = await fullAt(1.5, 250);
    expect(await uses()).toEqual([375]);
    expect((await send([{ op: "split_clip", clipId: "c1", at: 51, newClipId: "c2" }], 2)).version).toBe(3);
    expect((await send([{ op: "split_clip", clipId: "c2", at: 102, newClipId: "c3" }], 3)).version).toBe(4);
    expect((await send([{ op: "split_clip", clipId: "c3", at: 153, newClipId: "c4" }], 4)).version).toBe(5);
    expect((await clips()).map((c) => c.id)).toEqual(["c1", "c2", "c3", "c4"]);
    for (const used of await uses()) expect(used).toBeLessThanOrEqual(375);
    expect((await clips())[3]).toMatchObject({ id: "c4", start: 153, duration: 97, in: 229 }); // 229 + 146 ends at 375, where the clip did
    // The last piece: its start can be trimmed, and an end trim of it can be undone.
    expect((await send([{ op: "trim_clip", clipId: "c4", edge: "start", to: 160 }], 5)).version).toBe(6);
    const shorter = await send([{ op: "trim_clip", clipId: "c4", edge: "end", to: 240 }], 6); // in by 10 frames
    expect(shorter.version).toBe(7);
    expect(shorter.inverse).toEqual([{ op: "trim_clip", clipId: "c4", edge: "end", to: 250, expect: { start: 160, duration: 80 } }]);
    expect((await send(shorter.inverse, 7)).version).toBe(8);
    expect((await clips())[3]).toMatchObject({ id: "c4", start: 160, duration: 90, in: 240 }); // 240 + 135 = 375
    for (const used of await uses()) expect(used).toBeLessThanOrEqual(375);
  });

  it.each([[1.5, 250], [0.5, 750]])("2. ten one-frame start trims in ten requests at speed %s are each taken, and each can be undone", async (speed, duration) => {
    const { send, clips, uses } = await fullAt(speed, duration);
    const whole = await clips();
    expect(await uses()).toEqual([375]); // it ends on the last frame of its media
    const undo: unknown[][] = [];
    for (let to = 1; to <= 10; to++) {
      const trimmed = await send([{ op: "trim_clip", clipId: "c1", edge: "start", to }], to + 1);
      expect(trimmed.version).toBe(to + 2);
      undo.push(trimmed.inverse);
      expect((await clips())[0]).toMatchObject({ start: to, duration: duration - to });
      expect((await uses())[0]).toBeLessThanOrEqual(375);
    }
    for (let i = 9; i >= 0; i--) expect((await send(undo[i], 21 - i)).version).toBe(22 - i); // newest first
    expect(await clips()).toEqual(whole);
  });

  // 45 × 0.7 is 31.499999999999996 in floating point, so the clip uses 31 frames and ends on 375; 35 × 0.7 is 24.5.
  it("2. at speed 0.7 a split and a start trim of a clip that ends on the last frame stay inside the media", async () => {
    const { video, send, ctx, id } = await setup();
    const clips = async () => (await getProject(ctx.db, ctx.ada, id))!.doc.tracks.flatMap((t) => t.clips);
    expect((await send([add(clip("video", video.id, { in: 344, duration: 45, speed: 0.7 }))], 0)).version).toBe(1);
    const trimmed = await send([{ op: "trim_clip", clipId: "c1", edge: "start", to: 10 }], 1); // in by 10 frames
    expect(trimmed.version).toBe(2);
    expect((await clips())[0]).toMatchObject({ start: 10, duration: 35, in: 350 }); // 350 + 25 = 375
    expect((await send(trimmed.inverse, 2)).version).toBe(3);
    expect((await send([{ op: "split_clip", clipId: "c1", at: 10, newClipId: "c2" }], 3)).version).toBe(4);
    const [, right] = await clips();
    expect(right).toMatchObject({ id: "c2", start: 10, duration: 35, in: 350 });
    expect(right.type !== "text" && right.in + Math.round(right.duration * right.speed)).toBeLessThanOrEqual(375);
    const shorter = await send([{ op: "trim_clip", clipId: "c2", edge: "end", to: 35 }], 4); // in by 10 frames
    expect(shorter.version).toBe(5);
    expect((await send(shorter.inverse, 5)).version).toBe(6);
    expect((await clips())[1]).toMatchObject({ id: "c2", start: 10, duration: 35, in: 350 });
  });

  it.each([1.5, 0.5])("2. a start trimmed in by one frame at speed %s can be trimmed back out to `in` 0", async (speed) => {
    const { video, send, ctx, id } = await setup();
    const first = async () => (await getProject(ctx.db, ctx.ada, id))!.doc.tracks.flatMap((t) => t.clips)[0];
    expect((await send([add(clip("video", video.id, { start: 10, duration: 100, speed }))], 0)).version).toBe(1);
    expect((await send([{ op: "trim_clip", clipId: "c1", edge: "start", to: 11 }], 1)).version).toBe(2);
    expect((await send([{ op: "trim_clip", clipId: "c1", edge: "start", to: 10 }], 2)).version).toBe(3);
    expect(await first()).toMatchObject({ start: 10, duration: 100, in: 0 });
  });

  it("3. replace_track is not checked, and a clip it brought in is checked only when it is trimmed or re-timed", async () => {
    const { video, send } = await setup();
    const clips = [clip("video", "made-up-id"), clip("video", video.id, { id: "c2", start: 100, duration: 400 })]; // c2 is 25 frames too long
    expect((await send([{ op: "replace_track", track: track(clips), index: 0 }], 0)).version).toBe(1);
    expect((await send([{ op: "update_clip", clipId: "c2", patch: { volume: 0.5, transform: { opacity: 0.5 } } }], 1)).version).toBe(2);
    expect((await send([{ op: "move_clip", clipId: "c2", start: 200 }], 2)).version).toBe(3);
    expect((await send([{ op: "split_clip", clipId: "c2", at: 210, newClipId: "c3" }], 3)).version).toBe(4); // c3 is the part that is too long
    expect((await send([{ op: "move_clip", clipId: "c3", start: 700 }, { op: "update_track", trackId: "v1", patch: { muted: true } }, { op: "set_format", format: "long_16x9" }], 4)).version).toBe(5);
    await expect(send([{ op: "trim_clip", clipId: "c3", edge: "end", to: 1089 }], 5)).rejects.toMatchObject({ code: "TRIM_OUT_OF_RANGE", opIndex: 0 }); // one frame shorter, still 24 too long
    await expect(send([{ op: "update_clip", clipId: "c3", patch: { speed: 0.99 } }], 5)).rejects.toMatchObject({ code: "TRIM_OUT_OF_RANGE", opIndex: 0 });
    // The clip of the asset that is not in the library has no known length. It can be trimmed, re-timed and deleted, and not brought back.
    expect((await send([{ op: "trim_clip", clipId: "c1", edge: "end", to: 50 }, { op: "update_clip", clipId: "c1", patch: { speed: 2, in: 5 } }], 5)).version).toBe(6);
    const deleted = await send([{ op: "remove_clip", clipId: "c1" }], 6);
    await expect(send(deleted.inverse, 7)).rejects.toMatchObject({ code: "INVALID", message: 'add_clip (op 0): asset "made-up-id" is not in the library' });
  });

  it("4. finds a trimmed clip in the document after the batch, not the one before it", async () => {
    const { video, send } = await setup();
    const tooLong = clip("video", video.id, { duration: 400 });
    await expect(send([{ op: "replace_track", track: track([tooLong]), index: 0 }, { op: "trim_clip", clipId: "c1", edge: "end", to: 380 }], 0)).rejects.toMatchObject({
      code: "TRIM_OUT_OF_RANGE", opIndex: 1, message: 'trim_clip (op 1): clip "c1" would run past the end of its media, which is 375 frames long',
    });
    expect((await send([{ op: "replace_track", track: track([tooLong]), index: 0 }, { op: "trim_clip", clipId: "c1", edge: "end", to: 375 }], 0)).version).toBe(1);
  });

  it("4. is made before the size checks", async () => {
    const { ctx, send } = await setup();
    const long = await insertAsset(ctx.db, { durationMs: 40_000 }); // 1,200 frames
    await send([add(clip("video", long, { id: "s0", duration: 1000 }))], 0);
    const lost = add(clip("video", "made-up-id", { id: "c9", start: 2000 }));
    await expect(send([...splits(251), lost], 1)).rejects.toMatchObject({ code: "INVALID", opIndex: 251, message: 'add_clip (op 251): asset "made-up-id" is not in the library' });
    await expect(send(splits(251), 1)).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });

  it("4. checks the document the write would produce, not the one the caller last saw", async () => {
    const { video, send } = await setup();
    await send([add(clip("video", video.id, { duration: 180 }))], 0);
    await send([{ op: "update_clip", clipId: "c1", patch: { speed: 2 } }], 1); // someone else: 360 source frames
    await expect(send([{ op: "trim_clip", clipId: "c1", edge: "end", to: 190 }], 1)).rejects.toMatchObject({ code: "TRIM_OUT_OF_RANGE", opIndex: 0 }); // 380
    expect((await send([{ op: "trim_clip", clipId: "c1", edge: "end", to: 187 }], 1)).version).toBe(3); // 374
  });
});

describe("the media check, with facts and no database", () => {
  const fact = (id: string, over: Partial<AssetFact> = {}): AssetFact => ({ id, kind: "video", ready: true, removed: false, durationMs: 12_500, ...over });
  const FACTS = new Map([fact("A"), fact("B"), fact("C"), fact("D"), fact("I", { kind: "image", durationMs: null }), fact("S", { kind: "audio", durationMs: 95_000 })].map((f) => [f.id, f]));
  const text = { id: "x1", type: "text", start: 0, duration: 30, text: "GO", transform: T, style: { fontFamily: "Geist", fontSize: 96, fontWeight: 700, color: "#ffffff", align: "center" } };
  const media = (id: string, type: string, assetId: string, start: number) => mediaClip(assetId, { id, type, start });

  // v1: c3 (C) at 0, i1 (image I) at 100, c4 (D) at 200. t1: x1. a1: au1 (audio S).
  const BASE = applyOps(createEmptyDoc("short_9x16"), prepareOps([
    add(media("c3", "video", "C", 0)), add(media("i1", "image", "I", 100)), add(media("c4", "video", "D", 200)), add(text, "t1"), add(media("au1", "audio", "S", 0), "a1"),
  ] as OpInput[])).doc;

  function run(inputs: unknown[], base: TimelineDoc = BASE) {
    const ops = prepareOps(inputs as OpInput[]);
    const after = applyOps(base, ops).doc;
    return { ops, after, ids: assetIdsToCheck(after, ops), problem: findMediaProblem(after, ops, FACTS) };
  }

  it("1. assetTrouble makes its checks in order, and checks the kind only when it is given one", () => {
    expect(assetTrouble(undefined, "video")).toBe("missing");
    expect(assetTrouble(fact("A", { removed: true, ready: false, kind: "image" }), "video")).toBe("removed");
    expect(assetTrouble(fact("A", { ready: false, kind: "image" }), "video")).toBe("not_ready");
    expect(assetTrouble(fact("A", { kind: "image" }), "video")).toBe("wrong_kind");
    expect(assetTrouble(fact("A", { kind: "image" }))).toBeNull();
    expect(assetTrouble(fact("A"), "video")).toBeNull();
    expect(assetTrouble(undefined)).toBe("missing");
  });

  it("4. names the assets of clips that were added, pointed elsewhere, trimmed or re-timed, each once", () => {
    const { ids } = run([
      add(media("c1", "video", "A", 400)),
      add(media("c2", "video", "A", 500)),
      { op: "update_clip", clipId: "c2", patch: { assetId: "B" } },
      { op: "trim_clip", clipId: "i1", edge: "end", to: 150 },
      { op: "update_clip", clipId: "au1", patch: { speed: 2 } },
      { op: "update_clip", clipId: "c3", patch: { in: 5 } },
      { op: "trim_clip", clipId: "c3", edge: "end", to: 60 },
      { op: "trim_clip", clipId: "x1", edge: "end", to: 60 },
      { op: "update_clip", clipId: "c4", patch: { volume: 0.5, transform: { opacity: 0.5 } } },
      { op: "move_clip", clipId: "c4", start: 700 },
    ]);
    expect(ids).toEqual(["A", "B", "I", "S", "C"]);
  });

  it("4. names nothing for ops that are never checked", () => {
    const whole = { id: "o1", kind: "overlay", name: "Overlay 1", muted: false, hidden: false, locked: false, clips: [media("z1", "video", "Z", 0)] };
    expect(run([
      add({ ...text, id: "x2", start: 100 }, "t1"),
      { op: "update_clip", clipId: "c4", patch: { volume: 0 } },
      { op: "update_clip", clipId: "x1", patch: { text: "GO SOLVERS" } },
      { op: "split_clip", clipId: "c4", at: 210, newClipId: "c5" },
      { op: "move_clip", clipId: "c5", start: 900 },
      { op: "remove_clip", clipId: "c3" },
      { op: "add_track", track: { id: "n1", kind: "audio", name: "Music" } },
      { op: "update_track", trackId: "v1", patch: { muted: true } },
      { op: "move_track", trackId: "t1", index: 0 },
      { op: "remove_track", trackId: "a1" },
      { op: "replace_track", track: whole, index: 1 },
      { op: "set_format", format: "long_16x9" },
    ])).toMatchObject({ ids: [], problem: null });
    // A clip that was trimmed or re-timed and is gone after the batch names nothing either.
    expect(run([{ op: "trim_clip", clipId: "c4", edge: "end", to: 250 }, { op: "update_clip", clipId: "c4", patch: { speed: 2 } }, { op: "remove_clip", clipId: "c4" }])).toMatchObject({ ids: [], problem: null });
  });

  it("3. a clip that is already too long can be split, moved, restyled and deleted", () => {
    const whole = (clips: unknown[]) => ({ op: "replace_track", track: { id: "o1", kind: "overlay", name: "Overlay 1", muted: false, hidden: false, locked: false, clips }, index: 1 });
    const tooLong = applyOps(BASE, prepareOps([whole([{ ...media("z1", "video", "A", 0), duration: 400 }])] as OpInput[])).doc;
    expect(run([
      { op: "split_clip", clipId: "z1", at: 390, newClipId: "z2" }, // both halves reach past frame 375 of the media
      { op: "move_clip", clipId: "z2", start: 500 },
      { op: "move_clip", clipId: "z1", start: 300, trackId: "v1" },
      { op: "update_clip", clipId: "z2", patch: { volume: 0, transform: { scale: 2 } } },
      { op: "update_track", trackId: "o1", patch: { name: "B-roll" } },
      { op: "move_track", trackId: "o1", index: 0 },
      { op: "set_format", format: "square_1x1" },
    ], tooLong).problem).toBeNull();
    expect(run([{ op: "remove_clip", clipId: "z1" }], tooLong).problem).toBeNull();
    expect(run([whole([{ ...media("z1", "video", "nope", 0), duration: 9000 }])], tooLong).problem).toBeNull();
    expect(run([{ op: "trim_clip", clipId: "z1", edge: "end", to: 399 }], tooLong).problem).toMatchObject({ code: "past_end", clipId: "z1" });
  });

  it("1. tells what is wrong with the asset, the op and the clip", () => {
    expect(run([{ op: "update_track", trackId: "v1", patch: { name: "Main" } }, add(media("c1", "video", "nope", 400))]).problem).toEqual({ code: "missing", assetId: "nope", opIndex: 1, clipId: "c1" });
    expect(run([add(media("c1", "video", "S", 400))]).problem).toEqual({ code: "wrong_kind", assetId: "S", opIndex: 0, clipId: "c1", assetKind: "audio", clipType: "video" });
    expect(run([{ op: "update_clip", clipId: "i1", patch: { assetId: "A" } }]).problem).toEqual({ code: "wrong_kind", assetId: "A", opIndex: 0, clipId: "i1", assetKind: "video", clipType: "image" });
    expect(run([{ op: "update_clip", clipId: "i1", patch: { assetId: "I" } }, { op: "update_clip", clipId: "c4", patch: { assetId: "A" } }]).problem).toBeNull();
  });

  it("1. an update_clip of a clip that the batch then removes is checked for all but the kind", () => {
    expect(run([{ op: "update_clip", clipId: "c4", patch: { assetId: "I" } }, { op: "remove_clip", clipId: "c4" }]).problem).toBeNull();
    expect(run([{ op: "update_clip", clipId: "c4", patch: { assetId: "nope" } }, { op: "remove_clip", clipId: "c4" }]).problem).toEqual({ code: "missing", assetId: "nope", opIndex: 0, clipId: "c4" });
  });

  it("2. tells the clip, its asset, the media's length and the last op that touched the clip", () => {
    const long = { op: "trim_clip", clipId: "c4", edge: "end", to: 576 }; // 376 frames of 375
    expect(run([long]).problem).toEqual({ code: "past_end", assetId: "D", opIndex: 0, clipId: "c4", frames: 375 });
    expect(run([long, { op: "update_clip", clipId: "c4", patch: { volume: 0 } }, { op: "move_clip", clipId: "c4", start: 700 }]).problem).toMatchObject({ code: "past_end", opIndex: 0 });
    expect(run([long, { op: "update_track", trackId: "v1", patch: { muted: true } }, { op: "update_clip", clipId: "c4", patch: { in: 0 } }]).problem).toMatchObject({ code: "past_end", opIndex: 2 });
    expect(run([long, { op: "trim_clip", clipId: "c4", edge: "end", to: 575 }]).problem).toBeNull(); // what counts is the clip after the batch
  });

  it("2. counts the media's length in the project's frames", () => {
    const at60 = { ...BASE, fps: 60 }; // 12.5 s is 750 frames
    expect(run([{ op: "trim_clip", clipId: "c4", edge: "end", to: 950 }], at60).problem).toBeNull();
    expect(run([{ op: "trim_clip", clipId: "c4", edge: "end", to: 951 }], at60).problem).toEqual({ code: "past_end", assetId: "D", opIndex: 0, clipId: "c4", frames: 750 });
  });

  it("the first problem by op order is the one told, and an op's asset comes before its clip's length", () => {
    const tooLong = add({ ...media("c1", "video", "A", 1000), duration: 376 });
    const lost = add(media("c2", "video", "nope", 2000));
    expect(run([tooLong, lost]).problem).toMatchObject({ code: "past_end", opIndex: 0 });
    expect(run([lost, tooLong]).problem).toMatchObject({ code: "missing", opIndex: 0 });
    expect(run([tooLong, lost, { op: "trim_clip", clipId: "c1", edge: "end", to: 1377 }]).problem).toMatchObject({ code: "missing", opIndex: 1 }); // the length is now op 2's doing
    expect(run([add(media("c1", "video", "S", 1000))]).problem).toMatchObject({ code: "wrong_kind" });
    expect(run([add({ ...media("c1", "video", "S", 1000), duration: 9000 })]).problem).toMatchObject({ code: "wrong_kind", opIndex: 0 }); // not past_end
  });

  it("5. says each problem in the brief's words", () => {
    const ops = prepareOps([{ op: "update_track", trackId: "v1", patch: { muted: true } }, { op: "update_clip", clipId: "c4", patch: { assetId: "A" } }, { op: "trim_clip", clipId: "c4", edge: "end", to: 250 }] as OpInput[]);
    const told = (problem: Partial<MediaProblem>) => mediaProblemMessage({ code: "missing", assetId: "A", opIndex: 1, clipId: "c4", ...problem }, ops);
    expect(told({})).toBe('update_clip (op 1): asset "A" is not in the library');
    expect(told({ code: "removed" })).toBe('update_clip (op 1): asset "A" was removed from the library');
    expect(told({ code: "not_ready" })).toBe('update_clip (op 1): asset "A" is still uploading');
    expect(told({ code: "wrong_kind", assetKind: "video", clipType: "image" })).toBe('update_clip (op 1): asset "A" is a video, so it cannot be used by an image clip');
    expect(told({ code: "wrong_kind", assetKind: "image", clipType: "audio" })).toBe('update_clip (op 1): asset "A" is an image, so it cannot be used by an audio clip');
    expect(told({ code: "wrong_kind", assetKind: "audio", clipType: "video" })).toBe('update_clip (op 1): asset "A" is audio, so it cannot be used by a video clip');
    expect(told({ code: "past_end", opIndex: 2, frames: 375 })).toBe('trim_clip (op 2): clip "c4" would run past the end of its media, which is 375 frames long');
  });
});
