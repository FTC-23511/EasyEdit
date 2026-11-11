"use client";

import type { ReactNode } from "react";
import { cx } from "./cx";

// A label above one control. The <label> wraps the control, so it names it. The hint sits outside
// the label, so it does not become part of the control's name.
export function Field({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: ReactNode }) {
  return (
    <div className={cx("flex min-w-0 flex-col gap-1", className)}>
      <label className="flex min-w-0 flex-col gap-1">
        <span className="text-xs font-medium text-ed-muted">{label}</span>
        {children}
      </label>
      {hint && <p className="text-[11px] leading-4 text-ed-muted">{hint}</p>}
    </div>
  );
}
