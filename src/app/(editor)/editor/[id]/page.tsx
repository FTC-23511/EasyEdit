import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EditorShell } from "@/components/editor/editor-shell";
import { KeepSignedIn } from "@/components/keep-signed-in";
import { getDb } from "@/db";
import { meetsRole, requireUser } from "@/lib/access";
import { actorFrom } from "@/lib/actor";
import { getProject } from "@/lib/projects/service";

// The editor is always dark. This asks the Dark Reader browser extension to leave the page alone: on a screen that
// is already dark it darkens the few light elements, and the playhead all but disappears.
export const metadata: Metadata = { other: { "darkreader-lock": "true" } };

// The editor fills the window on its own: the (editor) group has no layout, so the site header is not drawn.
export default async function EditorPage({ params }: PageProps<"/editor/[id]">) {
  const user = await requireUser();
  const { id } = await params;
  const project = await getProject(getDb(), actorFrom(user), id);
  if (!project) notFound();

  return (
    <>
      <KeepSignedIn />
      <EditorShell
        key={project.id}
        initial={{
          projectId: project.id,
          name: project.name,
          doc: project.doc,
          version: project.version,
          me: { id: user.id, name: user.name },
          canEdit: meetsRole(user.role, "editor"),
        }}
      />
    </>
  );
}
