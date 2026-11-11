import { createEditorStore } from "@/lib/editor/store";
import type { ActivityEntry, EditorInit } from "@/lib/editor/types";
import { DEFAULT_TRANSFORM, createEmptyDoc, type Clip, type Op, type TimelineDoc } from "@/lib/timeline";

export const text = (id: string, start: number, duration: number, extra: Record<string, unknown> = {}) =>
  ({ id, type: "text", start, duration, text: "hi", transform: { ...DEFAULT_TRANSFORM },
     style: { fontFamily: "Geist", fontSize: 64, fontWeight: 700, color: "#ffffff", align: "center" }, ...extra }) as Clip;
export const video = (id: string, start: number, duration: number, extra: Record<string, unknown> = {}) =>
  ({ id, type: "video", assetId: "a", start, duration, in: 0, speed: 1, volume: 1, transform: { ...DEFAULT_TRANSFORM }, ...extra }) as Clip;

// v1 [c1 0-30, c2 30-60] · t1 [x1 0-60, x2 90-120] · cap · a1
export function sampleDoc(): TimelineDoc {
  const d = createEmptyDoc("short_9x16");
  d.tracks[0].clips = [video("c1", 0, 30), video("c2", 30, 30)];
  d.tracks[1].clips = [text("x1", 0, 60), text("x2", 90, 30)];
  return d;
}

export function makeStore(over: Partial<EditorInit> = {}) {
  let n = 0;
  return createEditorStore(
    { projectId: "p1", name: "Qual recap", doc: sampleDoc(), version: 5, me: { id: "u1", name: "Ada" }, canEdit: true, ...over },
    { genId: () => `g${++n}`, now: () => 1_000 },
  );
}

export const entry = (version: number, ops: Op[], actor = "u2", actorName = "Grace"): ActivityEntry =>
  ({ version, ops, inverse: null, actor, actorName, createdAt: "2026-11-11T10:00:00.000Z" });
