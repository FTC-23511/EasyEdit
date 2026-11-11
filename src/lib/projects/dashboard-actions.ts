import type { DB } from "@/db";
import type { CurrentUser } from "@/lib/access-rules";
import { actorFrom, type Actor } from "@/lib/actor";
import type { Role } from "@/lib/allowlist/service";
import { createProject, deleteProject, duplicateProject, renameProject } from "@/lib/projects/service";
import { ServiceError } from "@/lib/service-error";

export type FormState = { error?: string };

export type DashboardActionDeps = {
  db: () => DB;
  requireUser: (min?: Role) => Promise<CurrentUser>; // called with no argument; the service checks the role
  revalidate: (path: string) => void;
  redirect: (path: string) => never;
};

const field = (formData: FormData, key: string) => {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
};

export function makeDashboardActions(deps: DashboardActionDeps) {
  // Runs one service call as the signed-in user. A ServiceError becomes a message for the page; anything else rethrows.
  async function run<T>(call: (db: DB, actor: Actor) => Promise<T>): Promise<{ value: T } | { error: string }> {
    const actor = actorFrom(await deps.requireUser());
    try {
      return { value: await call(deps.db(), actor) };
    } catch (error) {
      if (!(error instanceof ServiceError)) throw error;
      if (error.code !== "NOT_FOUND") return { error: error.message };
      // Deleted elsewhere: refresh the list so its card goes away.
      deps.revalidate("/dashboard");
      return { error: "That project no longer exists." };
    }
  }

  async function change(call: (db: DB, actor: Actor) => Promise<unknown>): Promise<FormState> {
    const result = await run(call);
    if ("error" in result) return { error: result.error };
    deps.revalidate("/dashboard");
    return {};
  }

  return {
    async create(_prev: FormState, formData: FormData): Promise<FormState> {
      const result = await run((db, actor) =>
        createProject(db, actor, { name: field(formData, "name"), format: field(formData, "format") }),
      );
      if ("error" in result) return { error: result.error };
      return deps.redirect(`/editor/${result.value.id}`);
    },
    rename: (formData: FormData) =>
      change((db, actor) => renameProject(db, actor, field(formData, "id"), field(formData, "name"))),
    remove: (formData: FormData) => change((db, actor) => deleteProject(db, actor, field(formData, "id"))),
    duplicate: (formData: FormData) => change((db, actor) => duplicateProject(db, actor, field(formData, "id"))),
  };
}
