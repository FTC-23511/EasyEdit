// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { EditorProvider } from "@/components/editor/context";
import { EditorScreen } from "@/components/editor/editor-screen";
import type { EditorStore } from "@/lib/editor/store";
import { makeStore, sampleDoc } from "../editor/fixtures";
import { fireEvent, render, screen } from "../helpers/dom";

function show(canEdit: boolean) {
  const store = makeStore({ canEdit });
  store.getState().select(["x1"]);
  const { container } = render(<EditorProvider store={store}><EditorScreen /></EditorProvider>);
  const controls = [...container.querySelectorAll<HTMLButtonElement>("[data-edit-control]")];
  return { store, container, controls };
}

it("a viewer sees the same screen with no working edit control", () => {
  const { store, container, controls } = show(false);
  expect(controls.length).toBeGreaterThan(10);
  for (const control of controls) expect(control.disabled, control.outerHTML.slice(0, 120)).toBe(true);
  expect(container.querySelector("[data-trim-handle]")).toBeNull();
  expect(screen.getByText("View only")).toBeTruthy();
  expect((screen.getByRole("button", { name: /^Play/ }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByRole("img", { name: "Preview" })).toBeTruthy();
  fireEvent.keyDown(document.body, { key: "Delete" });
  fireEvent.keyDown(document.body, { key: "s" });
  expect(store.getState().doc).toEqual(sampleDoc());
  expect(store.getState().queue).toEqual([]);
});

it("an editor sees those controls working", () => {
  const { store, container, controls } = show(true);
  expect(controls.filter((control) => !control.disabled).length).toBeGreaterThan(10);
  expect(container.querySelector("[data-trim-handle]")).not.toBeNull();
  expect(screen.queryByText("View only")).toBeNull();
  fireEvent.keyDown(document.body, { key: "Delete" });
  expect(store.getState().queue).toMatchObject([{ label: "delete" }]);
});

// Every edit control on the screen, by tag and name, in page order, for what is selected. The list is
// exact, so a control that loses data-edit-control (or a new one without it) is noticed.
const TOP = ["button Undo", "button Redo", "button Add title", "button Add subtitle", "button Add lower third"];
const TIMELINE = [
  "button Add track", "button Split", "button Delete", "button Ripple delete",
  "button Lock track", "button Hide track", "button Track options",
  "button Lock track", "button Hide track", "button Track options",
  "button Lock track", "button Hide track", "button Mute track", "button Track options",
  "button Lock track", "button Mute track", "button Track options",
];
const STATES: [string, (store: EditorStore) => void, string[]][] = [
  [
    "a clip selected",
    (store) => store.getState().select(["x1"]),
    [
      "textarea Text", "input Size", "select Weight", "input Color", "input Hex color", "button Left", "button Center", "button Right",
      "input X", "input Y", "input Scale", "input Rotation", "input Opacity", "input Start", "input Length",
    ],
  ],
  ["nothing selected", (store) => store.getState().select([]), ["select Format"]],
  ["a track selected", (store) => store.getState().selectTrack("t1"), ["input Name", "button Locked", "button Hidden", "button Remove track"]],
];

const NATIVE = ["BUTTON", "INPUT", "SELECT", "TEXTAREA"];

// The accessible name, as far as these controls need: aria-label, else the caption of the label
// that wraps the control, else its text.
function nameOf(control: HTMLElement): string {
  const own = control.getAttribute("aria-label");
  if (own) return own;
  const label = control.closest("label");
  const caption = label ? [...label.children].find((c) => c.tagName === "SPAN" && !c.contains(control)) : undefined;
  return (caption ?? control).textContent?.trim() ?? "";
}

function showWith(canEdit: boolean, choose: (store: EditorStore) => void) {
  const store = makeStore({ canEdit });
  choose(store);
  const { container } = render(<EditorProvider store={store}><EditorScreen /></EditorProvider>);
  const controls = [...container.querySelectorAll<HTMLElement>("[data-edit-control]")];
  return { store, container, controls, names: controls.map((c) => `${c.tagName.toLowerCase()} ${nameOf(c)}`) };
}

describe.each(STATES)("with %s", (_state, choose, inspector) => {
  const expected = [...TOP, ...inspector, ...TIMELINE];

  it("a viewer has every edit control on the screen, each one native and disabled", () => {
    const { store, container, controls, names } = showWith(false, choose);
    expect(names).toEqual(expected);
    for (const control of controls) {
      expect(NATIVE, control.outerHTML.slice(0, 120)).toContain(control.tagName);
      expect((control as HTMLButtonElement).disabled, control.outerHTML.slice(0, 120)).toBe(true);
    }
    expect(container.querySelector("[data-trim-handle]")).toBeNull();
    expect((screen.getByRole("button", { name: /^Play/ }) as HTMLButtonElement).disabled).toBe(false);
    const before = store.getState().doc;
    fireEvent.keyDown(document.body, { key: "Delete" });
    fireEvent.keyDown(document.body, { key: "s" });
    expect(store.getState().doc).toBe(before);
    expect(store.getState().queue).toEqual([]);
  });

  it("an editor has the same controls", () => {
    const { names } = showWith(true, choose);
    expect(names).toEqual(expected);
  });
});
