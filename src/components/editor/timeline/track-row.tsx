"use client";

import { memo, useMemo, useRef, type PointerEvent } from "react";
import { cx } from "@/components/ui/cx";
import { HEADER_WIDTH, ROW_HEIGHT, visibleClips } from "@/lib/editor/geometry";
import type { Track } from "@/lib/timeline";
import { useEditorStore } from "../context";
import { ClipView } from "./clip-view";
import { LANE_GUTTER } from "./playhead";
import { TrackHeader } from "./track-header";
import { useClipDrag } from "./use-clip-drag";

type TrackRowProps = {
  track: Track;
  zoom: number;
  fps: number;
  fromFrame: number; // only clips in this range are rendered
  toFrame: number;
  selectedIds: string[];
  trackSelected: boolean;
  divider: boolean; // the last row before the audio rows draws the stronger rule under it
};

// A track's header and its lane of clips. Pressing empty row space right of the header (the lane, or
// the gutter before frame 0) clears the selection, unless Shift is held, and starts a box selection.
export const TrackRow = memo(function TrackRow(props: TrackRowProps) {
  const { track, zoom, fps, fromFrame, toFrame, selectedIds, trackSelected, divider } = props;
  const store = useEditorStore();
  const clips = useMemo(() => visibleClips(track.clips, fromFrame, toFrame), [track.clips, fromFrame, toFrame]);
  const laneRef = useRef<HTMLDivElement>(null);
  const drag = useClipDrag();

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || (e.target !== e.currentTarget && e.target !== laneRef.current)) return;
    const { selection, select } = store.getState();
    if (!e.shiftKey && (selection.clipIds.length > 0 || selection.trackId !== null)) select([]);
    drag?.pressRows(e);
  }

  return (
    <div
      role="group"
      aria-label={track.name}
      className={cx("flex border-b", divider ? "border-ed-line-strong" : "border-ed-line")}
      style={{ height: ROW_HEIGHT }}
      onPointerDown={onPointerDown}
    >
      <TrackHeader track={track} selected={trackSelected} />
      <div data-lane className="relative flex min-w-0 flex-1 items-center" ref={laneRef} style={{ marginLeft: LANE_GUTTER }}>
        {clips.map((clip) => (
          <ClipView
            key={clip.id}
            clip={clip}
            zoom={zoom}
            fps={fps}
            selected={selectedIds.includes(clip.id)}
            hidden={track.hidden}
            locked={track.locked}
          />
        ))}
        {track.kind === "caption" && track.clips.length === 0 && (
          <p className="pointer-events-none sticky w-max text-xs leading-4 text-ed-muted" style={{ left: HEADER_WIDTH + 12 }}>
            Captions are not available yet.
          </p>
        )}
      </div>
    </div>
  );
});
