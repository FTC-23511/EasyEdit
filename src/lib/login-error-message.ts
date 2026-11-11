// Better Auth sends the user back to /login with ?error=<code>. A database hook that refuses the user
// sends the hook's own code; anything else (a cancelled consent screen, a Google error) sends another code.
export function loginErrorMessage(error: string | undefined): string | null {
  if (!error) return null;
  if (error.toUpperCase() === "NOT_ALLOWLISTED") {
    return "This Google account isn't on the Seattle Solvers allowlist. Ask an admin to add you.";
  }
  return "Sign-in didn't finish. Try again. If it keeps happening, ask an admin to check that you're on the allowlist.";
}
