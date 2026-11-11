import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { forbidden, redirect } from "next/navigation";
import { getDb } from "@/db";
import { meetsRole, resolveCurrentUser, type CurrentUser } from "@/lib/access-rules";
import type { Role } from "@/lib/allowlist/service";
import { FORBIDDEN_BODY, UNAUTHENTICATED_BODY } from "@/lib/api-errors";
import { getAuth } from "@/lib/auth";

export { meetsRole, resolveCurrentUser, type CurrentUser } from "@/lib/access-rules";

async function currentUserFor(requestHeaders: Headers): Promise<CurrentUser | null> {
  // Read only. A renewal here would move the expiry in the database, but its new cookie has no response to travel
  // on, so the browser's cookie would still run out on the old date. KeepSignedIn renews both from the browser.
  const session = await getAuth().api.getSession({ headers: requestHeaders, query: { disableRefresh: true } });
  return resolveCurrentUser(getDb(), session?.user ?? null);
}

// One lookup per page render, however many layouts and pages ask.
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => currentUserFor(await headers()));

export async function requireUser(min: Role = "viewer"): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!meetsRole(user.role, min)) forbidden();
  return user;
}

export async function requireUserApi(req: Request, min: Role): Promise<CurrentUser | Response> {
  const user = await currentUserFor(req.headers);
  if (!user) return Response.json(UNAUTHENTICATED_BODY, { status: 401 });
  if (!meetsRole(user.role, min)) return Response.json(FORBIDDEN_BODY, { status: 403 });
  return user;
}
