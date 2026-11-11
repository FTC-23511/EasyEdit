import { describe, expect, it, vi } from "vitest";
import { addText } from "@/lib/editor/actions";
import { MESSAGES } from "@/lib/editor/messages";
import * as placement from "@/lib/editor/placement";
import { isFree, newTrackIndex, nextTrackName, placeClips } from "@/lib/editor/placement";
import { TEXT_PRESETS, presetClip } from "@/lib/editor/text-presets";
import { DEFAULT_TRANSFORM, applyOps, prepareOps, type OpInput, type TimelineDoc, type Track } from "@/lib/timeline";
import { makeStore, sampleDoc, text, video } from "./fixtures";

// Wraps the real placeClips so a test can see what addText asked for.
vi.mock("@/lib/editor/placement", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/editor/placement")>();
  return { ...actual, placeClips: vi.fn(actual.placeClips) };
});

const gen = () => { let n = 0; return () => `g${++n}`; };
const emptyTrack = (id: string, kind: Track["kind"]): Track => ({ id, kind, name: id, muted: false, hidden: false, locked: false, clips: [] });
const applied = (doc: TimelineDoc, ops: OpInput[]) => applyOps(doc, prepareOps(ops)).doc;
const fullTo = (doc: TimelineDoc, n: number) => { for (let i = doc.tracks.length; i < n; i++) doc.tracks.push(emptyTrack(`a${i}`, "audio")); return doc; };
const opsOf = (p: ReturnType<typeof placeClips>) => (p.ok ? p.ops : []);
const want = (clipStart: number, duration = 30) => [{ clip: text("old", clipStart, duration), trackId: "t1" }];

describe("placeClips", () => {
  it("isFree treats touching clips as free", () => {
    const t1 = sampleDoc().tracks[1]; // x1 0-60, x2 90-120
    expect([isFree(t1, 60, 30), isFree(t1, 50, 20), isFree(t1, 120, 10)]).toEqual([true, false, true]);
  });

  it("uses the wished track when it is free, with a new id", () => {
    const result = placeClips(sampleDoc(), want(200), gen());
    expect(result).toEqual({ ok: true, clipIds: ["g1"], ops: [{ op: "add_clip", trackId: "t1", clip: text("g1", 200, 30) }] });
    expect(() => applied(sampleDoc(), opsOf(result))).not.toThrow();
  });

  it("falls back to another track of the kind, then to a new track", () => {
    const two = sampleDoc();
    two.tracks.push(emptyTrack("t2", "text"));
    const onT2 = placeClips(two, want(0), gen());
    expect(onT2).toMatchObject({ ok: true, ops: [{ op: "add_clip", trackId: "t2" }] });
    expect(() => applied(two, opsOf(onT2))).not.toThrow();

    const made = placeClips(sampleDoc(), want(0), gen());
    expect(made).toEqual({ ok: true, clipIds: ["g2"], ops: [
      { op: "add_track", track: { id: "g1", kind: "text", name: "Text 2" }, index: 2 },
      { op: "add_clip", trackId: "g1", clip: text("g2", 0, 30) },
    ] });
    expect(applied(sampleDoc(), made.ok ? made.ops : []).tracks.map((t) => t.id)).toEqual(["v1", "t1", "g1", "cap", "a1"]);
  });

  it("puts a new track right after the last track of its kind, or at the end", () => {
    const d = sampleDoc(); // v1, t1, cap, a1
    expect([newTrackIndex(d, "video"), newTrackIndex(d, "text"), newTrackIndex(d, "audio"), newTrackIndex(d, "overlay")]).toEqual([1, 2, 4, 4]);
    d.tracks.push(emptyTrack("t2", "text"));
    expect(newTrackIndex(d, "text")).toBe(5);
  });

  it("gives each new track of one call its own place, counting the ones added before it", () => {
    const items = [
      { clip: text("a", 0, 30), trackId: "t1" }, // t1 is busy at 0
      { clip: video("b", 0, 30), trackId: "v1" }, // so is v1
      { clip: text("c", 0, 30), trackId: null },
    ];
    const result = placeClips(sampleDoc(), items, gen());
    const added = opsOf(result).flatMap((o) => (o.op === "add_track" ? [[o.track.id, o.index]] : []));
    expect(added).toEqual([["g1", 2], ["g3", 1], ["g5", 4]]);
    expect(applied(sampleDoc(), opsOf(result)).tracks.map((t) => t.id)).toEqual(["v1", "g3", "t1", "g1", "g5", "cap", "a1"]);
  });

  it("tries tracks of the wished track's own kind before other tracks that accept the clip", () => {
    const doc = sampleDoc();
    // Display order, top first: overlay o1, then video v2, then v1.
    doc.tracks = [doc.tracks[0], emptyTrack("v2", "video"), emptyTrack("o1", "overlay"), ...doc.tracks.slice(1)];
    const result = placeClips(doc, [{ clip: video("old", 0, 30), trackId: "v1" }], gen());
    expect(result).toMatchObject({ ok: true, ops: [{ op: "add_clip", trackId: "v2" }] });
    expect(() => applied(doc, result.ok ? result.ops : [])).not.toThrow();
  });

  it("skips a locked track, and keeps clips from one track together", () => {
    const locked = sampleDoc();
    locked.tracks[1].locked = true;
    const skipped = placeClips(locked, want(200), gen());
    expect(skipped).toMatchObject({ ok: true, ops: [{ op: "add_track" }, { op: "add_clip", trackId: "g1" }] });
    expect(() => applied(locked, opsOf(skipped))).not.toThrow();
    // The second clip would hit x2, so both go to a new track.
    const both = placeClips(sampleDoc(), [...want(200), ...want(100, 10)], gen());
    expect(both).toMatchObject({ ok: true, clipIds: ["g2", "g3"], ops: [{ op: "add_track" }, { op: "add_clip", trackId: "g1" }, { op: "add_clip", trackId: "g1" }] });
    expect(() => applied(sampleDoc(), both.ok ? both.ops : [])).not.toThrow();
  });

  it("puts a clip with no wished track on the first track of its kind", () => {
    const result = placeClips(sampleDoc(), [{ clip: video("old", 100, 30), trackId: null }], gen());
    expect(result).toMatchObject({ ok: true, ops: [{ op: "add_clip", trackId: "v1" }] });
    expect(() => applied(sampleDoc(), opsOf(result))).not.toThrow();
  });

  it("gives up only when the project cannot take another track", () => {
    const full = sampleDoc();
    for (let i = full.tracks.length; i < 20; i++) full.tracks.push(emptyTrack(`a${i}`, "audio"));
    expect(placeClips(full, want(0), gen())).toEqual({ ok: false });
    const fits = placeClips(full, want(200), gen());
    expect(fits).toMatchObject({ ok: true });
    expect(() => applied(full, opsOf(fits))).not.toThrow();
  });

  it("splits clips that overlap each other across tracks, in order", () => {
    const items = [{ clip: text("a", 0, 30), trackId: "t1" }, { clip: text("b", 10, 30), trackId: "t1" }];
    const result = placeClips(sampleDoc(), items, gen()); // t1 is busy at 0-60
    expect(() => applied(sampleDoc(), opsOf(result))).not.toThrow();
    expect(result).toMatchObject({ ok: true, clipIds: ["g2", "g4"] });
    expect(opsOf(result).filter((o) => o.op === "add_track")).toHaveLength(2);
    // Free wished track: the first clip takes it, the second needs another track.
    const free = placeClips(sampleDoc(), [{ clip: text("a", 200, 30), trackId: "t1" }, { clip: text("b", 210, 30), trackId: "t1" }], gen());
    expect(free).toMatchObject({ ok: true, ops: [{ op: "add_clip", trackId: "t1" }, { op: "add_track" }, { op: "add_clip" }] });
    expect(() => applied(sampleDoc(), opsOf(free))).not.toThrow();
  });

  it("counts clips placed earlier in the same call when checking free space", () => {
    const doc = sampleDoc();
    doc.tracks.push(emptyTrack("t2", "text"), emptyTrack("t3", "text"));
    // t1 is busy at 0, so both groups fall back to the same first fitting track.
    const items = [{ clip: text("a", 0, 30), trackId: "t1" }, { clip: text("b", 10, 30), trackId: "t3" }];
    const result = placeClips(doc, items, gen());
    expect(result).toMatchObject({ ok: true, ops: [{ op: "add_clip", trackId: "t3" }, { op: "add_clip", trackId: "t2" }] });
    expect(() => applied(doc, opsOf(result))).not.toThrow();
  });

  it("refuses the whole call when it would need more tracks than the project may have", () => {
    const doc = fullTo(sampleDoc(), 19);
    const items = [{ clip: text("a", 0, 30), trackId: "t1" }, { clip: video("b", 0, 30), trackId: "v1" }];
    expect(placeClips(doc, items, gen())).toEqual({ ok: false });
    expect(placeClips(doc, [items[0]], gen())).toMatchObject({ ok: true });
  });

  it("names new tracks differently within one call", () => {
    const items = [{ clip: text("a", 0, 30), trackId: "t1" }, { clip: text("b", 0, 30), trackId: null }];
    const result = placeClips(sampleDoc(), items, gen());
    expect(opsOf(result).filter((o) => o.op === "add_track").map((o) => (o.op === "add_track" ? o.track.name : ""))).toEqual(["Text 2", "Text 3"]);
    expect(() => applied(sampleDoc(), opsOf(result))).not.toThrow();
  });

  it("groups items with no wished track by the kind they belong on", () => {
    const result = placeClips(sampleDoc(), [{ clip: text("a", 200, 30), trackId: null }, { clip: video("b", 400, 30), trackId: null }], gen());
    expect(result).toMatchObject({ ok: true, ops: [{ op: "add_clip", trackId: "t1" }, { op: "add_clip", trackId: "v1" }] });
    expect(() => applied(sampleDoc(), opsOf(result))).not.toThrow();
  });

  it("gives a new track the kind of the clip, not of the wished track", () => {
    const doc = sampleDoc();
    doc.tracks[0].clips = [video("c1", 0, 30)];
    const result = placeClips(doc, [{ clip: text("a", 0, 30), trackId: "v1" }], gen()); // v1 does not take text
    expect(result).toMatchObject({ ok: true, ops: [{ op: "add_track", track: { kind: "text" } }, { op: "add_clip" }] });
    expect(() => applied(doc, opsOf(result))).not.toThrow();
  });

  it("orders candidates by the wished track's kind, not the clip's home kind", () => {
    const doc = sampleDoc();
    // Display order, front first: o1 (busy, wished), v2 (free), o2 (free).
    doc.tracks = [emptyTrack("o2", "overlay"), emptyTrack("v2", "video"), { ...emptyTrack("o1", "overlay"), clips: [video("b", 0, 30)] }];
    const result = placeClips(doc, [{ clip: video("old", 0, 30), trackId: "o1" }], gen());
    expect(result).toMatchObject({ ok: true, ops: [{ op: "add_clip", trackId: "o2" }] });
    expect(() => applied(doc, opsOf(result))).not.toThrow();
  });

  it("names a new track with the first free number", () => {
    const d = sampleDoc();
    expect([nextTrackName(d, "video"), nextTrackName(d, "overlay"), nextTrackName(d, "caption")]).toEqual(["Video 2", "Overlay 1", "Captions"]);
    expect(nextTrackName(d, "video", ["Video 2"])).toBe("Video 3");
    d.tracks[0].name = "Video 3";
    expect(nextTrackName(d, "video")).toBe("Video 1");
  });
});

describe("text presets", () => {
  it("offers three presets in the app font", () => {
    expect(TEXT_PRESETS.map((p) => [p.id, p.label, p.text])).toEqual([
      ["title", "Title", "Your title"], ["subtitle", "Subtitle", "Your subtitle"], ["lower-third", "Lower third", "Name and role"],
    ]);
    expect(presetClip(TEXT_PRESETS[0], 200, 30)).toEqual({
      id: "preset", type: "text", start: 200, duration: 90, text: "Your title",
      transform: { ...DEFAULT_TRANSFORM, y: 0.5 },
      style: { fontFamily: "Geist", fontSize: 96, fontWeight: 700, color: "#ffffff", align: "center" },
    });
    expect([24, 60].map((fps) => presetClip(TEXT_PRESETS[0], 0, fps).duration)).toEqual([72, 180]);
    expect(presetClip(TEXT_PRESETS[2], 0, 30)).toMatchObject({ transform: { y: 0.62 }, style: { fontSize: 44, fontWeight: 600, align: "left" } });
  });

  it("addText puts the preset at the playhead as one change and selects it", () => {
    const store = makeStore();
    store.getState().seek(200);
    addText(store, TEXT_PRESETS[0]);
    const s = store.getState();
    expect(s.queue).toMatchObject([{ kind: "edit", label: "add text" }]);
    const added = s.doc.tracks[1].clips.find((c) => c.start === 200)!;
    expect(added).toMatchObject({ type: "text", text: "Your title", duration: 90 });
    expect(s.selection).toEqual({ clipIds: [added.id], trackId: null });
    expect(() => applyOps(sampleDoc(), prepareOps(s.queue[0].ops))).not.toThrow();
  });

  it("addText uses a selected text track, but not a locked or non-text one", () => {
    const withSecond = () => { const d = sampleDoc(); d.tracks.push(emptyTrack("t2", "text")); return d; };
    const trackOf = (store: ReturnType<typeof makeStore>) => store.getState().doc.tracks.find((t) => t.clips.some((c) => c.type === "text" && c.start === 200))!.id;
    const run = (doc: TimelineDoc, trackId: string) => {
      const store = makeStore({ doc });
      store.getState().seek(200);
      store.getState().selectTrack(trackId);
      addText(store, TEXT_PRESETS[0]);
      return store;
    };
    // With no choice made, the front-most text track (t2) is tried first.
    expect(trackOf(run(withSecond(), "t1"))).toBe("t1");
    expect(trackOf(run(withSecond(), "v1"))).toBe("t2");
    // A selected video track is not passed on as the wish.
    expect(vi.mocked(placement.placeClips).mock.lastCall![1][0].trackId).toBeNull();
    const locked = withSecond();
    locked.tracks[1].locked = true;
    expect(trackOf(run(locked, "t1"))).toBe("t2");
  });

  it("addText does nothing for a viewer, even in a full project", () => {
    const store = makeStore({ doc: fullTo(sampleDoc(), 20), canEdit: false });
    addText(store, TEXT_PRESETS[0]);
    expect(store.getState().queue).toEqual([]);
    expect(store.getState().notice).toBeNull();
  });

  it("addText says so when there is no room", () => {
    const full = fullTo(sampleDoc(), 20);
    const store = makeStore({ doc: full });
    addText(store, TEXT_PRESETS[0]); // the playhead is at 0, where x1 sits
    expect(store.getState().queue).toEqual([]);
    expect(store.getState().notice).toMatchObject({ tone: "error", text: MESSAGES.noRoom });
  });
});
