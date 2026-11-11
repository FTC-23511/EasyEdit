"use client";

import { useId, useRef, type KeyboardEvent } from "react";
import { FADE, FOCUS_RING, cx } from "./cx";

export type TabsProps = {
  label: string;
  value: string;
  tabs: { id: string; label: string }[];
  onChange(id: string): void;
  idPrefix?: string; // given: each tab controls the panel with id tabIds(idPrefix, id).panel
  className?: string;
};

// The ids that link a tab and the one panel the caller renders under the tabs. Every tab controls
// that panel; the panel takes its name from the tab that is showing.
export function tabIds(idPrefix: string, tabId: string): { tab: string; panel: string } {
  return { tab: `${idPrefix}-tab-${tabId}`, panel: `${idPrefix}-panel` };
}

const KEY_MOVES: Record<string, (index: number, count: number) => number> = {
  ArrowRight: (i, n) => (i + 1) % n,
  ArrowLeft: (i, n) => (i - 1 + n) % n,
  Home: () => 0,
  End: (_, n) => n - 1,
};

// A row of tabs. The arrow keys, Home and End move to a tab and show it. The caller renders the
// panel: role="tabpanel", with id and aria-labelledby from tabIds(idPrefix, value).
export function Tabs({ label, value, tabs, onChange, idPrefix, className }: TabsProps) {
  const ownPrefix = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const current = tabs.findIndex((t) => t.id === value);
  const tabStop = current === -1 ? 0 : current;

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const move = KEY_MOVES[event.key];
    if (!move) return;
    event.preventDefault();
    const next = move(index, tabs.length);
    buttons.current[next]?.focus();
    if (tabs[next].id !== value) onChange(tabs[next].id);
  }

  return (
    <div role="tablist" aria-label={label} className={cx("flex min-w-0 items-center gap-1", className)}>
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          ref={(el) => {
            buttons.current[index] = el;
          }}
          id={tabIds(idPrefix ?? ownPrefix, tab.id).tab}
          type="button"
          role="tab"
          aria-controls={idPrefix === undefined ? undefined : tabIds(idPrefix, tab.id).panel}
          aria-selected={tab.id === value}
          tabIndex={index === tabStop ? 0 : -1}
          className={cx(
            "h-7 truncate rounded-md px-3 text-xs font-medium text-ed-muted select-none hover:bg-ed-hover hover:text-ed-text",
            "aria-selected:bg-ed-accent-weak aria-selected:text-ed-accent aria-selected:hover:bg-ed-accent-weak aria-selected:hover:text-ed-accent",
            FOCUS_RING,
            FADE,
          )}
          onClick={() => {
            if (tab.id !== value) onChange(tab.id);
          }}
          onKeyDown={(event) => handleKeyDown(event, index)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
