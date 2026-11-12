export type AssetKind = "video" | "image" | "audio";
export type AssetStatus = "uploading" | "ready";
export type PreviewStatus = "none" | "pending" | "ready" | "failed"; // none: images and audio play the original

// What the browser read from the file. width and height are as shown, after rotation.
export type AssetProbe = {
  kind: AssetKind;
  durationMs: number | null; // null for an image
  width: number | null; // null for audio
  height: number | null;
  fps: number | null;
  hasAudio: boolean;
  videoCodec: string | null; // Mediabunny's name: "avc", "hevc", "vp9", "av1" …
};

export type AssetView = {
  id: string;
  kind: AssetKind;
  name: string;
  fileName: string;
  sizeBytes: number;
  status: AssetStatus;
  removed: boolean;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasAudio: boolean;
  originalFileId: string | null; // null until the upload is complete
  previewStatus: PreviewStatus;
  previewFileId: string | null;
  posterFileId: string | null;
  event: string | null;
  uploadedBy: string;
  uploadedByName: string;
  createdAt: string; // ISO time
};

export type OpenUploadInput = {
  fileName: string;
  sizeBytes: number;
  mimeType: string;
  lastModifiedMs: number;
  probe: AssetProbe;
  event?: string;
};

// Where one upload is. `preview`: the original is in, and the preview copy or the still picture is on its way.
export type UploadStage = "waiting" | "reading" | "uploading" | "finishing" | "preview" | "done" | "failed";

// One row of the upload list.
export type UploadItem = {
  key: string;
  fileName: string;
  sizeBytes: number;
  stage: UploadStage;
  sentBytes: number; // of the original
  previewFraction: number; // how much of the preview copy is made, 0 to 1
  assetId: string | null; // null until the server has opened the upload
  message: string | null; // why it failed, or why a finished upload has no preview copy
  canRetry: boolean;
};
