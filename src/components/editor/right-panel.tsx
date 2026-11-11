"use client";

import { useId, useState } from "react";
import { Tabs, tabIds } from "@/components/ui/tabs";
import { ActivityPanel } from "./activity-panel";
import { Inspector } from "./inspector";

const TABS = [
  { id: "inspect", label: "Inspect" },
  { id: "activity", label: "Activity" },
];

export function RightPanel() {
  const [tab, setTab] = useState("inspect");
  const current = TABS.find((t) => t.id === tab) ?? TABS[0];
  const idPrefix = useId();
  const ids = tabIds(idPrefix, current.id);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center border-b border-ed-line px-3">
        <Tabs label="Details" value={current.id} tabs={TABS} onChange={setTab} idPrefix={idPrefix} />
      </div>
      <div id={ids.panel} role="tabpanel" aria-labelledby={ids.tab} className="min-h-0 flex-1 overflow-y-auto">
        {current.id === "inspect" ? <Inspector /> : <ActivityPanel />}
      </div>
    </div>
  );
}
