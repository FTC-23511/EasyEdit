import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRANSFORM,
  applyOps,
  createEmptyDoc,
  prepareOps,
  type Op,
  type OpInput,
  type TimelineDoc,
} from "@/lib/timeline";

const doc0 = () => createEmptyDoc("short_9x16");
const media = (id: string, start: number, duration: number, extra: Record<string, unknown> = {}) =>
  ({
    id,
    type: "video",
    assetId: "a",
    start,
    duration,
    in: 0,
    speed: 1,
    volume: 1,
    transform: { ...DEFAULT_TRANSFORM },
    ...extra,
  }) as never;
const text = (id: string, start: number, duration: number) =>
  ({
    id,
    type: "text",
    start,
    duration,
    transform: { ...DEFAULT_TRANSFORM },
    text: "hi",
    style: { fontFamily: "Inter", fontSize: 64, fontWeight: 700, color: "#fff", align: "center" },
  }) as never;

function withClips(...clips: unknown[]): TimelineDoc {
  const d = doc0();
  d.tracks[0].clips = clips as never;
  return d;
}
function failsWith(fn: () => unknown, code: string, opIndex = 0) {
  expect(fn).toThrow(expect.objectContaining({ name: "OpError", code, opIndex }));
}
const clipsOf = (d: TimelineDoc, track = 0) => d.tracks[track].clips;

describe("trim_clip", () => {
  it("trim start on media advances `in` by delta*speed", () => {
    const d = withClips(media("c1", 30, 60, { in: 10, speed: 2 }));
    const { doc } = applyOps(d, [{ op: "trim_clip", clipId: "c1", edge: "start", to: 40 }]);
    expect(clipsOf(doc)[0]).toMatchObject({ start: 40, duration: 50, in: 30 });
  });

  it("trim start past the source start is TRIM_OUT_OF_RANGE", () => {
    const d = withClips(media("c1", 30, 60, { in: 0 }));
    failsWith(() => applyOps(d, [{ op: "trim_clip", clipId: "c1", edge: "start", to: 20 }]), "TRIM_OUT_OF_RANGE");
  });

  it("trim end to <= start is TRIM_OUT_OF_RANGE", () => {
    const d = withClips(media("c1", 30, 60));
    failsWith(() => applyOps(d, [{ op: "trim_clip", clipId: "c1", edge: "end", to: 30 }]), "TRIM_OUT_OF_RANGE");
    failsWith(() => applyOps(d, [{ op: "trim_clip", clipId: "c1", edge: "end", to: 10 }]), "TRIM_OUT_OF_RANGE");
  });

  it("trim end sets duration and undo restores the doc", () => {
    const d = withClips(media("c1", 30, 60));
    const { doc, inverse } = applyOps(d, [{ op: "trim_clip", clipId: "c1", edge: "end", to: 50 }]);
    expect(clipsOf(doc)[0]).toMatchObject({ start: 30, duration: 20 });
    expect(applyOps(doc, inverse).doc).toEqual(d);
  });

  it("trim start to or beyond the end is TRIM_OUT_OF_RANGE", () => {
    const d = withClips(media("c1", 30, 60, { in: 100 }));
    failsWith(() => applyOps(d, [{ op: "trim_clip", clipId: "c1", edge: "start", to: 90 }]), "TRIM_OUT_OF_RANGE");
  });

  it("to < 0 is TRIM_OUT_OF_RANGE", () => {
    const d = withClips(media("c1", 0, 60, { in: 50 }));
    failsWith(() => applyOps(d, [{ op: "trim_clip", clipId: "c1", edge: "start", to: -5 }]), "TRIM_OUT_OF_RANGE");
  });

  it("trimming the start of a text clip changes only start and duration", () => {
    const d = doc0();
    d.tracks[1].clips = [text("t", 10, 40)] as never;
    const { doc } = applyOps(d, [{ op: "trim_clip", clipId: "t", edge: "start", to: 20 }]);
    expect(doc.tracks[1].clips[0]).toEqual({ ...d.tracks[1].clips[0], start: 20, duration: 30 });
    expect(doc.tracks[1].clips[0]).not.toHaveProperty("in");
  });

  it("a trim that extends into a neighbour is OVERLAP", () => {
    const d = withClips(media("c1", 0, 30), media("c2", 40, 30));
    failsWith(() => applyOps(d, [{ op: "trim_clip", clipId: "c1", edge: "end", to: 41 }]), "OVERLAP");
    const d2 = withClips(media("c1", 0, 30, { in: 0 }), media("c2", 40, 30, { in: 20 }));
    failsWith(() => applyOps(d2, [{ op: "trim_clip", clipId: "c2", edge: "start", to: 29 }]), "OVERLAP");
  });

  it("on a locked track is TRACK_LOCKED", () => {
    const d = withClips(media("c1", 0, 30));
    d.tracks[0].locked = true;
    failsWith(() => applyOps(d, [{ op: "trim_clip", clipId: "c1", edge: "end", to: 10 }]), "TRACK_LOCKED");
  });

  it("unknown clip is NOT_FOUND", () => {
    failsWith(() => applyOps(doc0(), [{ op: "trim_clip", clipId: "zz", edge: "end", to: 10 }]), "NOT_FOUND");
  });
});

describe("split_clip", () => {
  it("produces two contiguous clips and undo restores one", () => {
    const d = withClips(media("c1", 0, 90));
    const { doc, inverse } = applyOps(d, [{ op: "split_clip", clipId: "c1", at: 30, newClipId: "c2" }]);
    expect(clipsOf(doc)).toHaveLength(2);
    expect(clipsOf(doc)[0]).toMatchObject({ id: "c1", start: 0, duration: 30, in: 0 });
    expect(clipsOf(doc)[1]).toMatchObject({ id: "c2", start: 30, duration: 60, in: 30 });
    expect(applyOps(doc, inverse).doc).toEqual(d);
  });

  it("scales the right part's `in` by speed", () => {
    const d = withClips(media("c1", 10, 90, { in: 5, speed: 2 }));
    const { doc } = applyOps(d, [{ op: "split_clip", clipId: "c1", at: 40, newClipId: "c2" }]);
    expect(clipsOf(doc)[1]).toMatchObject({ start: 40, duration: 60, in: 65 });
  });

  it("splits a text clip without adding `in`", () => {
    const d = doc0();
    d.tracks[1].clips = [text("t", 0, 40)] as never;
    const { doc } = applyOps(d, [{ op: "split_clip", clipId: "t", at: 10, newClipId: "t2" }]);
    expect(doc.tracks[1].clips[1]).not.toHaveProperty("in");
    expect(doc.tracks[1].clips[1]).toMatchObject({ id: "t2", start: 10, duration: 30, text: "hi" });
  });

  it("at the clip edge or outside is INVALID", () => {
    const d = withClips(media("c1", 10, 90));
    for (const at of [10, 100, 5, 200]) {
      failsWith(() => applyOps(d, [{ op: "split_clip", clipId: "c1", at, newClipId: "c2" }]), "INVALID");
    }
  });

  it("a taken newClipId is DUPLICATE_ID", () => {
    const d = withClips(media("c1", 0, 90), media("c2", 100, 10));
    failsWith(() => applyOps(d, [{ op: "split_clip", clipId: "c1", at: 30, newClipId: "c2" }]), "DUPLICATE_ID");
  });

  it("on a locked track is TRACK_LOCKED", () => {
    const d = withClips(media("c1", 0, 90));
    d.tracks[0].locked = true;
    failsWith(() => applyOps(d, [{ op: "split_clip", clipId: "c1", at: 30, newClipId: "c2" }]), "TRACK_LOCKED");
  });

  it("prepareOps fills newClipId", () => {
    const [op] = prepareOps([{ op: "split_clip", clipId: "c1", at: 5 }], () => "gen1");
    expect(op).toEqual({ op: "split_clip", clipId: "c1", at: 5, newClipId: "gen1" });
    const [kept] = prepareOps([{ op: "split_clip", clipId: "c1", at: 5, newClipId: "mine" }], () => "gen1");
    expect(kept).toMatchObject({ newClipId: "mine" });
  });
});

// A start trim and a split work out where in its source a clip now begins. At a speed that is not whole that is
// seldom a whole frame, and it is rounded down, so that no piece ever reaches further into the source than the
// clip it was cut from.
describe("a source position is rounded down", () => {
  const SPEEDS = [0.25, 0.5, 0.75, 1.25, 1.5, 2.5];
  // The first source frame a clip does not use.
  const sourceEnd = (clip: unknown) => {
    const { in: sourceIn, duration, speed } = clip as { in: number; duration: number; speed: number };
    return sourceIn + Math.round(duration * speed);
  };

  it("a start trim rounds the new `in` down, inward and outward", () => {
    const d = withClips(media("c1", 30, 60, { in: 10, speed: 1.5 }));
    const inward = applyOps(d, [{ op: "trim_clip", clipId: "c1", edge: "start", to: 35 }]); // 7.5 source frames later
    expect(clipsOf(inward.doc)[0]).toMatchObject({ start: 35, duration: 55, in: 17 });
    expect(applyOps(inward.doc, inward.inverse).doc).toEqual(d);
    const outward = applyOps(d, [{ op: "trim_clip", clipId: "c1", edge: "start", to: 27 }]); // 4.5 source frames earlier
    expect(clipsOf(outward.doc)[0]).toMatchObject({ start: 27, duration: 63, in: 5 });
    expect(applyOps(outward.doc, outward.inverse).doc).toEqual(d);
    // An `in` that the op gives is taken as it is.
    const given = applyOps(d, [{ op: "trim_clip", clipId: "c1", edge: "start", to: 35, in: 18 }]);
    expect(clipsOf(given.doc)[0]).toMatchObject({ start: 35, duration: 55, in: 18 });
  });

  it("a split rounds the right part's `in` down", () => {
    const d = withClips(media("c1", 10, 90, { in: 5, speed: 1.5 }));
    const { doc, inverse } = applyOps(d, [{ op: "split_clip", clipId: "c1", at: 21, newClipId: "c2" }]); // 16.5 source frames in
    expect(clipsOf(doc)[0]).toMatchObject({ id: "c1", start: 10, duration: 11, in: 5 });
    expect(clipsOf(doc)[1]).toMatchObject({ id: "c2", start: 21, duration: 79, in: 21 });
    expect(applyOps(doc, inverse).doc).toEqual(d);
  });

  it("neither piece of a split uses more of the source than the clip did", () => {
    const over: string[] = [];
    for (const speed of SPEEDS) {
      for (let duration = 2; duration <= 120; duration++) {
        const d = withClips(media("c1", 10, duration, { in: 7, speed }));
        const limit = sourceEnd(clipsOf(d)[0]);
        for (let at = 11; at < 10 + duration; at++) {
          const pieces = clipsOf(applyOps(d, [{ op: "split_clip", clipId: "c1", at, newClipId: "c2" }]).doc);
          expect(pieces).toHaveLength(2);
          for (const piece of pieces) {
            if (sourceEnd(piece) > limit) over.push(`speed ${speed}, ${duration} frames, cut at ${at}: ${piece.id} ends at ${sourceEnd(piece)} of ${limit}`);
          }
        }
      }
    }
    expect({ over: over.length, first: over.slice(0, 3) }).toEqual({ over: 0, first: [] });
  });

  it("a start trim, inward or outward by 1 to 5 frames, never uses more of the source than the clip did", () => {
    const over: string[] = [];
    let trims = 0;
    for (const speed of SPEEDS) {
      for (let duration = 2; duration <= 120; duration++) {
        const d = withClips(media("c1", 10, duration, { in: 20, speed })); // room before it on the timeline and in the source
        const limit = sourceEnd(clipsOf(d)[0]);
        for (const by of [1, 2, 3, 4, 5, -1, -2, -3, -4, -5]) {
          if (by >= duration) continue; // nothing would be left of the clip
          const [trimmed] = clipsOf(applyOps(d, [{ op: "trim_clip", clipId: "c1", edge: "start", to: 10 + by }]).doc);
          expect(trimmed.duration).toBe(duration - by);
          trims++;
          if (sourceEnd(trimmed) > limit) over.push(`speed ${speed}, ${duration} frames, start moved by ${by}: ends at ${sourceEnd(trimmed)} of ${limit}`);
        }
      }
    }
    expect({ over: over.length, first: over.slice(0, 3) }).toEqual({ over: 0, first: [] });
    expect(trims).toBe(6 * (119 * 10 - 10)); // every case ran but the ten, at each speed, that would leave nothing of a short clip
  });
});

describe("update_clip", () => {
  it("merges transform one level deep", () => {
    const d = withClips(media("c1", 0, 30));
    const { doc, inverse } = applyOps(d, [{ op: "update_clip", clipId: "c1", patch: { transform: { scale: 1.5 } } }]);
    expect(clipsOf(doc)[0].transform).toEqual({ x: 0.5, y: 0.5, scale: 1.5, rotation: 0, opacity: 1, fit: "cover" });
    expect(applyOps(doc, inverse).doc).toEqual(d);
  });

  it("replaces plain fields", () => {
    const d = withClips(media("c1", 0, 30));
    const { doc } = applyOps(d, [{ op: "update_clip", clipId: "c1", patch: { volume: 0.5 } }]);
    expect(clipsOf(doc)[0]).toMatchObject({ volume: 0.5 });
  });

  it.each(["id", "type", "start", "duration"])("cannot change %s", (key) => {
    const d = withClips(media("c1", 0, 30));
    failsWith(() => applyOps(d, [{ op: "update_clip", clipId: "c1", patch: { [key]: key === "type" ? "text" : 5 } }]), "INVALID");
  });

  it("bad value is INVALID", () => {
    const d = withClips(media("c1", 0, 30));
    failsWith(() => applyOps(d, [{ op: "update_clip", clipId: "c1", patch: { volume: 9 } }]), "INVALID");
  });

  it("unknown keys are INVALID, not dropped", () => {
    const d = withClips(media("c1", 0, 30));
    failsWith(() => applyOps(d, [{ op: "update_clip", clipId: "c1", patch: { volum: 1 } }]), "INVALID");
    failsWith(() => applyOps(d, [{ op: "update_clip", clipId: "c1", patch: { text: "x" } }]), "INVALID");
    failsWith(() => applyOps(d, [{ op: "update_clip", clipId: "c1", patch: { transform: { skew: 1 } } }]), "INVALID");
  });

  it("on a locked track is TRACK_LOCKED", () => {
    const d = withClips(media("c1", 0, 30));
    d.tracks[0].locked = true;
    failsWith(() => applyOps(d, [{ op: "update_clip", clipId: "c1", patch: { volume: 1 } }]), "TRACK_LOCKED");
  });
});

describe("set_format", () => {
  it("changes dimensions and undoes", () => {
    const d = doc0();
    const { doc, inverse } = applyOps(d, [{ op: "set_format", format: "long_16x9" }]);
    expect(doc).toMatchObject({ format: "long_16x9", width: 1920, height: 1080 });
    expect(inverse).toEqual([{ op: "set_format", format: "short_9x16", expect: { format: "long_16x9" } }]);
    expect(applyOps(doc, inverse).doc).toEqual(d);
  });

  it("ignores track locks", () => {
    const d = doc0();
    d.tracks[0].locked = true;
    expect(applyOps(d, [{ op: "set_format", format: "square_1x1" }]).doc.width).toBe(1080);
  });
});

describe("track ordering and engine hardening", () => {
  it("add_clip keeps the track sorted by start", () => {
    const { doc } = applyOps(doc0(), [
      { op: "add_clip", trackId: "v1", clip: media("c2", 30, 10) },
      { op: "add_clip", trackId: "v1", clip: media("c1", 0, 10) },
    ]);
    expect(clipsOf(doc).map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("same-track move_clip leaves the array sorted", () => {
    const d = withClips(media("c1", 0, 10), media("c2", 20, 10));
    const { doc, inverse } = applyOps(d, [{ op: "move_clip", clipId: "c1", start: 40 }]);
    expect(clipsOf(doc).map((c) => c.id)).toEqual(["c2", "c1"]);
    expect(applyOps(doc, inverse).doc).toEqual(d);
  });

  it("split and trim keep the track sorted", () => {
    const d = withClips(media("c1", 0, 90), media("c3", 100, 10));
    const { doc } = applyOps(d, [{ op: "split_clip", clipId: "c1", at: 30, newClipId: "c2" }]);
    expect(clipsOf(doc).map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
  });

  it("replace_track sorts its clips", () => {
    const d = doc0();
    const track = { ...d.tracks[0], clips: [media("b", 20, 5), media("a", 0, 5)] };
    const { doc } = applyOps(d, [{ op: "replace_track", track, index: 0 }]);
    expect(clipsOf(doc).map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("an unhandled op throws INVALID instead of being skipped", () => {
    failsWith(() => applyOps(doc0(), [{ op: "bogus" } as unknown as Op]), "INVALID");
  });

  it("prepareOps names the op in its error", () => {
    const bad = [{ op: "remove_track", trackId: "v1" }, { op: "move_clip", clipId: "c", start: -1 }] as OpInput[];
    expect(() => prepareOps(bad)).toThrow(/move_clip \(op 1\) is invalid/);
  });

  it("clip and track ids are separate namespaces", () => {
    const { doc } = applyOps(doc0(), [{ op: "add_clip", trackId: "v1", clip: media("v1", 0, 10) }]);
    expect(clipsOf(doc)[0].id).toBe("v1");
  });
});
