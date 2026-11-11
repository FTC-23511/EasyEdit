"use client";

import { useEffect, useState } from "react";
import { EDITING_INDICATOR_MS, editingLabel } from "@/lib/editor/activity";
import { useEditor } from "./context";

// Shows who else just edited, until EDITING_INDICATOR_MS after their change.
export function EditingIndicator() {
  const remote = useEditor((s) => s.remote);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!remote) return;
    const left = Math.max(0, remote.at + EDITING_INDICATOR_MS - Date.now());
    const timer = setTimeout(() => setNow(Date.now()), left);
    return () => clearTimeout(timer);
  }, [remote]);

  const label = remote && now < remote.at + EDITING_INDICATOR_MS ? editingLabel(remote.names) : null;
  if (!label) return null;
  return (
    <span role="status" className="flex min-w-0 shrink items-center gap-1.5 text-xs leading-4 text-ed-muted">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-ed-text" />
      <span className="truncate">{label}</span>
    </span>
  );
}
