const CLAUDE_PREFIX = "claude:";

// An actor is a user id, or `claude:<userId>` when Claude made the change for that user.
export function actorUserId(actor: string): string {
  return actor.startsWith(CLAUDE_PREFIX) ? actor.slice(CLAUDE_PREFIX.length) : actor;
}

export function displayActor(actor: string, names: Map<string, string>): string {
  const name = names.get(actorUserId(actor));
  if (actor.startsWith(CLAUDE_PREFIX)) return name === undefined ? "Claude" : `Claude (for ${name})`;
  return name ?? "Someone";
}
