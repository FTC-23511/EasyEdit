import { z } from "zod";
import { LIMITS } from "@/lib/limits";
import { graphemes, isStorableText } from "@/lib/text";
import { FORMAT_PRESETS, type FormatId } from "@/lib/timeline";

const FORMAT_IDS = Object.keys(FORMAT_PRESETS) as [FormatId, ...FormatId[]];

export const projectName: z.ZodType<string> = z
  .string()
  .trim()
  .min(1)
  .max(LIMITS.projectNameChars)
  .refine(isStorableText);

export const createProjectInput = z.object({
  name: projectName,
  format: z.enum(FORMAT_IDS),
});

const COPY_SUFFIX = " copy";

// The name of a duplicated project. A long name is shortened by whole characters, so an emoji is never split.
export function copyName(name: string): string {
  if (name.length + COPY_SUFFIX.length <= LIMITS.projectNameChars) return name + COPY_SUFFIX;
  const parts = graphemes(name);
  let length = name.length;
  while (length + COPY_SUFFIX.length > LIMITS.projectNameChars) length -= parts.pop()!.length;
  return parts.join("").trimEnd() + COPY_SUFFIX;
}
