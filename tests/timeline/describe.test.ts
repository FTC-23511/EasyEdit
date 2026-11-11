import { describe as suite, expect, it } from "vitest";
import {
  DEFAULT_TRANSFORM,
  applyOps,
  createEmptyDoc,
  describe,
  framesToSeconds,
  type TimelineDoc,
} from "@/lib/timeline";

const style = {
  fontFamily: "Inter",
  fontSize: 96,
  fontWeight: 800,
  color: "#FFFFFF",
  align: "center",
} as const;

const withText = (text: string): TimelineDoc =>
  applyOps(createEmptyDoc("short_9x16"), [
    {
      op: "add_clip",
      trackId: "t1",
      clip: { id: "x1", type: "text", start: 0, duration: 30, text, transform: DEFAULT_TRANSFORM, style },
    },
  ]).doc;

suite("describe", () => {
  it("describes a small doc", () => {
    let d = createEmptyDoc("short_9x16");
    d = applyOps(d, [
      { op: "add_clip", trackId: "v1", clip: { id: "c1", type: "video", assetId: "as1", start: 0, duration: 120, in: 36, speed: 1, volume: 1, transform: DEFAULT_TRANSFORM } },
      { op: "add_clip", trackId: "t1", clip: { id: "x1", type: "text", start: 15, duration: 45, text: "QUALIFIER RECAP", transform: DEFAULT_TRANSFORM, style } },
    ]).doc;
    expect(describe(d, { version: 3 })).toBe(
`Format short_9x16 1080x1920 @30fps · duration 4.00s · version 3
Track v1 [video] "Video 1"
  c1  video  0.00–4.00s  asset=as1 in=1.20s speed=1 vol=1
Track t1 [text] "Text 1"
  x1  text  0.50–2.00s  "QUALIFIER RECAP"
Track cap [caption] "Captions"
  (empty)
Track a1 [audio] "Audio 1"
  (empty)`);
  });

  it("omits the version part when no version is given", () => {
    expect(describe(createEmptyDoc("long_16x9")).split("\n")[0]).toBe(
      "Format long_16x9 1920x1080 @30fps · duration 0.00s",
    );
  });

  it("truncates long text at 40 chars with …", () => {
    const text = "A".repeat(40) + "BCD";
    expect(describe(withText(text))).toContain(`  x1  text  0.00–1.00s  "${"A".repeat(40)}…"`);
    expect(describe(withText("A".repeat(40)))).toContain(`"${"A".repeat(40)}"`);
  });

  it("replaces newlines with spaces so a clip stays on one line", () => {
    const out = describe(withText("LINE ONE\nLINE TWO\r\nTHREE"));
    expect(out).toContain(`"LINE ONE LINE TWO THREE"`);
    expect(out).not.toContain("\r");
    expect(out.split("\n")).toHaveLength(9);
  });

  it("marks hidden/muted/locked tracks", () => {
    const d = createEmptyDoc("short_9x16");
    d.tracks[0] = { ...d.tracks[0], hidden: true, locked: true };
    d.tracks[1] = { ...d.tracks[1], muted: true };
    d.tracks[2] = { ...d.tracks[2], hidden: true, muted: true, locked: true };
    const lines = describe(d).split("\n");
    expect(lines[1]).toBe('Track v1 [video] "Video 1" (hidden, locked)');
    expect(lines[3]).toBe('Track t1 [text] "Text 1" (muted)');
    expect(lines[5]).toBe('Track cap [caption] "Captions" (hidden, muted, locked)');
    expect(lines[7]).toBe('Track a1 [audio] "Audio 1"');
  });

  it("sorts clips by start and prints speed and volume plainly", () => {
    const mk = (id: string, start: number) => ({
      op: "add_clip" as const,
      trackId: "v1",
      clip: { id, type: "video" as const, assetId: "a", start, duration: 30, in: 0, speed: 1.5, volume: 0.5, transform: DEFAULT_TRANSFORM },
    });
    const d = applyOps(createEmptyDoc("short_9x16"), [mk("late", 60), mk("early", 0)]).doc;
    const lines = describe(d).split("\n");
    expect(lines[2]).toBe("  early  video  0.00–1.00s  asset=a in=0.00s speed=1.5 vol=0.5");
    expect(lines[3]).toBe("  late  video  2.00–3.00s  asset=a in=0.00s speed=1.5 vol=0.5");
  });

  it("framesToSeconds uses 2 decimals", () => {
    expect(framesToSeconds(45, 30)).toBe("1.50");
    expect(framesToSeconds(0, 30)).toBe("0.00");
  });

  it("escapes quotes, backslashes, newlines and line separators in track names", () => {
    const d = createEmptyDoc("short_9x16");
    d.tracks[0].name = 'Say "hi"\\\nnext\u2028line\u2029end';
    const out = describe(d);
    expect(out.split("\n")).toHaveLength(9);
    expect(out).toContain(String.raw`Track v1 [video] "Say \"hi\"\\\nnext\u2028line\u2029end"`);
    expect(out).not.toMatch(/[\u2028\u2029]/);
    expect(describe(withText('He said "go"'))).toContain(String.raw`"He said \"go\""`);
  });

  it("never splits an emoji when truncating", () => {
    const family = "👨‍👩‍👧";
    expect(describe(withText("A".repeat(39) + family + "BC"))).toContain(`"${"A".repeat(39)}${family}…"`);
    expect(describe(withText("🇺🇸".repeat(41)))).toContain(`"${"🇺🇸".repeat(40)}…"`);
  });

  it("in detail, shows frames, the whole text, style and position on one line per clip", () => {
    let d = createEmptyDoc("short_9x16");
    d = applyOps(d, [
      { op: "add_clip", trackId: "v1", clip: { id: "c1", type: "video", assetId: "as 1", start: 0, duration: 120, in: 36, speed: 1, volume: 1, transform: { ...DEFAULT_TRANSFORM, scale: 1.5, rotation: -10, opacity: 0.4 } } },
      { op: "add_clip", trackId: "t1", clip: { id: "x1", type: "text", start: 15, duration: 45, text: `SAY "GO"\n${"A".repeat(50)}`, transform: DEFAULT_TRANSFORM, style: { ...style, fontFamily: "Geist Mono" } } },
    ]).doc;
    expect(describe(d, { version: 3, detail: true })).toBe(
`Format short_9x16 1080x1920 @30fps · duration 4.00s · version 3
Track v1 [video] "Video 1"
  c1  video  0.00–4.00s  frames 0–120  asset="as 1" in=1.20s speed=1 vol=1  x=0.5 y=0.5 fit=cover scale=1.5 rotation=-10 opacity=0.4
Track t1 [text] "Text 1"
  x1  text  0.50–2.00s  frames 15–60  "SAY \\"GO\\"\\n${"A".repeat(50)}"  font="Geist Mono" size=96 weight=800 color="#FFFFFF" align=center x=0.5 y=0.5
Track cap [caption] "Captions"
  (empty)
Track a1 [audio] "Audio 1"
  (empty)`);
  });

  it("without detail, prints exactly what it printed before", () => {
    expect(describe(withText("A".repeat(43)))).toContain(`  x1  text  0.00–1.00s  "${"A".repeat(40)}…"`);
    expect(describe(withText("hi"), { detail: false })).toBe(describe(withText("hi")));
  });
});
