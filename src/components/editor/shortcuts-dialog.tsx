"use client";

import { Fragment } from "react";
import { Dialog } from "@/components/ui/dialog";
import { SHORTCUTS, keyLabel, type Shortcut } from "@/lib/editor/shortcuts";
import { useIsMac } from "./use-shortcuts";

const GROUPS: Shortcut["group"][] = ["Playback", "Editing", "Timeline", "General"];

// Every shortcut, by group, straight from the shortcut table.
export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const isMac = useIsMac();

  return (
    <Dialog title="Keyboard shortcuts" open={open} onClose={onClose}>
      <div className="flex flex-col gap-4">
        {GROUPS.map((group) => (
          <section key={group} className="flex flex-col gap-1">
            <h3 className="text-sm leading-5 font-semibold text-ed-text">{group}</h3>
            <ul className="flex flex-col">
              {SHORTCUTS.filter((s) => s.group === group).map((shortcut) => (
                <li key={shortcut.command} className="flex min-h-7 items-center justify-between gap-4">
                  <span className="min-w-0 text-ed-text">{shortcut.label}</span>
                  <span className="flex shrink-0 items-center gap-1 text-xs text-ed-muted">
                    {shortcut.keys.map((keys, i) => (
                      <Fragment key={keys}>
                        {i > 0 && <span>or</span>}
                        <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-[4px] border border-ed-line bg-ed-raised px-1.5 font-sans text-[11px] leading-4 font-medium text-ed-text">
                          {keyLabel(keys, isMac)}
                        </kbd>
                      </Fragment>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
