import type { Op, OpErrorCode, TimelineDoc } from "@/lib/timeline";

export type Me = { id: string; name: string };

export type EditorInit = { projectId: string; name: string; doc: TimelineDoc; version: number; me: Me; canEdit: boolean };

export type EditKind = "edit" | "undo" | "redo";

// A local edit the server has not confirmed yet. Its id doubles as the request id when it is sent.
export type PendingEdit = { id: string; kind: EditKind; label: string; ops: Op[]; inverse: Op[]; sent: boolean };

// One step of undo history. ops is what to send to undo the edit (on the redo stack, to redo it).
export type UndoEntry = { editId: string; label: string; ops: Op[] };

export type Selection = { clipIds: string[]; trackId: string | null };

export type Notice = { id: number; tone: "info" | "error"; text: string };

export type SyncStatus = "saved" | "saving" | "offline" | "signed-out" | "deleted";

// One entry of the project's op log.
export type ActivityEntry = {
  version: number;
  ops: Op[];
  inverse: Op[] | null;
  actor: string;
  actorName: string;
  requestId?: string | null;
  createdAt: string;
};

export type EditResult = { ok: true } | { ok: false; code: OpErrorCode | "READ_ONLY"; message: string };

// The Activity list keeps at most this many changes, newest last.
export const ACTIVITY_LIMIT = 200;
