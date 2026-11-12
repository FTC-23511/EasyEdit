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
