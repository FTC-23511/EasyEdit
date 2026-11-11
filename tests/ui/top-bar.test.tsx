// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { EditorProvider } from "@/components/editor/context";
import { EditorScreen } from "@/components/editor/editor-screen";
import { TopBar } from "@/components/editor/top-bar";
import type { SyncStatus } from "@/lib/editor/types";
import { makeStore } from "../editor/fixtures";
import { act, fireEvent, render, screen } from "../helpers/dom";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("undo and redo are disabled once the project is deleted, and stay on while signed out", () => {
  const store = makeStore();
  render(
    <EditorProvider store={store}>
      <TopBar onShowShortcuts={() => {}} />
    </EditorProvider>,
  );
  act(() => {
    store.getState().edit([{ op: "remove_clip", clipId: "c1" }], "Delete");
  });
  const undo = () => screen.getByRole("button", { name: /^Undo/ }) as HTMLButtonElement;
  expect(undo().disabled).toBe(false);
  act(() => store.getState().setStatus("signed-out"));
  expect(undo().disabled).toBe(false);
  act(() => store.getState().setStatus("deleted"));
  expect(undo().disabled).toBe(true);
});

it("'Sign in' opens in a new tab, so the editor and its unsent edits stay", () => {
  const store = makeStore();
  store.getState().setStatus("signed-out");
  render(
    <EditorProvider store={store}>
      <TopBar onShowShortcuts={() => {}} />
    </EditorProvider>,
  );
  const link = screen.getByRole("link", { name: "Sign in" });
  expect(link.getAttribute("href")).toBe("/login");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noopener");
});

// Clicks "Projects" in a top bar whose store has `queued` unsent edits and the given status.
// Returns whether the page was loaded for real (the browser then asks before unsent edits go).
function leaveWith(queued: number, status: SyncStatus, click: Partial<MouseEventInit> = {}) {
  const store = makeStore();
  for (let i = 0; i < queued; i++) store.getState().edit([{ op: "move_clip", clipId: "x2", start: 100 + i }], "move");
  store.getState().setStatus(status);
  const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
  const { unmount } = render(
    <EditorProvider store={store}>
      <TopBar onShowShortcuts={() => {}} />
    </EditorProvider>,
  );
  const leftToTheApp = fireEvent.click(screen.getByRole("link", { name: "Projects" }), click);
  unmount();
  const assigned = assign.mock.calls.map(([href]) => String(href));
  assign.mockRestore();
  return { reloaded: !leftToTheApp, assigned };
}

it("'Projects' stays inside the app while queued edits can still be sent", () => {
  expect(leaveWith(0, "saved")).toEqual({ reloaded: false, assigned: [] });
  expect(leaveWith(2, "saving")).toEqual({ reloaded: false, assigned: [] });
  expect(leaveWith(0, "offline")).toEqual({ reloaded: false, assigned: [] });
});

it("'Projects' loads the page for real when queued edits cannot be sent, so the browser asks first", () => {
  expect(leaveWith(1, "offline")).toEqual({ reloaded: true, assigned: ["/dashboard"] });
  expect(leaveWith(2, "signed-out")).toEqual({ reloaded: true, assigned: ["/dashboard"] });
  // A click that opens a new tab leaves this one as it is.
  expect(leaveWith(1, "offline", { metaKey: true })).toEqual({ reloaded: false, assigned: [] });
});

it("'Back to projects' on a deleted project leaves without asking: its edits can never be saved", () => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const store = makeStore();
  store.getState().edit([{ op: "move_clip", clipId: "x2", start: 100 }], "move");
  store.getState().setStatus("deleted");
  const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
  render(
    <EditorProvider store={store}>
      <EditorScreen />
    </EditorProvider>,
  );
  expect(fireEvent.click(screen.getByRole("link", { name: "Back to projects" }))).toBe(true);
  expect(assign).not.toHaveBeenCalled();
});
