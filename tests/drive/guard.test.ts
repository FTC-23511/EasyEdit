import { expect, it } from "vitest";
import { importsFrom, sources } from "../helpers/sources";

const MEDIA_SERVER_FILES = ["src/lib/media/service.ts", "src/lib/media/handlers.ts"];
const mayImportDrive = (file: string) => file.startsWith("src/lib/drive/") || MEDIA_SERVER_FILES.includes(file) || file.startsWith("src/app/api/");
const DRIVE_IMPORT = importsFrom("@/lib/drive");
const USE_CLIENT = /^["']use client["']/;
const PRINTS = /\bconsole\s*\.\s*(?:log|info|debug|warn)\b/;
const PRINTS_ERROR = /\bconsole\s*\.\s*error\b/;

it("the key's setting is read in one file", () => {
  const files = sources("src").filter(([, code]) => code.includes("GOOGLE_SERVICE_ACCOUNT_KEY")).map(([file]) => file);
  expect(files).toEqual(["src/lib/drive/config.ts"]);
});

it("only server code imports the Drive code", () => {
  for (const [file, code] of sources("src")) {
    if (!DRIVE_IMPORT.test(code)) continue;
    expect(mayImportDrive(file), `${file} imports the Drive code`).toBe(true);
    expect(code, `${file} is browser code and imports the Drive code`).not.toMatch(USE_CLIENT);
  }
});

it("the Drive import check knows which files are which", () => {
  for (const line of ['import { getDrive } from "@/lib/drive";', 'import { DriveError } from "@/lib/drive/token";', 'const { driveConfig } = await import("@/lib/drive/config");', "import type { DriveClient } from '@/lib/drive/client';"]) {
    expect(line).toMatch(DRIVE_IMPORT);
  }
  for (const line of ['import { LIMITS } from "@/lib/limits";', 'import { x } from "@/lib/driveway";', 'import { createSign } from "node:crypto";']) {
    expect(line).not.toMatch(DRIVE_IMPORT);
  }
  for (const file of ["src/lib/drive/client.ts", "src/lib/drive/index.ts", "src/lib/media/service.ts", "src/lib/media/handlers.ts", "src/app/api/media/route.ts", "src/app/api/drive/read-token/route.ts"]) {
    expect(mayImportDrive(file), file).toBe(true);
  }
  for (const file of ["src/lib/media/rules.ts", "src/lib/media/upload.ts", "src/lib/driveway/x.ts", "src/lib/projects/service.ts", "src/lib/mcp/server.ts", "src/components/editor/media-tab.tsx", "src/app/projects/[id]/page.tsx", "src/app/apiary/route.ts", "src/proxy.ts"]) {
    expect(mayImportDrive(file), file).toBe(false);
  }
  expect('"use client";\nimport { getDrive } from "@/lib/drive";').toMatch(USE_CLIENT);
  expect("'use client'\n").toMatch(USE_CLIENT);
  expect('import { x } from "y";\nconst mode = "use client";').not.toMatch(USE_CLIENT);
});

it("Drive and media code does not print", () => {
  const drive = sources("src/lib/drive");
  expect(drive.map(([file]) => file)).toEqual(expect.arrayContaining(["src/lib/drive/config.ts", "src/lib/drive/token.ts"]));
  for (const [file, code] of [...drive, ...sources("src/lib/media")]) {
    expect(code, file).not.toMatch(PRINTS);
    if (file !== "src/lib/media/handlers.ts") expect(code, file).not.toMatch(PRINTS_ERROR);
  }
});

it("the print check catches a call and a function passed along", () => {
  for (const line of ['console.log("x");', "console.info(token)", "console.debug(url)", "console.warn(e)", "promise.catch(console.warn);", "console\n  .log(x)"]) {
    expect(line).toMatch(PRINTS);
  }
  for (const line of ['console.error("Drive call failed", error.call, error.status, error.reason);', "promise.catch(console.error);"]) {
    expect(line).toMatch(PRINTS_ERROR);
    expect(line).not.toMatch(PRINTS);
  }
  for (const line of ["const log = [];", "catalog.info(x)", "// writes nothing to the console"]) {
    expect(line).not.toMatch(PRINTS);
    expect(line).not.toMatch(PRINTS_ERROR);
  }
});
