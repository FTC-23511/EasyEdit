"use client";

import type { KeyboardEvent } from "react";
import { FOCUS_RING_INSET, cx } from "@/components/ui/cx";
import { HEADER_WIDTH, formatTimecode, frameToPx } from "@/lib/editor/geometry";
import { useEditor } from "../context";

const GRAB_PX = 24; // the transparent area that takes the pointer; the drawn head inside is 9 px

// Space before frame 0 in the ruler and in every lane, so the playhead's head and grab area are whole
// at frame 0. Frame f is drawn LANE_GUTTER + frameToPx(f) from the start of a lane.
export const LANE_GUTTER = GRAB_PX / 2;

// The draggable head in the ruler. It is the keyboard's way to the playhead: arrows move one frame,
// with Shift one second; Home and End go to the start and the end of the project. The ruler does the
// dragging, so the pointer is captured in one place.
export function PlayheadHead({ zoom, fps, max, end }: { zoom: number; fps: number; max: number; end: number }) {
  const playhead = useEditor((s) => s.playhead);
  const seek = useEditor((s) => s.seek);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? fps : 1;
    let frame: number;
    if (e.key === "ArrowLeft") frame = playhead - step;
    else if (e.key === "ArrowRight") frame = playhead + step;
    else if (e.key === "Home") frame = 0;
    else if (e.key === "End") frame = end;
    else return;
    e.preventDefault();
    seek(Math.min(max, Math.max(0, frame)));
  }

  return (
    <div
      data-playhead
      role="slider"
      tabIndex={0}
      aria-label="Playhead"
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={playhead}
      aria-valuetext={formatTimecode(playhead, fps)}
      onKeyDown={onKeyDown}
      className={cx("absolute top-0 left-0 h-full cursor-ew-resize rounded-[4px]", FOCUS_RING_INSET)}
      style={{ width: GRAB_PX, transform: `translateX(${LANE_GUTTER + frameToPx(playhead, zoom) - GRAB_PX / 2}px)` }}
    >
      <span aria-hidden className="absolute top-0 bottom-0 left-3 w-px bg-ed-text" />
      <span
        aria-hidden
        className="absolute top-0 left-2 h-[11px] w-[9px] bg-ed-text [clip-path:polygon(0_0,100%_0,100%_55%,50%_100%,0_55%)]"
      />
    </div>
  );
}

// The line across the rows. It sits under the track headers and the ruler and lets the pointer through.
export function PlayheadLine({ zoom }: { zoom: number }) {
  const playhead = useEditor((s) => s.playhead);
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute top-0 bottom-0 z-10 w-px bg-ed-text"
      style={{ left: HEADER_WIDTH + LANE_GUTTER, transform: `translateX(${frameToPx(playhead, zoom)}px)` }}
    />
  );
}
