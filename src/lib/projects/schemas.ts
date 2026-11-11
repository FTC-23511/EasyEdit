import { z } from "zod";
import { FORMAT_PRESETS, type FormatId } from "@/lib/timeline";

const FORMAT_IDS = Object.keys(FORMAT_PRESETS) as [FormatId, ...FormatId[]];

export const createProjectInput = z.object({
  name: z.string().trim().min(1).max(100),
  format: z.enum(FORMAT_IDS),
});
