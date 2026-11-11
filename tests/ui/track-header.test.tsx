// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { EditorProvider, useEditor } from "@/components/editor/context";
import { Toolbar } from "@/components/editor/timeline/toolbar";
import { TrackHeader } from "@/components/editor/timeline/track-header";
import { LIMITS } from "@/lib/limits";
import type { Track } from "@/lib/timeline";
import { makeStore, sampleDoc } from "../editor/fixtures";
import { act, fireEvent, render, screen } from "../helpers/dom";

// One track's header, re-rendered from the store as the track changes.
function Header({ id }: { id: string }) {
  const track = useEditor((s) => s.doc.tracks.find((t) => t.id === id));
  return track ? <TrackHeader track={track} selected={false} /> : null;
}

function setup(id = "t1", store = makeStore()) {
  const view = render(
    <EditorProvider store={store}>
      <Header id={id} />
    </EditorProvider>,
  );
  const track = () => store.getState().doc.tracks.find((t) => t.id === id) as Track;
  const openMenu = () => fireEvent.click(screen.getByRole("button", { name: "Track options" }));
  const item = (name: string) => screen.getByRole("menuitem", { name }) as HTMLButtonElement;
  const startRename = () => {
    openMenu();
    fireEvent.click(item("Rename"));
    return screen.getByRole("textbox", { name: "Track name" }) as HTMLInputElement;
  };
  return { store, view, track, openMenu, item, startRename };
}

describe("track header", () => {
  it("renames from the menu: the input takes focus, Enter saves and is marked handled", () => {
    const { store, track, startRename } = setup();
    const input = startRename();
    expect(document.activeElement).toBe(input);
    expect(input.maxLength).toBe(LIMITS.trackNameChars);
    fireEvent.change(input, { target: { value: "Titles" } });
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false); // false: defaultPrevented
    expect(track().name).toBe("Titles");
    expect(store.getState().queue.map((e) => e.label)).toEqual(["rename track"]);
    expect(screen.queryByRole("textbox", { name: "Track name" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Titles" }));
  });

  it("Escape cancels a rename and is marked handled", () => {
    const { store, track, startRename } = setup();
    const input = startRename();
    fireEvent.change(input, { target: { value: "Titles" } });
    expect(fireEvent.keyDown(input, { key: "Escape" })).toBe(false);
    expect(track().name).toBe("Text 1");
    expect(store.getState().queue).toEqual([]);
    expect(screen.queryByRole("textbox", { name: "Track name" })).toBeNull();
  });

  it("a blank name keeps the old one and makes no change", () => {
    const { store, track, startRename } = setup();
    const input = startRename();
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);
    expect(track().name).toBe("Text 1");
    expect(store.getState().queue).toEqual([]);
  });

  it("the lock switch keeps its name and shows whether it is on", () => {
    const { track } = setup();
    const lock = screen.getByRole("button", { name: "Lock track" });
    expect(lock.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(lock);
    expect(track().locked).toBe(true);
    expect(screen.getByRole("button", { name: "Lock track" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Hide track" }));
    expect(track().hidden).toBe(true);
    expect(screen.getByRole("button", { name: "Hide track" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("Remove track is disabled while the track is locked", () => {
    const { track, openMenu, item } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Lock track" }));
    openMenu();
    expect(item("Remove track (unlock first)").disabled).toBe(true);
    fireEvent.keyDown(item("Rename"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Lock track" }));
    openMenu();
    fireEvent.click(item("Remove track"));
    expect(track()).toBeUndefined();
  });

  it("Move up is disabled for the top row of its group", () => {
    for (const [id, up, down] of [["cap", true, false], ["t1", false, false], ["a1", true, true]] as const) {
      const { view, openMenu, item } = setup(id);
      openMenu();
      expect([item("Move up").disabled, item("Move down").disabled], id).toEqual([up, down]);
      view.unmount();
    }
  });

  it("a viewer's header controls are native controls and all disabled", () => {
    const { view } = setup("v1", makeStore({ canEdit: false }));
    const controls = [...view.container.querySelectorAll<HTMLButtonElement>("[data-edit-control]")];
    expect(controls.map((c) => c.getAttribute("aria-label"))).toEqual(["Lock track", "Hide track", "Mute track", "Track options"]);
    for (const c of controls) {
      expect(["BUTTON", "INPUT"]).toContain(c.tagName);
      expect(c.disabled).toBe(true);
    }
  });
});

describe("toolbar", () => {
  it("Add track is disabled once the project has the most tracks it may have", () => {
    const full = sampleDoc();
    for (let i = full.tracks.length; i < LIMITS.tracksPerProject; i++) {
      full.tracks.push({ id: `a${i}`, kind: "audio", name: `Audio ${i}`, muted: false, hidden: false, locked: false, clips: [] });
    }
    const store = makeStore({ doc: full });
    render(
      <EditorProvider store={store}>
        <Toolbar duration={120} fps={30} />
      </EditorProvider>,
    );
    const add = screen.getByRole("button", { name: "Add track" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(add.hasAttribute("data-edit-control")).toBe(true);
    act(() => store.getState().edit([{ op: "remove_track", trackId: "a19" }], "remove track"));
    expect(add.disabled).toBe(false);
  });
});
