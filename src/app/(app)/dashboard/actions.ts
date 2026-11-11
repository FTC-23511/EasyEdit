"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { requireUser } from "@/lib/access";
import { makeDashboardActions, type FormState } from "@/lib/projects/dashboard-actions";

const actions = makeDashboardActions({ db: getDb, requireUser, revalidate: revalidatePath, redirect });

export async function createProjectAction(prev: FormState, formData: FormData): Promise<FormState> {
  return actions.create(prev, formData);
}

export async function renameProjectAction(formData: FormData): Promise<FormState> {
  return actions.rename(formData);
}

export async function deleteProjectAction(formData: FormData): Promise<FormState> {
  return actions.remove(formData);
}

export async function duplicateProjectAction(formData: FormData): Promise<FormState> {
  return actions.duplicate(formData);
}
