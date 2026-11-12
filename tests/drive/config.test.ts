import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { driveConfig } from "@/lib/drive/config";

const key = { type: "service_account", client_email: "m@p.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n" };
const encoded = Buffer.from(JSON.stringify(key)).toString("base64");
const NOT_A_KEY = "GOOGLE_SERVICE_ACCOUNT_KEY is not a service account key. Encode the JSON key file with base64 (see the README).";
const base64 = (text: string) => Buffer.from(text).toString("base64");

afterEach(() => vi.unstubAllEnvs());

describe("the media settings", () => {
  it("reads the key and the folder id", () => {
    expect(driveConfig({ GOOGLE_SERVICE_ACCOUNT_KEY: encoded, DRIVE_FOLDER_ID: "folder1" })).toEqual({ clientEmail: key.client_email, privateKey: key.private_key, rootFolderId: "folder1" });
  });

  it("says media is not set up when either setting is missing", () => {
    expect(driveConfig({})).toBeNull();
    expect(driveConfig({ GOOGLE_SERVICE_ACCOUNT_KEY: encoded })).toBeNull();
    expect(driveConfig({ GOOGLE_SERVICE_ACCOUNT_KEY: "", DRIVE_FOLDER_ID: "folder1" })).toBeNull();
  });

  it("refuses a key it cannot read, without repeating it", () => {
    for (const bad of ["not base64 json", Buffer.from('{"client_email":"x"}').toString("base64"), JSON.stringify(key)]) {
      let message = "";
      try { driveConfig({ GOOGLE_SERVICE_ACCOUNT_KEY: bad, DRIVE_FOLDER_ID: "folder1" }); } catch (e) { message = (e as Error).message; }
      expect(message).toBe("GOOGLE_SERVICE_ACCOUNT_KEY is not a service account key. Encode the JSON key file with base64 (see the README).");
    }
  });

  it("says media is not set up when the folder id is missing or empty, whatever the key holds", () => {
    expect(driveConfig({ DRIVE_FOLDER_ID: "folder1" })).toBeNull();
    expect(driveConfig({ GOOGLE_SERVICE_ACCOUNT_KEY: encoded, DRIVE_FOLDER_ID: "" })).toBeNull();
    expect(driveConfig({ GOOGLE_SERVICE_ACCOUNT_KEY: "not base64 json" })).toBeNull();
    expect(driveConfig({ GOOGLE_SERVICE_ACCOUNT_KEY: "not base64 json", DRIVE_FOLDER_ID: "" })).toBeNull();
  });

  it("reads the app's own settings when none are passed", () => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_KEY", "");
    vi.stubEnv("DRIVE_FOLDER_ID", "");
    expect(driveConfig()).toBeNull();
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_KEY", encoded);
    vi.stubEnv("DRIVE_FOLDER_ID", "folder2");
    expect(driveConfig()).toEqual({ clientEmail: key.client_email, privateKey: key.private_key, rootFolderId: "folder2" });
  });

  it("reads a key that base64 broke into lines", () => {
    const wrapped = `${encoded.replace(/(.{76})/g, "$1\n")}\n`;
    expect(wrapped.split("\n").length).toBeGreaterThan(2);
    expect(driveConfig({ GOOGLE_SERVICE_ACCOUNT_KEY: wrapped, DRIVE_FOLDER_ID: "folder1" })).toEqual({ clientEmail: key.client_email, privateKey: key.private_key, rootFolderId: "folder1" });
  });

  it("refuses JSON that is not a key with an email and a private key", () => {
    const notKeys = [
      "null",
      "7",
      '"-----BEGIN PRIVATE KEY-----"',
      "[]",
      "{}",
      JSON.stringify([key]),
      JSON.stringify({ private_key: key.private_key }),
      JSON.stringify({ ...key, client_email: "" }),
      JSON.stringify({ ...key, private_key: "" }),
      JSON.stringify({ ...key, client_email: 7 }),
      JSON.stringify({ ...key, private_key: { pem: key.private_key } }),
    ];
    for (const text of notKeys) {
      expect(() => driveConfig({ GOOGLE_SERVICE_ACCOUNT_KEY: base64(text), DRIVE_FOLDER_ID: "folder1" }), text).toThrow(NOT_A_KEY);
    }
  });

  it("puts no part of the value in the error", () => {
    const values = [
      base64("SECRETMARKER is not JSON"), // JSON.parse would quote this in its own error
      base64(JSON.stringify({ client_email: "SECRETMARKER@p.iam.gserviceaccount.com" })),
      base64(JSON.stringify({ private_key: "-----BEGIN SECRETMARKER-----" })),
      "SECRETMARKER",
    ];
    for (const value of values) {
      let error: unknown;
      try { driveConfig({ GOOGLE_SERVICE_ACCOUNT_KEY: value, DRIVE_FOLDER_ID: "folder1" }); } catch (e) { error = e; }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(NOT_A_KEY);
      expect((error as Error).cause).toBeUndefined();
      const shown = inspect(error, { depth: 10 }) + JSON.stringify(error) + (error as Error).stack;
      expect(shown).not.toContain("SECRETMARKER");
      expect(shown).not.toContain(value);
      expect(shown).not.toContain(value.slice(0, 12));
    }
  });
});
