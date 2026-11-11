const UNITS: [limit: number, seconds: number, name: string][] = [
  [60, 1, "second"],
  [3600, 60, "minute"],
  [86400, 3600, "hour"],
  [604800, 86400, "day"],
  [2629800, 604800, "week"],
  [31557600, 2629800, "month"],
  [Infinity, 31557600, "year"],
];

export function timeAgo(date: Date, now: Date = new Date()): string {
  const elapsed = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));
  if (elapsed < 10) return "just now";
  for (const [limit, seconds, name] of UNITS) {
    if (elapsed < limit) {
      const count = Math.floor(elapsed / seconds);
      return `${count} ${name}${count === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}
