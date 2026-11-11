// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { NumberInput } from "@/components/ui/number-input";
import { fireEvent, render, screen } from "../helpers/dom";

function setup() {
  const onCommit = vi.fn();
  const onPreview = vi.fn();
  render(<NumberInput ariaLabel="Size" value={64} min={8} max={1000} onCommit={onCommit} onPreview={onPreview} />);
  return { input: screen.getByLabelText("Size") as HTMLInputElement, onCommit, onPreview };
}

it("previews while typing and commits once on Enter", () => {
  const { input, onCommit, onPreview } = setup();
  fireEvent.change(input, { target: { value: "72" } });
  expect(onPreview).toHaveBeenLastCalledWith(72);
  expect(onCommit).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onCommit).toHaveBeenCalledTimes(1);
  expect(onCommit).toHaveBeenCalledWith(72);
});

it("clamps to its range on blur, and puts back text that is not a number", () => {
  const { input, onCommit } = setup();
  fireEvent.change(input, { target: { value: "5000" } });
  fireEvent.blur(input);
  expect(onCommit).toHaveBeenCalledWith(1000);
  fireEvent.change(input, { target: { value: "abc" } });
  fireEvent.blur(input);
  expect(onCommit).toHaveBeenCalledTimes(1);
  expect(input.value).toBe("64");
});

it("Escape puts the old value back and commits nothing", () => {
  const { input, onCommit, onPreview } = setup();
  fireEvent.change(input, { target: { value: "90" } });
  fireEvent.keyDown(input, { key: "Escape" });
  expect(input.value).toBe("64");
  expect(onPreview).toHaveBeenLastCalledWith(null);
  fireEvent.blur(input);
  expect(onCommit).not.toHaveBeenCalled();
});

it("ArrowUp steps by step, and by ten steps with Shift, marking the key handled", () => {
  const onCommit = vi.fn();
  render(<NumberInput ariaLabel="Start" value={2} step={0.1} onCommit={onCommit} />);
  const input = screen.getByLabelText("Start");
  expect(fireEvent.keyDown(input, { key: "ArrowUp" })).toBe(false);
  expect(onCommit).toHaveBeenLastCalledWith(2.1);
  expect(fireEvent.keyDown(input, { key: "ArrowUp", shiftKey: true })).toBe(false);
  expect(onCommit).toHaveBeenLastCalledWith(3);
});

it("Enter then blur commits once, and Enter and Escape with a draft are marked handled", () => {
  const { input, onCommit } = setup();
  fireEvent.change(input, { target: { value: "72" } });
  expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
  fireEvent.blur(input);
  expect(onCommit).toHaveBeenCalledTimes(1);
  fireEvent.change(input, { target: { value: "90" } });
  expect(fireEvent.keyDown(input, { key: "Escape" })).toBe(false);
  expect(fireEvent.keyDown(input, { key: "Escape" })).toBe(true);
});
