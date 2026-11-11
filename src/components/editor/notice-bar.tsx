"use client";

import { X } from "lucide-react";
import { useEffect } from "react";
import { cx } from "@/components/ui/cx";
import { IconButton } from "@/components/ui/icon-button";
import { useEditor } from "./context";

const NOTICE_MS = 5000;

// The latest notice, centered over the preview just above the timeline. It goes away after five
// seconds, counted again for every new notice.
export function NoticeBar() {
  const notice = useEditor((s) => s.notice);
  const dismiss = useEditor((s) => s.dismissNotice);
  const noticeId = notice?.id;

  useEffect(() => {
    if (noticeId === undefined) return;
    const timer = setTimeout(dismiss, NOTICE_MS);
    return () => clearTimeout(timer);
  }, [noticeId, dismiss]);

  const error = notice?.tone === "error";

  // The two live regions stay mounted, empty without a notice, so a screen reader announces the
  // text when it arrives. The bar's frame and the Dismiss button appear only with a notice.
  return (
    <div className="pointer-events-none absolute right-[calc(var(--ed-right-w)+1px)] bottom-[calc(var(--ed-timeline-h)+9px)] left-[calc(var(--ed-left-w)+1px)] z-10 flex justify-center px-4">
      <div
        className={cx(
          "flex max-w-full min-w-0 items-center text-[13px] leading-5 text-ed-text",
          notice && "pointer-events-auto rounded-md border border-ed-line bg-ed-raised py-1 pr-1 pl-3",
          error && "border-l-2 border-l-ed-danger",
        )}
      >
        <p role="alert" className="min-w-0">
          {error ? notice.text : ""}
        </p>
        <p role="status" className="min-w-0">
          {notice && !error ? notice.text : ""}
        </p>
        {notice && (
          <IconButton label="Dismiss" className="ml-2" onClick={() => dismiss()}>
            <X />
          </IconButton>
        )}
      </div>
    </div>
  );
}
