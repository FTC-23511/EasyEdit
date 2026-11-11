"use client";

import { unstable_rethrow } from "next/navigation";
import { useState, useTransition } from "react";

type ActionResult = { error?: string };

type Outcome = { onStart?: () => void; onSuccess?: () => void; onFailure?: (message: string) => void };

export function useAction(action: (formData: FormData) => Promise<ActionResult>) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  function submit(formData: FormData, { onStart, onSuccess, onFailure }: Outcome = {}) {
    onStart?.();
    startTransition(async () => {
      let message: string | null;
      try {
        message = (await action(formData)).error ?? null;
      } catch (e) {
        unstable_rethrow(e);
        message = "Something went wrong. Try again.";
      }
      setError(message);
      if (message === null) onSuccess?.();
      else onFailure?.(message);
    });
  }
  return { error, pending, submit };
}

export function ErrorText({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-sm text-red-700 dark:text-red-400">
      {message}
    </p>
  );
}
