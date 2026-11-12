import { expect, it } from "vitest";
import { FRAMEWORK_IMPORT, sources } from "../helpers/sources";

const SERVER_FILES = ["src/lib/media/service.ts", "src/lib/media/handlers.ts"];
// A static import, a bare side-effect import, a dynamic import() or a require() of the database, the Drive code or a Node module.
const SERVER_IMPORT = /\b(?:from|import|require)\s*\(?\s*["'](?:@\/db(?:\/[^"']*)?|@\/lib\/drive(?:\/[^"']*)?|node:[^"']+)["']/;

it("the server import pattern catches every way of importing", () => {
  for (const line of [
    'import { db } from "@/db";',
    'import { assets } from "@/db/schema";',
    'import "@/db";',
    'import { driveFetch } from "@/lib/drive/client";',
    'import { config } from "@/lib/drive";',
    'const c = await import("@/lib/drive/config");',
    'import { createSign } from "node:crypto";',
    "const fs = require('node:fs');",
  ]) {
    expect(line).toMatch(SERVER_IMPORT);
  }
  for (const line of ['import { LIMITS } from "@/lib/limits";', 'import { graphemes } from "@/lib/text";', 'import type { AssetKind } from "./types";', 'import { x } from "@/dbx";']) {
    expect(line).not.toMatch(SERVER_IMPORT);
  }
});

it("media logic imports no React or Next code", () => {
  for (const [file, code] of sources("src/lib/media")) expect(code, file).not.toMatch(FRAMEWORK_IMPORT);
});

it("everything in src/lib/media but the two server files can run in a browser", () => {
  for (const [file, code] of sources("src/lib/media")) {
    if (!SERVER_FILES.includes(file)) expect(code, file).not.toMatch(SERVER_IMPORT);
  }
});
