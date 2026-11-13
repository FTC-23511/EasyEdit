"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { cx } from "@/components/ui/cx";
import {
  HEADER_WIDTH,
  MAX_CONTENT_PX,
  ROW_HEIGHT,
  RULER_HEIGHT,
  clampZoom,
  contentFrames,
  displayRows,
  frameToPx,
  revealScroll,
  zoomAt,
} from "@/lib/editor/geometry";
import { viewDoc } from "@/lib/editor/store";
import { docDuration, type Track } from "@/lib/timeline";
import { useEditor, useEditorStore } from "../context";
import { LANE_GUTTER, PlayheadLine } from "./playhead";
import { Ruler } from "./ruler";
import { Toolbar } from "./toolbar";
import { CLIP_HEIGHT, CLIP_TOP } from "./clip-view";
import { TrackRow } from "./track-row";
import { TimelineDragContext, useTimelineDrag, type DragView } from "./use-clip-drag";

const OVERSCAN_PX = 200; // clips this far outside the visible area are rendered too
const WINDOW_STEP_PX = 100; // the rendered range moves in steps, so scrolling re-renders rows only now and then
const WHEEL_ZOOM_RATE = 0.002; // per pixel of wheel travel
const LINE_PX = 16; // a wheel that reports lines

// The scrolling area's cursor follows the drag: a drop that is not allowed, or a trim.
const DRAG_CURSOR = "[&[data-drag=refused]]:cursor-not-allowed [&[data-drag=refused]_*]:cursor-not-allowed [&[data-drag=trim]_*]:cursor-ew-resize";

const windowStart = (scrollLeft: number) => Math.floor(scrollLeft / WINDOW_STEP_PX) * WINDOW_STEP_PX;

// The scrollLeft after a zoom that keeps the frame at anchorPx (from the left of the visible lanes)
// where it is. An anchor in the gutter before frame 0 keeps frame 0 where it is.
function keepAnchor(scrollLeft: number, anchorPx: number, zoom: number, nextZoom: number): number {
  if (scrollLeft + anchorPx <= LANE_GUTTER) return scrollLeft;
  return zoomAt({ scrollLeft, anchorPx: anchorPx - LANE_GUTTER, zoom, nextZoom });
}

// The tracks along the bottom: a toolbar, then one scrolling area with the ruler stuck to the top and
// the track headers stuck to the left. Only the playhead and its readout follow the playhead; the
// rows render only the clips in view.
export function Timeline() {
  const store = useEditorStore();
  const doc = useEditor(viewDoc);
  const storedZoom = useEditor((s) => s.zoom);
  const viewportPx = useEditor((s) => s.viewportPx);
  const fitRequest = useEditor((s) => s.fitRequest);
  const canEdit = useEditor((s) => s.canEdit);
  const selection = useEditor((s) => s.selection);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const [scrollStart, setScrollStart] = useState(0);
  const scrubbing = useRef(false);
  const wheelAnchor = useRef<number | null>(null);

  const { fps } = doc;
  const duration = useMemo(() => docDuration(doc), [doc]);
  const rows = useMemo(() => displayRows(doc), [doc]);
  const empty = useMemo(() => doc.tracks.every((t) => t.clips.length === 0), [doc]);
  // A project that grew may no longer fit at the stored zoom; draw at the allowed one and store it below.
  const zoom = clampZoom(storedZoom, duration, fps);
  const frames = contentFrames(duration, fps);
  const width = Math.min(HEADER_WIDTH + LANE_GUTTER + Math.floor(frames * zoom), MAX_CONTENT_PX);
  const fromFrame = Math.max(0, (scrollStart - LANE_GUTTER - OVERSCAN_PX) / zoom);
  const toFrame = (scrollStart - LANE_GUTTER + WINDOW_STEP_PX + viewportPx + OVERSCAN_PX) / zoom;
  const drag = useTimelineDrag(store, scrollRef, rowsRef, zoom);

  useEffect(() => {
    if (zoom !== storedZoom) store.getState().setZoom(zoom);
  }, [zoom, storedZoom, store]);

  // Measure the visible lane width before the first paint and on every resize; the first measurement
  // also fits the project.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let measured = false;
    const measure = () => {
      const lanes = el.clientWidth - HEADER_WIDTH;
      if (el.clientWidth === 0 || lanes <= 0) return;
      const { setViewport, zoomToFit } = store.getState();
      setViewport(lanes);
      if (!measured) {
        measured = true;
        zoomToFit();
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [store]);

  // Ctrl or Cmd with the wheel zooms around the pointer. React's wheel listener is passive, so this
  // one is added by hand to be allowed to stop the browser's own zoom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const { zoom: current, doc: d, setZoom } = store.getState();
      const delta = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * LINE_PX : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? e.deltaY * el.clientWidth : e.deltaY;
      const next = clampZoom(current * Math.exp(-delta * WHEEL_ZOOM_RATE), docDuration(d), d.fps);
      if (next === current) return;
      wheelAnchor.current = Math.max(0, e.clientX - el.getBoundingClientRect().left - HEADER_WIDTH);
      setZoom(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [store]);

  // After a zoom, before the frame is painted, scroll so the right thing stays put: the frame under the
  // pointer for the wheel, else the playhead when it is in view, else the left edge.
  const shownZoom = useRef(zoom);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const before = shownZoom.current;
    const anchor = wheelAnchor.current;
    shownZoom.current = zoom;
    wheelAnchor.current = null;
    if (!el || before === zoom) return;
    const playheadPx = LANE_GUTTER + frameToPx(store.getState().playhead, before) - el.scrollLeft;
    const anchorPx = anchor ?? (playheadPx >= 0 && playheadPx <= el.clientWidth - HEADER_WIDTH ? playheadPx : 0);
    el.scrollLeft = keepAnchor(el.scrollLeft, anchorPx, before, zoom);
    setScrollStart(windowStart(el.scrollLeft));
  }, [zoom, store]);

  // Fit (the button, a key, the first measurement) shows the project from the start, even when the
  // zoom was already the fitted one. This runs after the zoom effect above, so it has the last word.
  const handledFit = useRef(fitRequest);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || handledFit.current === fitRequest) return;
    handledFit.current = fitRequest;
    el.scrollLeft = 0;
    setScrollStart(0);
  }, [fitRequest]);

  // When the playhead moves out of view for any reason but the person dragging it (playback, a key),
  // scroll so it sits 10% in from the left.
  useEffect(
    () =>
      store.subscribe((s, prev) => {
        const el = scrollRef.current;
        if (!el || s.playhead === prev.playhead || scrubbing.current) return;
        const next = revealScroll({ playheadPx: LANE_GUTTER + frameToPx(s.playhead, s.zoom), scrollLeft: el.scrollLeft, viewportPx: el.clientWidth - HEADER_WIDTH });
        if (next !== null) el.scrollLeft = next;
      }),
    [store],
  );

  const onScrub = useCallback((active: boolean) => {
    scrubbing.current = active;
  }, []);

  function onScroll(e: UIEvent<HTMLDivElement>) {
    setScrollStart(windowStart(e.currentTarget.scrollLeft));
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar duration={duration} fps={fps} />
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={onScroll} className={cx("absolute inset-0 overflow-auto overscroll-contain", DRAG_CURSOR)}>
          <div className="relative min-h-full" style={{ width }}>
            <Ruler zoom={zoom} fps={fps} fromFrame={fromFrame} toFrame={toFrame} max={frames} end={duration} onScrub={onScrub} />
            <TimelineDragContext value={drag}>
              <div ref={rowsRef} className="relative">
                {rows.map((track, i) => (
                  <TrackRow
                    key={track.id}
                    track={track}
                    zoom={zoom}
                    fps={fps}
                    fromFrame={fromFrame}
                    toFrame={toFrame}
                    selectedIds={selection.clipIds}
                    trackSelected={selection.trackId === track.id}
                    divider={track.kind !== "audio" && rows[i + 1]?.kind === "audio"}
                  />
                ))}
                <DragOverlay view={drag.view} rows={rows} zoom={zoom} />
              </div>
            </TimelineDragContext>
            <PlayheadLine zoom={zoom} />
          </div>
        </div>
        {empty && (
          <p
            className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center text-[13px] leading-5 text-ed-muted"
            style={{ left: HEADER_WIDTH, top: RULER_HEIGHT }}
          >
            {canEdit ? "Nothing on the timeline yet. Add text or media from the panel on the left." : "Nothing on the timeline yet."}
          </p>
        )}
      </div>
    </div>
  );
}

// Drawn over the rows during a drag: the snap guide, where clips would land when the drop is not
// allowed, and the box of a box selection. Only this re-renders as they change.
function DragOverlay({ view, rows, zoom }: { view: StoreApi<DragView>; rows: Track[]; zoom: number }) {
  const { guide, ghost, box } = useStore(view);
  const x = (frame: number) => HEADER_WIDTH + LANE_GUTTER + frameToPx(frame, zoom);
  return (
    <>
      {ghost?.map((g) => {
        const row = rows.findIndex((t) => t.id === g.trackId);
        if (row < 0) return null;
        return (
          <div
            key={g.clipId}
            aria-hidden
            data-drag-ghost
            className="pointer-events-none absolute z-10 rounded-[4px] border border-ed-danger"
            style={{ left: x(g.start), top: row * ROW_HEIGHT + CLIP_TOP, width: Math.max(2, frameToPx(g.duration, zoom)), height: CLIP_HEIGHT }}
          />
        );
      })}
      {guide !== null && <div aria-hidden data-snap-guide className="pointer-events-none absolute inset-y-0 z-10 border-l border-ed-accent" style={{ left: x(guide) }} />}
      {box && (
        <div
          aria-hidden
          data-select-box
          className="pointer-events-none absolute z-10 border border-ed-accent bg-ed-accent-weak"
          style={{
            left: x(Math.min(box.fromFrame, box.toFrame)),
            top: Math.min(box.fromY, box.toY),
            width: frameToPx(Math.abs(box.toFrame - box.fromFrame), zoom),
            height: Math.abs(box.toY - box.fromY),
          }}
        />
      )}
    </>
  );
}
