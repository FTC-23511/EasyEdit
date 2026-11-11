"use client";

import { useEffect } from "react";

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

// Pages and API routes only read the session (see currentUserFor). This asks the sign-in endpoint from the browser,
// the one place that can renew the session and send its cookie again in the same answer. Once when a signed-in page
// opens, then whenever the tab is shown again and six hours have passed, so a tab left open for days is covered too.
export function KeepSignedIn() {
  useEffect(() => {
    let checkedAt = Number.NEGATIVE_INFINITY;
    let checking = false;

    async function check() {
      if (checking || document.visibilityState !== "visible" || Date.now() - checkedAt < CHECK_EVERY_MS) return;
      checking = true;
      try {
        const res = await fetch("/api/auth/get-session", { credentials: "same-origin", cache: "no-store" });
        if (res.ok) checkedAt = Date.now();
      } catch {
        // Offline or the request was cut off. The next time the tab is shown it is tried again.
      } finally {
        checking = false;
      }
    }

    void check();
    document.addEventListener("visibilitychange", check);
    return () => document.removeEventListener("visibilitychange", check);
  }, []);

  return null;
}
