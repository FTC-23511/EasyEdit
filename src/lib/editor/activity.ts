import { FORMAT_PRESETS, type Op } from "@/lib/timeline";
import { timeAgo } from "@/lib/time-ago";
import type { ProjectApi } from "./api";
import type { EditorStore } from "./store";
import { ACTIVITY_LIMIT, type ActivityEntry } from "./types";

// How long the editing indicator stays up after someone else's change.
export const EDITING_INDICATOR_MS = 6000;
// How many changes the activity list loads at a time.
export const ACTIVITY_PAGE = 50;

type OpOf<K extends Op["op"]> = Extract<Op, { op: K }>;

const count = (n: number, one: string, many: (n: number) => string) => (n === 1 ? one : many(n));

const TRACK_FLAG_SUMMARY: Record<"locked" | "hidden" | "muted", [on: string, off: string]> = {
  locked: ["Locked a track", "Unlocked a track"],
  hidden: ["Hid a track", "Showed a track"],
  muted: ["Muted a track", "Unmuted a track"],
};

function summarizeTrackUpdates(ops: OpOf<"update_track">[]): string {
  if (ops.length === 1) {
    const entries = Object.entries(ops[0].patch).filter(([, v]) => v !== undefined);
    if (entries.length === 1) {
      const [key, value] = entries[0];
      if (key === "name") return "Renamed a track";
      const flag = TRACK_FLAG_SUMMARY[key as keyof typeof TRACK_FLAG_SUMMARY];
      if (flag) return value ? flag[0] : flag[1];
    }
  }
  const tracks = new Set(ops.map((o) => o.trackId)).size;
  return count(tracks, "Changed a track", (n) => `Changed ${n} tracks`);
}

// A short line for the activity list saying what a batch of ops did.
export function summarizeOps(ops: Op[]): string {
  const fallback = `Made ${ops.length} changes`;
  if (ops.length === 0) return fallback;
  const kinds = new Set(ops.map((o) => o.op));
  const only = (kind: Op["op"]) => kinds.size === 1 && kinds.has(kind);
  const n = ops.length;

  // Tracks added to hold new clips are part of adding the clips.
  if (kinds.has("add_clip") && [...kinds].every((k) => k === "add_clip" || k === "add_track")) {
    const adds = ops.filter((o): o is OpOf<"add_clip"> => o.op === "add_clip");
    if (adds.length > 1) return `Added ${adds.length} clips`;
    return adds[0].clip.type === "text" ? "Added text" : "Added a clip";
  }
  if (only("remove_clip")) return count(n, "Deleted a clip", (k) => `Deleted ${k} clips`);
  if (only("move_clip")) return count(n, "Moved a clip", (k) => `Moved ${k} clips`);
  if (only("trim_clip")) return count(n, "Trimmed a clip", (k) => `Trimmed ${k} clips`);
  if (only("split_clip")) return count(n, "Split a clip", (k) => `Split ${k} clips`);
  if (only("update_clip")) return count(n, "Edited a clip", (k) => `Edited ${k} clips`);
  if (only("update_track")) return summarizeTrackUpdates(ops as OpOf<"update_track">[]);
  if (only("add_track")) return count(n, "Added a track", (k) => `Added ${k} tracks`);
  if (only("remove_track")) return count(n, "Removed a track", (k) => `Removed ${k} tracks`);
  if (only("move_track")) return "Reordered tracks";
  if (only("replace_track")) {
    const restored = ops.every((o) => o.op === "replace_track" && o.restore === true);
    return restored
      ? count(n, "Restored a track", (k) => `Restored ${k} tracks`)
      : count(n, "Replaced a track", (k) => `Replaced ${k} tracks`);
  }
  if (only("set_format") && n === 1) {
    return `Changed the format to ${FORMAT_PRESETS[(ops[0] as OpOf<"set_format">).format].label}`;
  }
  return fallback;
}

// True when the log kept an inverse for this change, so it can be undone.
export function canUndoChange(entry: ActivityEntry): entry is ActivityEntry & { inverse: Op[] } {
  return entry.inverse !== null && entry.inverse.length > 0;
}

export function whoLabel(entry: ActivityEntry, meId: string): string {
  return entry.actor === meId ? "You" : entry.actorName;
}

// The log names the assistant "Claude" or "Claude (for <name>)"; both show as Claude.
const ASSISTANT_NAME = /^Claude(?: \(for .*\))?$/;

export function editingLabel(names: string[]): string | null {
  const people = [...new Set(names.map((name) => (ASSISTANT_NAME.test(name) ? "Claude" : name)))];
  if (people.length === 0) return null;
  if (people.length === 1) return `${people[0]} is editing…`;
  return `${people.length} people are editing…`;
}

// The newest page of the log, ending at version.
export function recentRange(version: number): { since: number; limit: number } | null {
  if (version <= 0) return null;
  const since = Math.max(0, version - ACTIVITY_PAGE);
  return { since, limit: version - since };
}

// The page just before the oldest loaded version.
export function olderRange(oldestLoaded: number): { since: number; limit: number } | null {
  if (oldestLoaded <= 1) return null;
  const end = oldestLoaded - 1;
  const since = Math.max(0, end - ACTIVITY_PAGE);
  return { since, limit: end - since };
}

export type ActivityRow = { version: number; who: string; summary: string; when: string; canUndo: boolean };

// The loaded entries as list rows, newest first.
export function activityRows(entries: ActivityEntry[], meId: string, now: Date): ActivityRow[] {
  return entries
    .map((entry) => ({
      version: entry.version,
      who: whoLabel(entry, meId),
      summary: summarizeOps(entry.ops),
      when: timeAgo(new Date(entry.createdAt), now),
      canUndo: canUndoChange(entry),
    }))
    .reverse();
}

// True when earlier changes can still be loaded: the oldest loaded version is above 1 and the list is not full.
export function hasOlderActivity(entries: ActivityEntry[]): boolean {
  return entries.length > 0 && entries.length < ACTIVITY_LIMIT && entries[0].version > 1;
}

// Reads a range of the log. A page can be cut short by size, so it asks again from where the
// last page ended until the range is covered. Null when a request failed.
async function fetchRange(api: ProjectApi, range: { since: number; limit: number }): Promise<ActivityEntry[] | null> {
  const end = range.since + range.limit;
  const entries: ActivityEntry[] = [];
  let since = range.since;
  for (;;) {
    const page = await api.getOpsSince(since, end - since);
    if (!page.ok) return null;
    entries.push(...page.entries);
    if (!page.hasMore || page.version >= end || page.version <= since) return entries;
    since = page.version;
  }
}

async function loadRange(api: ProjectApi, store: EditorStore, range: { since: number; limit: number } | null): Promise<boolean> {
  if (!range) return true;
  const entries = await fetchRange(api, range);
  if (!entries) return false;
  store.getState().loadActivity(entries);
  return true;
}

// Loads the newest page of the log. False: the request failed.
export function loadRecentActivity(api: ProjectApi, store: EditorStore): Promise<boolean> {
  return loadRange(api, store, recentRange(store.getState().server.version));
}

// Loads the page before the oldest loaded change. False: the request failed.
export function loadOlderActivity(api: ProjectApi, store: EditorStore): Promise<boolean> {
  const { activity } = store.getState();
  const range = activity.length === 0 || !hasOlderActivity(activity) ? null : olderRange(activity[0].version);
  return loadRange(api, store, range);
}
