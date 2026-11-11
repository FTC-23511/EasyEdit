import { getDb } from "@/db";
import type { CurrentUser } from "@/lib/access-rules";
import { claudeActorFor } from "@/lib/actor";
import { appBaseUrl } from "@/lib/connector/config";
import { LIMITS } from "@/lib/limits";
import type { ToolContext } from "./types";

// Everything a tool needs to act for the member whose Claude is calling.
export function toolContextFor(user: CurrentUser): ToolContext {
  return { db: getDb(), user, actor: claudeActorFor(user), baseUrl: appBaseUrl(), limits: LIMITS, now: () => new Date() };
}
