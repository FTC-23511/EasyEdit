import { nanoid } from "nanoid";
import { z } from "zod";
import { OpError } from "./errors";
import { Clip, MediaClip, TextClip, Track, TrackKind } from "./types";

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

const removeTrack = z.object({ op: z.literal("remove_track"), trackId: id });
const updateTrack = z.object({ op: z.literal("update_track"), trackId: id, patch: TrackPatch });
const replaceTrack = z.object({
  op: z.literal("replace_track"),
  track: Track,
  index: z.number().int().min(0),
});
const removeClip = z.object({ op: z.literal("remove_clip"), clipId: id, ripple: z.boolean().optional() });
const moveClip = z.object({
  op: z.literal("move_clip"),
  clipId: id,
  start: z.number().int().min(0),
  trackId: id.optional(),
});

const newTrack = { kind: TrackKind, name: z.string() };

export const Op = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add_track"),
    track: z.object({ id, ...newTrack }),
    index: z.number().int().optional(),
  }),
  removeTrack,
  updateTrack,
  replaceTrack,
  z.object({ op: z.literal("add_clip"), trackId: id, clip: Clip }),
  removeClip,
  moveClip,
]);
export type Op = z.infer<typeof Op>;

export const OpInput = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add_track"),
    track: z.object({ ...optionalId, ...newTrack }),
    index: z.number().int().optional(),
  }),
  removeTrack,
  updateTrack,
  replaceTrack,
  z.object({ op: z.literal("add_clip"), trackId: id, clip: ClipInput }),
  removeClip,
  moveClip,
]);
export type OpInput = z.infer<typeof OpInput>;

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  const where = issue.path.length ? `${issue.path.join(".")}: ` : "";
  return `${where}${issue.message}`;
}

export function prepareOps(ops: OpInput[], genId: () => string = () => nanoid(10)): Op[] {
  return ops.map((raw, opIndex) => {
    const parsed = OpInput.safeParse(raw);
    if (!parsed.success) {
      throw new OpError("INVALID", `Op ${opIndex} is invalid: ${describeIssue(parsed.error)}`, opIndex);
    }
    const input = parsed.data;
    const filled =
      input.op === "add_track"
        ? { ...input, track: { ...input.track, id: input.track.id ?? genId() } }
        : input.op === "add_clip"
          ? { ...input, clip: { ...input.clip, id: input.clip.id ?? genId() } }
          : input;
    const checked = Op.safeParse(filled);
    if (!checked.success) {
      throw new OpError("INVALID", `Op ${opIndex} is invalid: ${describeIssue(checked.error)}`, opIndex);
    }
    return checked.data;
  });
}
