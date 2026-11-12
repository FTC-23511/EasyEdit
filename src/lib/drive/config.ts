export type DriveConfig = {
  clientEmail: string;
  privateKey: string;
  // The id of the Drive folder that holds EasyEdit media: a folder inside a shared drive, shared with the service account.
  // A shared drive's own id would also work.
  rootFolderId: string;
};

type Settings = Record<string, string | undefined>;

const NOT_A_KEY = "GOOGLE_SERVICE_ACCOUNT_KEY is not a service account key. Encode the JSON key file with base64 (see the README).";

const filled = (value: unknown): value is string => typeof value === "string" && value !== "";

// The two fields of a base64 JSON key file that the app uses, or null when the value is not one.
function readKey(value: string): Pick<DriveConfig, "clientEmail" | "privateKey"> | null {
  let key: unknown;
  try {
    key = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return null; // the parser's own error quotes what it read, so it is dropped
  }
  if (typeof key !== "object" || key === null) return null;
  const { client_email: clientEmail, private_key: privateKey } = key as Record<string, unknown>;
  return filled(clientEmail) && filled(privateKey) ? { clientEmail, privateKey } : null;
}

// The only place the service account key is read.
// null when either setting is missing or empty: media is not set up.
// Throws when the key is set but cannot be read. The message never holds any part of the value.
export function driveConfig(env: Settings = process.env): DriveConfig | null {
  const value = env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const rootFolderId = env.DRIVE_FOLDER_ID;
  if (!value || !rootFolderId) return null;
  const key = readKey(value);
  if (!key) throw new Error(NOT_A_KEY);
  return { ...key, rootFolderId };
}
