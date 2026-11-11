"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { makeFontResolver } from "@/lib/editor/fonts";
import { fitBox, previewSize } from "@/lib/editor/preview-size";
import { viewDoc } from "@/lib/editor/store";
import { drawFrame } from "@/lib/render/compositor";
import { SAFE_ZONES } from "@/lib/render/safe-zones";
import type { TimelineDoc } from "@/lib/timeline";
import { useEditor, useEditorStore } from "./context";
import { Transport } from "./transport";
import { usePlayback } from "./use-playback";

const PADDING_PX = 16; // around the canvas, inside the region

// The picture, drawn by the same compositor export uses, with the transport underneath. The canvas
// is drawn from a store subscription, not from React state, so playing re-renders nothing here.
// A frame the playback loop moves to is drawn in that same animation frame, in step with the
// timecode and the timeline's playhead; every other change waits for the next one.
export function Preview() {
  const drawNow = useRef<(() => void) | null>(null);
  usePlayback(useCallback(() => drawNow.current?.(), []));
  const store = useEditorStore();
  const width = useEditor((s) => viewDoc(s).width);
  const height = useEditor((s) => viewDoc(s).height);
  const format = useEditor((s) => viewDoc(s).format);
  const showSafeZones = useEditor((s) => s.showSafeZones);
  const areaRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [area, setArea] = useState({ width: 0, height: 0 });

  const backing = previewSize({ width, height });
  const box = fitBox(width / height, area.width, area.height);
  const zone = SAFE_ZONES[format];

  // The room left for the canvas, before the first paint and on every resize.
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const measure = () => {
      const next = { width: Math.max(0, el.clientWidth - 2 * PADDING_PX), height: Math.max(0, el.clientHeight - 2 * PADDING_PX) };
      setArea((prev) => (prev.width === next.width && prev.height === next.height ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Draws now, then again whenever the shown document, the playhead or the loaded fonts change, at
  // most once per animation frame. A new backing size clears the canvas, so it starts over then.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resolveFont = makeFontResolver(cachedCssVar());
    const requested = new Set<string>();
    let raf = 0;
    let disposed = false;

    const draw = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const s = store.getState();
      const doc = viewDoc(s);
      const { scale } = previewSize(doc);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      drawFrame(ctx, doc, s.playhead, { resolveFont });
    };
    const schedule = () => {
      if (!disposed && raf === 0) raf = requestAnimationFrame(draw);
    };
    // Asks the browser for every face the text uses and draws again once each has loaded, so text
    // never stays in a fallback face.
    const loadFonts = (doc: TimelineDoc) => {
      if (!("fonts" in document)) return;
      for (const font of textFonts(doc, resolveFont)) {
        if (requested.has(font)) continue;
        requested.add(font);
        document.fonts.load(font).then(schedule, schedule);
      }
    };

    const unsubscribe = store.subscribe((s, prev) => {
      const doc = viewDoc(s);
      const docChanged = doc !== viewDoc(prev);
      if (docChanged) loadFonts(doc);
      if (docChanged || s.playhead !== prev.playhead) schedule();
    });
    loadFonts(viewDoc(store.getState()));
    draw();
    drawNow.current = draw;
    return () => {
      disposed = true;
      drawNow.current = null;
      if (raf) cancelAnimationFrame(raf);
      unsubscribe();
    };
  }, [store, backing.width, backing.height]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={areaRef} className="flex min-h-0 flex-1 items-center justify-center" style={{ padding: PADDING_PX }}>
        {/* The edge is an outline, outside the box, so the canvas and the safe-zone box cover exactly the picture. */}
        <div className="relative shrink-0 outline outline-ed-line" style={{ width: box.width, height: box.height }}>
          <canvas ref={canvasRef} role="img" aria-label="Preview" width={backing.width} height={backing.height} className="block size-full" />
          {showSafeZones && (
            <div
              aria-hidden
              className="pointer-events-none absolute border border-dashed border-ed-faint"
              style={{ top: `${zone.top * 100}%`, right: `${zone.right * 100}%`, bottom: `${zone.bottom * 100}%`, left: `${zone.left * 100}%` }}
            >
              <span className="absolute top-1 left-1.5 text-[11px] leading-4 text-ed-muted">{zone.label}</span>
            </div>
          )}
        </div>
      </div>
      <Transport />
    </div>
  );
}

// Reads CSS variables from the document element. The app's font variables never change once set, so a
// value is read once.
function cachedCssVar(): (name: string) => string {
  const cache = new Map<string, string>();
  return (name) => {
    const known = cache.get(name);
    if (known !== undefined) return known;
    const value = getComputedStyle(document.documentElement).getPropertyValue(name);
    if (value.trim()) cache.set(name, value);
    return value;
  };
}

// Each distinct weight and family the text clips use, as a CSS font for document.fonts.load. The size
// does not choose the face, so one size stands for all.
function textFonts(doc: TimelineDoc, resolveFont: (family: string) => string): Set<string> {
  const fonts = new Set<string>();
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.type === "text") fonts.add(`${clip.style.fontWeight} 16px ${resolveFont(clip.style.fontFamily)}`);
    }
  }
  return fonts;
}
