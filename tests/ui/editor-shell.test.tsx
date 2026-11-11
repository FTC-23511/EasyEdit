// @vitest-environment happy-dom
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorShell } from "@/components/editor/editor-shell";
import type { EditorInit } from "@/lib/editor/types";
import { sampleDoc } from "../editor/fixtures";
import { act, fireEvent, render, screen } from "../helpers/dom";

const initial = (): EditorInit => ({ projectId: "p1", name: "Qual recap", doc: sampleDoc(), version: 5, me: { id: "u1", name: "Ada" }, canEdit: true });

// The projects API as the shell's fetch sees it. While `hold` is on, each post waits for release().
function stubServer() {
  const requests: string[] = [];
  const waiting: (() => void)[] = [];
  let version = 5;
  const server = {
    requests,
    hold: false,
    posts: () => requests.filter((r) => r.startsWith("POST")).length,
    versionChecks: () => requests.filter((r) => r.endsWith("/version")).length,
    release() {
      server.hold = false;
      waiting.splice(0).forEach((answer) => answer());
    },
  };
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url}`);
    if (method === "POST") {
      const answer = () => Response.json({ version: ++version, ops: [], inverse: [] });
      return server.hold ? new Promise<Response>((resolve) => waiting.push(() => resolve(answer()))) : answer();
    }
    if (url.endsWith("/version")) return Response.json({ version });
    return Response.json({ version, entries: [], hasMore: false });
  });
  return server;
}

const flush = () => act(() => vi.advanceTimersByTimeAsync(0));
const after = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const addTitle = (name = "Add title") => act(() => fireEvent.click(screen.getByRole("button", { name })));
const unloadListeners = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter(([type]) => type === "beforeunload").length;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("asks before the page unloads only while edits are unsent", async () => {
  const server = stubServer();
  const added = vi.spyOn(window, "addEventListener");
  const removed = vi.spyOn(window, "removeEventListener");
  render(<EditorShell initial={initial()} />);
  expect(unloadListeners(added)).toBe(0);

  server.hold = true;
  await addTitle();
  expect(unloadListeners(added)).toBe(1);
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);

  server.release();
  await flush();
  expect(server.posts()).toBe(1);
  expect(unloadListeners(removed)).toBe(1);
  const later = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(later);
  expect(later.defaultPrevented).toBe(false);
});

it("leaving the editor with edits still queued sends them all, then stops", async () => {
  const server = stubServer();
  const { unmount } = render(<EditorShell initial={initial()} />);
  server.hold = true;
  await addTitle();
  await addTitle("Add subtitle");
  expect(server.posts()).toBe(1); // the first is in flight, the second waits
  unmount(); // "Projects" or the Back button: a navigation inside the app
  server.release();
  await flush();
  expect(server.posts()).toBe(2);
  const sent = server.requests.length;
  await after(120_000);
  expect(server.requests).toHaveLength(sent); // and no more polling
});

it("under strict mode one sync runs", async () => {
  const server = stubServer();
  render(
    <StrictMode>
      <EditorShell initial={initial()} />
    </StrictMode>,
  );
  await addTitle();
  await flush();
  expect(server.posts()).toBe(1);
  await after(2000);
  expect(server.versionChecks()).toBe(1);
});
