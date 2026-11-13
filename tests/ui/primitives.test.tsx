// @vitest-environment happy-dom
import { Plus } from "lucide-react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Menu } from "@/components/ui/menu";
import { NumberInput } from "@/components/ui/number-input";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { TextArea } from "@/components/ui/text-area";
import { TextInput } from "@/components/ui/text-input";
import { Toggle } from "@/components/ui/toggle";
import { fireEvent, render, screen } from "../helpers/dom";

afterEach(() => vi.restoreAllMocks());

const ALIGN = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
] as const;

it("puts data-edit-control and disabled on the native control itself", () => {
  const { container } = render(
    <>
      <Button data-edit-control disabled>Remove</Button>
      <IconButton data-edit-control disabled label="Split">
        <Plus />
      </IconButton>
      <TextInput data-edit-control disabled aria-label="Name" />
      <NumberInput data-edit-control disabled ariaLabel="Size" value={1} onCommit={() => {}} />
      <TextArea data-edit-control disabled aria-label="Text" />
      <Select data-edit-control disabled aria-label="Weight">
        <option>400</option>
      </Select>
      <Toggle data-edit-control disabled label="Locked" checked={false} onChange={() => {}} />
      <Segmented data-edit-control disabled label="Align" value="left" options={[...ALIGN]} onChange={() => {}} />
      <Menu data-edit-control disabled label="Track options" icon={<Plus />} items={[]} onSelect={() => {}} />
    </>,
  );
  const marked = [...container.querySelectorAll<HTMLButtonElement>("[data-edit-control]")];
  expect(marked.map((el) => el.tagName)).toEqual(["BUTTON", "BUTTON", "INPUT", "INPUT", "TEXTAREA", "SELECT", "BUTTON", "BUTTON", "BUTTON", "BUTTON"]);
  for (const el of marked) expect(el.disabled, el.outerHTML.slice(0, 80)).toBe(true);
  expect(screen.getAllByRole("radio")).toHaveLength(2);
  expect(screen.getByRole("switch", { name: "Locked" }).hasAttribute("data-edit-control")).toBe(true);
});

it("a caller's onClick on Toggle and Segmented does not stop onChange", () => {
  const onClick = vi.fn();
  const onToggle = vi.fn();
  const onAlign = vi.fn();
  render(
    <>
      <Toggle label="Locked" checked={false} onChange={onToggle} onClick={onClick} />
      <Segmented label="Align" value="left" options={[...ALIGN]} onChange={onAlign} onClick={onClick} />
    </>,
  );
  fireEvent.click(screen.getByRole("switch", { name: "Locked" }));
  fireEvent.click(screen.getByRole("radio", { name: "Right" }));
  expect(onClick).toHaveBeenCalledTimes(2);
  expect(onToggle).toHaveBeenCalledWith(true);
  expect(onAlign).toHaveBeenCalledWith("right");
});

function DisablingMenu() {
  const [disabled, setDisabled] = useState(false);
  return (
    <>
      <Menu label="Track options" icon={<Plus />} items={[{ id: "rename", label: "Rename" }]} onSelect={() => {}} disabled={disabled} />
      <button type="button" onClick={() => setDisabled((d) => !d)}>
        Switch
      </button>
    </>
  );
}

it("a menu disabled while open stays closed when it is enabled again", () => {
  render(<DisablingMenu />);
  fireEvent.click(screen.getByRole("button", { name: "Track options" }));
  expect(screen.getByRole("menu")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Switch" }));
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Switch" }));
  expect(screen.queryByRole("menu")).toBeNull();
});

it("a dialog opens with focus on its marked field, text selected; with none marked the browser's choice stands", () => {
  // As a browser's showModal: the first control takes focus, here the header's Close.
  vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
    this.querySelector<HTMLElement>("button, input")?.focus();
  });
  function Shown({ marked }: { marked: boolean }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open</button>
        <Dialog title="Rename" open={open} onClose={() => setOpen(false)}>
          <TextInput aria-label="Name" defaultValue="field" data-autofocus={marked || undefined} />
        </Dialog>
      </>
    );
  }
  const { unmount } = render(<Shown marked />);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  const name = screen.getByLabelText("Name") as HTMLInputElement;
  expect(document.activeElement).toBe(name);
  expect([name.selectionStart, name.selectionEnd]).toEqual([0, 5]);
  unmount();

  render(<Shown marked={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
});
