// The playback clock and the J/K/L shuttle, as pure functions of time and state.

export const MAX_RATE = 4;

export type Shuttle = { playing: boolean; rate: number }; // the rate is negative when playing backward

// K stops. L plays forward, doubling the rate up to MAX_RATE while already going forward. J mirrors L.
export function shuttle(state: Shuttle, key: "j" | "k" | "l"): Shuttle {
  if (key === "k") return { playing: false, rate: 1 };
  const direction = key === "l" ? 1 : -1;
  if (state.playing && Math.sign(state.rate) === direction) {
    return { playing: true, rate: direction * Math.min(Math.abs(state.rate) * 2, MAX_RATE) };
  }
  return { playing: true, rate: direction };
}

// Where playback is at `now`, counted in whole frames from the moment it started at `origin`,
// kept inside 0..duration. It has ended once it reaches the end it is heading for. An origin past
// the end counts from the end, so playing backward from there moves at once.
export function advance(
  origin: { frame: number; at: number },
  now: number,
  rate: number,
  fps: number,
  duration: number,
): { frame: number; ended: boolean } {
  const clamp = (f: number) => Math.min(duration, Math.max(0, f));
  const travelled = Math.trunc(((now - origin.at) / 1000) * fps * rate);
  const frame = clamp(clamp(origin.frame) + travelled);
  const ended = rate > 0 ? frame >= duration : rate < 0 ? frame <= 0 : false;
  return { frame, ended };
}
