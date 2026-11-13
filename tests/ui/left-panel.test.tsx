// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { EditorProvider } from "@/components/editor/context";
import { LeftPanel } from "@/components/editor/left-panel";
import { makeStore } from "../editor/fixtures";
import { fireEvent, render, screen } from "../helpers/dom";

const NAMES = ["Add title", "Add subtitle", "Add lower third"];

function setup(canEdit = true) {
  const store = makeStore({ canEdit });
  render(<EditorProvider store={store}><LeftPanel /></EditorProvider>);
  return store;
}

it("offers three text presets that add a clip and are disabled for a viewer", () => {
  const store = setup();
  const buttons = NAMES.map((name) => screen.getByRole("button", { name }));
  for (const b of buttons) expect(b.hasAttribute("data-edit-control")).toBe(true);
  const texts = () => store.getState().doc.tracks.flatMap((t) => t.clips).filter((c) => c.type === "text").length;
  const before = texts();
  for (const b of buttons) fireEvent.click(b);
  expect(texts()).toBe(before + 3);
});

it("disables the preset buttons for a viewer", () => {
  const store = setup(false);
  for (const name of NAMES) {
    const b = screen.getByRole("button", { name }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    fireEvent.click(b);
  }
  expect(store.getState().queue).toEqual([]);
});

it("shows the Media tab as loading when there is no provider", () => {
  setup();
  fireEvent.click(screen.getByRole("tab", { name: "Media" }));
  expect(screen.getByText("Loading media")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Add title" })).toBeNull();
});
