"use client";

import { useRef, type ComponentProps, type KeyboardEvent } from "react";
import { DISABLED, FADE, FOCUS_RING, cx } from "./cx";

export type SegmentedProps<T extends string> = Omit<ComponentProps<"button">, "value" | "onChange" | "children" | "aria-label"> & {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange(value: T): void;
};

const NEXT_KEYS: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

// One choice out of a few, as a radio group. Only the chosen option is in the tab order; the
// arrow keys move the choice. Extra props go on every option button, except id, which names the
// group (an id must be unique). A caller's onClick and onKeyDown run first; calling
// preventDefault() in them skips the control's own handling.
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  id,
  className,
  onClick,
  onKeyDown,
  ...rest
}: SegmentedProps<T>) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const chosen = options.findIndex((o) => o.value === value);
  const tabStop = chosen === -1 ? 0 : chosen;

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    const by = NEXT_KEYS[event.key];
    if (by === undefined) return;
    event.preventDefault();
    const next = (index + by + options.length) % options.length;
    buttons.current[next]?.focus();
    if (options[next].value !== value) onChange(options[next].value);
  }

  return (
    <div
      id={id}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={cx("flex h-7 min-w-0 gap-px rounded-md border border-ed-line bg-ed-raised p-px", className)}
    >
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(el) => {
            buttons.current[index] = el;
          }}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={index === tabStop ? 0 : -1}
          disabled={disabled}
          className={cx(
            "flex-1 truncate rounded-[4px] px-2 text-xs font-medium text-ed-muted select-none",
            "enabled:hover:bg-ed-hover enabled:hover:text-ed-text",
            "aria-checked:bg-ed-accent-weak aria-checked:text-ed-accent enabled:aria-checked:hover:bg-ed-accent-weak enabled:aria-checked:hover:text-ed-accent",
            FOCUS_RING,
            FADE,
            DISABLED,
          )}
          onClick={(event) => {
            onClick?.(event);
            if (!event.defaultPrevented && option.value !== value) onChange(option.value);
          }}
          onKeyDown={(event) => handleKeyDown(event, index)}
          {...rest}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
