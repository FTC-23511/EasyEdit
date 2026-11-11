"use client";

import { Pause, Play, Scan, SkipBack, SkipForward, StepBack, StepForward } from "lucide-react";
import { useMemo } from "react";
import { IconButton } from "@/components/ui/icon-button";
import { shortcutFor } from "@/lib/editor/shortcuts";
import { viewDoc } from "@/lib/editor/store";
import { FORMAT_PRESETS, docDuration } from "@/lib/timeline";
import { useEditor } from "./context";
import { Timecode } from "./timecode";
import { useIsMac } from "./use-shortcuts";

// "2×", or "−2×" when playing backward.
const rateLabel = (rate: number) => (rate < 0 ? `−${-rate}×` : `${rate}×`);

// The bar under the preview. Playback is not an edit, so every control here works for a viewer too.
export function Transport() {
  const doc = useEditor(viewDoc);
  const playing = useEditor((s) => s.playing);
  const rate = useEditor((s) => s.rate);
  const showSafeZones = useEditor((s) => s.showSafeZones);
  const seek = useEditor((s) => s.seek);
  const step = useEditor((s) => s.step);
  const play = useEditor((s) => s.play);
  const pause = useEditor((s) => s.pause);
  const toggleSafeZones = useEditor((s) => s.toggleSafeZones);
  const duration = useMemo(() => docDuration(doc), [doc]);
  const isMac = useIsMac();
  const playKey = shortcutFor("play-pause", isMac);

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-t border-ed-line bg-ed-panel px-3">
      <div className="flex items-center gap-1">
        <IconButton label="Go to start" shortcut={shortcutFor("go-start", isMac)} onClick={() => seek(0)}>
          <SkipBack />
        </IconButton>
        <IconButton label="Back one frame" shortcut={shortcutFor("frame-back", isMac)} onClick={() => step(-1)}>
          <StepBack />
        </IconButton>
        {playing ? (
          <IconButton label="Pause" shortcut={playKey} className="[&>svg]:text-ed-accent" onClick={() => pause()}>
            <Pause />
          </IconButton>
        ) : (
          <IconButton label="Play" shortcut={playKey} className="[&>svg]:text-ed-accent" disabled={duration === 0} onClick={() => play()}>
            <Play />
          </IconButton>
        )}
        <IconButton label="Forward one frame" shortcut={shortcutFor("frame-forward", isMac)} onClick={() => step(1)}>
          <StepForward />
        </IconButton>
        <IconButton label="Go to end" shortcut={shortcutFor("go-end", isMac)} onClick={() => seek(duration)}>
          <SkipForward />
        </IconButton>
      </div>
      <TimeReadout duration={duration} fps={doc.fps} />
      {playing && rate !== 1 && (
        <span className="shrink-0 rounded-[4px] border border-ed-line px-1.5 font-mono text-[11px] leading-4 font-medium text-ed-muted tabular-nums">
          {rateLabel(rate)}
        </span>
      )}
      <div className="ml-auto flex min-w-0 items-center gap-2">
        <IconButton label="Safe zones" pressed={showSafeZones} onClick={() => toggleSafeZones()}>
          <Scan />
        </IconButton>
        <span className="truncate text-xs text-ed-muted">{FORMAT_PRESETS[doc.format].label}</span>
      </div>
    </div>
  );
}

// Its own component, so only the readout re-renders while the playhead moves.
function TimeReadout({ duration, fps }: { duration: number; fps: number }) {
  const playhead = useEditor((s) => s.playhead);
  return (
    <p className="shrink-0 pl-1 text-xs leading-4 whitespace-nowrap text-ed-muted">
      <Timecode frame={playhead} fps={fps} className="text-ed-text" />
      {" / "}
      <Timecode frame={duration} fps={fps} />
    </p>
  );
}
