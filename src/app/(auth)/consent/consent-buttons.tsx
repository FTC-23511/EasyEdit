"use client";

import { useState } from "react";
import { decideConsent } from "@/lib/connector/consent-client";

const BUTTON = "h-11 w-full rounded-full px-5 font-medium transition-opacity disabled:opacity-60";

export function ConsentButtons({ navigate = (url) => window.location.assign(url) }: { navigate?: (url: string) => void }) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function decide(accept: boolean) {
    setPending(true);
    setFailed(false);
    const result = await decideConsent(accept);
    if ("url" in result) {
      // Stays disabled while the browser leaves for Claude.
      navigate(result.url);
      return;
    }
    setFailed(true);
    setPending(false);
  }

  return (
    <div className="flex w-full flex-col gap-3">
      {failed && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          That didn&apos;t work. Go back to Claude and connect again.
        </p>
      )}
      <button type="button" onClick={() => decide(true)} disabled={pending} className={`${BUTTON} bg-foreground text-background`}>
        Allow
      </button>
      <button
        type="button"
        onClick={() => decide(false)}
        disabled={pending}
        className={`${BUTTON} border border-black/15 dark:border-white/20`}
      >
        Don&apos;t allow
      </button>
    </div>
  );
}
