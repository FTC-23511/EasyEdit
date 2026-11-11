"use client";

import type { ComponentProps } from "react";
import { FIELD_BOX, cx } from "./cx";

export function TextArea({ className, ...rest }: ComponentProps<"textarea">) {
  return <textarea className={cx(FIELD_BOX, "resize-y py-1", className)} {...rest} />;
}
