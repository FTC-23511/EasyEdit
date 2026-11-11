"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { requireUser } from "@/lib/access";
import { makeAdminActions } from "@/lib/allowlist/admin-actions";

const actions = makeAdminActions({ db: getDb, requireUser, revalidate: revalidatePath });

export async function addMemberAction(formData: FormData) {
  return actions.addMember(formData);
}

export async function setRoleAction(formData: FormData) {
  return actions.setRole(formData);
}

export async function removeMemberAction(formData: FormData) {
  return actions.removeMember(formData);
}

export async function disconnectClaudeAction(formData: FormData) {
  return actions.disconnectClaude(formData);
}
