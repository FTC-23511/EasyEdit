"use client";

import { useEffect, useSyncExternalStore } from "react";
import { runCommand } from "@/lib/editor/run-command";
import { SHORTCUTS, isPressable, matchShortcut, shouldIgnoreKey } from "@/lib/editor/shortcuts";
import { useClipboard, useEditorStore } from "./context";

const isMacPlatform = () => navigator.platform.startsWith("Mac");
const noChanges = () => () => {};

// The width at which EditorScreen shows the editor (Tailwind's lg). Below it a message takes its
// place, so a key would change things nobody can see.
const WIDE_ENOUGH = "(min-width: 64rem)";

const REPEATING = new Set(SHORTCUTS.filter((s) => s.repeats).map((s) => s.command));

// Whether shortcuts read Cmd (a Mac) or Ctrl. The server cannot know, so its render says Ctrl and
// the browser corrects it after hydration.
export function useIsMac(): boolean {
  return useSyncExternalStore(noChanges, isMacPlatform, () => false);
}

// Focus that arrives this soon after a pointer went down came from that click (or from what the
// click did, such as a menu handing focus back to its button).
const CLICK_FOCUS_MS = 1000;

// Text selected on the page, which Cmd/Ctrl+C and X should copy as usual.
function hasTextSelection(): boolean {
  const selection = window.getSelection();
  return selection !== null && !selection.isCollapsed;
}

// Runs the shortcut table's commands from key presses anywhere in the window. A key is left alone
// when a control already handled it, when it is typed into a field or presses a focused button,
// while the window is too narrow for the editor, and while a dialog or a menu is open. Space plays
// or pauses even on a button, unless the button was reached with the keyboard. Copy and cut
// are left to the browser when no clip is selected or text is. A held key runs its command again
// only where the table says it repeats. Pass a stable openShortcuts: a new one adds the listener again.
export function useShortcuts(openShortcuts: () => void): void {
  const store = useEditorStore();
  const clipboard = useClipboard();

  useEffect(() => {
    const isMac = isMacPlatform();
    // The control the pointer last focused or pressed, until the keyboard moves focus. The browser's
    // own :focus-visible cannot say this at key time: it switches on as soon as any key goes down.
    let clickedControl: Element | null = null;
    let pointerDownAt = Number.NEGATIVE_INFINITY;
    function onPointerDown(event: PointerEvent) {
      pointerDownAt = performance.now();
      // Pressing a control that already has focus moves no focus, so note it here.
      clickedControl = event.target instanceof Element && event.target === document.activeElement ? event.target : null;
    }
    function onFocusIn(event: FocusEvent) {
      const byPointer = performance.now() - pointerDownAt < CLICK_FOCUS_MS;
      clickedControl = byPointer && event.target instanceof Element ? event.target : null;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      // A button, link or summary focused by a click: Space is the shortcut, not a second press.
      const clicked =
        event.key === " " && target instanceof HTMLElement && isPressable(target) && target === clickedControl ? target : null;
      if (!clicked && shouldIgnoreKey(event, target)) return;
      if (!window.matchMedia(WIDE_ENOUGH).matches) return;
      if (document.querySelector('dialog[open], [role="menu"]')) return;
      const command = matchShortcut(event, isMac);
      if (!command) return;
      if ((command === "copy" || command === "cut") && (store.getState().selection.clipIds.length === 0 || hasTextSelection())) return;
      event.preventDefault();
      // Focus leaves the control, so letting go of Space cannot press it.
      clicked?.blur();
      if (event.repeat && !REPEATING.has(command)) return;
      runCommand(command, { store, clipboard, openShortcuts });
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("focusin", onFocusIn, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("focusin", onFocusIn, true);
    };
  }, [store, clipboard, openShortcuts]);
}
