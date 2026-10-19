import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A guide that names an export the package does not have is worse than no guide: an agent reads it,
 * writes the import, and fails on a symbol that was never shipped. Every `@threenative/*` import in a
 * guide or an agent reference must resolve to a real export of that package's entry point.
 */
const PACKAGES = path.resolve("packages");
const DOCS = [
  path.resolve("docs/guides"),
  path.resolve("packages/create-threenative/agent-docs/references"),
];

function exportedNames(file: string, seen: Set<string> = new Set()): ReadonlySet<string> {
  if (seen.has(file)) return new Set();
  seen.add(file);
  const names = new Set<string>();
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/gu)) {
    for (const part of match[1]?.split(",") ?? []) {
      const name = part
        ?.trim()
        .split(/\s+as\s+/u)
        .pop()
        ?.replace(/^type\s+/u, "")
        .trim();
      if (name) names.add(name);
    }
  }
  for (const match of source.matchAll(
    /export\s+(?:declare\s+)?(?:abstract\s+)?(?:const|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gu,
  )) {
    const name = match[1];
    if (name) names.add(name);
  }
  for (const match of source.matchAll(/export\s+\*\s+from\s+"(\.[^"]+)"/gu)) {
    const target = path.resolve(path.dirname(file), match[1]?.replace(/\.js$/u, "") ?? "");
    for (const candidate of [`${target}.ts`, path.join(target, "index.ts")]) {
      if (existsSync(candidate)) for (const name of exportedNames(candidate, seen)) names.add(name);
    }
  }
  return names;
}

/** Package name to the entry point a bare or subpath import resolves to, or nothing. */
function entryPoint(specifier: string): string | undefined {
  const [name = "", ...rest] = specifier.replace("@threenative/", "").split("/");
  for (const directory of readdirSync(PACKAGES)) {
    const manifest = path.join(PACKAGES, directory, "package.json");
    if (!existsSync(manifest)) continue;
    if (
      (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name !==
      `@threenative/${name}`
    )
      continue;
    const source = path.join(PACKAGES, directory, "src");
    const candidates = rest.length
      ? [path.join(source, `${rest.join("/")}.ts`), path.join(source, rest.join("/"), "index.ts")]
      : [path.join(source, "index.ts")];
    return candidates.find((candidate) => existsSync(candidate));
  }
  return undefined;
}

function documentedImports(): readonly {
  readonly file: string;
  readonly specifier: string;
  readonly symbol: string;
}[] {
  const found: { file: string; specifier: string; symbol: string }[] = [];
  for (const directory of DOCS) {
    for (const name of readdirSync(directory).sort()) {
      if (!name.endsWith(".md")) continue;
      const file = path.join(directory, name);
      for (const match of readFileSync(file, "utf8").matchAll(
        /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s+"(@threenative\/[\w/-]+)"/gu,
      )) {
        const specifier = match[2] ?? "";
        for (const part of match[1]?.split(",") ?? []) {
          const symbol = part
            ?.trim()
            .split(/\s+as\s+/u)[0]
            ?.replace(/^type\s+/u, "")
            .trim();
          if (symbol) found.push({ file, specifier, symbol });
        }
      }
    }
  }
  return found;
}

describe("documented engine imports", () => {
  it("names only exports the package actually ships", () => {
    const imports = documentedImports();
    expect(imports.length).toBeGreaterThan(20);
    const unknown: string[] = [];
    const cache = new Map<string, ReadonlySet<string>>();
    for (const { file, specifier, symbol } of imports) {
      const entry = entryPoint(specifier);
      const names = entry ? (cache.get(entry) ?? exportedNames(entry)) : undefined;
      if (entry && names && !cache.has(entry)) cache.set(entry, names);
      if (!names?.has(symbol))
        unknown.push(`${path.relative(process.cwd(), file)}: ${symbol} from ${specifier}`);
    }
    expect(unknown).toEqual([]);
  });
});
