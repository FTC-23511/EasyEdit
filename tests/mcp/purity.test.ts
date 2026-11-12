import { expect, it } from "vitest";
import { importsFrom, sources } from "../helpers/sources";

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
