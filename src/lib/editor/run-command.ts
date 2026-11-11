import { docDuration } from "@/lib/timeline";
import {
  copySelection,
  cutSelection,
  deleteSelection,
  goToEdge,
  nudgeSelection,
  paste,
  selectAll,
  splitAtPlayhead,
} from "./actions";
import type { ClipboardStore } from "./clipboard";
import { ZOOM_STEP } from "./geometry";
import { SHORTCUTS, type CommandId } from "./shortcuts";
import type { EditorState, EditorStore } from "./store";

export type CommandContext = { store: EditorStore; clipboard: ClipboardStore; openShortcuts(): void };

const EDITS = new Set(SHORTCUTS.filter((s) => s.edits).map((s) => s.command));

// A command that changes the project runs only for someone who can edit, never in the middle of a
// drag or a field being typed in (the gesture is saved or dropped first), and not once the project
// is gone. Signed out, edits go on and wait to be sent, as when offline.
function canRun(command: CommandId, state: EditorState): boolean {
  if (!EDITS.has(command)) return true;
  return state.canEdit && state.gesture === null && state.status !== "deleted";
}

// Runs one command of the shortcut table.
export function runCommand(command: CommandId, ctx: CommandContext): void {
  const { store, clipboard } = ctx;
  const state = store.getState();
  if (!canRun(command, state)) return;
  const { fps } = state.doc;

  switch (command) {
    case "play-pause":
      if (state.playing) state.pause();
      else state.play();
      return;
    case "play-forward":
      return state.shuttle("l");
    case "pause":
      return state.shuttle("k");
    case "play-reverse":
      return state.shuttle("j");
    case "frame-back":
      return state.step(-1);
    case "frame-forward":
      return state.step(1);
    case "second-back":
      return state.step(-fps);
    case "second-forward":
      return state.step(fps);
    case "prev-edge":
      return goToEdge(store, "prev");
    case "next-edge":
      return goToEdge(store, "next");
    case "go-start":
      return state.seek(0);
    case "go-end":
      return state.seek(docDuration(state.doc));
    case "undo":
      return state.undo();
    case "redo":
      return state.redo();
    case "split":
      return splitAtPlayhead(store);
    case "delete":
      return deleteSelection(store, false);
    case "ripple-delete":
      return deleteSelection(store, true);
    case "copy":
      return copySelection(store, clipboard);
    case "cut":
      return cutSelection(store, clipboard);
    case "paste":
      return paste(store, clipboard);
    case "nudge-left":
      return nudgeSelection(store, -1);
    case "nudge-right":
      return nudgeSelection(store, 1);
    case "nudge-left-second":
      return nudgeSelection(store, -fps);
    case "nudge-right-second":
      return nudgeSelection(store, fps);
    case "select-all":
      return selectAll(store);
    case "clear-selection":
      // Clears the selected clips and the selected track alike.
      return state.select([]);
    case "zoom-in":
      return state.zoomBy(ZOOM_STEP);
    case "zoom-out":
      return state.zoomBy(1 / ZOOM_STEP);
    case "zoom-fit":
      return state.zoomToFit();
    case "toggle-snapping":
      return state.setSnapping(!state.snapping);
    case "show-shortcuts":
      return ctx.openShortcuts();
    default: {
      // A command added to CommandId without a case here does not compile.
      const missing: never = command;
      throw new Error(`No action for the command ${String(missing)}.`);
    }
  }
}
