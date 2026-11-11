"use client";

import { memo, useMemo, useRef, type PointerEvent } from "react";
import { HEADER_WIDTH, RULER_HEIGHT, frameToPx, pxToFrame, rulerTicks } from "@/lib/editor/geometry";
import { useEditorStore } from "../context";
import { LANE_GUTTER, PlayheadHead } from "./playhead";

type RulerProps = {
  zoom: number;
  fps: number;
  fromFrame: number; // the rendered range
  toFrame: number;
  max: number; // the last frame the playhead can reach
  end: number; // the end of the project
  onScrub(active: boolean): void; // tells the timeline the person is moving the playhead
};

// Ticks for the rendered range, and the playhead's head. Pressing or dragging anywhere on it seeks;
// grabbing the head drags it from where it was taken, so it does not jump under the pointer.
export const Ruler = memo(function Ruler({ zoom, fps, fromFrame, toFrame, max, end, onScrub }: RulerProps) {
  const store = useEditorStore();
  const laneRef = useRef<HTMLDivElement>(null);
  const grabOffset = useRef(0);
  const { ticks } = useMemo(() => rulerTicks({ zoom, fps, fromFrame, toFrame }), [zoom, fps, fromFrame, toFrame]);

  // The pointer's distance from frame 0; the gutter before frame 0 is part of the ruler.
  const lanePx = (clientX: number) => clientX - (laneRef.current?.getBoundingClientRect().left ?? 0) - LANE_GUTTER;
  const seekTo = (clientX: number) => store.getState().seek(Math.min(max, pxToFrame(lanePx(clientX) - grabOffset.current, zoom)));

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    onScrub(true);
    const onHead = e.target instanceof Element && e.target.closest("[data-playhead]") !== null;
    grabOffset.current = onHead ? lanePx(e.clientX) - frameToPx(store.getState().playhead, zoom) : 0;
    if (!onHead) seekTo(e.clientX);
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) seekTo(e.clientX);
  }

  return (
    <div className="sticky top-0 z-30 flex bg-ed-panel select-none" style={{ height: RULER_HEIGHT }}>
      <div className="sticky left-0 z-10 shrink-0 border-r border-b border-ed-line bg-ed-panel" style={{ width: HEADER_WIDTH }} />
      <div
        ref={laneRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onLostPointerCapture={() => onScrub(false)}
        className="relative min-w-0 flex-1 touch-none overflow-hidden border-b border-ed-line"
      >
        {ticks.map(({ frame, label }) => {
          const x = LANE_GUTTER + frameToPx(frame, zoom);
          return (
            <div key={frame} aria-hidden>
              <span className="absolute bottom-0 h-1.5 w-px bg-ed-line-strong" style={{ left: x }} />
              <span className="absolute top-0.5 text-[11px] leading-4 whitespace-nowrap text-ed-muted tabular-nums" style={{ left: x + 4 }}>
                {label}
              </span>
            </div>
          );
        })}
        <PlayheadHead zoom={zoom} fps={fps} max={max} end={end} />
      </div>
    </div>
  );
});
