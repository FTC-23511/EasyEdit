import { readFileSync, readdirSync } from "node:fs";

// Every .ts and .tsx file under a folder, as [path, text].
export const sources = (dir: string): (readonly [string, string])[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory()) return sources(path);
    return /\.tsx?$/.test(e.name) ? [[path, readFileSync(path, "utf8")] as const] : [];
  });

// A static import, a bare side-effect import, a dynamic import() or a require() of React or Next.
export const FRAMEWORK_IMPORT = /\b(?:from|import|require)\s*\(?\s*["'](?:react|react-dom|next)(?:\/[^"']*)?["']/;

export const importsFrom = (pkg: string) => new RegExp(`\\b(?:from|import|require)\\s*\\(?\\s*["']${pkg}(?:/[^"']*)?["']`);
