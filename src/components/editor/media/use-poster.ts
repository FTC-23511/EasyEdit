"use client";

import { useEffect, useState } from "react";
import type { AssetView } from "@/lib/media/types";
import { useMedia } from "./media-context";

// The still picture of an asset, as a blob address for an <img>, or null until it is here (and for audio, or an
// asset without one). It is read through `files.get` only once `inView` has been true, so a row that never scrolls
// into view reads nothing. The address is released when the row goes away or names another picture.
export function usePoster(asset: AssetView, inView: boolean): string | null {
  const { files } = useMedia();
  const [seen, setSeen] = useState(inView);
  if (inView && !seen) setSeen(true); // once seen, the picture is kept while the row is there
  const fileId = asset.kind === "audio" ? null : asset.posterFileId;
  const [shown, setShown] = useState<{ fileId: string; url: string } | null>(null);

  useEffect(() => {
    if (!seen || fileId === null) return;
    let live = true;
    let url: string | null = null;
    files.get(fileId).then(
      (got) => {
        if (!live || !got.ok) return;
        url = URL.createObjectURL(got.blob);
        setShown({ fileId, url });
      },
      () => {}, // no picture: the plain box stays
    );
    return () => {
      live = false;
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [files, fileId, seen]);

  return shown !== null && shown.fileId === fileId ? shown.url : null;
}
