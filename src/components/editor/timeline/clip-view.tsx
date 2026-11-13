"use client";

import { memo, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { FADE, FOCUS_RING_INSET, cx } from "@/components/ui/cx";
import { ROW_HEIGHT, formatTimecode, frameToPx } from "@/lib/editor/geometry";
import type { Clip } from "@/lib/timeline";
import { useEditor, useEditorStore } from "../context";
import { useLibrary } from "../media/media-context";
import { CLICK_SLOP_PX, useClipDrag } from "./use-clip-drag";

const FILL: Record<Clip["type"], string> = {
  video: "bg-ed-clip-video",
  image: "bg-ed-clip-image",
  text: "bg-ed-clip-text",
  audio: "bg-ed-clip-audio",
};

const KIND: Record<Clip["type"], string> = { video: "Video", image: "Image", text: "Text", audio: "Audio" };

const MIN_LABEL_PX = 24;
export const CLIP_HEIGHT = 32; // the clip's box in its row; the timeline draws a refused drop's outline with the same
export const CLIP_TOP = (ROW_HEIGHT - CLIP_HEIGHT) / 2;
const MIN_TRIM_PX = 16; // narrower clips have no trim handles, so they can still be grabbed to move
const HANDLE = cx("absolute inset-y-0 w-1.5 cursor-ew-resize", FADE); // 6 px, as tall as the clip

// A text clip's first line; a media clip's asset name, or its kind before the library knows the asset.
function clipLabel(clip: Clip, assetName: string | undefined): string {
  if (clip.type === "text") return clip.text.split("\n")[0];
  return assetName ?? KIND[clip.type];
}

function clipName(clip: Clip, assetName: string | undefined, fps: number): string {
  const range = `${formatTimecode(clip.start, fps)} to ${formatTimecode(clip.start + clip.duration, fps)}`;
  if (clip.type === "text") return `Text clip "${clipLabel(clip, undefined)}", ${range}`;
  return assetName === undefined ? `${KIND[clip.type]} clip, ${range}` : `${KIND[clip.type]} clip "${assetName}", ${range}`;
}

type ClipViewProps = { clip: Clip; zoom: number; fps: number; selected: boolean; hidden: boolean; locked: boolean };

// One clip in its row. Selection happens on press, so a later drag can take the whole selection:
// pressing a clip that is not selected selects only it (Shift, Cmd or Ctrl toggles it); pressing a
// selected clip keeps the selection, and letting go without moving makes it the only one. Where
// the clip can be edited, the timeline's drag takes the press from there: it moves the clip, or
// trims it from a handle at either end, and handles the release.
export const ClipView = memo(function ClipView({ clip, zoom, fps, selected, hidden, locked }: ClipViewProps) {
  const store = useEditorStore();
  const drag = useClipDrag();
  const canEdit = useEditor((s) => s.canEdit);
  const assetName = useLibrary((s) => (clip.type === "text" ? undefined : s.assets[clip.assetId]?.name));
  const press = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const width = Math.max(2, frameToPx(clip.duration, zoom));
  const dragger = canEdit && !locked ? drag : null; // null for a viewer, a locked track, or outside a timeline

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    press.current = null;
    if (e.button !== 0) return;
    const { selection, select } = store.getState();
    const toggle = e.shiftKey || e.metaKey || e.ctrlKey;
    const keep = !toggle && selection.clipIds.includes(clip.id);
    if (toggle) select([clip.id], "toggle");
    else if (!keep) select([clip.id]);
    if (dragger) {
      const edge = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-trim-handle]")?.dataset.trimHandle : undefined;
      dragger.pressClip(e, clip.id, edge === "start" || edge === "end" ? edge : "move", keep);
    } else if (keep) press.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    const pressed = press.current;
    press.current = null;
    if (!pressed || pressed.pointerId !== e.pointerId) return;
    if (Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) < CLICK_SLOP_PX) store.getState().select([clip.id]);
  }

  // Enter selects the clip. Space is left alone: in the editor it always plays or pauses.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    store.getState().select([clip.id]);
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={clipName(clip, assetName, fps)}
      aria-pressed={selected}
      data-clip-id={clip.id}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (press.current = null)}
      onKeyDown={onKeyDown}
      className={cx(
        "group absolute flex touch-none items-center overflow-hidden rounded-[4px] border select-none",
        FILL[clip.type],
        selected ? "border-ed-accent bg-linear-to-r from-ed-accent-weak to-ed-accent-weak" : "border-ed-line-strong",
        hidden && "opacity-50",
        locked && "cursor-not-allowed",
        FOCUS_RING_INSET,
        FADE,
      )}
      style={{ left: frameToPx(clip.start, zoom), top: CLIP_TOP, width, height: CLIP_HEIGHT }}
    >
      {width >= MIN_LABEL_PX && <span className="min-w-0 truncate px-1.5 text-xs leading-4 text-ed-text">{clipLabel(clip, assetName)}</span>}
      {dragger && width >= MIN_TRIM_PX && (
        <>
          <span aria-hidden data-trim-handle="start" className={cx(HANDLE, "left-0", handleLook(selected))} />
          <span aria-hidden data-trim-handle="end" className={cx(HANDLE, "right-0", handleLook(selected))} />
        </>
      )}
    </div>
  );
}, drawsTheSame);

// A drag gives every clip a new object, so an unmoved clip is kept by comparing what it draws from.
function drawsTheSame(a: ClipViewProps, b: ClipViewProps): boolean {
  return (
    a.zoom === b.zoom &&
    a.fps === b.fps &&
    a.selected === b.selected &&
    a.hidden === b.hidden &&
    a.locked === b.locked &&
    a.clip.id === b.clip.id &&
    a.clip.type === b.clip.type &&
    a.clip.start === b.clip.start &&
    a.clip.duration === b.clip.duration &&
    clipLabel(a.clip, undefined) === clipLabel(b.clip, undefined) &&
    (a.clip.type === "text" || b.clip.type === "text" || a.clip.assetId === b.clip.assetId)
  );
}

// Trim handles show on selected clips, and on any clip under the pointer.
function handleLook(selected: boolean): string {
  return selected ? "bg-ed-accent" : "bg-ed-muted opacity-0 group-hover:opacity-100";
}
