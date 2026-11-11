import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/access";
import { SignInButton } from "./sign-in-button";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { error } = await searchParams;
  // Decided by the allowlist, not by cookie presence, so a removed user's stale cookie cannot loop.
  if (await getCurrentUser()) redirect("/dashboard");

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-24">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Seattle Solvers Studio</h1>
        {error !== undefined && (
          <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
            This Google account isn&apos;t on the Seattle Solvers allowlist. Ask an admin to add you.
          </p>
        )}
        <SignInButton />
      </div>
    </main>
  );
}
