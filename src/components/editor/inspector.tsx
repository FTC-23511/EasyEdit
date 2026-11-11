"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DISABLED, FADE, FOCUS_RING_INSET, cx } from "@/components/ui/cx";
import { Field } from "@/components/ui/field";
import { NumberInput } from "@/components/ui/number-input";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { TextArea } from "@/components/ui/text-area";
import { TextInput } from "@/components/ui/text-input";
import { Toggle } from "@/components/ui/toggle";
import { removeTrack, renameTrack, toggleTrack } from "@/lib/editor/actions";
import { trackToggles } from "@/lib/editor/geometry";
import {
  FIELD_LABEL,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  WEIGHTS,
  clipFieldOps,
  clipFieldValue,
  parseNumber,
  type ClipField,
} from "@/lib/editor/inspector-fields";
import { explainOpError } from "@/lib/editor/messages";
import { TRACK_KIND_LABEL } from "@/lib/editor/placement";
import { findClip, viewDoc, type EditorStore } from "@/lib/editor/store";
import { LIMITS } from "@/lib/limits";
import { FORMAT_PRESETS, docDuration, type Clip, type FormatId, type Op, type OpInput, type Track } from "@/lib/timeline";
import { useEditor, useEditorStore } from "./context";
import { Timecode } from "./timecode";

const TEXT = "text-[13px] leading-5";
const CAPTION = "text-xs font-medium text-ed-muted";

const MEDIA_TITLE: Record<Exclude<Clip["type"], "text">, string> = {
  video: "Video clip",
  image: "Image",
  audio: "Audio clip",
};

const ALIGN_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "center", label: "Center" },
  { value: "right", label: "Right" },
] as const;

type Align = (typeof ALIGN_OPTIONS)[number]["value"];

const HEX = /^#[0-9a-f]{6}$/; // what a color input accepts

// The ops that set a field of the clip as the store holds it now (not as a live gesture shows it):
// null when the input is not valid, [] when it changes nothing.
function fieldOps(store: EditorStore, clipId: string, field: ClipField, raw: string) {
  const { doc } = store.getState();
  const found = findClip(doc, clipId);
  return found ? clipFieldOps(found.clip, field, raw, doc.fps) : null;
}

// Ends a field's edit the way leaving it does. The field's own live gesture is saved as one change;
// the store refuses one that does not apply, with its own message. A value that could not be turned
// into a change is reported, unless the clip is gone. Anything else (no draft, or a gesture the
// store already ended) is nothing to do.
function finishField(store: EditorStore, clipId: string, field: ClipField, own: Op[] | null, refused: boolean) {
  const state = store.getState();
  if (own !== null && state.gesture?.ops === own) state.commitGesture(FIELD_LABEL[field]);
  else if (refused && findClip(state.doc, clipId)) state.notify("error", explainOpError("INVALID"));
}

// One field's live gesture: the ops it last previewed (as the store holds them, so a gesture this
// field did not start is never saved under its label) and whether that preview was refused. When
// the field goes away mid-edit, for example because the selection changed before it lost focus,
// the edit is finished as if the field had been left.
function useFieldGesture(store: EditorStore, clipId: string, field: ClipField) {
  const own = useRef<Op[] | null>(null);
  const refused = useRef(false);
  const [live, setLive] = useState<Op[] | null>(null); // own, for rendering

  function remember(ops: Op[] | null, wasRefused: boolean) {
    own.current = ops;
    refused.current = wasRefused;
    setLive(ops);
  }

  useEffect(() => () => finishField(store, clipId, field, own.current, refused.current), [store, clipId, field]);

  return {
    live,
    preview(ops: OpInput[] | null) {
      const change = ops !== null && ops.length > 0 ? ops : null;
      const applies = store.getState().setGesture(change);
      remember(change ? (store.getState().gesture?.ops ?? null) : null, ops === null || !applies);
    },
    finish() {
      finishField(store, clipId, field, own.current, refused.current);
      remember(null, false);
    },
    drop() {
      const state = store.getState();
      if (own.current !== null && state.gesture?.ops === own.current) state.setGesture(null);
      remember(null, false);
    },
  };
}

// Select, Segmented and Toggle change the project at once.
function editField(store: EditorStore, clipId: string, field: ClipField, raw: string) {
  const ops = fieldOps(store, clipId, field, raw);
  if (ops && ops.length > 0) store.getState().edit(ops, FIELD_LABEL[field]);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-sm leading-5 font-semibold text-ed-text">{title}</h2>
      {children}
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p className={cx(TEXT, "text-ed-muted")}>{children}</p>;
}

// A number field of the clip. Typing previews the change; Enter, blur or an arrow key saves it.
function NumberField(props: {
  clipId: string;
  field: ClipField;
  label: string;
  suffix: string;
  min?: number;
  max?: number;
  step?: number;
}) {
  const { clipId, field, label, suffix, ...rest } = props;
  const store = useEditorStore();
  const canEdit = useEditor((s) => s.canEdit);
  const box = useRef<HTMLInputElement>(null);
  const gesture = useFieldGesture(store, clipId, field);
  const { live } = gesture;
  // While the field previews its own value, it is given the saved value, so a commit compares what
  // was typed with what is stored. Otherwise it follows the view, such as a drag on the timeline.
  const shown = useEditor((s) => {
    const doc = live !== null && s.gesture?.ops === live ? s.doc : viewDoc(s);
    const found = findClip(doc, clipId);
    return found ? clipFieldValue(found.clip, field, doc.fps) : "";
  });

  // NumberInput reads the box with Number(), which also takes "0x10" and "1e2"; only plain decimals count.
  function typedIsPlain(): boolean {
    let text = box.current?.value.trim() ?? "";
    if (text.endsWith(suffix)) text = text.slice(0, -suffix.length);
    return parseNumber(text) !== null;
  }

  return (
    <Field label={label}>
      {/* The unit sits inside the label, so the field is named on its own. */}
      <NumberInput
        ref={box}
        ariaLabel={label}
        data-edit-control
        disabled={!canEdit}
        value={Number(shown)}
        suffix={suffix}
        onPreview={(v) => {
          if (v === null || !typedIsPlain()) gesture.drop();
          else gesture.preview(fieldOps(store, clipId, field, String(v)));
        }}
        onCommit={(v) => {
          const ops = typedIsPlain() ? fieldOps(store, clipId, field, String(v)) : null;
          if (ops === null) {
            gesture.drop();
            store.getState().notify("error", explainOpError("INVALID"));
            return;
          }
          // Previewed again before saving: the committed value may have been clamped.
          gesture.preview(ops);
          gesture.finish();
        }}
        {...rest}
      />
    </Field>
  );
}

// A typed text field of the clip. What was typed is kept as a draft and previewed; blur or Enter
// saves it and Escape drops it. A refused value is reported on save, and the field then shows the
// document's value again.
function useTextField(store: EditorStore, clipId: string, field: ClipField, shown: string) {
  const [draft, setDraft] = useState<string | null>(null);
  const gesture = useFieldGesture(store, clipId, field);

  function change(raw: string) {
    setDraft(raw);
    gesture.preview(fieldOps(store, clipId, field, raw));
  }

  function save() {
    if (draft === null) return;
    setDraft(null);
    gesture.finish();
  }

  // Returns whether there was a draft to drop.
  function cancel(): boolean {
    if (draft === null) return false;
    setDraft(null);
    gesture.drop();
    return true;
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>, multiline = false) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !(multiline && event.shiftKey)) {
      event.preventDefault();
      save();
    } else if (event.key === "Escape" && cancel()) {
      event.preventDefault();
    }
  }

  return { value: draft ?? shown, change, save, onKeyDown };
}

// The native color input previews while the picker moves and saves when it closes.
function ColorField({ clip, fps, canEdit }: { clip: Clip; fps: number; canEdit: boolean }) {
  const store = useEditorStore();
  const swatch = useRef<HTMLInputElement>(null);
  const shown = clipFieldValue(clip, "color", fps);
  const hex = useTextField(store, clip.id, "color", shown);
  const picked = useFieldGesture(store, clip.id, "color");

  // React's onChange follows the input event, so the closing change event is listened for here,
  // afresh after each render so it sees this render's gesture.
  useEffect(() => {
    const input = swatch.current;
    if (!input) return;
    function onChange() {
      if (!input) return;
      // Previewed again first, so the save never depends on which handler ran first.
      picked.preview(fieldOps(store, clip.id, "color", input.value));
      picked.finish();
    }
    input.addEventListener("change", onChange);
    return () => input.removeEventListener("change", onChange);
  });

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className={CAPTION}>Color</span>
      <div className="flex min-w-0 gap-2">
        <input
          ref={swatch}
          type="color"
          aria-label="Color"
          data-edit-control
          disabled={!canEdit}
          value={HEX.test(shown) ? shown : "#000000"}
          onChange={(event) => {
            // The closing change event is saved by the listener above.
            if (event.nativeEvent.type === "change") return;
            picked.preview(fieldOps(store, clip.id, "color", event.target.value));
          }}
          className={cx(
            "h-7 w-9 shrink-0 cursor-pointer rounded-md border border-ed-line-strong bg-ed-raised p-0.5",
            "[&::-moz-color-swatch]:rounded-[4px] [&::-moz-color-swatch]:border-none [&::-webkit-color-swatch]:rounded-[4px] [&::-webkit-color-swatch]:border-none [&::-webkit-color-swatch-wrapper]:p-0",
            FOCUS_RING_INSET,
            FADE,
            DISABLED,
          )}
        />
        <TextInput
          aria-label="Hex color"
          data-edit-control
          disabled={!canEdit}
          maxLength={7}
          spellCheck={false}
          autoComplete="off"
          className="font-mono"
          value={hex.value}
          onChange={(event) => hex.change(event.target.value)}
          onBlur={hex.save}
          onKeyDown={(event) => hex.onKeyDown(event)}
        />
      </div>
    </div>
  );
}

function TextSection({ clip, fps, canEdit }: { clip: Clip; fps: number; canEdit: boolean }) {
  const store = useEditorStore();
  const text = useTextField(store, clip.id, "text", clipFieldValue(clip, "text", fps));
  if (clip.type !== "text") return null;
  const weight = clip.style.fontWeight;
  const weights = WEIGHTS.some((w) => w.value === weight) ? WEIGHTS : [...WEIGHTS, { value: weight, label: String(weight) }];

  return (
    <Section title="Text">
      <Field label="Text">
        <TextArea
          data-edit-control
          disabled={!canEdit}
          rows={3}
          maxLength={LIMITS.textClipChars}
          value={text.value}
          onChange={(event) => text.change(event.target.value)}
          onBlur={text.save}
          onKeyDown={(event) => text.onKeyDown(event, true)}
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <NumberField clipId={clip.id} field="fontSize" label="Size" suffix="px" min={FONT_SIZE_MIN} max={FONT_SIZE_MAX} />
        <Field label="Weight">
          <Select
            data-edit-control
            disabled={!canEdit}
            value={String(weight)}
            onChange={(event) => editField(store, clip.id, "fontWeight", event.target.value)}
          >
            {weights.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <ColorField clip={clip} fps={fps} canEdit={canEdit} />
      <div className="flex min-w-0 items-center gap-2">
        <span className={cx(CAPTION, "w-12 shrink-0")}>Align</span>
        <Segmented<Align>
          label="Align"
          data-edit-control
          disabled={!canEdit}
          className="flex-1"
          value={clip.style.align}
          options={[...ALIGN_OPTIONS]}
          onChange={(align) => editField(store, clip.id, "align", align)}
        />
      </div>
    </Section>
  );
}

function PositionSection({ clipId }: { clipId: string }) {
  return (
    <Section title="Position">
      <div className="grid grid-cols-2 gap-2">
        <NumberField clipId={clipId} field="x" label="X" suffix="%" />
        <NumberField clipId={clipId} field="y" label="Y" suffix="%" />
        <NumberField clipId={clipId} field="scale" label="Scale" suffix="%" min={1} />
        <NumberField clipId={clipId} field="rotation" label="Rotation" suffix="°" />
        <NumberField clipId={clipId} field="opacity" label="Opacity" suffix="%" min={0} max={100} />
      </div>
    </Section>
  );
}

function TimingSection({ clipId }: { clipId: string }) {
  return (
    <Section title="Timing">
      <div className="grid grid-cols-2 gap-2">
        <NumberField clipId={clipId} field="start" label="Start" suffix="s" min={0} step={0.1} />
        <NumberField clipId={clipId} field="duration" label="Length" suffix="s" min={0} step={0.1} />
      </div>
    </Section>
  );
}

function ClipInspector({ clip }: { clip: Clip }) {
  const fps = useEditor((s) => viewDoc(s).fps);
  const canEdit = useEditor((s) => s.canEdit);
  return (
    <>
      {clip.type === "text" ? (
        <TextSection clip={clip} fps={fps} canEdit={canEdit} />
      ) : (
        <h2 className="text-sm leading-5 font-semibold text-ed-text">{MEDIA_TITLE[clip.type]}</h2>
      )}
      {clip.type !== "audio" && <PositionSection clipId={clip.id} />}
      <TimingSection clipId={clip.id} />
    </>
  );
}

function clipCount(n: number): string {
  if (n === 0) return "No clips";
  return n === 1 ? "1 clip" : `${n} clips`;
}

function TrackSection({ track }: { track: Track }) {
  const store = useEditorStore();
  const canEdit = useEditor((s) => s.canEdit);
  const [draft, setDraft] = useState<string | null>(null);

  function saveName() {
    if (draft === null) return;
    setDraft(null);
    renameTrack(store, track.id, draft);
  }

  function onNameKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      saveName();
    } else if (event.key === "Escape" && draft !== null) {
      event.preventDefault();
      setDraft(null);
    }
  }

  const switches = [
    { field: "locked", label: "Locked" },
    ...trackToggles(track.kind).map((field) => ({ field, label: field === "hidden" ? "Hidden" : "Muted" })),
  ] as const;

  return (
    <Section title="Track">
      <Field label="Name">
        <TextInput
          data-edit-control
          disabled={!canEdit}
          maxLength={LIMITS.trackNameChars}
          value={draft ?? track.name}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={saveName}
          onKeyDown={onNameKeyDown}
        />
      </Field>
      {switches.map(({ field, label }) => (
        <Toggle
          key={field}
          data-edit-control
          disabled={!canEdit}
          label={label}
          checked={track[field]}
          onChange={() => toggleTrack(store, track.id, field)}
        />
      ))}
      <p className={cx(TEXT, "text-ed-muted")}>
        {TRACK_KIND_LABEL[track.kind]} · {clipCount(track.clips.length)}
      </p>
      <div className="flex flex-col items-start gap-1">
        <Button
          variant="danger"
          data-edit-control
          disabled={!canEdit || track.locked}
          onClick={() => removeTrack(store, track.id)}
        >
          Remove track
        </Button>
        {track.locked && <Hint>Unlock the track to remove it.</Hint>}
      </div>
    </Section>
  );
}

const FORMATS = Object.entries(FORMAT_PRESETS) as [FormatId, (typeof FORMAT_PRESETS)[FormatId]][];

function ProjectSection() {
  const store = useEditorStore();
  const canEdit = useEditor((s) => s.canEdit);
  const format = useEditor((s) => viewDoc(s).format);
  const fps = useEditor((s) => viewDoc(s).fps);
  const length = useEditor((s) => docDuration(viewDoc(s)));

  return (
    <>
      <Section title="Project">
        <Field label="Format">
          <Select
            data-edit-control
            disabled={!canEdit}
            value={format}
            onChange={(event) => store.getState().edit([{ op: "set_format", format: event.target.value as FormatId }], "format change")}
          >
            {FORMATS.map(([id, preset]) => (
              <option key={id} value={id}>
                {preset.label} ({preset.width} × {preset.height})
              </option>
            ))}
          </Select>
        </Field>
        <p className={cx(TEXT, "text-ed-muted")}>{fps} fps</p>
        <p className={cx(TEXT, "text-ed-muted")}>
          Length <Timecode frame={length} fps={fps} />
        </p>
      </Section>
      <Hint>Select a clip to edit it.</Hint>
    </>
  );
}

// The settings of what is selected: one clip, several clips, a track, or else the project.
export function Inspector() {
  const count = useEditor((s) => s.selection.clipIds.length);
  const clip = useEditor((s) => {
    const ids = s.selection.clipIds;
    return ids.length === 1 ? (findClip(viewDoc(s), ids[0])?.clip ?? null) : null;
  });
  const track = useEditor((s) => {
    const id = s.selection.trackId;
    return id === null ? null : (viewDoc(s).tracks.find((t) => t.id === id) ?? null);
  });

  let body: ReactNode;
  if (clip) body = <ClipInspector key={clip.id} clip={clip} />;
  else if (count > 1) {
    body = (
      <>
        <p className={cx(TEXT, "font-medium text-ed-text")}>{count} clips selected</p>
        <Hint>Select one clip to edit it.</Hint>
      </>
    );
  } else if (track) body = <TrackSection key={track.id} track={track} />;
  else body = <ProjectSection />;

  return <div className="flex flex-col gap-4 p-3">{body}</div>;
}
