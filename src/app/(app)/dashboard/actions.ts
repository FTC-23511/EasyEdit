"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { requireUser } from "@/lib/access";
import { createProjectInput } from "@/lib/projects/schemas";
import { createProject } from "@/lib/projects/service";

export async function createProjectAction(formData: FormData): Promise<void> {
  const user = await requireUser("editor");
  const parsed = createProjectInput.safeParse({ name: formData.get("name"), format: formData.get("format") });
  if (!parsed.success) redirect("/dashboard");
  const { id } = await createProject(getDb(), { ...parsed.data, actor: user.id });
  redirect(`/editor/${id}`);
}
