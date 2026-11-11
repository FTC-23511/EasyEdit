import { headers } from "next/headers";
import { forbidden, redirect } from "next/navigation";
import { getDb } from "@/db";
import { meetsRole, resolveCurrentUser, type CurrentUser } from "@/lib/access-rules";
import type { Role } from "@/lib/allowlist/service";
import { getAuth } from "@/lib/auth";

export { meetsRole, resolveCurrentUser, type CurrentUser } from "@/lib/access-rules";

async function currentUserFor(requestHeaders: Headers): Promise<CurrentUser | null> {
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  return resolveCurrentUser(getDb(), session?.user ?? null);
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  return currentUserFor(await headers());
}

export async function requireUser(min: Role = "viewer"): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!meetsRole(user.role, min)) forbidden();
  return user;
}

export async function requireUserApi(req: Request, min: Role): Promise<CurrentUser | Response> {
  const user = await currentUserFor(req.headers);
  if (!user) return Response.json({ code: "UNAUTHENTICATED" }, { status: 401 });
  if (!meetsRole(user.role, min)) return Response.json({ code: "FORBIDDEN" }, { status: 403 });
  return user;
}
