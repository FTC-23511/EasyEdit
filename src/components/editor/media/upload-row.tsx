"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import type { UploadItem } from "@/lib/media/types";

// How far along a stage is, 0 to 100, rounded down so that a row never reads 100 before it is done.
export function progressOf(item: UploadItem): number {
  const fraction = (() => {
    switch (item.stage) {
      case "uploading":
        return item.sizeBytes > 0 ? item.sentBytes / item.sizeBytes : 0;
      case "finishing":
        return 1;
      case "preview":
        return item.previewFraction;
      default:
        return 0;
    }
  })();
  return Math.max(0, Math.min(100, Math.floor(fraction * 100 + 1e-9))); // 0.29 × 100 is 28.999…
}

const RUNNING = new Set<UploadItem["stage"]>(["waiting", "reading", "uploading", "finishing", "preview"]);

export function stageLabel(item: UploadItem): string {
  switch (item.stage) {
    case "waiting":
      return "Waiting";
    case "reading":
      return "Reading file";
    case "uploading":
      return `Uploading ${progressOf(item)}%`;
    case "finishing":
      return "Finishing";
    case "preview":
      return `Making preview ${progressOf(item)}%`;
    default:
      return "";
  }
}

type UploadRowProps = { item: UploadItem; canEdit: boolean; onCancel(key: string): void; onRetry(key: string): void; onDismiss(key: string): void };

// One upload: its file, how far it is, and what can be done about it. Cancel is there until the upload is done;
// Retry for a failed upload that can be tried again; Dismiss for a failed or finished one that has something to say.
export function UploadRow({ item, canEdit, onCancel, onRetry, onDismiss }: UploadRowProps) {
  const running = RUNNING.has(item.stage);
  const progress = progressOf(item);
  return (
    <li className="flex flex-col gap-1 py-1">
      <div className="flex min-w-0 items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-ed-text">{item.fileName}</span>
        {item.stage !== "done" && (
          <IconButton data-edit-control disabled={!canEdit} label={`Cancel upload of ${item.fileName}`} onClick={() => onCancel(item.key)}>
            <X />
          </IconButton>
        )}
      </div>
      {running ? (
        <>
          <span className="text-[11px] leading-4 text-ed-muted">{stageLabel(item)}</span>
          <div
            role="progressbar"
            aria-label={`Upload of ${item.fileName}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            className="h-1 overflow-hidden rounded-full bg-ed-raised"
          >
            <div className="h-full bg-ed-accent" style={{ width: `${progress}%` }} />
          </div>
        </>
      ) : (
        <>
          {item.message && <p className="text-[11px] leading-4 text-ed-muted">{item.message}</p>}
          {(item.canRetry && item.stage === "failed") || item.message ? (
            <div className="flex gap-1">
              {item.stage === "failed" && item.canRetry && (
                <Button data-edit-control size="sm" disabled={!canEdit} onClick={() => onRetry(item.key)}>
                  Retry
                </Button>
              )}
              {item.message && (
                <Button size="sm" variant="ghost" onClick={() => onDismiss(item.key)}>
                  Dismiss
                </Button>
              )}
            </div>
          ) : null}
        </>
      )}
    </li>
  );
}
