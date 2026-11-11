import { nanoid } from "nanoid";
import { createStore, type StoreApi } from "zustand/vanilla";
import { LIMITS } from "@/lib/limits";
import {
  OpError,
  applyOps,
  docDuration,
  prepareOps,
  type Clip,
  type Op,
  type OpErrorCode,
  type OpInput,
  type TimelineDoc,
  type Track,
} from "@/lib/timeline";
import { canUndoChange } from "./activity";
import { clampZoom, fitZoom } from "./geometry";
import { MESSAGES, explainOpError } from "./messages";
import { shuttle as nextShuttle } from "./playback";
import { foldQueue, sameOps } from "./reconcile";
import type {
  ActivityEntry,
  EditKind,
  EditResult,
  EditorInit,
  Me,
  Notice,
  PendingEdit,
  Selection,
  SyncStatus,
  UndoEntry,
} from "./types";
import { ACTIVITY_LIMIT } from "./types";

export const UNDO_LIMIT = 100;
export { ACTIVITY_LIMIT };

export type EditorState = {
  projectId: string;
  name: string;
  me: Me;
  canEdit: boolean;
  server: { doc: TimelineDoc; version: number }; // what the server is known to hold
  queue: PendingEdit[]; // local edits not yet confirmed, oldest first
  doc: TimelineDoc; // server.doc with every queued edit applied
  gesture: { ops: Op[]; doc: TimelineDoc | null } | null; // a drag or a field being typed in; doc is null while it cannot apply
  selection: Selection;
  playhead: number;
  zoom: number; // pixels per frame
  viewportPx: number; // width of the timeline's scrolling area, without the track headers
  fitRequest: number; // counts zoomToFit calls, so the timeline knows to scroll to the start
  snapping: boolean;
  status: SyncStatus;
  notice: Notice | null;
  undoStack: UndoEntry[]; // newest last, at most UNDO_LIMIT
  redoStack: UndoEntry[];
  activity: ActivityEntry[]; // oldest first, at most ACTIVITY_LIMIT
  remote: { names: string[]; at: number } | null; // who else just edited, and when
  playing: boolean;
  rate: number; // negative when playing backward
  showSafeZones: boolean;

  edit(ops: OpInput[], label: string): EditResult;
  undo(): void;
  redo(): void;
  undoChange(entry: ActivityEntry): void; // "Undo this change" in the activity list
  loadActivity(entries: ActivityEntry[]): void; // merges a fetched page
  setGesture(ops: OpInput[] | null): boolean; // true when the gesture applies right now
  commitGesture(label: string): EditResult;
  select(clipIds: string[], mode?: "replace" | "toggle" | "add"): void;
  selectTrack(trackId: string | null): void;
  seek(frame: number): void; // rounds, never below 0
  setZoom(zoom: number): void;
  setViewport(px: number): void;
  zoomBy(factor: number): void; // zoom × factor, through clampZoom
  zoomToFit(): void; // the whole project in the viewport
  setSnapping(on: boolean): void;
  notify(tone: Notice["tone"], text: string): void;
  dismissNotice(): void;
  // called by the sync engine
  markSent(editId: string, sent: boolean): void;
  ack(editId: string, version: number, inverse: Op[]): void;
  refuse(editId: string, code: OpErrorCode): void;
  applyRemote(entries: ActivityEntry[]): boolean; // false: an entry is missing or does not apply; the caller reloads
  replaceServer(doc: TimelineDoc, version: number): void;
  setStatus(status: SyncStatus): void;
  revokeEditing(): void;
  // playback, open to viewers too
  play(): void; // from the start when the playhead is at the end; not in a project with no clips
  pause(): void;
  shuttle(key: "j" | "k" | "l"): void;
  step(deltaFrames: number): void; // pauses, then moves the playhead; forward stops at the end
  toggleSafeZones(): void;
};

export type EditorStore = StoreApi<EditorState>;

// The gesture's doc when it applies, else doc.
export function viewDoc(state: EditorState): TimelineDoc {
  return state.gesture?.doc ?? state.doc;
}

export function findClip(doc: TimelineDoc, clipId: string): { clip: Clip; track: Track } | null {
  for (const track of doc.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { clip, track };
  }
  return null;
}

function clipIds(doc: TimelineDoc): Set<string> {
  return new Set(doc.tracks.flatMap((t) => t.clips.map((c) => c.id)));
}

// Keeps only the clips and the track that still exist. Returns the same object when nothing went.
function pruneSelection(doc: TimelineDoc, selection: Selection): Selection {
  const existing = clipIds(doc);
  const kept = selection.clipIds.filter((id) => existing.has(id));
  const trackId = selection.trackId !== null && doc.tracks.some((t) => t.id === selection.trackId) ? selection.trackId : null;
  if (kept.length === selection.clipIds.length && trackId === selection.trackId) return selection;
  return { clipIds: kept, trackId };
}

type Stacks = Pick<EditorState, "undoStack" | "redoStack">;

function stacksOf(state: EditorState): Stacks {
  return { undoStack: state.undoStack, redoStack: state.redoStack };
}

// Forgets the history of edits that never happened (refused or dropped).
function withoutEdits(stacks: Stacks, editIds: string[]): Stacks {
  if (editIds.length === 0) return { undoStack: stacks.undoStack, redoStack: stacks.redoStack };
  const kept = (e: UndoEntry) => !editIds.includes(e.editId);
  return { undoStack: stacks.undoStack.filter(kept), redoStack: stacks.redoStack.filter(kept) };
}

// Once an edit is confirmed, undoing it sends the server's inverse instead of the local one.
function withServerInverse(stacks: Stacks, editId: string, inverse: Op[] | null): Stacks {
  if (inverse === null) return stacks;
  const swap = (e: UndoEntry) => (e.editId === editId ? { ...e, ops: inverse } : e);
  return { undoStack: stacks.undoStack.map(swap), redoStack: stacks.redoStack.map(swap) };
}

function pushCapped(stack: UndoEntry[], entry: UndoEntry): UndoEntry[] {
  return [...stack, entry].slice(-UNDO_LIMIT);
}

// One entry per version, oldest first, keeping the newest ACTIVITY_LIMIT.
function mergeActivity(list: ActivityEntry[], added: ActivityEntry[]): ActivityEntry[] {
  if (added.length === 0) return list;
  const byVersion = new Map(list.map((e) => [e.version, e]));
  for (const e of added) byVersion.set(e.version, e);
  return [...byVersion.values()].sort((a, b) => a.version - b.version).slice(-ACTIVITY_LIMIT);
}

function refusalMessage(kind: EditKind, code: OpErrorCode): string {
  if (kind === "undo") return MESSAGES.undoRefused;
  if (kind === "redo") return MESSAGES.redoRefused;
  return explainOpError(code);
}

// A request id names the edit exactly, so an entry from my other tab with the same ops is not
// taken for this tab's edit. Entries without one are matched on who made them and what they do.
function isOwnHead(entry: ActivityEntry, head: PendingEdit | undefined, meId: string): boolean {
  if (!head) return false;
  if (entry.requestId) return entry.requestId === head.id;
  return head.sent && entry.actor === meId && sameOps(entry.ops, head.ops);
}

export function createEditorStore(
  init: EditorInit,
  deps: { genId?: () => string; now?: () => number } = {},
): EditorStore {
  // Edit ids are sent as request ids, which must be 8 to 64 characters of A-Za-z0-9_-.
  const genId = deps.genId ?? (() => nanoid(10));
  const now = deps.now ?? Date.now;
  let lastNoticeId = 0;
  const makeNotice = (tone: Notice["tone"], text: string): Notice => ({ id: ++lastNoticeId, tone, text });

  return createStore<EditorState>()((set, get) => {
    // What follows a change to doc: the selection keeps only what still exists, and a live
    // gesture is re-applied. A gesture whose clip is gone ends; one that no longer fits waits.
    function settle(state: EditorState, doc: TimelineDoc): Partial<EditorState> {
      const patch: Partial<EditorState> = { doc, selection: pruneSelection(doc, state.selection) };
      const gesture = state.gesture;
      if (gesture) {
        try {
          patch.gesture = { ops: gesture.ops, doc: applyOps(doc, gesture.ops).doc };
        } catch (err) {
          if (err instanceof OpError && err.code === "NOT_FOUND") {
            patch.gesture = null;
            patch.notice = makeNotice("error", MESSAGES.clipGone);
          } else {
            patch.gesture = { ops: gesture.ops, doc: null };
          }
        }
      }
      return patch;
    }

    // Shows a new server copy with the queue re-applied on top. Returns the edits that no longer
    // fit; their undo history goes with them.
    function rebase(
      state: EditorState,
      server: EditorState["server"],
      queue: PendingEdit[],
      stacks: Stacks = stacksOf(state),
    ) {
      const { doc, kept, dropped } = foldQueue(server.doc, queue);
      const history = withoutEdits(stacks, dropped.map((e) => e.id));
      return { patch: { server, queue: kept, ...history, ...settle(state, doc) }, dropped };
    }

    function rebaseAndTell(
      state: EditorState,
      server: EditorState["server"],
      queue: PendingEdit[],
      stacks: Stacks = stacksOf(state),
      extra: Partial<EditorState> = {},
    ) {
      const { patch, dropped } = rebase(state, server, queue, stacks);
      // A dropped undo or redo says what the server would say had it refused it.
      const first = dropped[0];
      const text = !first ? null : first.kind === "edit" ? MESSAGES.rebaseDropped : refusalMessage(first.kind, "STALE");
      const notice = text ? { notice: makeNotice("error", text) } : {};
      set({ ...patch, ...extra, ...notice });
    }

    // Undo and redo: replays the top entry of one stack as a new edit and puts its inverse on the
    // other. An entry that no longer applies is dropped with a notice.
    function replayTop(kind: "undo" | "redo") {
      const state = get();
      const source = kind === "undo" ? state.undoStack : state.redoStack;
      const top = source.at(-1);
      if (!state.canEdit || !top) return;
      const rest = source.slice(0, -1);
      const stacks = (pushed: UndoEntry | null): Stacks => {
        if (kind === "undo") return { undoStack: rest, redoStack: pushed ? pushCapped(state.redoStack, pushed) : state.redoStack };
        return { redoStack: rest, undoStack: pushed ? pushCapped(state.undoStack, pushed) : state.undoStack };
      };
      let result: { doc: TimelineDoc; inverse: Op[] };
      try {
        result = applyOps(state.doc, top.ops);
      } catch (err) {
        if (!(err instanceof OpError)) throw err;
        set({ ...stacks(null), notice: makeNotice("error", refusalMessage(kind, err.code)) });
        return;
      }
      if (result.inverse.length === 0) {
        set(stacks(null));
        return;
      }
      const pending: PendingEdit = { id: genId(), kind, label: top.label, ops: top.ops, inverse: result.inverse, sent: false };
      set({
        queue: [...state.queue, pending],
        ...stacks({ editId: pending.id, label: top.label, ops: result.inverse }),
        ...settle(state, result.doc),
      });
    }

    function fail(code: OpErrorCode, message: string): EditResult {
      set({ notice: makeNotice("error", message) });
      return { ok: false, code, message };
    }

    return {
      projectId: init.projectId,
      name: init.name,
      me: init.me,
      canEdit: init.canEdit,
      server: { doc: init.doc, version: init.version },
      queue: [],
      doc: init.doc,
      gesture: null,
      selection: { clipIds: [], trackId: null },
      playhead: 0,
      zoom: 2,
      viewportPx: 1200,
      fitRequest: 0,
      snapping: true,
      status: "saved",
      notice: null,
      undoStack: [],
      redoStack: [],
      activity: [],
      remote: null,
      playing: false,
      rate: 1,
      showSafeZones: true,

      edit(ops, label) {
        const state = get();
        if (!state.canEdit) return { ok: false, code: "READ_ONLY", message: MESSAGES.readOnly };
        if (ops.length > LIMITS.opsPerRequest) return fail("LIMIT_EXCEEDED", MESSAGES.tooManyOps);
        let prepared: Op[];
        let result: { doc: TimelineDoc; inverse: Op[] };
        try {
          prepared = prepareOps(ops, genId);
          result = applyOps(state.doc, prepared);
        } catch (err) {
          if (err instanceof OpError) return fail(err.code, explainOpError(err.code));
          throw err;
        }
        if (result.inverse.length === 0) return { ok: true };
        const pending: PendingEdit = { id: genId(), kind: "edit", label, ops: prepared, inverse: result.inverse, sent: false };
        set({
          queue: [...state.queue, pending],
          undoStack: pushCapped(state.undoStack, { editId: pending.id, label, ops: result.inverse }),
          redoStack: [],
          ...settle(state, result.doc),
        });
        return { ok: true };
      },

      undo() {
        replayTop("undo");
      },

      redo() {
        replayTop("redo");
      },

      undoChange(entry) {
        const state = get();
        if (!state.canEdit || !canUndoChange(entry)) return;
        try {
          applyOps(state.doc, entry.inverse);
        } catch (err) {
          if (!(err instanceof OpError)) throw err;
          set({ notice: makeNotice("error", MESSAGES.undoRefused) });
          return;
        }
        get().edit(entry.inverse, "revert"); // the Undo button then reads "Undo revert"
      },

      loadActivity(entries) {
        const { activity } = get();
        const merged = mergeActivity(activity, entries);
        if (merged !== activity) set({ activity: merged });
      },

      setGesture(ops) {
        const state = get();
        if (!state.canEdit) return false;
        if (ops === null) {
          if (state.gesture) set({ gesture: null });
          return true;
        }
        let prepared: Op[];
        try {
          prepared = prepareOps(ops, genId);
        } catch (err) {
          if (!(err instanceof OpError)) throw err;
          set({ gesture: null });
          return false;
        }
        try {
          set({ gesture: { ops: prepared, doc: applyOps(state.doc, prepared).doc } });
          return true;
        } catch (err) {
          if (!(err instanceof OpError)) throw err;
          set({ gesture: { ops: prepared, doc: null } });
          return false;
        }
      },

      commitGesture(label) {
        const { gesture } = get();
        if (!gesture) return { ok: true };
        set({ gesture: null });
        return get().edit(gesture.ops, label);
      },

      select(ids, mode = "replace") {
        const state = get();
        const existing = clipIds(state.doc);
        const wanted = [...new Set(ids)].filter((id) => existing.has(id));
        const current = state.selection.clipIds;
        const added = wanted.filter((id) => !current.includes(id));
        let next: string[];
        if (mode === "replace") next = wanted;
        else if (mode === "add") next = [...current, ...added];
        else next = [...current.filter((id) => !wanted.includes(id)), ...added];
        set({ selection: { clipIds: next, trackId: null } });
      },

      selectTrack(trackId) {
        if (trackId !== null && !get().doc.tracks.some((t) => t.id === trackId)) return;
        set({ selection: { clipIds: [], trackId } });
      },

      seek(frame) {
        if (!Number.isFinite(frame)) return;
        set({ playhead: Math.max(0, Math.round(frame)) });
      },

      setZoom(zoom) {
        set({ zoom });
      },

      setViewport(px) {
        if (px > 0 && Number.isFinite(px) && px !== get().viewportPx) set({ viewportPx: px });
      },

      zoomBy(factor) {
        const { zoom, doc } = get();
        set({ zoom: clampZoom(zoom * factor, docDuration(doc), doc.fps) });
      },

      zoomToFit() {
        const { doc, viewportPx } = get();
        set({ zoom: fitZoom(docDuration(doc), doc.fps, viewportPx), fitRequest: get().fitRequest + 1 });
      },

      setSnapping(on) {
        set({ snapping: on });
      },

      notify(tone, text) {
        set({ notice: makeNotice(tone, text) });
      },

      dismissNotice() {
        set({ notice: null });
      },

      markSent(editId, sent) {
        const { queue } = get();
        if (!queue.some((e) => e.id === editId && e.sent !== sent)) return;
        set({ queue: queue.map((e) => (e.id === editId ? { ...e, sent } : e)) });
      },

      ack(editId, version, inverse) {
        const state = get();
        const head = state.queue[0];
        if (!head || head.id !== editId) return;
        const fresh = version === state.server.version + 1;
        if (!fresh && version > state.server.version) return;
        const stacks = withServerInverse(stacksOf(state), editId, inverse);
        const logged: ActivityEntry = {
          version,
          ops: head.ops,
          inverse,
          actor: state.me.id,
          actorName: state.me.name,
          requestId: head.id,
          createdAt: new Date(now()).toISOString(),
        };
        const activity = mergeActivity(state.activity, [logged]);
        if (fresh) {
          // The server applied the head on exactly this copy, so doc already shows the result.
          set({
            server: { doc: applyOps(state.server.doc, head.ops).doc, version },
            queue: state.queue.slice(1),
            ...stacks,
            activity,
          });
        } else {
          // A replayed answer: the server copy already holds the head, so it only leaves the queue.
          rebaseAndTell(state, state.server, state.queue.slice(1), stacks, { activity });
        }
      },

      refuse(editId, code) {
        const state = get();
        const refused = state.queue.find((e) => e.id === editId);
        if (!refused) return;
        // Edits dropped because they depended on the refused one add no second notice.
        const { patch } = rebase(
          state,
          state.server,
          state.queue.filter((e) => e.id !== editId),
          withoutEdits(stacksOf(state), [editId]),
        );
        set({ ...patch, notice: makeNotice("error", refusalMessage(refused.kind, code)) });
      },

      applyRemote(entries) {
        const state = get();
        let server = state.server;
        let queue = state.queue;
        let stacks = stacksOf(state);
        const applied: ActivityEntry[] = [];
        let complete = true;
        for (const entry of [...entries].sort((a, b) => a.version - b.version)) {
          if (entry.version <= server.version) continue;
          if (entry.version !== server.version + 1) {
            complete = false;
            break;
          }
          let doc: TimelineDoc;
          try {
            doc = applyOps(server.doc, entry.ops).doc;
          } catch (err) {
            if (!(err instanceof OpError)) throw err;
            complete = false;
            break;
          }
          // My own edit coming back from the log: it is now part of the server copy.
          if (isOwnHead(entry, queue[0], state.me.id)) {
            stacks = withServerInverse(stacks, queue[0].id, entry.inverse);
            queue = queue.slice(1);
          }
          server = { doc, version: entry.version };
          applied.push(entry);
        }
        if (applied.length > 0) {
          // A change by Claude on my behalf has actor "claude:<my id>", so it counts as someone else.
          const others = applied.filter((e) => e.actor !== state.me.id);
          const extra: Partial<EditorState> = { activity: mergeActivity(state.activity, applied) };
          if (others.length > 0) extra.remote = { names: [...new Set(others.map((e) => e.actorName))], at: now() };
          rebaseAndTell(state, server, queue, stacks, extra);
        }
        return complete;
      },

      replaceServer(doc, version) {
        const state = get();
        if (version < state.server.version) return;
        rebaseAndTell(state, { doc, version }, state.queue);
      },

      setStatus(status) {
        set({ status });
      },

      revokeEditing() {
        const { server, selection } = get();
        set({
          canEdit: false,
          queue: [],
          gesture: null,
          doc: server.doc,
          selection: pruneSelection(server.doc, selection),
          notice: makeNotice("error", MESSAGES.lostAccess),
        });
      },

      play() {
        const { doc, playhead } = get();
        const end = docDuration(doc);
        if (end === 0) return;
        set({ playing: true, rate: 1, playhead: playhead >= end ? 0 : playhead });
      },

      pause() {
        set({ playing: false, rate: 1 });
      },

      shuttle(key) {
        const { doc, playhead, playing, rate } = get();
        const next = nextShuttle({ playing, rate }, key);
        if (!next.playing) {
          set(next);
          return;
        }
        const end = docDuration(doc);
        if (end === 0) return;
        const startsForward = next.rate > 0 && !(playing && rate > 0);
        set({ ...next, playhead: startsForward && playhead >= end ? 0 : playhead });
      },

      step(deltaFrames) {
        const { pause, seek, playhead, doc } = get();
        pause();
        const next = playhead + deltaFrames;
        // A playhead already past the end stays where it is rather than jumping back.
        seek(deltaFrames > 0 ? Math.min(next, Math.max(playhead, docDuration(doc))) : next);
      },

      toggleSafeZones() {
        set({ showSafeZones: !get().showSafeZones });
      },
    };
  });
}
