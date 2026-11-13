import { nanoid } from "nanoid";
import type { AssetView } from "@/lib/media/types";
import { TRACK_ACCEPTS, type OpInput, type TrackKind } from "@/lib/timeline";
import { copyClips, pasteItems, type ClipboardStore } from "./clipboard";
import {
  addTrackOps,
  deleteOps,
  edgeFrames,
  moveOps,
  nearestEdge,
  removeTrackOps,
  renameTrackOps,
  reorderTrackOps,
  splitOps,
  toggleTrackOps,
  type TrackSwitch,
} from "./commands";
import { mediaClipFor } from "./media-clips";
import { MESSAGES } from "./messages";
import { placeClips } from "./placement";
import { findClip, type EditorStore } from "./store";
import { presetClip, type TextPreset } from "./text-presets";

// Puts a text preset at the playhead, on the selected text track when it has room, and selects it.
export function addText(store: EditorStore, preset: TextPreset): void {
  const state = store.getState();
  if (!state.canEdit) return;
  const selected = state.doc.tracks.find((t) => t.id === state.selection.trackId);
  const trackId = selected?.kind === "text" ? selected.id : null;
  const placement = placeClips(state.doc, [{ clip: presetClip(preset, state.playhead, state.doc.fps), trackId }], () => nanoid(10));
  if (!placement.ok) {
    state.notify("error", MESSAGES.noRoom);
    return;
  }
  const result = state.edit(placement.ops, "add text");
  if (result.ok) state.select(placement.clipIds);
}

// Puts a clip of a library asset at the frame given, else the playhead, and selects it. The clip would like the track
// given, else the selected track when that track takes it; placeClips finds where it goes.
export function addMedia(store: EditorStore, asset: AssetView, at: { frame?: number; trackId?: string | null } = {}): void {
  const state = store.getState();
  if (!state.canEdit) return;
  const clip = asset.status === "ready" && !asset.removed ? mediaClipFor(asset, at.frame ?? state.playhead, state.doc.fps) : null;
  if (!clip) {
    state.notify("info", MESSAGES.mediaNotReady);
    return;
  }
  const selected = state.doc.tracks.find((t) => t.id === state.selection.trackId);
  const trackId = at.trackId !== undefined ? at.trackId : selected && TRACK_ACCEPTS[selected.kind].includes(clip.type) ? selected.id : null;
  // The id is a stand-in, as presetClip's is: placement gives the clip its real one.
  const placement = placeClips(state.doc, [{ clip: { ...clip, id: "new" }, trackId }], () => nanoid(10));
  if (!placement.ok) {
    state.notify("error", MESSAGES.noRoom);
    return;
  }
  const result = state.edit(placement.ops, "add media");
  if (result.ok) state.select(placement.clipIds);
}

// The runners below edit the project. For a viewer they do nothing and say nothing.

// Cuts the selected clips under the playhead, or every clip under it on unlocked tracks.
export function splitAtPlayhead(store: EditorStore): void {
  const state = store.getState();
  if (!state.canEdit) return;
  const ops = splitOps(state.doc, state.playhead, state.selection.clipIds);
  if (ops.length === 0) state.notify("info", MESSAGES.nothingToSplit);
  else state.edit(ops, "split");
}

export function deleteSelection(store: EditorStore, ripple: boolean): void {
  const state = store.getState();
  const ids = state.selection.clipIds;
  if (!state.canEdit || ids.length === 0) return;
  state.edit(deleteOps(ids, ripple), ripple ? "ripple delete" : "delete");
}

export function nudgeSelection(store: EditorStore, deltaFrames: number): void {
  const state = store.getState();
  if (!state.canEdit) return;
  const clips = state.selection.clipIds.flatMap((clipId) => {
    const found = findClip(state.doc, clipId);
    return found ? [{ clipId, start: found.clip.start }] : [];
  });
  const ops = moveOps(clips, deltaFrames);
  if (ops.length > 0) state.edit(ops, "nudge");
}

// Clips on locked tracks are left out, so a following delete or nudge is not refused as a whole.
export function selectAll(store: EditorStore): void {
  const state = store.getState();
  state.select(state.doc.tracks.flatMap((t) => (t.locked ? [] : t.clips.map((c) => c.id))));
}

// Moves the playhead to the nearest clip edge before or after it.
export function goToEdge(store: EditorStore, direction: "prev" | "next"): void {
  const state = store.getState();
  state.seek(nearestEdge(edgeFrames(state.doc), state.playhead, direction));
}

// Copying changes nothing, so a viewer can copy too.
export function copySelection(store: EditorStore, clipboard: ClipboardStore): void {
  const state = store.getState();
  const copied = copyClips(state.doc, state.selection.clipIds);
  if (copied) clipboard.write(copied);
}

export function cutSelection(store: EditorStore, clipboard: ClipboardStore): void {
  const state = store.getState();
  const ids = state.selection.clipIds;
  if (!state.canEdit || ids.length === 0) return;
  // Copied first, but kept only once the delete went through: a refused cut leaves the clipboard alone.
  const copied = copyClips(state.doc, ids);
  if (state.edit(deleteOps(ids, false), "cut").ok && copied) clipboard.write(copied);
}

// Puts the clipboard's clips at the playhead, where placeClips finds room, and selects them.
export function paste(store: EditorStore, clipboard: ClipboardStore): void {
  const state = store.getState();
  if (!state.canEdit) return;
  const copied = clipboard.read();
  if (!copied) {
    state.notify("info", MESSAGES.nothingToPaste);
    return;
  }
  const placement = placeClips(state.doc, pasteItems(copied, state.playhead), () => nanoid(10));
  if (!placement.ok) {
    state.notify("error", MESSAGES.noRoom);
    return;
  }
  const result = state.edit(placement.ops, "paste");
  if (result.ok) state.select(placement.clipIds);
}

// Track runners, used by the track headers, the timeline toolbar and the inspector.

function editTrack(store: EditorStore, ops: OpInput[], label: string): void {
  const state = store.getState();
  if (state.canEdit && ops.length > 0) state.edit(ops, label);
}

export function addTrack(store: EditorStore, kind: TrackKind): void {
  editTrack(store, addTrackOps(store.getState().doc, kind), "add track");
}

export function renameTrack(store: EditorStore, trackId: string, name: string): void {
  editTrack(store, renameTrackOps(store.getState().doc, trackId, name), "rename track");
}

export function toggleTrack(store: EditorStore, trackId: string, field: TrackSwitch): void {
  editTrack(store, toggleTrackOps(store.getState().doc, trackId, field), "track change");
}

export function reorderTrack(store: EditorStore, trackId: string, direction: "up" | "down"): void {
  editTrack(store, reorderTrackOps(store.getState().doc, trackId, direction), "reorder tracks");
}

export function removeTrack(store: EditorStore, trackId: string): void {
  editTrack(store, removeTrackOps(store.getState().doc, trackId), "remove track");
}
