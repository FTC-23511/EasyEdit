import { nanoid } from "nanoid";
import { z } from "zod";
import { OpError } from "./errors";
import { Clip, FormatId, MediaClip, TextClip, Track, TrackKind } from "./types";

const id = z.string().min(1);
const optionalId = { id: id.optional() };

const TrackPatch = z.object({
  name: z.string().optional(),
  muted: z.boolean().optional(),
  hidden: z.boolean().optional(),
  locked: z.boolean().optional(),
});

const ClipInput = z.discriminatedUnion("type", [
  MediaClip.extend(optionalId),
  TextClip.extend(optionalId),
]);

const newTrack = { kind: TrackKind, name: z.string() };

const addTrackOp = <T extends z.ZodType>(trackId: T) =>
  z.object({
    op: z.literal("add_track"),
    track: z.object({ id: trackId, ...newTrack }),
    index: z.number().int().optional(),
  });
const addClipOp = <T extends z.ZodType>(clipSchema: T) =>
  z.object({ op: z.literal("add_clip"), trackId: id, clip: clipSchema });
const splitClipOp = <T extends z.ZodType>(newClipId: T) =>
  z.object({ op: z.literal("split_clip"), clipId: id, at: z.number().int(), newClipId });

// Ops with no optional ids: one definition, shared by Op and OpInput.
const sharedOps = [
  z.object({ op: z.literal("remove_track"), trackId: id }),
  z.object({ op: z.literal("update_track"), trackId: id, patch: TrackPatch }),
  z.object({
    op: z.literal("replace_track"),
    track: Track,
    index: z.number().int().min(0),
  }),
  z.object({ op: z.literal("remove_clip"), clipId: id, ripple: z.boolean().optional() }),
  z.object({
    op: z.literal("move_clip"),
    clipId: id,
    start: z.number().int().min(0),
    trackId: id.optional(),
  }),
  z.object({
    op: z.literal("trim_clip"),
    clipId: id,
    edge: z.enum(["start", "end"]),
    to: z.number().int(),
  }),
  z.object({ op: z.literal("update_clip"), clipId: id, patch: z.record(z.string(), z.unknown()) }),
  z.object({ op: z.literal("set_format"), format: FormatId }),
] as const;

export const Op = z.discriminatedUnion("op", [
  addTrackOp(id),
  addClipOp(Clip),
  splitClipOp(id),
  ...sharedOps,
]);
export type Op = z.infer<typeof Op>;

export const OpInput = z.discriminatedUnion("op", [
  addTrackOp(id.optional()),
  addClipOp(ClipInput),
  splitClipOp(id.optional()),
  ...sharedOps,
]);
export type OpInput = z.infer<typeof OpInput>;

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  const where = issue.path.length ? `${issue.path.join(".")}: ` : "";
  return `${where}${issue.message}`;
}

function opLabel(raw: unknown, opIndex: number): string {
  const name = typeof raw === "object" && raw !== null ? (raw as { op?: unknown }).op : undefined;
  return typeof name === "string" ? `${name} (op ${opIndex})` : `Op ${opIndex}`;
}

export function prepareOps(ops: OpInput[], genId: () => string = () => nanoid(10)): Op[] {
  return ops.map((raw, opIndex) => {
    const parsed = OpInput.safeParse(raw);
    if (!parsed.success) {
      throw new OpError(
        "INVALID",
        `${opLabel(raw, opIndex)} is invalid: ${describeIssue(parsed.error)}`,
        opIndex,
      );
    }
    const input = parsed.data;
    let filled: unknown = input;
    if (input.op === "add_track") {
      filled = { ...input, track: { ...input.track, id: input.track.id ?? genId() } };
    } else if (input.op === "add_clip") {
      filled = { ...input, clip: { ...input.clip, id: input.clip.id ?? genId() } };
    } else if (input.op === "split_clip") {
      filled = { ...input, newClipId: input.newClipId ?? genId() };
    }
    const checked = Op.safeParse(filled);
    if (!checked.success) {
      throw new OpError(
        "INVALID",
        `${opLabel(raw, opIndex)} is invalid: ${describeIssue(checked.error)}`,
        opIndex,
      );
    }
    return checked.data;
  });
}
