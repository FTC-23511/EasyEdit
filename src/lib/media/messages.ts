import { LIMITS } from "@/lib/limits";
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
export const MEDIA_MESSAGES = {
  eventTooLong: `An event name can be up to ${LIMITS.mediaEventChars} characters.`,
  tooManyUnfinished: `You have ${LIMITS.mediaPendingPerMember} unfinished uploads. Finish or cancel one first.`,
  gone: "That file is no longer in the library.",
  sessionExpired: "This upload expired. Choose the file again.",
  notFinished: "The upload is not finished.",
  wrongFolder: "That file is not in the library's folder.",
  tooManyIds: `Ask for up to ${LIMITS.mediaIdsPerRequest} files at a time.`,
  formerMember: "A former member", // shown as the uploader when that person's account is gone
};
