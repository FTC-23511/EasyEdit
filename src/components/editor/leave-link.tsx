"use client";

import Link from "next/link";
import type { ComponentProps, MouseEvent } from "react";
import { useEditorStore } from "./context";
import { useMedia } from "./media/media-context";

type LeaveLinkProps = Omit<ComponentProps<typeof Link>, "href" | "onClick"> & { href: string };

// A link out of the editor. It navigates inside the app, and the edits still queued are sent
// after the editor closes. When they cannot be sent now (offline, signed out, a send that
// failed), it loads the page for real instead, so the browser asks before they are lost.
// Edits to a project that was deleted can never be saved, so leaving it asks nothing about them.
// Leaving stops the uploads that are running, so while one runs the page is loaded for real too.
export function LeaveLink({ href, ...props }: LeaveLinkProps) {
  const store = useEditorStore();
  const { queue: uploads } = useMedia();

  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    // A click that opens another tab or window leaves this one as it is.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const { queue, status } = store.getState();
    const editsAtRisk = queue.length > 0 && status !== "saving" && status !== "deleted";
    if (!editsAtRisk && uploads.active() === 0) return;
    event.preventDefault();
    window.location.assign(href);
  }

  return <Link {...props} href={href} onClick={onClick} />;
}
