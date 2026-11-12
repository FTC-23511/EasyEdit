import { describe, expect, it } from "vitest";
import { LIMITS } from "@/lib/limits";
import { pageLines } from "@/lib/mcp/paging";
import { newIdLines, projectPage } from "@/lib/mcp/project-text";
import { editRequestId, stableJson } from "@/lib/mcp/request-id";
import { DEFAULT_TRANSFORM, createEmptyDoc, type Clip } from "@/lib/timeline";

describe("pageLines", () => {
  const lines = ["aaaa", "bbbb", "cccc", "dddd"]; // each costs 5 with its line break

  it("fills a page up to the budget and says where to read on", () => {
    expect(pageLines(lines, 0, 10)).toEqual({ lines: ["aaaa", "bbbb"], next: 2 });
    expect(pageLines(lines, 2, 10)).toEqual({ lines: ["cccc", "dddd"], next: null });
    expect(pageLines(lines, 0, 9)).toEqual({ lines: ["aaaa"], next: 1 });
  });

  it("always gives one line, even one longer than the budget", () => {
    expect(pageLines(["x".repeat(50), "y"], 0, 10)).toEqual({ lines: ["x".repeat(50)], next: 1 });
  });

  it("gives nothing past the end, and treats a negative offset as the start", () => {
    expect(pageLines(lines, 9, 10)).toEqual({ lines: [], next: null });
    expect(pageLines(lines, -3, 100)).toEqual({ lines, next: null });
  });
});

describe("projectPage", () => {
  const project = { id: "p1", name: 'Say "hi"', doc: createEmptyDoc("short_9x16"), version: 4 };
  const NAME = 'Project "Say \\"hi\\"" (id p1)';
  const HEAD = "Format short_9x16 1080x1920 @30fps · duration 0.00s · version 4";

  it("prints the name, the head and the whole body when it fits", () => {
    expect(projectPage(project, { maxChars: 10_000 })).toEqual({
      next: null,
      text: [NAME, HEAD, 'Track v1 [video] "Video 1"', "  (empty)", 'Track t1 [text] "Text 1"', "  (empty)",
        'Track cap [caption] "Captions"', "  (empty)", 'Track a1 [audio] "Audio 1"', "  (empty)"].join("\n"),
    });
  });

  it("pages the body, repeats the name and head on every page, and says how to read on", () => {
    const first = projectPage(project, { maxChars: 60 }); // the first two body lines cost 37, the third would make 62
    expect(first.next).toBe(2);
    expect(first.text.split("\n")).toEqual([NAME, HEAD, 'Track v1 [video] "Video 1"', "  (empty)",
      '… 6 more lines. Call get_project with project_id "p1", cursor 2 and version 4 to read on.']);
    expect(projectPage(project, { cursor: 2, maxChars: 10_000 }).text.split("\n").slice(0, 3)).toEqual([NAME, HEAD, 'Track t1 [text] "Text 1"']);
    expect(projectPage(project, { cursor: 99, maxChars: 100 })).toEqual({ next: null, text: [NAME, HEAD, "(no more lines)"].join("\n") });
  });
});

describe("newIdLines", () => {
  it("lists the ids the server made, in op order", () => {
    const clip = { id: "C1", type: "text", start: 0, duration: 30, text: "hi", transform: { ...DEFAULT_TRANSFORM },
      style: { fontFamily: "Geist", fontSize: 64, fontWeight: 700, color: "#ffffff", align: "center" } } as Clip;
    expect(newIdLines([
      { op: "add_track", track: { id: "T9", kind: "text", name: 'Text "2"' } },
      { op: "add_clip", trackId: "T9", clip },
      { op: "split_clip", clipId: "C1", at: 10, newClipId: "C2" },
      { op: "move_clip", clipId: "C1", start: 0 },
    ])).toEqual(['  track T9 ("Text \\"2\\"", text)', "  clip C1 on track T9", "  clip C2 (second half of C1)"]);
  });
});

describe("request ids", () => {
  const id = (over: Partial<Parameters<typeof editRequestId>[0]> = {}) =>
    editRequestId({ actorId: "claude:u1", projectId: "p1", expectedVersion: 3, key: [{ op: "x", n: 1 }], ...over });

  it("stableJson sorts keys at every level and keeps array order", () => {
    expect(stableJson({ b: 1, a: [{ d: 1, c: 2 }, 3], u: undefined })).toBe('{"a":[{"c":2,"d":1},3],"b":1}');
  });

  it("is the same for the same call however its keys are ordered, and fits the service's format", () => {
    expect(id()).toMatch(/^c[A-Za-z0-9_-]{42}$/);
    expect(id({ key: [{ n: 1, op: "x" }] })).toBe(id());
  });

  it("differs when the member, the project, the version or the input differs", () => {
    for (const other of [{ actorId: "claude:u2" }, { projectId: "p2" }, { expectedVersion: 4 }, { key: [{ op: "x", n: 2 }] }, { key: [{ op: "x", n: 1 }, { op: "x", n: 1 }] }]) {
      expect(id(other), JSON.stringify(other)).not.toBe(id());
    }
  });
});

it("the connector's limits are in LIMITS", () => {
  expect(LIMITS).toMatchObject({
    connectorReadChars: 16_000, connectorEchoChars: 6_000, connectorListPage: 50, connectorConflictEntries: 10,
    connectorTextItems: 20, connectorWritesPerMinute: 30, connectorBytesPerDay: 10 * 1024 * 1024, connectorProjectsPerDay: 50,
  });
});
