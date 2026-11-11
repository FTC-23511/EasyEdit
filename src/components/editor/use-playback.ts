"use client";

import { useEffect } from "react";
import { advance } from "@/lib/editor/playback";
import { viewDoc } from "@/lib/editor/store";
import { docDuration } from "@/lib/timeline";
import { useEditor, useEditorStore } from "./context";

// Moves the playhead while the store says playing. Each animation frame works out the frame from
// an origin (a frame and the time it was shown), so a slow frame never slows playback down. The
// origin is taken again when the rate changes or something else moves the playhead. Playback
// pauses at the end, and when the tab is hidden. onFrame runs right after the loop moves the
// playhead, inside the same animation frame, so a canvas can show that frame at once. Pass a
// stable function: a new one restarts the loop.
export function usePlayback(onFrame?: () => void): void {
  const store = useEditorStore();
  const playing = useEditor((s) => s.playing);

  useEffect(() => {
    if (!playing) return;
    const start = store.getState();
    let origin = { frame: start.playhead, at: performance.now() };
    let shown = start.playhead; // the frame this loop last moved the playhead to
    let raf = 0;

    const unsubscribe = store.subscribe((s, prev) => {
      if (s.rate !== prev.rate || (s.playhead !== prev.playhead && s.playhead !== shown)) {
        origin = { frame: s.playhead, at: performance.now() };
        shown = s.playhead;
      }
    });

    const tick = () => {
      raf = 0;
      const s = store.getState();
      if (!s.playing) return;
      const doc = viewDoc(s);
      const { frame, ended } = advance(origin, performance.now(), s.rate, doc.fps, docDuration(doc));
      shown = frame;
      if (frame !== s.playhead) {
        s.seek(frame);
        onFrame?.();
      }
      if (ended) {
        s.pause();
        return;
      }
      raf = requestAnimationFrame(tick);
    };

    const onVisibility = () => {
      if (document.hidden) store.getState().pause();
    };

    raf = requestAnimationFrame(tick);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [playing, store, onFrame]);
}
