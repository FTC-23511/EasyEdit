"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, tabIds } from "@/components/ui/tabs";
import { addText } from "@/lib/editor/actions";
import { TEXT_PRESETS } from "@/lib/editor/text-presets";
import { useEditor, useEditorStore } from "./context";

const TABS = [
  { id: "text", label: "Text" },
  { id: "media", label: "Media" },
];

function TextTab() {
  const store = useEditorStore();
  const canEdit = useEditor((s) => s.canEdit);
  return (
    <div className="flex flex-col gap-2 p-3">
      {TEXT_PRESETS.map((preset) => (
        <Button
          key={preset.id}
          data-edit-control
          disabled={!canEdit}
          aria-label={`Add ${preset.label.toLowerCase()}`}
          className="w-full justify-start"
          style={{ fontWeight: Math.min(preset.fontWeight, 600) }}
          onClick={() => addText(store, preset)}
        >
          {preset.label}
        </Button>
      ))}
      <p className="text-[13px] leading-5 text-ed-muted">Adds at the playhead.</p>
    </div>
  );
}

function MediaTab() {
  return (
    <div className="flex h-full items-center justify-center p-3 text-center">
      <p className="text-[13px] leading-5 text-ed-muted">Video, images and audio will be added here in a later update.</p>
    </div>
  );
}

export function LeftPanel() {
  const [tab, setTab] = useState("text");
  const current = TABS.find((t) => t.id === tab) ?? TABS[0];
  const idPrefix = useId();
  const ids = tabIds(idPrefix, current.id);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center border-b border-ed-line px-3">
        <Tabs label="Add" value={current.id} tabs={TABS} onChange={setTab} idPrefix={idPrefix} />
      </div>
      <div id={ids.panel} role="tabpanel" aria-labelledby={ids.tab} className="min-h-0 flex-1 overflow-y-auto">
        {current.id === "text" ? <TextTab /> : <MediaTab />}
      </div>
    </div>
  );
}
