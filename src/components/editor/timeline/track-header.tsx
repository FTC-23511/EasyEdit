"use client";

import { Ellipsis, Eye, EyeOff, Lock, LockOpen, Volume2, VolumeX } from "lucide-react";
import { memo, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { FADE, FOCUS_RING, cx } from "@/components/ui/cx";
import { IconButton } from "@/components/ui/icon-button";
import { Menu, type MenuItem } from "@/components/ui/menu";
import { TextInput } from "@/components/ui/text-input";
import { removeTrack, renameTrack, reorderTrack, toggleTrack } from "@/lib/editor/actions";
import { reorderTrackOps } from "@/lib/editor/commands";
import { HEADER_WIDTH, trackToggles } from "@/lib/editor/geometry";
import { LIMITS } from "@/lib/limits";
import type { Track } from "@/lib/timeline";
import { useEditor, useEditorStore } from "../context";

// Each switch keeps one name, for what it turns on, and shows with aria-pressed whether it is on.
const SWITCHES = {
  hidden: { label: "Hide track", OnIcon: EyeOff, OffIcon: Eye },
  muted: { label: "Mute track", OnIcon: VolumeX, OffIcon: Volume2 },
} as const;

// The name of a track and its switches, stuck to the left of its row. The accent tint is a
// background image over the opaque fill, because the clips scroll underneath. While the options
// menu is open the header rises above the ruler, so a menu that opens upwards is not covered.
export const TrackHeader = memo(function TrackHeader({ track, selected }: { track: Track; selected: boolean }) {
  const store = useEditorStore();
  const selectTrack = useEditor((s) => s.selectTrack);
  const canEdit = useEditor((s) => s.canEdit);
  const canMoveUp = useEditor((s) => reorderTrackOps(s.doc, track.id, "up").length > 0);
  const canMoveDown = useEditor((s) => reorderTrackOps(s.doc, track.id, "down").length > 0);
  const [editing, setEditing] = useState(false);
  const renaming = editing && canEdit;
  const nameButton = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const finished = useRef(false); // Enter or Escape already ended this rename
  const refocus = useRef(false);

  useEffect(() => {
    if (renaming) {
      nameInput.current?.focus();
      nameInput.current?.select();
    } else if (refocus.current) {
      refocus.current = false;
      nameButton.current?.focus();
    }
  }, [renaming]);

  function startRename() {
    finished.current = false;
    setEditing(true);
  }

  function endRename(save: boolean, byKey: boolean) {
    if (finished.current) return;
    finished.current = true;
    refocus.current = byKey;
    if (save && nameInput.current) renameTrack(store, track.id, nameInput.current.value);
    setEditing(false);
  }

  function onNameKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" && event.key !== "Escape") return;
    event.preventDefault();
    endRename(event.key === "Enter", true);
  }

  const items: MenuItem[] = [
    { id: "rename", label: "Rename" },
    { id: "up", label: "Move up", disabled: !canMoveUp },
    { id: "down", label: "Move down", disabled: !canMoveDown },
    track.locked
      ? { id: "remove", label: "Remove track (unlock first)", danger: true, disabled: true }
      : { id: "remove", label: "Remove track", danger: true },
  ];

  function onMenuSelect(id: string) {
    if (id === "rename") startRename();
    else if (id === "up" || id === "down") reorderTrack(store, track.id, id);
    else if (id === "remove") removeTrack(store, track.id);
  }

  return (
    <div
      className={cx(
        "sticky left-0 z-20 flex shrink-0 items-center gap-1 border-r border-ed-line bg-ed-raised px-2 has-[[aria-expanded=true]]:z-40",
        selected && "bg-linear-to-r from-ed-accent-weak to-ed-accent-weak",
        FADE,
      )}
      style={{ width: HEADER_WIDTH }}
    >
      {renaming ? (
        <TextInput
          ref={nameInput}
          data-edit-control
          disabled={!canEdit}
          aria-label="Track name"
          defaultValue={track.name}
          maxLength={LIMITS.trackNameChars}
          onKeyDown={onNameKeyDown}
          onBlur={() => endRename(true, false)}
        />
      ) : (
        <>
          <button
            ref={nameButton}
            type="button"
            title={track.name}
            aria-current={selected ? "true" : undefined}
            onClick={() => selectTrack(track.id)}
            className={cx(
              "h-7 min-w-0 flex-1 truncate rounded-md px-1.5 text-left text-xs leading-4 font-medium",
              selected ? "text-ed-accent" : "text-ed-text hover:bg-ed-hover",
              FOCUS_RING,
              FADE,
            )}
          >
            {track.name}
          </button>
          <IconButton
            data-edit-control
            disabled={!canEdit}
            label="Lock track"
            pressed={track.locked}
            onClick={() => toggleTrack(store, track.id, "locked")}
          >
            {track.locked ? <Lock /> : <LockOpen />}
          </IconButton>
          {trackToggles(track.kind).map((field) => {
            const { label, OnIcon, OffIcon } = SWITCHES[field];
            return (
              <IconButton
                key={field}
                data-edit-control
                disabled={!canEdit}
                label={label}
                pressed={track[field]}
                onClick={() => toggleTrack(store, track.id, field)}
              >
                {track[field] ? <OnIcon /> : <OffIcon />}
              </IconButton>
            );
          })}
          <Menu
            data-edit-control
            disabled={!canEdit}
            label="Track options"
            icon={<Ellipsis />}
            items={items}
            onSelect={onMenuSelect}
          />
        </>
      )}
    </div>
  );
});
