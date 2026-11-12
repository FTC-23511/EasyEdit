import { readdirSync } from "node:fs";
import { expect, it } from "vitest";
import { FRAMEWORK_IMPORT, sources } from "../helpers/sources";

it("the framework import pattern catches every way of importing", () => {
  for (const line of [
    'import { useState } from "react";',
    'import "react";',
    'const r = await import("react");',
    'import { createPortal } from "react-dom";',
    'import Link from "next/link";',
    'import { NextResponse } from "next/server";',
    'import next from "next";',
    "const r = require('react');",
  ]) {
    expect(line).toMatch(FRAMEWORK_IMPORT);
  }
  for (const line of ['import { createStore } from "zustand/vanilla";', 'import { nanoid } from "nanoid";', 'import { x } from "./react-like";']) {
    expect(line).not.toMatch(FRAMEWORK_IMPORT);
  }
});

it("editor logic imports no React or Next code", () => {
  for (const [file, code] of sources("src/lib/editor")) {
    expect(code, file).not.toMatch(FRAMEWORK_IMPORT);
  }
});

const ZUSTAND_IMPORT = /\b(?:from|import|require)\s*\(?\s*["']zustand(?:\/[^"']*)?["']/;
// One pass: string literals are matched first and kept, so a // or /* inside a string is never read as a comment.
const stripComments = (code: string) =>
  code.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\/\/.*$|\/\*[\s\S]*?\*\//gm, "$1");
const BROWSER_GLOBAL = /\b(?:window|document|localStorage|navigator)\b/;

it("the compositor is worker-safe: no React, Next or store imports, no browser globals", () => {
  expect(ZUSTAND_IMPORT.test('import { create } from "zustand";')).toBe(true);
  expect(ZUSTAND_IMPORT.test("import 'zustand/vanilla';")).toBe(true);
  expect(BROWSER_GLOBAL.test(stripComments("const w = typeof window;"))).toBe(true);
  expect(BROWSER_GLOBAL.test(stripComments("// window\n/* document */ const a = 1;"))).toBe(false);
  expect(BROWSER_GLOBAL.test(stripComments('const u = "http://x.com"; const d = document;'))).toBe(true);
  expect(BROWSER_GLOBAL.test(stripComments("const a = 1; // window here\n/* and document\n here */ const b = 2;"))).toBe(false);
  expect(stripComments("const s = 'a /* b */ c';")).toBe("const s = 'a /* b */ c';");
  expect(readdirSync("src/lib/render").filter((f) => f.endsWith(".tsx"))).toEqual([]);
  for (const [file, code] of sources("src/lib/render")) {
    expect(code, file).not.toMatch(FRAMEWORK_IMPORT);
    expect(code, file).not.toMatch(ZUSTAND_IMPORT);
    expect(stripComments(code), file).not.toMatch(BROWSER_GLOBAL);
  }
});
