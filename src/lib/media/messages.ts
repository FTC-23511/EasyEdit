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

// How many of the projects that use an asset are named when it cannot be removed.
export const NAMED_PROJECTS = 3;

// The other sentences the media library shows. Each part of the library adds its own here.
export const MEDIA_MESSAGES = {
  badName: `Enter a name up to ${LIMITS.mediaNameChars} characters.`,
  eventTooLong: `An event name can be up to ${LIMITS.mediaEventChars} characters.`,
  tooManyUnfinished: `You have ${LIMITS.mediaPendingPerMember} unfinished uploads. Finish or cancel one first.`,
  gone: "That file is no longer in the library.",
  sessionExpired: "This upload expired. Choose the file again.",
  notFinished: "The upload is not finished.",
  wrongFolder: "That file is not in the library's folder.",
  tooManyIds: `Ask for up to ${LIMITS.mediaIdsPerRequest} files at a time.`,
  formerMember: "A former member", // shown as the uploader when that person's account is gone
  // Why an asset cannot be removed. names: the projects that use it, in the order to show them, of which the
  // first three are named; total: how many use it.
  usedIn(names: string[], total: number): string {
    const named = names.slice(0, NAMED_PROJECTS);
    const list = named.map((name) => `"${name}"`).join(", ");
    if (total === 1) return `Used in 1 project: ${list}. Remove it from that project first.`;
    const more = total > named.length ? ` and ${total - named.length} more` : "";
    return `Used in ${total} projects: ${list}${more}. Remove it from those projects first.`;
  },
  usedAMomentAgo: "A project was using that file a moment ago. Try again.",
  wrongFileRole: "A preview copy is for a video, and a still picture for a video or an image.",
  badFileSize: "That file is empty or too large.",
  storageDown: "Google Drive didn't answer. Try again.",
  // What an upload's row says when it stopped, or when it is done and has no preview copy.
  uploadStopped: "Upload stopped. Check your connection, then retry.",
  uploadExpired: "This upload expired. Retry to start it again.",
  uploadRefused: "Google Drive refused this upload. Tell an admin.",
  signedOut: "You're signed out. Sign in again, then retry.",
  lostAccess: "You no longer have edit access.",
  noPreviewHere: "No preview: this browser can't read this video. It can still be used in projects.",
  noPreview: "The preview couldn't be made. The file can still be used in projects.",
};
