"use client";

import { ChevronDown } from "lucide-react";
import type { ComponentProps } from "react";
import { FIELD_BOX, cx } from "./cx";

// A native select, so the option list, typing to jump and screen readers all work as usual.
export function Select({ className, ...rest }: ComponentProps<"select">) {
  return (
    <span className={cx("relative flex min-w-0", className)}>
      <select className={cx(FIELD_BOX, "peer h-7 appearance-none pr-7")} {...rest} />
      <ChevronDown
        aria-hidden
        size={16}
        strokeWidth={1.75}
        className="pointer-events-none absolute top-1.5 right-1.5 text-ed-muted peer-disabled:opacity-40"
      />
    </span>
  );
}
