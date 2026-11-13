"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { cx } from "./cx";
import { IconButton } from "./icon-button";

export type DialogProps = { title: string; open: boolean; onClose(): void; children: ReactNode; className?: string };

// A modal on the native <dialog>, so focus stays inside it and the page behind is inert. Escape and
// the Close button ask the caller to close it through onClose; open decides. On opening, focus goes to
// the first element marked data-autofocus, a field's text selected so typing replaces it; with none
// marked, the browser's choice stands. React's autoFocus cannot do this: the contents mount while the
// dialog is still closed.
export function Dialog({ title, open, onClose, children, className }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      const marked = dialog.querySelector<HTMLElement>("[data-autofocus]");
      marked?.focus();
      if (marked instanceof HTMLInputElement) marked.select();
    } else if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={cx(
        "m-auto max-h-[min(80vh,640px)] w-[min(32rem,calc(100vw-32px))] flex-col rounded-md border border-ed-line bg-ed-panel p-0 text-ed-text shadow-2xl open:flex backdrop:bg-ed-bg/70",
        className,
      )}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        onClose();
      }}
      onCancel={(event) => {
        // Any other close request (such as a back gesture) also goes through the caller.
        event.preventDefault();
        onClose();
      }}
    >
      {open && (
        <>
          <header className="flex shrink-0 items-center gap-2 border-b border-ed-line py-2 pr-2 pl-4">
            <h2 id={titleId} className="min-w-0 flex-1 truncate text-sm font-semibold">
              {title}
            </h2>
            <IconButton label="Close" onClick={onClose}>
              <X />
            </IconButton>
          </header>
          <div className="min-h-0 overflow-y-auto p-4 text-[13px] leading-5">{children}</div>
        </>
      )}
    </dialog>
  );
}
