import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/access";
import { isConnectorRequest } from "@/lib/connector/consent";
import { loginErrorMessage } from "@/lib/login-error-message";
import { SignInButton } from "./sign-in-button";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const { error } = params;
  const errorMessage = loginErrorMessage(Array.isArray(error) ? error[0] : error);
  // Sent here by the sign-in server while connecting Claude: signing in carries on with that request.
  const forClaude = isConnectorRequest(params);
  // Decided by the allowlist, not by cookie presence, so a removed user's stale cookie cannot loop.
  if (!forClaude && (await getCurrentUser())) redirect("/dashboard");

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-24">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">EasyEdit</h1>
        {forClaude && <p>Sign in to connect Claude.</p>}
        {errorMessage !== null && (
          <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
            {errorMessage}
          </p>
        )}
        <SignInButton />
      </div>
    </main>
  );
}
