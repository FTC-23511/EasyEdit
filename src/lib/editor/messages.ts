import type { OpErrorCode } from "@/lib/timeline";
import type { SyncStatus } from "./types";

export const MESSAGES = {
  undoRefused: "Can't undo. This was changed afterwards.",
  redoRefused: "Can't redo. This was changed afterwards.",
  rebaseDropped: "A change of yours no longer fits and was removed.",
  clipGone: "That clip was removed by someone else.",
  tooManyOps: "That's too many changes at once.",
  readOnly: "You have view-only access.",
  lostAccess: "You no longer have edit access.",
  signedOut: "You're signed out. Sign in again to save your changes.",
  nothingToSplit: "Nothing to split at the playhead.",
  nothingToPaste: "Nothing to paste.",
  noRoom: "No room here, and the project can't take more tracks.",
  mediaNotReady: "This file isn't ready yet.",
} as const;

const OP_ERROR_MESSAGES: Record<OpErrorCode, string> = {
  OVERLAP: "There's another clip in the way.",
  TRACK_LOCKED: "That track is locked.",
  WRONG_TRACK_KIND: "That clip can't go on this track.",
  TRIM_OUT_OF_RANGE: "The clip can't be trimmed that far.",
  NOT_FOUND: "That clip or track no longer exists.",
  LIMIT_EXCEEDED: "This project has reached a size limit.",
  STALE: MESSAGES.undoRefused,
  INVALID: "That change couldn't be made.",
  DUPLICATE_ID: "That change couldn't be made.",
};

export function explainOpError(code: OpErrorCode): string {
  return OP_ERROR_MESSAGES[code] ?? OP_ERROR_MESSAGES.INVALID;
}

// The top bar's save status. A viewer has nothing to save, so "Saved" reads as "Up to date".
export function saveStatusLabel(status: SyncStatus, pending: number, canEdit: boolean): string {
  switch (status) {
    case "saved":
      return canEdit ? "Saved" : "Up to date";
    case "saving":
      return "Saving…";
    case "offline":
      return pending > 0 ? "Offline. Changes will save when you reconnect." : "Offline";
    case "signed-out":
      return "Signed out";
    case "deleted":
      return "Deleted";
  }
}
