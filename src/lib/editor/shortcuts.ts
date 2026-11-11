export type CommandId =
  | "play-pause" | "play-forward" | "pause" | "play-reverse" | "frame-back" | "frame-forward" | "second-back" | "second-forward"
  | "prev-edge" | "next-edge" | "go-start" | "go-end"
  | "undo" | "redo" | "split" | "delete" | "ripple-delete" | "copy" | "cut" | "paste"
  | "nudge-left" | "nudge-right" | "nudge-left-second" | "nudge-right-second"
  | "select-all" | "clear-selection" | "zoom-in" | "zoom-out" | "zoom-fit" | "toggle-snapping" | "show-shortcuts";

// edits: the command changes the project, so it does nothing for a viewer. repeats: holding the key
// down runs it again with each repeat; other commands run once per press.
export type Shortcut = {
  command: CommandId;
  keys: string[];
  label: string;
  group: "Playback" | "Editing" | "Timeline" | "General";
  edits: boolean;
  repeats: boolean;
};

export type KeyLike = { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean };

type Flags = { edits?: boolean; repeats?: boolean };

const row = (group: Shortcut["group"], command: CommandId, keys: string[], label: string, flags: Flags = {}): Shortcut => ({
  command,
  keys,
  label,
  group,
  edits: flags.edits ?? false,
  repeats: flags.repeats ?? false,
});

const EDITS: Flags = { edits: true };
const REPEATS: Flags = { repeats: true };
const EDITS_REPEATS: Flags = { edits: true, repeats: true };

// The one list of shortcuts: keys are matched against it and the shortcuts dialog shows it. A key
// is written as its modifiers (Mod, Alt, Shift, in that order) and the KeyboardEvent key, joined by
// "+", with Space for the space bar and letters in upper case. Mod is Cmd on a Mac, Ctrl elsewhere.
export const SHORTCUTS: Shortcut[] = [
  row("Playback", "play-pause", ["Space"], "Play or pause"),
  row("Playback", "play-forward", ["L"], "Play forward; press again to go faster"),
  row("Playback", "pause", ["K"], "Pause"),
  row("Playback", "play-reverse", ["J"], "Play backward; press again to go faster"),
  row("Playback", "frame-back", ["ArrowLeft"], "Back one frame", REPEATS),
  row("Playback", "frame-forward", ["ArrowRight"], "Forward one frame", REPEATS),
  row("Playback", "second-back", ["Shift+ArrowLeft"], "Back one second", REPEATS),
  row("Playback", "second-forward", ["Shift+ArrowRight"], "Forward one second", REPEATS),
  row("Playback", "prev-edge", ["ArrowUp"], "Previous clip edge", REPEATS),
  row("Playback", "next-edge", ["ArrowDown"], "Next clip edge", REPEATS),
  row("Playback", "go-start", ["Home"], "Go to start"),
  row("Playback", "go-end", ["End"], "Go to end"),
  row("Editing", "undo", ["Mod+Z"], "Undo", EDITS_REPEATS),
  row("Editing", "redo", ["Mod+Shift+Z", "Mod+Y"], "Redo", EDITS_REPEATS),
  row("Editing", "split", ["S"], "Split at the playhead", EDITS),
  row("Editing", "delete", ["Delete", "Backspace"], "Delete", EDITS),
  row("Editing", "ripple-delete", ["Shift+Delete", "Shift+Backspace"], "Delete and close the gap", EDITS),
  row("Editing", "copy", ["Mod+C"], "Copy"),
  row("Editing", "cut", ["Mod+X"], "Cut", EDITS),
  row("Editing", "paste", ["Mod+V"], "Paste", EDITS),
  row("Editing", "nudge-left", ["Alt+ArrowLeft"], "Nudge one frame left", EDITS_REPEATS),
  row("Editing", "nudge-right", ["Alt+ArrowRight"], "Nudge one frame right", EDITS_REPEATS),
  row("Editing", "nudge-left-second", ["Alt+Shift+ArrowLeft"], "Nudge one second left", EDITS_REPEATS),
  row("Editing", "nudge-right-second", ["Alt+Shift+ArrowRight"], "Nudge one second right", EDITS_REPEATS),
  row("Timeline", "select-all", ["Mod+A"], "Select all clips"),
  row("Timeline", "clear-selection", ["Escape"], "Clear the selection"),
  row("Timeline", "zoom-in", ["=", "+"], "Zoom in", REPEATS),
  row("Timeline", "zoom-out", ["-"], "Zoom out", REPEATS),
  row("Timeline", "zoom-fit", ["Shift+Z"], "Fit the timeline"),
  row("Timeline", "toggle-snapping", ["N"], "Snapping on or off"),
  row("General", "show-shortcuts", ["?"], "Show shortcuts"),
];

type Combo = { mod: boolean; alt: boolean; shift: boolean; key: string };

// Split on "+", except that a string ending in "+" has "+" as its key ("+", "Mod++").
function parse(keys: string): Combo {
  const plusKey = keys.endsWith("+");
  const parts = (plusKey ? keys.slice(0, -1) : keys).split("+").filter((part) => part !== "");
  const key = plusKey ? "+" : (parts.pop() ?? "");
  return { mod: parts.includes("Mod"), alt: parts.includes("Alt"), shift: parts.includes("Shift"), key };
}

const PARSED = SHORTCUTS.map((shortcut) => ({ command: shortcut.command, combos: shortcut.keys.map(parse) }));

// Shift is part of typing these, so it is not asked for.
const SHIFTED_KEYS = new Set(["?", "+"]);

// The event's key as the table writes it: Space for the space bar, letters in upper case.
function tableKey(key: string): string {
  if (key === " ") return "Space";
  return key.length === 1 ? key.toUpperCase() : key;
}

// The command for a key press, or null. Mod must be down and the other of Cmd and Ctrl up; Alt and
// Shift must be exactly as written. The first matching row wins.
export function matchShortcut(event: KeyLike, isMac: boolean): CommandId | null {
  const mod = isMac ? event.metaKey : event.ctrlKey;
  const other = isMac ? event.ctrlKey : event.metaKey;
  if (other) return null;
  const key = tableKey(event.key);
  for (const { command, combos } of PARSED) {
    const hit = combos.some(
      (c) => c.key === key && c.mod === mod && c.alt === event.altKey && (SHIFTED_KEYS.has(c.key) || c.shift === event.shiftKey),
    );
    if (hit) return command;
  }
  return null;
}

const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const PRESSABLE_TAGS = new Set(["BUTTON", "A", "SUMMARY"]);

type KeyTarget = { tagName?: string; isContentEditable?: boolean };

// A button, link or summary: the space bar and Enter press it.
export function isPressable(target: KeyTarget): boolean {
  return PRESSABLE_TAGS.has(target.tagName?.toUpperCase() ?? "");
}

// True when the key belongs to what has focus: anything typed into a field, and the space bar or
// Enter on a button or link, which presses it.
export function shouldIgnoreKey(event: KeyLike, target: KeyTarget | null): boolean {
  if (!target) return false;
  const tag = target.tagName?.toUpperCase() ?? "";
  if (TYPING_TAGS.has(tag) || target.isContentEditable) return true;
  return (event.key === " " || event.key === "Enter") && isPressable(target);
}

const ARROWS: Record<string, string> = { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓" };
// Delete and Backspace as each keyboard marks them: a Mac's delete key sends Backspace.
const MAC_KEYS: Record<string, string> = { ...ARROWS, Backspace: "⌫", Delete: "⌦" };
const OTHER_KEYS: Record<string, string> = { ...ARROWS, Delete: "Del" };

// A key string as people read it: "⌘⇧Z" on a Mac, "Ctrl+Shift+Z" elsewhere.
export function keyLabel(keys: string, isMac: boolean): string {
  const { mod, alt, shift, key } = parse(keys);
  const parts = [
    mod && (isMac ? "⌘" : "Ctrl"),
    alt && (isMac ? "⌥" : "Alt"),
    shift && (isMac ? "⇧" : "Shift"),
    (isMac ? MAC_KEYS : OTHER_KEYS)[key] ?? key,
  ].filter((part) => part !== false);
  return parts.join(isMac ? "" : "+");
}

// The command's first key, for a button's tooltip. On a Mac a Backspace key comes first, because
// that is the key marked delete there.
export function shortcutFor(command: CommandId, isMac: boolean): string {
  const shortcut = SHORTCUTS.find((s) => s.command === command);
  if (!shortcut) return "";
  const keys = (isMac && shortcut.keys.find((k) => parse(k).key === "Backspace")) || shortcut.keys[0];
  return keyLabel(keys, isMac);
}
