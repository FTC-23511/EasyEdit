import type { FileRefusal } from "./rules";

// Why a chosen file was not taken, as the person reads it.
export const FILE_REFUSALS: Record<FileRefusal, string> = {
  empty: "This file is empty.",
  "too-large": "This file is larger than 2 GB.",
  heic: "HEIC photos aren't supported yet. Save the photo as JPEG first.",
  unsupported: "This file type isn't supported. Use MP4, MOV, WebM, JPEG, PNG, WebP, MP3, M4A, WAV or AAC.",
  unreadable: "This file couldn't be read. It may be damaged.",
};

// The other sentences the media library shows. Each part of the library adds its own here.
export const MEDIA_MESSAGES = {};
