import { describe, expect, it } from "vitest";
import type { DB } from "@/db";
import type { Actor } from "@/lib/actor";
import { applyProjectOps, createProject, getProject } from "@/lib/projects/service";
import { DEFAULT_TRANSFORM, type Clip, type OpInput } from "@/lib/timeline";
import { makeTestDb } from "../helpers/db";

const editor: Actor = { userId: "u1", email: "u1@gmail.com", role: "editor" };

const video = (id: string, start: number, duration: number, extra: Record<string, unknown> = {}) =>
  ({ id, type: "video", assetId: "a", start, duration, in: 0, speed: 1, volume: 1, transform: { ...DEFAULT_TRANSFORM }, ...extra }) as Clip;
const text = (id: string, start: number, duration: number) =>
  ({ id, type: "text", start, duration, text: "hi", transform: { ...DEFAULT_TRANSFORM },
     style: { fontFamily: "Inter", fontSize: 64, fontWeight: 700, color: "#fff", align: "center" } }) as Clip;

const doc = async (db: DB, id: string) => (await getProject(db, editor, id))!.doc;

// Version 1: v1 [c1 0-30 (in 10, speed 1.5), c2 30-60, c3 60-90], o1 (empty overlay), t1 [x1 0-60].
async function seeded(db: DB): Promise<string> {
  const { id } = await createProject(db, editor, { name: "P", format: "short_9x16" });
  await applyProjectOps(db, editor, {
    projectId: id,
    baseVersion: 0,
    ops: [
      { op: "add_track", track: { id: "o1", kind: "overlay", name: "Overlay 1" }, index: 1 },
      { op: "add_clip", trackId: "v1", clip: video("c1", 0, 30, { in: 10, speed: 1.5 }) },
      { op: "add_clip", trackId: "v1", clip: video("c2", 30, 30) },
      { op: "add_clip", trackId: "v1", clip: video("c3", 60, 30) },
      { op: "add_clip", trackId: "t1", clip: text("x1", 0, 60) },
    ],
  });
  return id;
}

const CASES: [string, OpInput][] = [
  ["add_track", { op: "add_track", track: { id: "n1", kind: "audio", name: "Music" }, index: 2 }],
  ["remove_track", { op: "remove_track", trackId: "t1" }],
  ["update_track", { op: "update_track", trackId: "v1", patch: { name: "Main", muted: true } }],
  ["replace_track existing", { op: "replace_track", track: { id: "o1", kind: "overlay", name: "O", muted: false, hidden: false, locked: false, clips: [video("z", 0, 10)] }, index: 1 }],
  ["replace_track absent", { op: "replace_track", track: { id: "n2", kind: "overlay", name: "New", muted: false, hidden: false, locked: false, clips: [video("z", 0, 10)] }, index: 2 }],
  ["add_clip", { op: "add_clip", trackId: "v1", clip: video("c4", 90, 30) }],
  ["add_clip ripple", { op: "add_clip", trackId: "v1", clip: video("c4", 30, 15), ripple: true }],
  ["remove_clip", { op: "remove_clip", clipId: "c2" }],
  ["remove_clip ripple", { op: "remove_clip", clipId: "c1", ripple: true }],
  ["move_clip", { op: "move_clip", clipId: "c1", start: 5, trackId: "o1" }],
  ["trim_clip start", { op: "trim_clip", clipId: "c1", edge: "start", to: 5 }],
  ["trim_clip end", { op: "trim_clip", clipId: "c3", edge: "end", to: 70 }],
  ["split_clip", { op: "split_clip", clipId: "c1", at: 11, newClipId: "c5" }],
  ["update_clip", { op: "update_clip", clipId: "x1", patch: { text: "GO", style: { color: "#000" } } }],
  ["set_format", { op: "set_format", format: "long_16x9" }],
];

describe("every accepted change can be undone in one request", () => {
  it.each(CASES)("%s: the returned inverse undoes it, and that answer's inverse redoes it", async (_name, op) => {
    const db = await makeTestDb();
    const id = await seeded(db);
    const base = await doc(db, id);
    const edit = await applyProjectOps(db, editor, { projectId: id, baseVersion: 1, ops: [op] });
    const edited = await doc(db, id);
    expect(edited).not.toEqual(base);

    const undo = await applyProjectOps(db, editor, { projectId: id, baseVersion: edit.version, strict: true, ops: edit.inverse });
    expect(await doc(db, id)).toEqual(base);
    const redo = await applyProjectOps(db, editor, { projectId: id, baseVersion: undo.version, strict: true, ops: undo.inverse });
    expect(redo.version).toBe(4);
    expect(await doc(db, id)).toEqual(edited);
  });

  // Each split's inverse is two ops, so 250 splits undo with exactly 500 ops.
  const splits = (n: number): OpInput[] =>
    Array.from({ length: n }, (_, i) => ({ op: "split_clip", clipId: `s${i}`, at: i + 1, newClipId: `s${i + 1}` }));

  async function oneLongClip(db: DB): Promise<string> {
    const { id } = await createProject(db, editor, { name: "P", format: "short_9x16" });
    await applyProjectOps(db, editor, { projectId: id, baseVersion: 0, ops: [{ op: "add_clip", trackId: "v1", clip: video("s0", 0, 1000) }] });
    return id;
  }

  it("250 splits in one request are accepted with a 500-op inverse", async () => {
    const db = await makeTestDb();
    const id = await oneLongClip(db);
    const r = await applyProjectOps(db, editor, { projectId: id, baseVersion: 1, ops: splits(250) });
    expect(r.inverse).toHaveLength(500);
    expect(r.version).toBe(2);
  });

  it("251 splits are refused because the undo would be too large, and nothing is written", async () => {
    const db = await makeTestDb();
    const id = await oneLongClip(db);
    const before = await getProject(db, editor, id);
    await expect(applyProjectOps(db, editor, { projectId: id, baseVersion: 1, ops: splits(251) })).rejects.toMatchObject({
      status: 400,
      code: "LIMIT_EXCEEDED",
      message: "This change is too large to undo in one step. Send it in smaller batches.",
    });
    expect(await getProject(db, editor, id)).toEqual(before);
  });
});

describe("op-log row size", () => {
  // Text clips whose text is 2,000 two-byte characters: about 4,250 UTF-8 bytes of JSON each.
  const bigTextClips = (n: number): OpInput[] =>
    Array.from({ length: n }, (_, i) => ({ op: "add_clip", trackId: "t1", clip: { ...text(`x${i}`, i * 10, 10), text: "é".repeat(2000) } }) as OpInput);

  it("a change whose ops and inverse pass 1 MiB of UTF-8 JSON is refused, and nothing is written", async () => {
    const db = await makeTestDb();
    const { id } = await createProject(db, editor, { name: "P", format: "short_9x16" });
    const ops = bigTextClips(300);
    // Under 1 MiB counted in UTF-16 units, over it in UTF-8 bytes.
    expect(JSON.stringify(ops).length).toBeLessThan(1024 * 1024);
    const before = await getProject(db, editor, id);
    await expect(applyProjectOps(db, editor, { projectId: id, baseVersion: 0, ops })).rejects.toMatchObject({
      status: 400,
      code: "LIMIT_EXCEEDED",
      message: "This change is too large. Send it in smaller steps.",
    });
    expect(await getProject(db, editor, id)).toEqual(before);
  });

  it("a change whose undo would not fit in one log row is refused, and nothing is written", async () => {
    const db = await makeTestDb();
    const { id } = await createProject(db, editor, { name: "P", format: "short_9x16" });
    const long = "a".repeat(2000);
    const adds = Array.from({ length: 300 }, (_, i) => ({ op: "add_clip", trackId: "t1", clip: { ...text(`x${i}`, i * 10, 10), text: long } }) as OpInput);
    await applyProjectOps(db, editor, { projectId: id, baseVersion: 0, ops: adds });
    // The edit and its inverse fit in one row. The undo, which carries the long old texts twice, would not.
    const edits: OpInput[] = Array.from({ length: 300 }, (_, i) => ({ op: "update_clip", clipId: `x${i}`, patch: { text: "x" } }));
    const before = await getProject(db, editor, id);
    await expect(applyProjectOps(db, editor, { projectId: id, baseVersion: 1, ops: edits })).rejects.toMatchObject({
      status: 400,
      code: "LIMIT_EXCEEDED",
      message: "This change is too large to undo in one step. Send it in smaller batches.",
    });
    expect(await getProject(db, editor, id)).toEqual(before);
    // Half as many edits can be made, undone and redone.
    const half = await applyProjectOps(db, editor, { projectId: id, baseVersion: 1, ops: edits.slice(0, 120) });
    const undo = await applyProjectOps(db, editor, { projectId: id, baseVersion: half.version, strict: true, ops: half.inverse });
    await applyProjectOps(db, editor, { projectId: id, baseVersion: undo.version, strict: true, ops: undo.inverse });
  });

  it("a change just under 1 MiB is accepted", async () => {
    const db = await makeTestDb();
    const { id } = await createProject(db, editor, { name: "P", format: "short_9x16" });
    const r = await applyProjectOps(db, editor, { projectId: id, baseVersion: 0, ops: bigTextClips(240) });
    const bytes = new TextEncoder().encode(JSON.stringify(r.ops) + JSON.stringify(r.inverse)).length;
    expect(bytes).toBeLessThanOrEqual(1024 * 1024);
    expect(r.version).toBe(1);
  });
});
