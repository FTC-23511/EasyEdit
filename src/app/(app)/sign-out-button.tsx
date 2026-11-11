"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { signOutAndLeave } from "@/lib/sign-out";

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut() {
    setPending(true);
    setFailed(false);
    const done = await signOutAndLeave({
      signOut: () => authClient.signOut(),
      leave: () => router.push("/login"),
    });
    if (!done) {
      setPending(false);
      setFailed(true);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={signOut}
        disabled={pending}
        className="underline disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
      >
        Sign out
      </button>
      {failed && (
        <span role="alert" className="text-red-700 dark:text-red-400">
          Couldn&apos;t sign out. Try again.
        </span>
      )}
    </>
  );
}
