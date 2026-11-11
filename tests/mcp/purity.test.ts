import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";

const sources = (dir: string): (readonly [string, string])[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory()) return sources(path);
    return /\.tsx?$/.test(e.name) ? [[path, readFileSync(path, "utf8")] as const] : [];
  });

const importsFrom = (pkg: string) => new RegExp(`\\b(?:from|import|require)\\s*\\(?\\s*["']${pkg}(?:/[^"']*)?["']`);

it("the tools never see a request: no Next, no auth library, no headers", () => {
  const files = sources("src/lib/mcp");
  expect(files.length).toBeGreaterThan(5);
  for (const [file, code] of files) {
    for (const pkg of ["next", "better-auth", "@better-auth/[a-z-]+", "mcp-handler"]) expect(code, `${file} imports ${pkg}`).not.toMatch(importsFrom(pkg));
    expect(code, file).not.toMatch(/\bheaders\b|\bauthorization\b|\bcookie\b/i);
    if (!file.endsWith("/server.ts")) expect(code, file).not.toMatch(importsFrom("@modelcontextprotocol/[a-z-]+"));
  }
});

it("nothing in the connector prints with console.log, and only the tool wrapper logs errors", () => {
  for (const [file, code] of [...sources("src/lib/mcp"), ...sources("src/lib/connector"), ...sources("src/app/api/mcp")]) {
    expect(code, file).not.toMatch(/console\.(log|info|debug|warn)\(/);
    if (!file.endsWith("/mcp/server.ts")) expect(code, file).not.toMatch(/console\.error\(/);
  }
});
