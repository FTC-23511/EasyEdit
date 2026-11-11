"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    await authClient.signOut();
    router.push("/login");
  }

  return (
    <button type="button" onClick={signOut} disabled={pending} className="underline disabled:opacity-60">
      Sign out
    </button>
  );
}
