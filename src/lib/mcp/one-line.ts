// Text that comes from people or from Claude, printed inside a line of a tool result: a person's name, or an id echoed
// in the engine's message. A line break or any other control character becomes a space, so it cannot start a line of its own.
export function oneLine(text: string): string {
  return text.replace(/\r\n|[\p{Cc}\p{Zl}\p{Zp}]/gu, " ");
}
