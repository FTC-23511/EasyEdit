"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ACTIVITY_LIMIT } from "@/lib/editor/store";
import { activityRows, hasOlderActivity, loadOlderActivity, loadRecentActivity } from "@/lib/editor/activity";
import { useEditor, useEditorApi, useEditorStore } from "./context";

type Load = "loading" | "failed" | "ready";

const NOW_REFRESH_MS = 30_000;

export function ActivityPanel() {
  const store = useEditorStore();
  const api = useEditorApi();
  const activity = useEditor((s) => s.activity);
  const me = useEditor((s) => s.me);
  const canEdit = useEditor((s) => s.canEdit);
  const serverVersion = useEditor((s) => s.server.version);
  const undoChange = useEditor((s) => s.undoChange);

  const [load, setLoad] = useState<Load>("loading");
  const [attempt, setAttempt] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderFailed, setOlderFailed] = useState(false);
  const [now, setNow] = useState(() => new Date());

  const loadNext = useRef(true); // load on the next run of the effect: set on mount and by "Try again"
  const inFlight = useRef<number | null>(null); // the server version a running load was started for
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Loads when the panel first shows and after "Try again". Later it reloads only when the project
  // moved on and the newest loaded change is behind it, once per version change.
  useEffect(() => {
    const forced = loadNext.current;
    loadNext.current = false;
    const { activity: loaded, server } = store.getState();
    const behind = (loaded.at(-1)?.version ?? 0) < server.version;
    if (!forced && !behind) return;
    if (inFlight.current === server.version) return;
    inFlight.current = server.version;
    void loadRecentActivity(api, store).then((ok) => {
      inFlight.current = null;
      if (mounted.current) setLoad(ok ? "ready" : "failed");
    });
  }, [api, store, serverVersion, attempt]);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), NOW_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  function showEarlier() {
    setLoadingOlder(true);
    void loadOlderActivity(api, store).then((ok) => {
      if (!mounted.current) return;
      setLoadingOlder(false);
      setOlderFailed(!ok);
    });
  }

  const rows = useMemo(() => activityRows(activity, me.id, now), [activity, me.id, now]);
  const byVersion = useMemo(() => new Map(activity.map((entry) => [entry.version, entry])), [activity]);

  if (rows.length === 0) {
    if (load === "loading") return <Message>Loading…</Message>;
    if (load === "failed") {
      return (
        <Message>
          <span>Couldn&apos;t load changes.</span>
          <Button
            onClick={() => {
              loadNext.current = true;
              setLoad("loading");
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </Button>
        </Message>
      );
    }
    return <Message>No changes yet.</Message>;
  }

  const older = hasOlderActivity(activity);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <ul role="list" className="flex flex-col">
        {rows.map((row) => {
          const entry = byVersion.get(row.version);
          return (
            <li key={row.version} className="flex flex-col gap-1 border-b border-ed-line px-3 py-2">
              {/* The whole summary, wrapping as it needs: the list is there to say what changed. */}
              <p className="text-[13px] leading-5 wrap-break-word text-ed-text">
                {row.who} · {row.summary}
              </p>
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] leading-4 text-ed-muted">{row.when}</p>
                {row.canUndo && canEdit && entry && (
                  <Button data-edit-control variant="ghost" size="sm" onClick={() => undoChange(entry)}>
                    Undo this change
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-col items-start gap-2 p-3">
        {olderFailed && (
          <>
            <p className="text-[13px] leading-5 text-ed-muted">Couldn&apos;t load changes.</p>
            <Button disabled={loadingOlder} onClick={showEarlier}>
              Try again
            </Button>
          </>
        )}
        {older && !olderFailed && (
          <Button disabled={loadingOlder} onClick={showEarlier}>
            Show earlier changes
          </Button>
        )}
        {!older && activity.length >= ACTIVITY_LIMIT && (
          <p className="text-[13px] leading-5 text-ed-muted">Showing the latest {ACTIVITY_LIMIT} changes.</p>
        )}
      </div>
    </div>
  );
}

function Message({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center gap-2 p-3 text-center text-[13px] leading-5 text-ed-muted">{children}</div>;
}
