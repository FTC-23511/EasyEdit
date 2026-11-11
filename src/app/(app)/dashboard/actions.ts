"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db";
import { requireUser } from "@/lib/access";
import { createProject } from "@/lib/projects/service";
import { FORMAT_PRESETS, type FormatId } from "@/lib/timeline";

const input = z.object({
  name: z.string().trim().min(1).max(100),
  format: z.enum(Object.keys(FORMAT_PRESETS) as [FormatId, ...FormatId[]]),
});

export async function createProjectAction(formData: FormData): Promise<void> {
  const user = await requireUser("editor");
  const parsed = input.safeParse({ name: formData.get("name"), format: formData.get("format") });
  if (!parsed.success) redirect("/dashboard");
  const { id } = await createProject(getDb(), { ...parsed.data, actor: user.id });
  redirect(`/editor/${id}`);
}
