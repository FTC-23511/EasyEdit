import Link from "next/link";
import { getDb } from "@/db";
import { meetsRole, requireUser } from "@/lib/access";
import { actorUserId, displayActor } from "@/lib/projects/display-actor";
import { listProjects } from "@/lib/projects/service";
import { getUserNames } from "@/lib/projects/user-names";
import { FORMAT_PRESETS } from "@/lib/timeline";
import { timeAgo } from "@/lib/time-ago";
import { createProjectAction } from "./actions";

export default async function DashboardPage() {
  const user = await requireUser();
  const db = getDb();
  const projects = await listProjects(db);
  const names = await getUserNames(db, projects.map((project) => actorUserId(project.updatedBy)));

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
      {meetsRole(user.role, "editor") && (
        <form action={createProjectAction} className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Name
            <input
              name="name"
              required
              maxLength={100}
              className="rounded border border-black/20 bg-transparent px-3 py-2 dark:border-white/25"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Format
            <select
              name="format"
              defaultValue="short_9x16"
              className="rounded border border-black/20 bg-transparent px-3 py-2 dark:border-white/25"
            >
              {Object.entries(FORMAT_PRESETS).map(([id, preset]) => (
                <option key={id} value={id}>
                  {preset.label} ({preset.width}×{preset.height})
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="rounded bg-foreground px-4 py-2 text-sm font-medium text-background">
            New project
          </button>
        </form>
      )}
      {projects.length === 0 ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">No projects yet.</p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <li key={project.id}>
              <Link
                href={`/editor/${project.id}`}
                className="flex flex-col gap-2 rounded-lg border border-black/10 p-4 hover:bg-black/[.03] dark:border-white/15 dark:hover:bg-white/[.05]"
              >
                <span className="font-medium">{project.name}</span>
                <span className="w-fit rounded-full bg-black/[.06] px-2 py-0.5 text-xs dark:bg-white/[.1]">
                  {FORMAT_PRESETS[project.format].label}
                </span>
                <span className="text-xs text-zinc-600 dark:text-zinc-400">
                  updated by {displayActor(project.updatedBy, names)} · {timeAgo(project.updatedAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
