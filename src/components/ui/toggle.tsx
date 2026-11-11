"use client";

import type { ComponentProps } from "react";
import { DISABLED, FADE, FOCUS_RING, cx } from "./cx";

export type ToggleProps = Omit<ComponentProps<"button">, "onChange" | "children"> & {
  label: string;
  checked: boolean;
  onChange(checked: boolean): void;
};

// An on/off switch with its label beside it. The <label> names the switch and clicking the text flips it too.
// A caller's onClick runs first; calling preventDefault() in it keeps the switch as it is.
export function Toggle({ label, checked, onChange, disabled, className, onClick, ...rest }: ToggleProps) {
  return (
    <label className={cx("flex min-h-7 items-center gap-2 text-xs text-ed-text", disabled ? "cursor-not-allowed" : "cursor-pointer", className)}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) onChange(!checked);
        }}
        className={cx(
          "group relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border border-ed-line-strong bg-ed-raised",
          "aria-checked:border-ed-accent aria-checked:bg-ed-accent-weak",
          FOCUS_RING,
          FADE,
          DISABLED,
        )}
        {...rest}
      >
        <span
          aria-hidden
          className={cx(
            "absolute top-0.5 left-0.5 size-2.5 rounded-full bg-ed-muted group-aria-checked:left-auto group-aria-checked:right-0.5 group-aria-checked:bg-ed-accent",
            FADE,
          )}
        />
      </button>
      <span className={cx(disabled && "opacity-40")}>{label}</span>
    </label>
  );
}
