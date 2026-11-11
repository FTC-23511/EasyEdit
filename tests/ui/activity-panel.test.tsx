// @vitest-environment happy-dom
import { StrictMode } from "react";
import { expect, it } from "vitest";
import { ActivityPanel } from "@/components/editor/activity-panel";
import { EditorProvider } from "@/components/editor/context";
import { ACTIVITY_LIMIT } from "@/lib/editor/store";
import type { ProjectApi } from "@/lib/editor/api";
import { makeFakeServer } from "../editor/fake-server";
import { entry, makeStore, sampleDoc } from "../editor/fixtures";
import { act, fireEvent, render, screen, waitFor } from "../helpers/dom";

const rename = (i: number) => [{ op: "update_track" as const, trackId: "v1", patch: { name: `V${i}` } }];

function setup(count: number, over: Parameters<typeof makeStore>[0] = {}) {
  const server = makeFakeServer(sampleDoc(), 0);
  for (let i = 0; i < count; i++) server.remote(rename(i));
  const store = makeStore({ doc: server.doc(), version: count, ...over });
  const ops = () => server.calls.filter((c) => c === "ops").length;
  const view = (api: ProjectApi = server.api) =>
    render(
      <StrictMode>
        <EditorProvider store={store} api={api}>
          <ActivityPanel />
        </EditorProvider>
      </StrictMode>,
    );
  return { server, store, ops, view };
}

const rows = () => screen.queryAllByRole("listitem");
const flush = () => act(async () => {});

it("a failed first load can be retried, and strict mode makes one request", async () => {
  const { server, ops, view } = setup(3);
  server.fail("network");
  view();
  await screen.findByText("Couldn't load changes.");
  expect(ops()).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(rows()).toHaveLength(3));
  expect(ops()).toBe(2);
});

it("after a retry it reloads only when the project moved ahead of the list", async () => {
  const { server, store, ops, view } = setup(3);
  server.fail("network");
  view();
  await screen.findByText("Couldn't load changes.");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(rows()).toHaveLength(3));
  expect(ops()).toBe(2);

  server.remote(rename(9));
  act(() => {
    expect(store.getState().applyRemote([server.log[3]])).toBe(true);
  });
  await waitFor(() => expect(rows()).toHaveLength(4));
  await flush();
  expect(ops()).toBe(2);

  act(() => store.getState().replaceServer(server.doc(), 9));
  await waitFor(() => expect(ops()).toBe(3));
  await flush();
  expect(ops()).toBe(3);
});

it("a failed 'Show earlier changes' says so and can be retried", async () => {
  const { server, ops, view } = setup(120);
  view();
  await waitFor(() => expect(rows()).toHaveLength(50));
  server.fail("network");
  fireEvent.click(screen.getByRole("button", { name: "Show earlier changes" }));
  await screen.findByText("Couldn't load changes.");
  expect(rows()).toHaveLength(50);
  expect(screen.queryByRole("button", { name: "Show earlier changes" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(rows()).toHaveLength(100));
  expect(screen.queryByText("Couldn't load changes.")).toBeNull();
  expect(ops()).toBe(3);
});

it("shows 'Undo this change' to an editor, on the button itself, and not to a viewer", async () => {
  const editor = setup(3);
  editor.view();
  await waitFor(() => expect(rows()).toHaveLength(3));
  const buttons = screen.getAllByRole("button", { name: "Undo this change" });
  expect(buttons).toHaveLength(3);
  expect(buttons[0].hasAttribute("data-edit-control")).toBe(true);
  document.body.innerHTML = "";

  const viewer = setup(3, { canEdit: false });
  viewer.view();
  await waitFor(() => expect(rows()).toHaveLength(3));
  expect(screen.queryByRole("button", { name: "Undo this change" })).toBeNull();
});

it("at the most the list keeps, it says so instead of offering earlier changes", async () => {
  let calls = 0;
  const api: ProjectApi = {
    postOps: async () => ({ ok: false, kind: "network" }),
    getVersion: async () => ({ ok: false, kind: "network" }),
    getProject: async () => ({ ok: false, kind: "network" }),
    getOpsSince: async () => {
      calls += 1;
      return { ok: true, version: 500, entries: [], hasMore: false };
    },
  };
  const store = makeStore({ version: 500 });
  store.getState().loadActivity(Array.from({ length: ACTIVITY_LIMIT }, (_, i) => entry(301 + i, [])));
  render(
    <EditorProvider store={store} api={api}>
      <ActivityPanel />
    </EditorProvider>,
  );
  await waitFor(() => expect(calls).toBe(1));
  await flush();
  expect(screen.queryByRole("button", { name: "Show earlier changes" })).toBeNull();
  expect(screen.getByText("Showing the latest 200 changes.")).toBeTruthy();
});

it("shows the whole summary of a long entry, with 'Undo this change' under it", async () => {
  const server = makeFakeServer(sampleDoc(), 0);
  server.remote([{ op: "update_track", trackId: "v1", patch: { name: "Opening shot" } }], "claude:u2", "Claude (for Grace Hopper)");
  const store = makeStore({ doc: server.doc(), version: 1 });
  render(
    <EditorProvider store={store} api={server.api}>
      <ActivityPanel />
    </EditorProvider>,
  );
  const [row] = await waitFor(() => {
    const found = rows();
    expect(found).toHaveLength(1);
    return found;
  });
  const summary = screen.getByText(/^Claude \(for Grace Hopper\) · /);
  expect(summary.textContent?.length).toBeGreaterThan(40);
  expect(summary.closest(".truncate")).toBeNull();
  const undo = screen.getByRole("button", { name: "Undo this change" });
  expect(row.contains(undo)).toBe(true);
  // Under the text, not beside it: the button is in the line that follows the summary.
  expect(summary.nextElementSibling?.contains(undo)).toBe(true);
});
