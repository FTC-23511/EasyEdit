import type { Role } from "@/lib/allowlist/service";

// What Claude reads when a tool fails for a reason it cannot see. Nothing about the server goes in it.
export const UNEXPECTED =
  "Something went wrong on the server. Read the project again before you retry: the change may or may not have been applied.";

export function roleMessage(role: Role): string {
  return `Your role is ${role}. You can read projects but not change them. An admin can change your role on the Admin page.`;
}

export function notFoundText(projectId: string): string {
  return `No project with id "${projectId}". It may have been deleted. Call list_projects to see the ids.`;
}
