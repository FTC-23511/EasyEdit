"use client";

import { useEffect, useRef, useState } from "react";
import { LIMITS } from "@/lib/limits";
import { ErrorText, useAction } from "../action-ui";
import { ConfirmButton } from "../confirm-button";
import { deleteProjectAction, duplicateProjectAction, renameProjectAction } from "./actions";

const BUTTON = "rounded-md border border-black/15 px-2 py-1 text-sm disabled:opacity-60 dark:border-white/20";
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground";

export function ProjectControls({ id, name }: { id: string; name: string }) {
  const rename = useAction(renameProjectAction);
  const duplicate = useAction(duplicateProjectAction);
  const remove = useAction(deleteProjectAction);
  const [renaming, setRenaming] = useState(false);
  const pending = rename.pending || duplicate.pending || remove.pending;
  // One error per card, owned by the most recent action; starting any action clears it.
  const [error, setError] = useState<string | null>(null);
  const renameButton = useRef<HTMLButtonElement>(null);
  const wantRenameFocus = useRef(false);
  const outcome = { onStart: () => setError(null), onFailure: setError };

  function closeRename() {
    wantRenameFocus.current = true;
    setRenaming(false);
  }

  // Save, Cancel and Escape unmount the form. Once it is closed and nothing is pending (a disabled
  // button cannot take focus), put focus back on the Rename button, then drop the request.
  useEffect(() => {
    if (!wantRenameFocus.current || renaming || pending) return;
    wantRenameFocus.current = false;
    renameButton.current?.focus();
  }, [renaming, pending]);

  function idOnly() {
    const formData = new FormData();
    formData.set("id", id);
    return formData;
  }

  if (renaming) {
    return (
      <div className="flex flex-col gap-1">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const formData = new FormData(e.currentTarget);
            formData.set("id", id);
            rename.submit(formData, { ...outcome, onSuccess: closeRename });
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") closeRename();
          }}
          className="flex flex-wrap items-center gap-2"
        >
          <input
            name="name"
            aria-label={`New name for ${name}`}
            defaultValue={name}
            required
            maxLength={LIMITS.projectNameChars}
            autoFocus
            className={`min-w-0 flex-1 rounded border border-black/20 bg-transparent px-2 py-1 text-sm dark:border-white/25 ${FOCUS}`}
          />
          <button
            type="submit"
            disabled={pending}
            className={`rounded-md bg-foreground px-2 py-1 text-sm font-medium text-background disabled:opacity-60 ${FOCUS}`}
          >
            Save
          </button>
          <button type="button" disabled={pending} onClick={closeRename} className={`${BUTTON} ${FOCUS}`}>
            Cancel
          </button>
        </form>
        <ErrorText message={error} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <button
          ref={renameButton}
          type="button"
          disabled={pending}
          onClick={() => {
            setError(null);
            setRenaming(true);
          }}
          className={`${BUTTON} ${FOCUS}`}
        >
          Rename
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => duplicate.submit(idOnly(), outcome)}
          className={`${BUTTON} ${FOCUS}`}
        >
          Duplicate
        </button>
        <ConfirmButton
          label="Delete"
          question="Delete this project?"
          confirmLabel="Delete"
          pending={pending}
          onConfirm={() => remove.submit(idOnly(), outcome)}
        />
      </div>
      <ErrorText message={error} />
    </div>
  );
}
