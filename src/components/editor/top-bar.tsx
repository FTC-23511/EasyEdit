"use client";

import { ChevronLeft, Keyboard, Redo2, Undo2 } from "lucide-react";
import { FADE, FOCUS_RING, cx } from "@/components/ui/cx";
import { IconButton } from "@/components/ui/icon-button";
import { shortcutFor } from "@/lib/editor/shortcuts";
import { useEditor } from "./context";
import { EditingIndicator } from "./editing-indicator";
import { LeaveLink } from "./leave-link";
import { SaveStatus } from "./save-status";
import { useIsMac } from "./use-shortcuts";

export function TopBar({ onShowShortcuts }: { onShowShortcuts(): void }) {
  const name = useEditor((s) => s.name);
  const canEdit = useEditor((s) => s.canEdit);
  const status = useEditor((s) => s.status);
  const undoLabel = useEditor((s) => s.undoStack.at(-1)?.label);
  const redoLabel = useEditor((s) => s.redoStack.at(-1)?.label);
  const deleted = status === "deleted";
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const isMac = useIsMac();

  return (
    <header className="col-span-3 flex min-w-0 items-center gap-2 bg-ed-panel px-3">
      <LeaveLink
        href="/dashboard"
        className={cx(
          "inline-flex h-7 shrink-0 items-center gap-1 rounded-md pr-2 pl-1 text-xs font-medium text-ed-muted hover:bg-ed-hover hover:text-ed-text",
          FOCUS_RING,
          FADE,
        )}
      >
        <ChevronLeft aria-hidden size={16} strokeWidth={1.75} />
        Projects
      </LeaveLink>
      <span aria-hidden className="h-4 w-px shrink-0 bg-ed-line" />
      <h1 title={name} className="min-w-0 truncate pl-1 text-sm font-semibold">
        {name}
      </h1>
      {!canEdit && (
        <span className="shrink-0 rounded-[4px] border border-ed-line px-1.5 text-[11px] leading-4 font-medium text-ed-muted">
          View only
        </span>
      )}
      <div className="ml-auto flex min-w-0 items-center gap-2 pl-2">
        <EditingIndicator />
        <div className="shrink-0">
          <SaveStatus />
        </div>
        <IconButton
          data-edit-control
          label={undoLabel ? `Undo ${undoLabel}` : "Undo"}
          shortcut={shortcutFor("undo", isMac)}
          disabled={!canEdit || deleted || undoLabel === undefined}
          onClick={() => undo()}
        >
          <Undo2 />
        </IconButton>
        <IconButton
          data-edit-control
          label={redoLabel ? `Redo ${redoLabel}` : "Redo"}
          shortcut={shortcutFor("redo", isMac)}
          disabled={!canEdit || deleted || redoLabel === undefined}
          onClick={() => redo()}
        >
          <Redo2 />
        </IconButton>
        <IconButton label="Keyboard shortcuts" shortcut={shortcutFor("show-shortcuts", isMac)} onClick={onShowShortcuts}>
          <Keyboard />
        </IconButton>
      </div>
    </header>
  );
}
