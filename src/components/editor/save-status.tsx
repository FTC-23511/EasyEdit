"use client";

import Link from "next/link";
import { FOCUS_RING, cx } from "@/components/ui/cx";
import { saveStatusLabel } from "@/lib/editor/messages";
import { useEditor } from "./context";

export function SaveStatus() {
  const status = useEditor((s) => s.status);
  const pending = useEditor((s) => s.queue.length);
  const canEdit = useEditor((s) => s.canEdit);
  const tone = status === "offline" ? "text-ed-warn" : status === "signed-out" ? "text-ed-danger" : "text-ed-muted";

  return (
    <div className="flex min-w-0 items-center gap-2 text-xs">
      <span role="status" className={cx("truncate", tone)}>
        {saveStatusLabel(status, pending, canEdit)}
      </span>
      {/* A new tab, so this one keeps the edits that wait to be sent once the person is back. */}
      {status === "signed-out" && (
        <Link
          href="/login"
          target="_blank"
          rel="noopener"
          className={cx("shrink-0 rounded-[4px] font-medium text-ed-text underline underline-offset-2", FOCUS_RING)}
        >
          Sign in
        </Link>
      )}
    </div>
  );
}
