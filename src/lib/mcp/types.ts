import type { DB } from "@/db";
import type { Actor } from "@/lib/actor";
import type { CurrentUser } from "@/lib/access-rules";
import type { Limits } from "@/lib/limits";

export type ToolContext = { db: DB; user: CurrentUser; actor: Actor; baseUrl: string; limits: Limits; now: () => Date };
export type ToolResult = { text: string; isError: boolean };

export const ok = (text: string): ToolResult => ({ text, isError: false });
export const fail = (text: string): ToolResult => ({ text, isError: true });
