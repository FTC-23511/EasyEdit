"use client";

import { FoldHorizontal, Plus, Scissors, Trash2, UnfoldHorizontal, ZoomIn, ZoomOut } from "lucide-react";
import { Magnet } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { Menu, type MenuItem } from "@/components/ui/menu";
import { addTrack, deleteSelection, splitAtPlayhead } from "@/lib/editor/actions";
import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, clampZoom } from "@/lib/editor/geometry";
import { shortcutFor, type CommandId } from "@/lib/editor/shortcuts";
import { LIMITS } from "@/lib/limits";
import type { TrackKind } from "@/lib/timeline";
import { useEditor, useEditorStore } from "../context";
import { Timecode } from "../timecode";
import { useIsMac } from "../use-shortcuts";

const TRACK_ITEMS: { id: TrackKind; label: string }[] = [
  { id: "video", label: "Video track" },
  { id: "overlay", label: "Overlay track" },
  { id: "text", label: "Text track" },
  { id: "audio", label: "Audio track" },
];
const CAPTIONS_ITEM: MenuItem = { id: "caption", label: "Captions track" };
const TRACK_ITEMS_WITH_CAPTIONS: MenuItem[] = [...TRACK_ITEMS, CAPTIONS_ITEM];

// The bar above the tracks: adding tracks and the clip commands on the left, zoom and the playhead
// readout on the right. The readout is its own component, so only it re-renders while the playhead
// moves. The bar is 32 px and its buttons 28 px, so their focus outline is drawn inside the edge;
// outside it, the timeline region would cut off the top of the outline.
export function Toolbar({ duration, fps }: { duration: number; fps: number }) {
  const store = useEditorStore();
  const canEdit = useEditor((s) => s.canEdit);
  const hasSelection = useEditor((s) => s.selection.clipIds.length > 0);
  const hasCaptions = useEditor((s) => s.doc.tracks.some((t) => t.kind === "caption"));
  const tracksFull = useEditor((s) => s.doc.tracks.length >= LIMITS.tracksPerProject);
  const zoom = useEditor((s) => s.zoom);
  const zoomBy = useEditor((s) => s.zoomBy);
  const zoomToFit = useEditor((s) => s.zoomToFit);
  const snapping = useEditor((s) => s.snapping);
  const setSnapping = useEditor((s) => s.setSnapping);
  const isMac = useIsMac();
  const key = (command: CommandId) => shortcutFor(command, isMac);
  const maxZoom = clampZoom(ZOOM_MAX, duration, fps);
  const minZoom = Math.min(ZOOM_MIN, maxZoom);

  return (
    <div className="flex h-8 shrink-0 items-center gap-1 border-b border-ed-line px-3 [&_button:focus-visible]:-outline-offset-2">
      <Menu
        data-edit-control
        disabled={!canEdit || tracksFull}
        label="Add track"
        icon={<Plus />}
        items={hasCaptions ? TRACK_ITEMS : TRACK_ITEMS_WITH_CAPTIONS}
        onSelect={(kind) => addTrack(store, kind as TrackKind)}
      />
      <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-ed-line" />
      <IconButton data-edit-control disabled={!canEdit} label="Split" shortcut={key("split")} onClick={() => splitAtPlayhead(store)}>
        <Scissors />
      </IconButton>
      <IconButton data-edit-control disabled={!canEdit || !hasSelection} label="Delete" shortcut={key("delete")} onClick={() => deleteSelection(store, false)}>
        <Trash2 />
      </IconButton>
      <IconButton
        data-edit-control
        disabled={!canEdit || !hasSelection}
        label="Ripple delete"
        shortcut={key("ripple-delete")}
        onClick={() => deleteSelection(store, true)}
      >
        <FoldHorizontal />
      </IconButton>
      <div className="ml-auto flex items-center gap-1">
        <IconButton label="Snap" shortcut={key("toggle-snapping")} pressed={snapping} onClick={() => setSnapping(!snapping)}>
          <Magnet />
        </IconButton>
        <IconButton label="Zoom out" shortcut={key("zoom-out")} disabled={zoom <= minZoom} onClick={() => zoomBy(1 / ZOOM_STEP)}>
          <ZoomOut />
        </IconButton>
        <IconButton label="Zoom in" shortcut={key("zoom-in")} disabled={zoom >= maxZoom} onClick={() => zoomBy(ZOOM_STEP)}>
          <ZoomIn />
        </IconButton>
        <IconButton label="Fit" shortcut={key("zoom-fit")} onClick={() => zoomToFit()}>
          <UnfoldHorizontal />
        </IconButton>
      </div>
      <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-ed-line" />
      <PlayheadReadout duration={duration} fps={fps} />
    </div>
  );
}

function PlayheadReadout({ duration, fps }: { duration: number; fps: number }) {
  const playhead = useEditor((s) => s.playhead);
  return (
    <p className="shrink-0 text-xs leading-4 whitespace-nowrap text-ed-muted">
      <Timecode frame={playhead} fps={fps} className="text-ed-text" />
      {" / "}
      <Timecode frame={duration} fps={fps} />
    </p>
  );
}
