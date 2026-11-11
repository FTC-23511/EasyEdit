"use client";

import type { ComponentProps } from "react";
import { FIELD_BOX, cx } from "./cx";

export function TextInput({ type = "text", className, ...rest }: ComponentProps<"input">) {
  return <input type={type} className={cx(FIELD_BOX, "h-7", className)} {...rest} />;
}
