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
// seldom a whole frame. The engine counts it back from where the clip ends in its source, the number the server's
// length check reads, so a trimmed clip and the right piece of a split end exactly where the clip did, and a start
// trimmed in can be trimmed back out to where it was.
describe("a clip's end in its source stays put", () => {
  const SPEEDS = [0.25, 0.35, 0.5, 0.7, 0.75, 1.25, 1.5, 2.3, 2.5];
  // The first source frame a clip does not use.
  const sourceEnd = (clip: unknown) => {
    const { in: sourceIn, duration, speed } = clip as { in: number; duration: number; speed: number };
    return sourceIn + Math.round(duration * speed);
  };

  it("a start trim keeps the end, inward and outward", () => {
    const d = withClips(media("c1", 30, 60, { in: 10, speed: 1.5 })); // ends at 10 + 90 = 100
    const inward = applyOps(d, [{ op: "trim_clip", clipId: "c1", edge: "start", to: 35 }]); // 55 × 1.5 = 82.5 rounds to 83
    expect(clipsOf(inward.doc)[0]).toMatchObject({ start: 35, duration: 55, in: 17 });
    expect(applyOps(inward.doc, inward.inverse).doc).toEqual(d);
    const outward = applyOps(d, [{ op: "trim_clip", clipId: "c1", edge: "start", to: 27 }]); // 63 × 1.5 = 94.5 rounds to 95
    expect(clipsOf(outward.doc)[0]).toMatchObject({ start: 27, duration: 63, in: 5 });
    expect(applyOps(outward.doc, outward.inverse).doc).toEqual(d);
    // An `in` that the op gives is taken as it is.
    const given = applyOps(d, [{ op: "trim_clip", clipId: "c1", edge: "start", to: 35, in: 18 }]);
    expect(clipsOf(given.doc)[0]).toMatchObject({ start: 35, duration: 55, in: 18 });
  });

  it("a split keeps the right piece's end", () => {
    const d = withClips(media("c1", 10, 90, { in: 5, speed: 1.5 })); // ends at 5 + 135 = 140
    const { doc, inverse } = applyOps(d, [{ op: "split_clip", clipId: "c1", at: 21, newClipId: "c2" }]); // 79 × 1.5 = 118.5 rounds to 119
    expect(clipsOf(doc)[0]).toMatchObject({ id: "c1", start: 10, duration: 11, in: 5 });
    expect(clipsOf(doc)[1]).toMatchObject({ id: "c2", start: 21, duration: 79, in: 21 });
    expect(applyOps(doc, inverse).doc).toEqual(d);
  });

  it("at speed 0.7 a split and a start trim end where the clip did, though 45 × 0.7 is a hair under 31.5", () => {
    const d = withClips(media("c1", 0, 45, { in: 344, speed: 0.7 })); // ends at 344 + 31 = 375
    const split = clipsOf(applyOps(d, [{ op: "split_clip", clipId: "c1", at: 10, newClipId: "c2" }]).doc);
    expect(split[1]).toMatchObject({ id: "c2", start: 10, duration: 35, in: 350 }); // 35 × 0.7 = 24.5 rounds to 25
    const [trimmed] = clipsOf(applyOps(d, [{ op: "trim_clip", clipId: "c1", edge: "start", to: 10 }]).doc);
    expect(trimmed).toMatchObject({ start: 10, duration: 35, in: 350 });
  });

  it("an image's split is as it was", () => {
    const d = withClips(media("i1", 10, 91, { type: "image", in: 5, speed: 1.5 }));
    const pieces = clipsOf(applyOps(d, [{ op: "split_clip", clipId: "i1", at: 41, newClipId: "i2" }]).doc);
    expect(pieces[1]).toMatchObject({ id: "i2", start: 41, duration: 60, in: 51 }); // 5 + 31 × 1.5 = 51.5, rounded down (a video gives 52)
  });

  it("every split leaves a right piece that ends in its source where the clip did", () => {
    const off: string[] = [];
    let splits = 0;
    for (const speed of SPEEDS) {
      for (const sourceIn of [0, 7]) {
        for (let duration = 2; duration <= 60; duration++) {
          const d = withClips(media("c1", 10, duration, { in: sourceIn, speed }));
          const end = sourceEnd(clipsOf(d)[0]);
          for (let at = 11; at < 10 + duration; at++) {
            const pieces = clipsOf(applyOps(d, [{ op: "split_clip", clipId: "c1", at, newClipId: "c2" }]).doc);
            expect(pieces).toHaveLength(2);
            splits++;
            if (sourceEnd(pieces[1]) !== end) off.push(`speed ${speed}, in ${sourceIn}, ${duration} frames, cut at ${at}: ends at ${sourceEnd(pieces[1])}, not ${end}`);
          }
        }
      }
    }
    expect({ off: off.length, first: off.slice(0, 3) }).toEqual({ off: 0, first: [] });
    expect(splits).toBe(9 * 2 * 1770); // 1 + 2 + … + 59 cut points over the lengths 2 to 60
  });

  it("every inward start trim keeps the end, and the same trim back out gives back the `in`", () => {
    const off: string[] = [];
    let trims = 0;
    for (const speed of SPEEDS) {
      for (const sourceIn of [0, 7]) {
        for (let duration = 2; duration <= 60; duration++) {
          const d = withClips(media("c1", 10, duration, { in: sourceIn, speed }));
          const end = sourceEnd(clipsOf(d)[0]);
          for (let by = 1; by < duration; by++) {
            const where = `speed ${speed}, in ${sourceIn}, ${duration} frames, trimmed by ${by}`;
            const inward = applyOps(d, [{ op: "trim_clip", clipId: "c1", edge: "start", to: 10 + by }]).doc;
            const [trimmed] = clipsOf(inward);
            expect(trimmed.duration).toBe(duration - by);
            trims++;
            if (sourceEnd(trimmed) !== end) off.push(`${where}: ends at ${sourceEnd(trimmed)}, not ${end}`);
            let back: unknown;
            try {
              [back] = clipsOf(applyOps(inward, [{ op: "trim_clip", clipId: "c1", edge: "start", to: 10 }]).doc);
            } catch (error) {
              off.push(`${where}: back out refused: ${(error as Error).message}`);
              continue;
            }
            if ((back as { in: number }).in !== sourceIn) off.push(`${where}: back out at in ${(back as { in: number }).in}, not ${sourceIn}`);
          }
        }
      }
    }
    expect({ off: off.length, first: off.slice(0, 3) }).toEqual({ off: 0, first: [] });
    expect(trims).toBe(9 * 2 * 1770);
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
