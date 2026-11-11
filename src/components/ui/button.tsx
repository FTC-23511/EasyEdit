"use client";

import type { ComponentProps } from "react";
import { DISABLED, FADE, FOCUS_RING, cx } from "./cx";

export type ButtonProps = ComponentProps<"button"> & {
  variant?: "default" | "primary" | "ghost" | "danger";
  size?: "sm" | "md";
};

const VARIANTS = {
  default: "border border-ed-line bg-ed-raised text-ed-text enabled:hover:bg-ed-hover",
  primary: "border border-ed-accent bg-ed-accent text-ed-bg enabled:hover:bg-ed-accent/85",
  ghost: "border border-transparent text-ed-text enabled:hover:bg-ed-hover",
  danger: "border border-ed-line bg-ed-raised text-ed-danger enabled:hover:bg-ed-hover",
};

const SIZES = { sm: "h-6 px-2", md: "h-7 px-3" };

export function Button({ variant = "default", size = "md", type = "button", className, ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md text-xs font-medium whitespace-nowrap select-none [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:stroke-[1.75]",
        VARIANTS[variant],
        SIZES[size],
        FOCUS_RING,
        FADE,
        DISABLED,
        className,
      )}
      {...rest}
    />
  );
}
