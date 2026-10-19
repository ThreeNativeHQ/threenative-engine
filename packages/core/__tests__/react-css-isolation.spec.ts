import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Every module reachable from `entry` through relative imports/exports, and every bare specifier it names. */
function closure(entry: string): { modules: Set<string>; bare: Set<string> } {
  const modules = new Set<string>();
  const bare = new Set<string>();
  const visit = (file: string): void => {
    if (modules.has(file)) return;
    modules.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/gu)) {
      const spec = match[1] ?? "";
      if (spec.startsWith("."))
        visit(path.resolve(path.dirname(file), spec.replace(/\.js$/u, ".ts")));
      else bare.add(spec);
    }
  };
  visit(entry);
  return { modules, bare };
}

describe("opting out of native-css", () => {
  it("keeps the React reconciler host out of everything the main entry loads", () => {
    const { modules, bare } = closure(path.join(src, "index.ts"));
    expect([...modules].filter((m) => m.endsWith("react-css.ts"))).toEqual([]);
    expect([...bare].filter((b) => b.startsWith("react-reconciler"))).toEqual([]);
  });

  it("names react-reconciler only as an optional peer, so a game that never imports the subpath installs none", () => {
    const pkg = JSON.parse(readFileSync(path.join(src, "..", "package.json"), "utf8"));
    expect(pkg.dependencies?.["react-reconciler"]).toBeUndefined();
    expect(pkg.peerDependencies["react-reconciler"]).toBeDefined();
    expect(pkg.peerDependenciesMeta["react-reconciler"]?.optional).toBe(true);
  });

  it("does reach the reconciler through the ./react-css subpath, so the check above can fail", () => {
    const { bare } = closure(path.join(src, "react-css.ts"));
    expect([...bare].some((b) => b.startsWith("react-reconciler"))).toBe(true);
  });
});
