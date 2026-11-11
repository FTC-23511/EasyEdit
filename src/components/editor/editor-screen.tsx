"use client";

import { useCallback, useState } from "react";
import { FOCUS_RING, cx } from "@/components/ui/cx";
import { useEditor } from "./context";
import { LeaveLink } from "./leave-link";
import { LeftPanel } from "./left-panel";
import { NoticeBar } from "./notice-bar";
import { Preview } from "./preview";
import { RightPanel } from "./right-panel";
import { ShortcutsDialog } from "./shortcuts-dialog";
import { Timeline } from "./timeline/timeline";
import { TopBar } from "./top-bar";
import { useShortcuts } from "./use-shortcuts";

const REGION = "relative min-h-0 min-w-0 overflow-hidden";

// The whole editor, drawn from the store in context. Always dark and exactly as tall as the window:
// top bar, then the add panel, preview and details side by side, then the timeline across the bottom.
// The keyboard shortcuts work anywhere in the window.
export function EditorScreen() {
  const deleted = useEditor((s) => s.status === "deleted");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const openShortcuts = useCallback(() => setShortcutsOpen(true), []);
  useShortcuts(openShortcuts);

  return (
    <div className="editor relative h-dvh overflow-hidden bg-ed-bg font-sans text-ed-text [--ed-left-w:240px] [--ed-right-w:280px] [--ed-timeline-h:clamp(220px,36vh,360px)]">
      <div className="relative hidden h-full grid-cols-[var(--ed-left-w)_minmax(0,1fr)_var(--ed-right-w)] grid-rows-[44px_minmax(0,1fr)_var(--ed-timeline-h)] gap-px bg-ed-line-strong lg:grid">
        <TopBar onShowShortcuts={openShortcuts} />
        {deleted ? (
          <main className="col-span-3 row-span-2 flex flex-col items-center justify-center gap-2 bg-ed-bg text-center">
            <p className="text-sm font-semibold">This project was deleted.</p>
            <LeaveLink
              href="/dashboard"
              className={cx("rounded-[4px] text-[13px] leading-5 text-ed-muted underline underline-offset-2 hover:text-ed-text", FOCUS_RING)}
            >
              Back to projects
            </LeaveLink>
          </main>
        ) : (
          <>
            <aside aria-label="Add" className={cx(REGION, "bg-ed-panel")}>
              <LeftPanel />
            </aside>
            <main aria-label="Preview" className={cx(REGION, "bg-ed-bg")}>
              <Preview />
            </main>
            <aside aria-label="Details" className={cx(REGION, "bg-ed-panel")}>
              <RightPanel />
            </aside>
            <section aria-label="Timeline" className={cx(REGION, "col-span-3 bg-ed-panel")}>
              <Timeline />
            </section>
            <NoticeBar />
          </>
        )}
      </div>
      <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center lg:hidden">
        <p className="text-sm font-semibold">The editor needs a wider window.</p>
        <p className="text-[13px] leading-5 text-ed-muted">Open this project on a laptop or desktop.</p>
      </div>
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}
