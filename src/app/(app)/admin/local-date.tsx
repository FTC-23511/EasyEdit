"use client";

import { useSyncExternalStore } from "react";
import { formatAddedDate } from "@/lib/format-date";

// The server and hydration render in UTC so they match; the browser then switches to its own time zone.
export function LocalDate({ iso }: { iso: string }) {
  const onClient = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const date = new Date(iso);
  return <time dateTime={iso}>{formatAddedDate(date, onClient ? undefined : "UTC")}</time>;
}
