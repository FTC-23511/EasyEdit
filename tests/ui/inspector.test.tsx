// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { EditorProvider } from "@/components/editor/context";
import { Inspector } from "@/components/editor/inspector";
import { MESSAGES, explainOpError } from "@/lib/editor/messages";
import { findClip, viewDoc } from "@/lib/editor/store";
import { LIMITS } from "@/lib/limits";
import { entry, makeStore, text } from "../editor/fixtures";
import { act, fireEvent, render, screen } from "../helpers/dom";

it("previews while typing and saves one change on blur", () => {
  const store = makeStore();
  store.getState().select(["x1"]);
  render(<EditorProvider store={store}><Inspector /></EditorProvider>);
  const field = screen.getByLabelText("Text");
  fireEvent.change(field, { target: { value: "GO" } });
  expect(findClip(viewDoc(store.getState()), "x1")!.clip).toMatchObject({ text: "GO" });
  expect(store.getState().queue).toEqual([]);
  fireEvent.blur(field);
  expect(store.getState().queue).toMatchObject([{ label: "text edit", ops: [{ op: "update_clip", clipId: "x1", patch: { text: "GO" } }] }]);
});

it("shows the project with nothing selected, and switches the format", () => {
  const store = makeStore();
  render(<EditorProvider store={store}><Inspector /></EditorProvider>);
  expect(screen.getByText("Select a clip to edit it.")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Format"), { target: { value: "long_16x9" } });
  expect(store.getState().doc).toMatchObject({ format: "long_16x9", width: 1920, height: 1080 });
  expect(store.getState().queue).toMatchObject([{ label: "format change" }]);
});

it("saves the clamped value when a size above the maximum is confirmed with Enter", () => {
  const store = makeStore();
  store.getState().select(["x1"]);
  render(<EditorProvider store={store}><Inspector /></EditorProvider>);
  const size = screen.getByLabelText("Size");
  fireEvent.change(size, { target: { value: "5000" } });
  fireEvent.keyDown(size, { key: "Enter" });
  expect(store.getState().gesture).toBeNull();
  expect(store.getState().queue).toMatchObject([
    { label: "style change", ops: [{ op: "update_clip", clipId: "x1", patch: { style: { fontSize: 1000 } } }] },
  ]);
  expect(findClip(store.getState().doc, "x1")!.clip).toMatchObject({ style: { fontSize: 1000 } });
});

it("a refused text says so on blur and shows the saved text again", () => {
  const store = makeStore();
  store.getState().select(["x1"]);
  render(<EditorProvider store={store}><Inspector /></EditorProvider>);
  const field = screen.getByLabelText("Text") as HTMLTextAreaElement;
  fireEvent.change(field, { target: { value: "a\u0000b" } });
  fireEvent.blur(field);
  expect(store.getState().notice).toMatchObject({ tone: "error", text: explainOpError("INVALID") });
  expect(store.getState().queue).toEqual([]);
  expect(store.getState().gesture).toBeNull();
  expect(field.value).toBe("hi");
});

it("edits a selected track through the track commands", () => {
  const store = makeStore();
  store.getState().selectTrack("t1");
  render(<EditorProvider store={store}><Inspector /></EditorProvider>);
  expect(screen.getByText("Text · 2 clips")).toBeTruthy();
  expect(screen.queryByRole("switch", { name: "Muted" })).toBeNull();
  const name = screen.getByLabelText("Name");
  fireEvent.change(name, { target: { value: "Titles" } });
  expect(fireEvent.keyDown(name, { key: "Enter" })).toBe(false);
  fireEvent.blur(name);
  fireEvent.click(screen.getByRole("switch", { name: "Locked" }));
  expect(store.getState().queue.map((e) => e.label)).toEqual(["rename track", "track change"]);
  expect(store.getState().doc.tracks[1]).toMatchObject({ name: "Titles", locked: true });
  expect((screen.getByRole("button", { name: "Remove track" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("Unlock the track to remove it.")).toBeTruthy();
});

it("a viewer sees the values with every edit control disabled", () => {
  const store = makeStore({ canEdit: false });
  store.getState().select(["x1"]);
  const { container } = render(<EditorProvider store={store}><Inspector /></EditorProvider>);
  expect((screen.getByLabelText("Text") as HTMLTextAreaElement).value).toBe("hi");
  expect((screen.getByLabelText("Size") as HTMLInputElement).value).toBe("64");
  const controls = [...container.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input, select, textarea")];
  expect(controls.length).toBeGreaterThan(10);
  for (const control of controls) {
    expect(control.hasAttribute("data-edit-control")).toBe(true);
    expect(control.disabled).toBe(true);
  }
});

it("a clip removed by someone else while its field is typed in ends the edit", () => {
  const store = makeStore();
  store.getState().select(["x1"]);
  render(<EditorProvider store={store}><Inspector /></EditorProvider>);
  fireEvent.change(screen.getByLabelText("Text"), { target: { value: "GO" } });
  act(() => {
    store.getState().applyRemote([entry(6, [{ op: "remove_clip", clipId: "x1" }])]);
  });
  expect(store.getState().gesture).toBeNull();
  expect(store.getState().notice).toMatchObject({ text: MESSAGES.clipGone });
  expect(screen.getByText("Select a clip to edit it.")).toBeTruthy();
  expect(store.getState().queue).toEqual([]);
});

it("the color swatch previews while it moves and saves once when it closes; a bad hex value is reported", () => {
  const store = makeStore();
  store.getState().select(["x1"]);
  render(<EditorProvider store={store}><Inspector /></EditorProvider>);
  const swatch = screen.getByLabelText("Color");
  fireEvent.input(swatch, { target: { value: "#ff0000" } });
  expect(findClip(viewDoc(store.getState()), "x1")!.clip).toMatchObject({ style: { color: "#ff0000" } });
  expect(store.getState().queue).toEqual([]);
  fireEvent.change(swatch);
  expect(store.getState().gesture).toBeNull();
  expect(store.getState().queue).toMatchObject([{ label: "style change", ops: [{ patch: { style: { color: "#ff0000" } } }] }]);

  const hex = screen.getByLabelText("Hex color") as HTMLInputElement;
  fireEvent.change(hex, { target: { value: "red" } });
  fireEvent.keyDown(hex, { key: "Enter" });
  expect(store.getState().notice).toMatchObject({ tone: "error", text: explainOpError("INVALID") });
  expect(hex.value).toBe("#ff0000");
  expect(store.getState().queue).toHaveLength(1);
});

describe("fix round 1", () => {
  function setup(select: { clip?: string; track?: string } = { clip: "x1" }) {
    const store = makeStore();
    if (select.clip) store.getState().select([select.clip]);
    if (select.track) store.getState().selectTrack(select.track);
    render(<EditorProvider store={store}><Inspector /></EditorProvider>);
    return store;
  }
  const clipOf = (store: ReturnType<typeof makeStore>, id: string) => findClip(store.getState().doc, id)!.clip;
  const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

  it.each([
    ["Size", "72", { op: "update_clip", clipId: "x1", patch: { style: { fontSize: 72 } } }, "style change"],
    ["Start", "0.5", { op: "move_clip", clipId: "x1", start: 15 }, "timing change"],
  ] as const)("an in-range %s confirmed with Enter is saved as one edit", (label, value, op, editLabel) => {
    const store = setup();
    fireEvent.change(input(label), { target: { value } });
    expect(store.getState().queue).toEqual([]);
    fireEvent.keyDown(input(label), { key: "Enter" });
    expect(store.getState().gesture).toBeNull();
    expect(store.getState().queue).toMatchObject([{ label: editLabel, ops: [op] }]);
    expect(input(label).value).toBe(value);
  });

  it.each([
    ["X", "25", { transform: { x: 0.25 } }],
    ["Opacity", "40", { transform: { opacity: 0.4 } }],
  ] as const)("an in-range %s is saved on blur", (label, value, patch) => {
    const store = setup();
    fireEvent.change(input(label), { target: { value } });
    expect(store.getState().queue).toEqual([]);
    fireEvent.blur(input(label));
    expect(store.getState().gesture).toBeNull();
    expect(store.getState().queue).toMatchObject([{ label: "position change", ops: [{ op: "update_clip", clipId: "x1", patch }] }]);
    expect(input(label).value).toBe(value);
  });

  it("a time that rounds to the current frame saves nothing and says nothing", () => {
    const store = setup({ clip: "x2" });
    fireEvent.change(input("Start"), { target: { value: "3.01" } });
    fireEvent.keyDown(input("Start"), { key: "Enter" });
    expect(store.getState().queue).toEqual([]);
    expect(store.getState().notice).toBeNull();
    expect(store.getState().gesture).toBeNull();
  });

  it("a number that is not plain decimal is refused, not read as hex", () => {
    const store = setup();
    fireEvent.change(input("Start"), { target: { value: "0x10" } });
    expect(store.getState().gesture).toBeNull();
    fireEvent.keyDown(input("Start"), { key: "Enter" });
    expect(store.getState().queue).toEqual([]);
    expect(store.getState().notice).toMatchObject({ tone: "error", text: explainOpError("INVALID") });
    expect(clipOf(store, "x1").start).toBe(0);
  });

  it.each([["Text", "GO", { text: "GO" }, "text edit"], ["Size", "72", { style: { fontSize: 72 } }, "style change"]] as const)(
    "a %s typed and left by selecting another clip is saved",
    (label, value, patch, editLabel) => {
      const store = setup();
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
      act(() => store.getState().select(["x2"]));
      expect(store.getState().gesture).toBeNull();
      expect(store.getState().queue).toMatchObject([{ label: editLabel, ops: [{ op: "update_clip", clipId: "x1", patch }] }]);
      expect(clipOf(store, "x2")).toMatchObject({ text: "hi", style: { fontSize: 64 } });
      expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(label === "Text" ? "hi" : "64");
    },
  );

  it("a draft left by selecting a track is saved too", () => {
    const store = setup();
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "GO" } });
    act(() => store.getState().selectTrack("v1"));
    expect(store.getState().gesture).toBeNull();
    expect(store.getState().queue).toMatchObject([{ label: "text edit" }]);
  });

  it("a remote removal while a number is typed saves nothing and does not throw", () => {
    const store = setup();
    fireEvent.change(input("Size"), { target: { value: "72" } });
    act(() => {
      store.getState().applyRemote([entry(6, [{ op: "remove_clip", clipId: "x1" }])]);
    });
    expect(store.getState().gesture).toBeNull();
    expect(store.getState().queue).toEqual([]);
    expect(screen.getByText("Select a clip to edit it.")).toBeTruthy();
  });

  it("a text field saves only the gesture it started", () => {
    const store = setup();
    const field = screen.getByLabelText("Text");
    fireEvent.change(field, { target: { value: "GO" } });
    act(() => {
      store.getState().setGesture([{ op: "move_clip", clipId: "c1", start: 200 }]);
    });
    fireEvent.blur(field);
    expect(store.getState().queue).toEqual([]);
    expect(store.getState().gesture?.ops).toMatchObject([{ op: "move_clip", clipId: "c1" }]);
  });

  it.each([
    ["Text", "GO", "hi"],
    ["Size", "72", "64"],
    ["Hex color", "#00ff00", "#ffffff"],
  ])("Escape in %s puts the saved value back and saves nothing", (label, value, saved) => {
    const store = setup();
    const field = screen.getByLabelText(label) as HTMLInputElement;
    fireEvent.change(field, { target: { value } });
    expect(store.getState().gesture).not.toBeNull();
    expect(fireEvent.keyDown(field, { key: "Escape" })).toBe(false);
    expect(field.value).toBe(saved);
    expect(store.getState().gesture).toBeNull();
    fireEvent.blur(field);
    expect(store.getState().queue).toEqual([]);
  });

  it("two fields edited one after the other give two edits, each with its own label", () => {
    const store = setup();
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "GO" } });
    fireEvent.blur(screen.getByLabelText("Text"));
    fireEvent.change(input("Rotation"), { target: { value: "-45" } });
    fireEvent.blur(input("Rotation"));
    expect(store.getState().queue).toMatchObject([
      { label: "text edit", ops: [{ op: "update_clip", clipId: "x1", patch: { text: "GO" } }] },
      { label: "position change", ops: [{ op: "update_clip", clipId: "x1", patch: { transform: { rotation: -45 } } }] },
    ]);
  });

  it("Weight and Align each send one edit", () => {
    const store = setup();
    fireEvent.change(screen.getByLabelText("Weight"), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("radio", { name: "Left" }));
    expect(store.getState().queue).toMatchObject([
      { label: "style change", ops: [{ op: "update_clip", clipId: "x1", patch: { style: { fontWeight: 500 } } }] },
      { label: "style change", ops: [{ op: "update_clip", clipId: "x1", patch: { style: { align: "left" } } }] },
    ]);
    expect(store.getState().queue).toHaveLength(2);
  });

  it("Hidden and Muted each send one edit, and Remove track removes the track", () => {
    const store = setup({ track: "v1" });
    fireEvent.click(screen.getByRole("switch", { name: "Hidden" }));
    fireEvent.click(screen.getByRole("switch", { name: "Muted" }));
    expect(store.getState().queue).toMatchObject([
      { label: "track change", ops: [{ op: "update_track", trackId: "v1", patch: { hidden: true } }] },
      { label: "track change", ops: [{ op: "update_track", trackId: "v1", patch: { muted: true } }] },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Remove track" }));
    expect(store.getState().queue).toHaveLength(3);
    expect(store.getState().queue[2]).toMatchObject({ label: "remove track", ops: [{ op: "remove_track", trackId: "v1" }] });
    expect(store.getState().doc.tracks.some((t) => t.id === "v1")).toBe(false);
  });

  it("Escape on the track name keeps the old name, and the name is limited to the track name length", () => {
    const store = setup({ track: "t1" });
    const name = input("Name");
    expect(name.maxLength).toBe(LIMITS.trackNameChars);
    fireEvent.change(name, { target: { value: "Titles" } });
    expect(fireEvent.keyDown(name, { key: "Escape" })).toBe(false);
    expect(name.value).toBe("Text 1");
    fireEvent.blur(name);
    expect(store.getState().queue).toEqual([]);
    expect(store.getState().doc.tracks[1].name).toBe("Text 1");
  });

  it.each([
    ["cap", 0, "Captions · No clips"],
    ["t1", 1, "Text · 1 clip"],
    ["t1", 3, "Text · 3 clips"],
  ] as const)("counts the clips of a track (%s, %i)", (trackId, clips, line) => {
    const store = makeStore();
    if (trackId === "t1" && clips === 1) store.getState().edit([{ op: "remove_clip", clipId: "x2" }], "delete");
    if (clips === 3) store.getState().edit([{ op: "add_clip", trackId: "t1", clip: text("x3", 200, 30) }], "add");
    store.getState().selectTrack(trackId);
    render(<EditorProvider store={store}><Inspector /></EditorProvider>);
    expect(screen.getByText(line)).toBeTruthy();
  });
});
