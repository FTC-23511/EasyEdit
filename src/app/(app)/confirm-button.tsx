"use client";

import { useEffect, useRef, useState } from "react";

const BUTTON = "rounded-md border px-2 py-1 text-sm disabled:opacity-60";
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground";

export function ConfirmButton({
  label,
  question,
  confirmLabel,
  pending,
  onConfirm,
}: {
  label: string;
  question: string;
  confirmLabel: string;
  pending: boolean;
  onConfirm: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const openRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const wasAsking = useRef(false);

  // Keep keyboard focus on the control that is on screen after each switch.
  useEffect(() => {
    if (asking) cancelRef.current?.focus();
    else if (wasAsking.current) openRef.current?.focus();
    wasAsking.current = asking;
  }, [asking]);

  if (!asking) {
    return (
      <button
        ref={openRef}
        type="button"
        disabled={pending}
        onClick={() => setAsking(true)}
        className={`${BUTTON} border-red-300 text-red-700 dark:border-red-400/60 dark:text-red-400 ${FOCUS}`}
      >
        {label}
      </button>
    );
  }
  return (
    <span
      className="flex flex-wrap items-center gap-2"
      onKeyDown={(e) => {
        if (e.key === "Escape") setAsking(false);
      }}
    >
      <span className="text-sm">{question}</span>
      <button
        type="button"
        disabled={pending}
        onClick={onConfirm}
        className={`${BUTTON} border-red-300 text-red-700 dark:border-red-400/60 dark:text-red-400 ${FOCUS}`}
      >
        {confirmLabel}
      </button>
      <button
        ref={cancelRef}
        type="button"
        disabled={pending}
        onClick={() => setAsking(false)}
        className={`${BUTTON} border-black/15 dark:border-white/20 ${FOCUS}`}
      >
        Cancel
      </button>
    </span>
  );
}
