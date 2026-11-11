"use client";

import { useState, type ComponentProps, type KeyboardEvent } from "react";
import { FIELD_BOX, cx } from "./cx";

export type NumberInputProps = Omit<
  ComponentProps<"input">,
  "value" | "defaultValue" | "onChange" | "min" | "max" | "step" | "type" | "inputMode" | "aria-label"
> & {
  value: number;
  onCommit(value: number): void;
  onPreview?(value: number | null): void; // the typed number while it is valid, else null
  min?: number;
  max?: number;
  step?: number;
  suffix?: string; // a unit shown inside the right edge, such as "%" or "s"
  ariaLabel?: string;
};

// Up to four decimals, without the float noise of values such as 0.1 + 0.2.
function format(n: number): string {
  return String(Number(n.toFixed(4)));
}

function decimals(n: number): number {
  const text = String(n);
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}

// A text field for a number. What was typed is kept as a draft until Enter or blur commits it,
// so the field never fights the person typing. Without a draft it shows value.
export function NumberInput({
  value,
  onCommit,
  onPreview,
  min = -Infinity,
  max = Infinity,
  step = 1,
  suffix,
  ariaLabel,
  className,
  onBlur,
  onKeyDown,
  ...rest
}: NumberInputProps) {
  const [draft, setDraft] = useState<string | null>(null);

  function parse(text: string): number | null {
    let t = text.trim();
    if (suffix && t.endsWith(suffix)) t = t.slice(0, -suffix.length).trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }

  const clamp = (n: number) => Math.min(max, Math.max(min, n));

  function commit() {
    if (draft === null) return;
    setDraft(null);
    const n = parse(draft);
    const next = n === null ? value : clamp(n);
    if (next === value) onPreview?.(null);
    else onCommit(next);
  }

  function nudge(by: number) {
    const base = (draft === null ? null : parse(draft)) ?? value;
    const places = Math.min(10, Math.max(decimals(step), decimals(base)));
    const next = clamp(Number((base + by).toFixed(places)));
    setDraft(null);
    if (next === value) onPreview?.(null);
    else onCommit(next);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      if (draft === null) return;
      event.preventDefault();
      setDraft(null);
      onPreview?.(null);
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const steps = event.shiftKey ? 10 : 1;
      nudge((event.key === "ArrowUp" ? steps : -steps) * step);
    }
  }

  return (
    <span className={cx("relative flex min-w-0", className)}>
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        aria-label={ariaLabel}
        className={cx(FIELD_BOX, "peer h-7 tabular-nums", suffix && "pr-7")}
        value={draft ?? format(value)}
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          const n = parse(text);
          onPreview?.(n !== null && n >= min && n <= max ? n : null);
        }}
        onBlur={(event) => {
          onBlur?.(event);
          commit();
        }}
        onKeyDown={handleKeyDown}
        {...rest}
      />
      {suffix && (
        <span
          aria-hidden
          className="pointer-events-none absolute top-1.5 right-2 text-xs text-ed-muted peer-disabled:opacity-40"
        >
          {suffix}
        </span>
      )}
    </span>
  );
}
