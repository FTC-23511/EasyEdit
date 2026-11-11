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
} as const;
