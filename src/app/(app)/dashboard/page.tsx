import Link from "next/link";
import { getDb } from "@/db";
import { meetsRole, requireUser } from "@/lib/access";
import { actorFrom } from "@/lib/actor";
import { actorUserId, displayActor } from "@/lib/projects/display-actor";
import { listProjects } from "@/lib/projects/service";
import { getUserNames } from "@/lib/projects/user-names";
import { FORMAT_PRESETS } from "@/lib/timeline";
import { timeAgo } from "@/lib/time-ago";
import { NewProjectForm } from "./new-project-form";
import { ProjectControls } from "./project-controls";

export default async function DashboardPage() {
  const user = await requireUser();
  const db = getDb();
  const canEdit = meetsRole(user.role, "editor");
  const projects = await listProjects(db, actorFrom(user));
  const names = await getUserNames(db, projects.map((project) => actorUserId(project.updatedBy)));

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
      {canEdit && <NewProjectForm />}
      {projects.length === 0 ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">No projects yet.</p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <li
              key={project.id}
              className="flex flex-col rounded-lg border border-black/10 dark:border-white/15"
            >
              <Link
                href={`/editor/${project.id}`}
                className="flex flex-col gap-2 rounded-t-lg p-4 hover:bg-black/[.03] focus-visible:outline-2 focus-visible:outline-foreground dark:hover:bg-white/[.05]"
              >
                <span className="font-medium">{project.name}</span>
                <span className="w-fit rounded-full bg-black/[.06] px-2 py-0.5 text-xs dark:bg-white/[.1]">
                  {FORMAT_PRESETS[project.format].label}
                </span>
                <span className="text-xs text-zinc-600 dark:text-zinc-400">
                  updated by {displayActor(project.updatedBy, names)} · {timeAgo(project.updatedAt)}
                </span>
              </Link>
              {canEdit && (
                <div className="border-t border-black/10 p-3 dark:border-white/15">
                  <ProjectControls id={project.id} name={project.name} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
