import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { requireUser } from "@/lib/access";
import { getProject } from "@/lib/projects/service";
import { describe } from "@/lib/timeline";

export default async function EditorPage({ params }: PageProps<"/editor/[id]">) {
  await requireUser();
  const { id } = await params;
  const project = await getProject(getDb(), id);
  if (!project) notFound();

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">The full editor is coming soon.</p>
      <pre className="overflow-x-auto rounded-lg border border-black/10 p-4 text-sm dark:border-white/15">
        {describe(project.doc, { version: project.version })}
      </pre>
    </main>
  );
}
