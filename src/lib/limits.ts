export const LIMITS = {
  projectNameChars: 100,
  textClipChars: 2000,
  trackNameChars: 100,
  tracksPerProject: 20,
  clipsPerTrack: 1000,
  docBytes: 2 * 1024 * 1024,
  opsPerRequest: 500,
  opsPageDefault: 100,
  opsPageMax: 500,
  opLogRowBytes: 1024 * 1024, // one op-log row: its ops plus its inverse, as UTF-8 JSON
  opsPageBytes: 2 * 1024 * 1024, // one page of the op log; a single larger entry is still sent alone
  connectorReadChars: 16_000, // one page of a read
  connectorEchoChars: 6_000, // the project text attached to a write or a conflict
  connectorListPage: 50, // projects per list_projects page
  connectorConflictEntries: 10, // unseen changes listed in a conflict
  connectorTextItems: 20, // text clips per add_text call
  connectorWritesPerMinute: 30, // changes one member's Claude may make in a minute
  connectorBytesPerDay: 10 * 1024 * 1024, // change data one member's Claude may store in a day
  connectorProjectsPerDay: 50, // projects one member's Claude may create in a day
  connectorNewIdLines: 50, // new ids listed after a write; the rest are in the project
  mediaFileBytes: 2 * 1024 * 1024 * 1024, // one uploaded file
  mediaChunkBytes: 8 * 1024 * 1024, // one piece of an upload; Drive needs a multiple of 256 KiB
  mediaParallelUploads: 2, // uploads running at once in one tab
  mediaPendingPerMember: 20, // unfinished uploads one member may have
  mediaPendingMaxAgeMs: 7 * 24 * 60 * 60 * 1000, // an unfinished upload older than this is dropped
  mediaNameChars: 120,
  mediaEventChars: 80,
  mediaListMax: 2000, // assets sent to an editor
  mediaIdsPerRequest: 200, // asset ids one list request may name
  mediaPosterBytes: 1024 * 1024, // one still picture
  mediaDirectPlayBytes: 200 * 1024 * 1024, // an original this small may be played when it has no preview copy
  mediaPreviewWaitMs: 2 * 60 * 60_000, // a preview copy still not made this long after the original was ready is shown as failed
  mediaCacheBytes: 2 * 1024 * 1024 * 1024, // playback files kept in the browser
  mediaReadTokenMinSeconds: 600, // a read token handed to a browser has at least this long left
  connectorAssetsPage: 50, // assets per list_assets page
  connectorMediaItems: 20, // clips per add_media call
} as const;

export type Limits = { readonly [K in keyof typeof LIMITS]: number };
