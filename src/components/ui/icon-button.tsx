"use client";

import type { ComponentProps, ReactNode } from "react";
import { DISABLED, FADE, FOCUS_RING, cx } from "./cx";

export type IconButtonProps = Omit<ComponentProps<"button">, "children" | "aria-label" | "title"> & {
  label: string; // the accessible name and the tooltip
  shortcut?: string; // shown in the tooltip, in parentheses after the label
  pressed?: boolean; // a toggle: sets aria-pressed and the selected look
  children: ReactNode; // the icon
};

// A 28 × 28 button with a 16 px icon. The icon itself is hidden from screen readers; the label names the button.
export function IconButton({ label, shortcut, pressed, type = "button", className, children, ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-pressed={pressed}
      className={cx(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-transparent text-ed-muted select-none",
        "enabled:hover:bg-ed-hover enabled:hover:text-ed-text",
        "aria-pressed:bg-ed-accent-weak aria-pressed:text-ed-accent enabled:aria-pressed:hover:bg-ed-accent-weak",
        "[&>svg]:pointer-events-none [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:stroke-[1.75]",
        FOCUS_RING,
        FADE,
        DISABLED,
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
