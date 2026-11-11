import type { DB } from "@/db";
import type { CurrentUser } from "@/lib/access-rules";
import { addEntry, AllowlistError, normalizeEmail, removeEntry, setRole, type Role } from "@/lib/allowlist/service";

export type ActionResult = { error?: string };

export type AdminActionDeps = {
  db: () => DB;
  requireUser: (min: Role) => Promise<CurrentUser>;
  revalidate: (path: string) => void;
};

const ROLES: readonly Role[] = ["admin", "editor", "viewer"];

const ERROR_MESSAGES: Record<AllowlistError["code"], string> = {
  LAST_ADMIN: "There must always be at least one admin.",
  INVALID_EMAIL: "That doesn't look like an email address.",
  ALREADY_MEMBER: "That email is already a member. Change their role in the table.",
};

function textField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function roleField(formData: FormData): Role | null {
  const value = textField(formData, "role");
  return ROLES.find((r) => r === value) ?? null;
}

export function makeAdminActions(deps: AdminActionDeps) {
  async function run(change: (admin: CurrentUser, db: DB) => Promise<ActionResult | void>): Promise<ActionResult> {
    const admin = await deps.requireUser("admin");
    try {
      const failure = await change(admin, deps.db());
      if (failure) return failure;
    } catch (e) {
      if (e instanceof AllowlistError) return { error: ERROR_MESSAGES[e.code] };
      throw e;
    }
    deps.revalidate("/admin");
    return {};
  }

  return {
    addMember: (formData: FormData) =>
      run(async (admin, db) => {
        const role = roleField(formData);
        if (!role) return { error: "Unknown role." };
        await addEntry(db, { email: textField(formData, "email"), role, invitedBy: admin.email });
      }),
    setRole: (formData: FormData) =>
      run(async (_admin, db) => {
        const role = roleField(formData);
        if (!role) return { error: "Unknown role." };
        await setRole(db, normalizeEmail(textField(formData, "email")), role);
      }),
    removeMember: (formData: FormData) =>
      run(async (_admin, db) => {
        await removeEntry(db, textField(formData, "email"));
      }),
  };
}
