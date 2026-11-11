import { cx } from "@/components/ui/cx";
import { formatTimecode } from "@/lib/editor/geometry";

// A frame as "0:03:15" in Geist Mono with even-width digits, so the readout does not jitter.
export function Timecode({ frame, fps, className }: { frame: number; fps: number; className?: string }) {
  return <span className={cx("font-mono tabular-nums", className)}>{formatTimecode(frame, fps)}</span>;
}
