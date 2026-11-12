import { getDb } from "@/db";
import { requireUser } from "@/lib/access";
import { readConsentRequest } from "@/lib/connector/consent";
import { requiredEnv } from "@/lib/env";
import { ConsentButtons } from "./consent-buttons";

const WARNING = "rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800";

// Shown every time Claude asks to connect, after the member has signed in.
export default async function ConsentPage({ searchParams }: PageProps<"/consent">) {
  const me = await requireUser();
  const request = await readConsentRequest(getDb(), requiredEnv("BETTER_AUTH_SECRET"), await searchParams);

  if (!request.ok) {
    return (
      <main className="flex flex-1 items-center justify-center px-6 py-24">
        <p className="max-w-sm text-center">This request has expired. Go back to Claude and connect again.</p>
      </main>
    );
  }

  const { clientName, verifiedHost } = request.view;
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-24">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <h1 className="text-center text-2xl font-semibold tracking-tight">Connect Claude</h1>
        <div className="flex flex-col gap-3 text-sm">
          <p>Claude is asking to use EasyEdit as you.</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>It will be able to see the team&apos;s projects.</li>
            {me.role === "viewer" ? (
              <li>Your role is viewer, so it will not be able to change anything.</li>
            ) : (
              <li>{`It will be able to create projects and change them. Each change is listed in the editor as “Claude (for ${me.name})” and can be undone there.`}</li>
            )}
          </ul>
          <p>Signed in as {me.email}.</p>
          <p>
            {verifiedHost !== null
              ? `The request comes from ${verifiedHost}.`
              : `The request comes from an app that calls itself “${clientName}”. EasyEdit cannot confirm who runs it.`}
          </p>
        </div>
        <p className={WARNING}>
          Only allow this if you just added the connector in your own Claude settings. If someone sent you a link to this
          page, choose Don&apos;t allow.
        </p>
        <ConsentButtons />
      </div>
    </main>
  );
}
