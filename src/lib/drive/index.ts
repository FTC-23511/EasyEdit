import { type DriveClient, createDriveClient } from "./client";
import { driveConfig } from "./config";

const globalForDrive = globalThis as typeof globalThis & { __easyEditDrive?: DriveClient };

// The server's one Drive client, or null when media is not set up.
// The settings are read on first use, never when this module loads, so a build with no settings works.
// "Not set up" and a key that cannot be read are not remembered: the next call reads the settings again.
export function getDrive(): DriveClient | null {
  if (!globalForDrive.__easyEditDrive) {
    const config = driveConfig();
    if (!config) return null;
    globalForDrive.__easyEditDrive = createDriveClient({ config });
  }
  return globalForDrive.__easyEditDrive;
}
