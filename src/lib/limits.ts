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
} as const;

export type Limits = { readonly [K in keyof typeof LIMITS]: number };
