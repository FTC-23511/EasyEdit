import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MESSAGES } from "@/lib/editor/messages";
import { findClip } from "@/lib/editor/store";
import { POLL_IDLE_LIMIT_MS, createSync, nextPollDelay } from "@/lib/editor/sync";
import type { Op, OpInput } from "@/lib/timeline";
import { makeFakeServer } from "./fake-server";
import { entry, makeStore, sampleDoc, text } from "./fixtures";

const move = (start: number): OpInput[] => [{ op: "move_clip", clipId: "x2", start }];
const addN1: OpInput[] = [{ op: "add_clip", trackId: "t1", clip: text("n1", 200, 30) }];
const retext = (value: string): OpInput[] => [{ op: "update_clip", clipId: "x1", patch: { text: value } }];
const settle = () => vi.advanceTimersByTimeAsync(0);
const after = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const count = (calls: string[], name: string) => calls.filter((c) => c === name).length;

function setup() {
  const server = makeFakeServer(sampleDoc(), 5);
  const store = makeStore();
  let visible = true;
  const sync = createSync({ store, api: server.api, isVisible: () => visible });
  sync.start();
  const show = (v: boolean) => { visible = v; sync.visibilityChanged(); };
  return { server, sync, show, st: () => store.getState() };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("sending", () => {
  it("sends a local edit and reports saving, then saved", async () => {
    const { server, st } = setup();
    st().edit(move(120), "move");
    expect(st().status).toBe("saving");
    await settle();
    expect(st().status).toBe("saved");
    expect(st().queue).toEqual([]);
    expect(st().server).toEqual({ doc: server.doc(), version: 6 });
    expect(server.calls).toEqual(["post"]);
  });

  it("sends edits one at a time, in the order they were made", async () => {
    const { server, st } = setup();
    st().edit(move(120), "move");
    st().edit(move(150), "move");
    st().edit(addN1, "add text");
    await settle();
    expect(server.log.map((e) => e.ops[0].op)).toEqual(["move_clip", "move_clip", "add_clip"]);
    expect(st().doc).toEqual(server.doc());
    expect(st().server.version).toBe(8);
  });

  it("a remote edit landed first: the local edit is kept and both show", async () => {
    const { server, st } = setup();
    server.remote(retext("GO")); // the server is at 6, the client still at 5
    st().edit(move(120), "move");
    await settle();
    expect(server.calls).toEqual(["post", "ops"]);
    expect(st().server.version).toBe(7);
    expect(st().queue).toEqual([]);
    expect(st().doc).toEqual(server.doc());
    expect(findClip(st().doc, "x1")!.clip).toMatchObject({ text: "GO" });
    expect(findClip(st().doc, "x2")!.clip.start).toBe(120);
  });

  it("an edit the server refuses is rolled back with the reason, and the client catches up", async () => {
    const { server, st } = setup();
    server.remote([{ op: "remove_clip", clipId: "x2" }]);
    st().edit(move(120), "move");
    await settle();
    expect(server.calls).toEqual(["post", "ops"]);
    expect(st().notice).toMatchObject({ tone: "error", text: "That clip or track no longer exists." });
    expect(findClip(st().doc, "x2")).toBeNull();
    expect(st()).toMatchObject({ queue: [], status: "saved" });
  });

  it("a 409 is followed by a catch-up and one more try", async () => {
    const { server, st } = setup();
    server.fail("conflict");
    st().edit(move(120), "move");
    await settle();
    expect(server.calls).toEqual(["post", "ops", "post"]);
    expect(st()).toMatchObject({ queue: [], status: "saved" });
    expect(server.version()).toBe(6);
  });
});

describe("losing the network", () => {
  it("a failed request is retried and lands once", async () => {
    const { server, st } = setup();
    server.fail("network", 2);
    st().edit(move(120), "move");
    await settle();
    expect(st()).toMatchObject({ status: "offline" });
    expect(st().queue).toHaveLength(1);
    expect(findClip(st().doc, "x2")!.clip.start).toBe(120); // still on screen
    await after(2000); // the retry is a catch-up, and it fails too
    expect(st().status).toBe("offline");
    await after(4000);
    expect(st()).toMatchObject({ status: "saved", queue: [] });
    expect(server.calls).toEqual(["post", "ops", "ops", "post"]);
    expect(server.log).toHaveLength(1);
  });

  it("an edit whose first send failed is sent again with the same request id", async () => {
    const { server, st } = setup();
    const post = vi.spyOn(server.api, "postOps");
    server.fail("network");
    st().edit(move(120), "move");
    const id = st().queue[0].id;
    await settle();
    await after(2000);
    expect(server.calls).toEqual(["post", "ops", "post"]);
    expect(post.mock.calls.map(([input]) => input.requestId)).toEqual([id, id]);
    expect(server.log.map((e) => e.requestId)).toEqual([id]);
  });

  it("a lost answer is not sent twice", async () => {
    const { server, st } = setup();
    server.loseNextAnswer();
    st().edit(addN1, "add text");
    await settle();
    expect(st().status).toBe("offline");
    expect(server.version()).toBe(6); // it did land
    await after(2000);
    expect(server.calls).toEqual(["post", "ops"]);
    expect(st()).toMatchObject({ status: "saved", queue: [] });
    expect(st().server.version).toBe(6);
    expect(st().doc.tracks[1].clips.filter((c) => c.id === "n1")).toHaveLength(1);
  });

  it("a replayed answer for an edit the reloaded copy already holds confirms it without applying it again", async () => {
    const { server, st } = setup();
    const emptied = sampleDoc();
    emptied.tracks[1].clips = [];
    st().replaceServer(emptied, 5); // the local copy no longer fits the log
    server.remote([{ op: "remove_clip", clipId: "x1" }]);
    server.loseNextAnswer();
    st().edit([{ op: "move_clip", clipId: "c2", start: 60 }], "move");
    await settle();
    expect(st().status).toBe("offline");
    expect(server.version()).toBe(7); // it did land
    await after(2000); // the catch-up reloads the project, and the edit is sent again under the same id
    expect(server.calls).toEqual(["post", "ops", "project", "post"]);
    expect(server.log).toHaveLength(2);
    expect(st()).toMatchObject({ status: "saved", queue: [], notice: null });
    expect(st().server).toEqual({ doc: server.doc(), version: 7 });
    expect(st().doc).toEqual(server.doc());
  });

  it("edits made while offline are kept in order and all land", async () => {
    const { server, st } = setup();
    server.fail("network");
    st().edit(move(120), "move");
    await settle();
    st().edit(move(150), "move");
    st().edit(addN1, "add text");
    expect(st().queue).toHaveLength(3);
    await after(2000);
    expect(st()).toMatchObject({ status: "saved", queue: [] });
    expect(server.log.map((e) => e.ops[0].op)).toEqual(["move_clip", "move_clip", "add_clip"]);
    expect(st().doc).toEqual(server.doc());
  });

  it.each([
    { name: "nothing is queued", queued: false },
    { name: "an edit is queued", queued: true },
  ])("a catch-up whose second page keeps failing backs off and stays offline ($name)", async ({ queued }) => {
    const { server, st } = setup();
    for (let i = 0; i < 501; i++) server.remote([{ op: "update_track", trackId: "v1", patch: { name: `V${i}` } }]);
    const t0 = Date.now();
    const failedAt: number[] = [];
    const statusAt: string[] = [];
    const getOpsSince = server.api.getOpsSince;
    server.api.getOpsSince = async (since, limit) => {
      if (since === 5) return getOpsSince(since, limit);
      server.calls.push("ops");
      failedAt.push(Date.now() - t0);
      statusAt.push(st().status);
      return { ok: false, kind: "network" };
    };
    if (queued) st().edit(move(120), "move");
    await after(100_000);
    expect(failedAt.slice(1).map((t, i) => t - failedAt[i])).toEqual([2000, 4000, 8000, 16000, 30000, 30000]);
    expect(new Set(statusAt.slice(1))).toEqual(new Set(["offline"]));
    expect(st().status).toBe("offline");
  });

  it("a hidden tab that is offline with nothing queued makes no version checks until it is shown", async () => {
    const { server, show, st } = setup();
    server.fail("network");
    await after(2000);
    expect(server.calls).toEqual(["version"]);
    show(false);
    await after(120_000);
    expect(server.calls).toEqual(["version"]);
    expect(st().status).toBe("offline");
    show(true);
    await settle();
    expect(server.calls).toEqual(["version", "version"]);
    expect(st().status).toBe("saved");
  });

  it("a hidden tab that is offline still retries a queued edit", async () => {
    const { server, show, st } = setup();
    show(false);
    server.fail("network");
    st().edit(move(120), "move");
    await settle();
    expect(st().status).toBe("offline");
    await after(2000);
    expect(server.calls).toEqual(["post", "ops", "post"]);
    expect(st()).toMatchObject({ status: "saved", queue: [] });
  });

  it("an unexpected error in a step is reported and retried like a network failure", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { server, st } = setup();
      server.remote(retext("GO"));
      const getOpsSince = server.api.getOpsSince;
      server.api.getOpsSince = async () => {
        server.calls.push("ops");
        return { ok: true, version: 6, entries: [entry(6, null as unknown as Op[])], hasMore: false }; // applyRemote throws a TypeError
      };
      await after(2000);
      expect(server.calls).toEqual(["version", "ops"]);
      expect(st().status).toBe("offline");
      expect(errors).toHaveBeenCalledTimes(1);
      expect(errors.mock.calls[0]).toContainEqual(expect.any(TypeError));
      server.api.getOpsSince = getOpsSince;
      await after(2000);
      expect(server.calls).toEqual(["version", "ops", "version", "ops"]);
      expect(st()).toMatchObject({ status: "saved", server: { version: 6 } });
    } finally {
      errors.mockRestore();
    }
  });

  it("retryNow ends the wait at once", async () => {
    const { server, sync, st } = setup();
    server.fail("network");
    st().edit(move(120), "move");
    await settle();
    sync.retryNow();
    await settle();
    expect(st()).toMatchObject({ status: "saved", queue: [] });
  });
});

describe("polling", () => {
  it("backs off from 2 s to 30 s, and activity brings it back to 2 s", async () => {
    expect([0, 4, 5, 6, 7, 8, 50].map(nextPollDelay)).toEqual([2000, 2000, 4000, 8000, 16000, 30000, 30000]);
    const { server, sync } = setup();
    await after(10_000);
    expect(count(server.calls, "version")).toBe(5); // 2, 4, 6, 8, 10 s
    await after(28_000);
    expect(count(server.calls, "version")).toBe(8); // 14, 22, 38 s
    await after(60_000);
    expect(count(server.calls, "version")).toBe(10); // 68, 98 s
    sync.noteActivity();
    await after(2000);
    expect(count(server.calls, "version")).toBe(11);
  });

  it("stops polling after ten minutes without activity; the next activity checks at once and the schedule resumes", async () => {
    expect(POLL_IDLE_LIMIT_MS).toBe(10 * 60_000);
    const { server, sync, show, st } = setup();
    const t0 = Date.now();
    const checks: number[] = [];
    const getVersion = server.api.getVersion;
    server.api.getVersion = async () => {
      checks.push(Date.now() - t0);
      return getVersion();
    };
    await after(60 * 60_000);
    expect(checks.at(-1)).toBeGreaterThan(POLL_IDLE_LIMIT_MS - 30_000); // every 30 s up to the limit
    expect(checks.every((t) => t <= POLL_IDLE_LIMIT_MS)).toBe(true); // and none after it

    const idleChecks = checks.length;
    sync.noteActivity(); // a click or a key
    await settle();
    expect(checks).toHaveLength(idleChecks + 1);
    await after(2000);
    expect(checks).toHaveLength(idleChecks + 2);

    await after(60 * 60_000);
    const beforeShow = checks.length;
    show(false);
    show(true); // the tab is shown again
    await settle();
    expect(checks).toHaveLength(beforeShow + 1);

    await after(60 * 60_000);
    const beforeEdit = checks.length;
    st().edit(move(120), "move"); // sending is never held back, and a local edit wakes polling too
    await settle();
    expect(st()).toMatchObject({ queue: [], status: "saved" });
    expect(checks).toHaveLength(beforeEdit + 1);
    expect(server.calls.slice(-2)).toEqual(["post", "version"]);
  });

  it("applies a remote edit found by a poll", async () => {
    const { server, st } = setup();
    server.remote(retext("GO"));
    await after(2000);
    expect(server.calls).toEqual(["version", "ops"]);
    expect(st().server.version).toBe(6);
    expect(findClip(st().doc, "x1")!.clip).toMatchObject({ text: "GO" });
  });

  it("pages through a long gap", async () => {
    const { server, st } = setup();
    for (let i = 0; i < 501; i++) server.remote([{ op: "update_track", trackId: "v1", patch: { name: `V${i}` } }]);
    await after(2000);
    expect(server.calls).toEqual(["version", "ops", "ops"]);
    expect(st().server.version).toBe(506);
    expect(st().doc).toEqual(server.doc());
  });

  it("does not poll while the tab is hidden, and polls at once when it is shown", async () => {
    const { server, show } = setup();
    show(false);
    await after(120_000);
    expect(server.calls).toEqual([]);
    show(true);
    await settle();
    expect(server.calls).toEqual(["version"]);
  });

  it("reloads the whole project when the log no longer fits the local copy", async () => {
    const { server, st } = setup();
    const emptied = sampleDoc();
    emptied.tracks[1].clips = [];
    st().replaceServer(emptied, 5);
    server.remote([{ op: "remove_clip", clipId: "x1" }]);
    await after(2000);
    expect(server.calls).toEqual(["version", "ops", "project"]);
    expect(st().server).toEqual({ doc: server.doc(), version: 6 });
  });
});

describe("stopping", () => {
  it("signed out: stops everything and keeps the pending edit on screen", async () => {
    const { server, st } = setup();
    server.fail("signed-out");
    st().edit(move(120), "move");
    await after(120_000);
    expect(st().status).toBe("signed-out");
    expect(st().queue).toHaveLength(1);
    expect(server.calls).toEqual(["post"]);
  });

  it("signed out: one notice, editing goes on, and the queue lands once the tab is shown signed in again", async () => {
    const { server, show, st } = setup();
    server.fail("signed-out");
    st().edit(move(120), "move");
    await settle();
    expect(st().status).toBe("signed-out");
    expect(st().notice).toMatchObject({ tone: "error", text: MESSAGES.signedOut });
    const notice = st().notice;
    st().edit(move(150), "move");
    await after(60_000);
    expect(server.calls).toEqual(["post"]);
    show(true); // signed in again in another tab, then back to this one
    await settle();
    expect(server.calls).toEqual(["post", "ops", "post", "post"]);
    expect(st()).toMatchObject({ status: "saved", queue: [] });
    expect(server.log.map((e) => (e.ops[0] as { start: number }).start)).toEqual([120, 150]);
    expect(st().notice).toBe(notice);
  });

  it("signed out: a 401 while trying again halts again without a second notice; retryNow tries once more", async () => {
    const { server, show, sync, st } = setup();
    server.fail("signed-out", 2);
    st().edit(move(120), "move");
    await settle();
    const notice = st().notice;
    show(true);
    await settle();
    expect(server.calls).toEqual(["post", "ops"]);
    expect(st()).toMatchObject({ status: "signed-out", notice });
    await after(60_000);
    expect(server.calls).toEqual(["post", "ops"]);
    sync.retryNow(); // the network came back, or anything else that asks for a retry
    await settle();
    expect(server.calls).toEqual(["post", "ops", "ops", "post"]);
    expect(st()).toMatchObject({ status: "saved", queue: [], notice });
  });

  it("signed out with nothing queued: showing the tab checks the version and the status returns", async () => {
    const { server, show, st } = setup();
    server.fail("signed-out");
    await after(2000);
    expect(st().status).toBe("signed-out");
    show(true);
    await settle();
    expect(server.calls).toEqual(["version", "version"]);
    expect(st().status).toBe("saved");
    await after(2000);
    expect(server.calls).toEqual(["version", "version", "version"]); // polling is back
  });

  it("access removed: becomes read-only and keeps polling", async () => {
    const { server, st } = setup();
    server.fail("forbidden");
    st().edit(move(120), "move");
    await settle();
    expect(st()).toMatchObject({ canEdit: false, queue: [] });
    expect(st().doc).toEqual(sampleDoc());
    expect(st().notice).toMatchObject({ text: MESSAGES.lostAccess });
    await after(2000);
    expect(count(server.calls, "version")).toBe(1);
  });

  it("project deleted: reports it and stops for good", async () => {
    const { server, show, sync, st } = setup();
    server.fail("not-found");
    await after(60_000);
    expect(st().status).toBe("deleted");
    expect(server.calls).toEqual(["version"]);
    show(true);
    sync.retryNow();
    await after(60_000);
    expect(server.calls).toEqual(["version"]);
  });

  it("an answer that arrives after stop() changes nothing and leaves no timer", async () => {
    const { server, sync, st } = setup();
    server.fail("network");
    st().edit(move(120), "move"); // the post is now in flight
    sync.stop();
    const before = st();
    await settle();
    expect(server.calls).toEqual(["post"]);
    expect(st()).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stopWhenSent() sends every queued edit in order, then stops", async () => {
    const { server, sync, st } = setup();
    st().edit(move(120), "move"); // in flight
    st().edit(move(150), "move");
    st().edit(addN1, "add text");
    sync.stopWhenSent(); // the editor closed
    await settle();
    expect(server.calls).toEqual(["post", "post", "post"]);
    expect(server.log.map((e) => e.ops[0].op)).toEqual(["move_clip", "move_clip", "add_clip"]);
    expect(st()).toMatchObject({ queue: [], status: "saved" });
    await after(120_000);
    expect(server.calls).toEqual(["post", "post", "post"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stopWhenSent() ends at the first send that fails, and retries nothing", async () => {
    const { server, sync, st } = setup();
    st().edit(move(120), "move");
    st().edit(move(150), "move");
    st().edit(addN1, "add text");
    server.fail("network"); // the first post is already on its way, so this fails the second
    sync.stopWhenSent();
    await settle();
    await after(120_000);
    expect(server.calls).toEqual(["post", "post"]);
    expect(server.log).toHaveLength(1);
    expect(st().queue).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { name: "nothing is queued", prepare: async () => {} },
    { name: "it is offline", prepare: async (s: ReturnType<typeof setup>) => { s.server.fail("network"); s.st().edit(move(120), "move"); await settle(); } },
    { name: "it is signed out", prepare: async (s: ReturnType<typeof setup>) => { s.server.fail("signed-out"); s.st().edit(move(120), "move"); await settle(); } },
  ])("stopWhenSent() stops at once when $name", async ({ prepare }) => {
    const s = setup();
    await prepare(s);
    const calls = [...s.server.calls];
    s.sync.stopWhenSent();
    expect(vi.getTimerCount()).toBe(0);
    await after(120_000);
    expect(s.server.calls).toEqual(calls);
  });

  it("start() after stopWhenSent() keeps the sync running (strict mode mounts twice)", async () => {
    const { server, sync, st } = setup();
    st().edit(move(120), "move");
    st().edit(move(150), "move");
    sync.stopWhenSent();
    sync.start();
    await settle();
    expect(server.calls).toEqual(["post", "post"]);
    await after(2000);
    expect(server.calls).toEqual(["post", "post", "version"]);
  });

  it("stop() ends all requests; start() resumes", async () => {
    const { server, sync } = setup();
    sync.stop();
    await after(60_000);
    expect(server.calls).toEqual([]);
    sync.start();
    await after(2000);
    expect(server.calls).toEqual(["version"]);
  });
});
