"use client";

import { Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent, type HTMLAttributes } from "react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Segmented } from "@/components/ui/segmented";
import { TextInput } from "@/components/ui/text-input";
import { LIMITS } from "@/lib/limits";
import type { MediaFailure, MediaResult } from "@/lib/media/api";
import { visibleAssets } from "@/lib/media/library-store";
import { MEDIA_MESSAGES } from "@/lib/media/messages";
import type { AssetKind, AssetView, UploadItem } from "@/lib/media/types";
import { useEditor, useEditorStore } from "../context";
import { AssetTile, type AssetAction, type WatchView } from "./asset-tile";
import { useLibrary, useMedia } from "./media-context";
import { UploadRow } from "./upload-row";

const ACCEPT = ".mp4,.m4v,.mov,.webm,.jpg,.jpeg,.png,.webp,.mp3,.m4a,.wav,.aac";

const KINDS: { value: AssetKind | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "video", label: "Video" },
  { value: "image", label: "Images" },
  { value: "audio", label: "Audio" },
];

// A finished upload with nothing to say is not shown. The queue keeps it; nothing dismisses it.
const shownUpload = (item: UploadItem) => item.stage !== "done" || item.message !== null;

// What a change the server did not make reads as, in the server's words when it gave some.
function refusalOf(answer: MediaFailure): string {
  if (answer.message !== "") return answer.message;
  return answer.kind === "network" ? MEDIA_MESSAGES.noAnswer : MEDIA_MESSAGES.tryAgain;
}

// Whether a drag carries files from the computer, and not text or a clip of this page.
const carriesFiles = (event: DragEvent) => [...(event.dataTransfer?.types ?? [])].includes("Files");

// One IntersectionObserver for the rows of the tab's scrolling panel, so that a row reads its still picture only
// once it has been scrolled into view. Without one, every row counts as in view.
function useRowsInView() {
  const scroller = useRef<HTMLDivElement>(null);
  const watched = useRef(new Map<Element, (inView: boolean) => void>());
  const observer = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const rows = watched.current;
    const seen = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) rows.get(entry.target)?.(entry.isIntersecting);
      },
      { root: scroller.current },
    );
    observer.current = seen;
    for (const row of rows.keys()) seen.observe(row); // rows that came before the observer
    return () => {
      seen.disconnect();
      observer.current = null;
    };
  }, []);

  const watch = useCallback<WatchView>((element, onChange) => {
    if (typeof IntersectionObserver === "undefined") {
      onChange(true);
      return () => {};
    }
    watched.current.set(element, onChange);
    observer.current?.observe(element);
    return () => {
      watched.current.delete(element);
      observer.current?.unobserve(element);
    };
  }, []);

  return { scroller, watch };
}

export type PanelProps = Pick<HTMLAttributes<HTMLDivElement>, "id" | "role" | "aria-labelledby">;

type MediaTabProps = {
  panel: PanelProps; // the tab panel's id, role and label, from the left panel
  onAdd?: (asset: AssetView) => void; // a row's click
};

// The Media tab of the left panel: upload, the uploads under way, search and the library. The whole tab takes
// dropped files.
export function MediaTab({ panel, onAdd }: MediaTabProps) {
  const { library, queue } = useMedia();
  const store = useEditorStore();
  const canEdit = useEditor((s) => s.canEdit);
  const { loaded, setUp, problem, query, kind, uploadEvent } = useLibrary(
    useShallow((s) => ({ loaded: s.loaded, setUp: s.setUp, problem: s.problem, query: s.query, kind: s.kind, uploadEvent: s.uploadEvent })),
  );
  const uploads = useLibrary(useShallow((s) => s.uploads.filter(shownUpload)));
  const assets = useLibrary(useShallow(visibleAssets));
  const hasAny = useLibrary((s) => Object.values(s.assets).some((asset) => asset.status === "ready" && !asset.removed));
  const canUpload = canEdit && setUp;
  const picker = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState<{ action: AssetAction; asset: AssetView } | null>(null);
  const { scroller, watch } = useRowsInView();

  // The library is fetched when the tab opens, and again after each refused edit while it is open: an asset that a
  // teammate removed is then gone from the list, so a second click cannot repeat the refusal.
  useEffect(() => {
    const refresh = () => void library.getState().refresh("tab").catch(() => {});
    refresh();
    return store.subscribe((state, before) => {
      if (state.notice && state.notice.tone === "error" && state.notice.id !== before.notice?.id) refresh();
    });
  }, [library, store]);

  const onAction = useCallback((action: AssetAction, asset: AssetView) => setEditing({ action, asset }), []);

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    if (!carriesFiles(event)) return;
    event.preventDefault(); // a file dropped here never opens in the window
    event.dataTransfer.dropEffect = canUpload ? "copy" : "none";
    if (canUpload) setDragging(true);
  }

  function onDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    setDragging(false);
    const files = [...event.dataTransfer.files];
    if (canUpload && files.length > 0) queue.add(files);
  }

  return (
    <div
      {...panel}
      className={cx("relative min-h-0 flex-1", dragging && "outline-2 -outline-offset-2 outline-ed-accent")}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div ref={scroller} className="flex h-full flex-col gap-3 overflow-y-auto p-3">
        <div className="flex flex-col gap-2">
          <Button variant="primary" data-edit-control disabled={!canUpload} className="w-full" onClick={() => picker.current?.click()}>
            <Upload />
            Upload
          </Button>
          <input
            ref={picker}
            type="file"
            multiple
            accept={ACCEPT}
            hidden
            tabIndex={-1}
            disabled={!canUpload}
            onChange={(event) => {
              const files = [...(event.currentTarget.files ?? [])];
              event.currentTarget.value = ""; // so that the same file can be chosen again
              if (canUpload && files.length > 0) queue.add(files);
            }}
          />
          <Field label="Event for new uploads">
            <TextInput
              data-edit-control
              disabled={!canUpload}
              placeholder="Qualifier 2026-11-08"
              maxLength={LIMITS.mediaEventChars}
              value={uploadEvent}
              onChange={(event) => library.getState().setUploadEvent(event.target.value)}
            />
          </Field>
          {!setUp && <p className="text-[13px] leading-5 text-ed-muted">{MEDIA_MESSAGES.notSetUp}</p>}
        </div>

        {uploads.length > 0 && (
          <ul aria-label="Uploads" className="flex flex-col gap-1">
            {uploads.map((item) => (
              <UploadRow
                key={item.key}
                item={item}
                canEdit={canEdit}
                onCancel={(key) => queue.cancel(key)}
                onRetry={(key) => queue.retry(key)}
                onDismiss={(key) => queue.dismiss(key)}
              />
            ))}
          </ul>
        )}

        <div className="flex flex-col gap-2">
          <TextInput type="search" aria-label="Search media" placeholder="Search" value={query} onChange={(event) => library.getState().setQuery(event.target.value)} />
          <Segmented label="Kind" value={kind} options={KINDS} onChange={(value) => library.getState().setKind(value)} />
        </div>

        {problem === "signed-out" ? (
          <p className="text-[13px] leading-5 text-ed-muted">{MEDIA_MESSAGES.signedOutLibrary}</p>
        ) : problem !== null ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-[13px] leading-5 text-ed-muted">{MEDIA_MESSAGES.loadFailed}</p>
            <Button size="sm" onClick={() => void library.getState().refresh("tab").catch(() => {})}>
              Try again
            </Button>
          </div>
        ) : null}

        {!loaded ? (
          problem === null && <p className="text-[13px] leading-5 text-ed-muted">{MEDIA_MESSAGES.loading}</p>
        ) : !hasAny ? (
          <p className="text-[13px] leading-5 text-ed-muted">{canEdit ? MEDIA_MESSAGES.emptyEditor : MEDIA_MESSAGES.emptyViewer}</p>
        ) : assets.length === 0 ? (
          <p className="text-[13px] leading-5 text-ed-muted">{MEDIA_MESSAGES.noMatch}</p>
        ) : (
          <ul aria-label="Media" className="-mx-1 flex flex-col">
            {assets.map((asset) => (
              <AssetTile key={asset.id} asset={asset} canEdit={canEdit} watch={watch} onAdd={onAdd} onAction={onAction} />
            ))}
          </ul>
        )}
      </div>

      {dragging && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-ed-bg/80">
          <p className="text-sm font-medium text-ed-text">Drop to upload</p>
        </div>
      )}

      <AssetDialog editing={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

const TITLES: Record<AssetAction, (name: string) => string> = {
  rename: () => "Rename",
  event: () => "Set event",
  remove: (name) => `Remove "${name}"?`,
};

// Rename, Set event and Remove. Each changes the asset through the library store; a refusal is shown in the dialog.
function AssetDialog({ editing, onClose }: { editing: { action: AssetAction; asset: AssetView } | null; onClose(): void }) {
  const { library } = useMedia();
  return (
    <Dialog title={editing ? TITLES[editing.action](editing.asset.name) : ""} open={editing !== null} onClose={onClose}>
      {editing?.action === "rename" && (
        <ValueForm
          key={editing.asset.id}
          label="Name"
          initial={editing.asset.name}
          maxLength={LIMITS.mediaNameChars}
          save={(name) => library.getState().rename(editing.asset.id, name)}
          onClose={onClose}
        />
      )}
      {editing?.action === "event" && (
        <ValueForm
          key={editing.asset.id}
          label="Event"
          initial={editing.asset.event ?? ""}
          maxLength={LIMITS.mediaEventChars}
          save={(event) => library.getState().setEvent(editing.asset.id, event.trim() === "" ? null : event)}
          onClose={onClose}
        />
      )}
      {editing?.action === "remove" && <RemoveForm key={editing.asset.id} remove={() => library.getState().remove(editing.asset.id)} onClose={onClose} />}
    </Dialog>
  );
}

type ValueFormProps = { label: string; initial: string; maxLength: number; save(value: string): Promise<MediaResult<unknown>>; onClose(): void };

// One field, Save and Cancel. Save closes the dialog once the server has taken the change.
function ValueForm({ label, initial, maxLength, save, onClose }: ValueFormProps) {
  const [value, setValue] = useState(initial);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    const answer = await save(value);
    setSaving(false);
    if (answer.ok) onClose();
    else setRefusal(refusalOf(answer));
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={onSubmit}>
      <Field label={label}>
        <TextInput autoFocus value={value} maxLength={maxLength} onChange={(event) => setValue(event.target.value)} />
      </Field>
      {refusal && (
        <p role="alert" className="text-ed-danger">
          {refusal}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={saving}>
          Save
        </Button>
      </div>
    </form>
  );
}

// Remove asks first. A refusal (the asset is in use) takes the place of the question, and only Close is left.
function RemoveForm({ remove, onClose }: { remove(): Promise<MediaResult<object>>; onClose(): void }) {
  const [refusal, setRefusal] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  async function onRemove() {
    if (removing) return;
    setRemoving(true);
    const answer = await remove();
    setRemoving(false);
    if (answer.ok) onClose();
    else setRefusal(refusalOf(answer));
  }

  if (refusal !== null) {
    return (
      <div className="flex flex-col gap-3">
        <p role="alert">{refusal}</p>
        <div className="flex justify-end">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p>The file moves to the Drive trash for 30 days.</p>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="danger" disabled={removing} onClick={onRemove}>
          Remove
        </Button>
      </div>
    </div>
  );
}
