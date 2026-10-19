import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * `guide-imports.spec.ts` proves a documented import resolves to a real export. It cannot see the
 * mistake this pair of checks is for: `new DefaultLoadingManager()` names a real three.js export and
 * is still wrong, because that export is an instance, not a class. So the guide's own text is the
 * input here: every snippet is typechecked against the real packages. The loader line the Unreal
 * guide writes is then run against the committed fixture by `packages/raw-unreal/__tests__/
 * guide-example.spec.ts`, which sits beside the fixture and the codec that fixture needs.
 */
const GUIDES = ["docs/guides/unreal-assets.md", "docs/guides/metahuman.md"] as const;

/** Snippets legitimately lean on the scene and loader context a guide never imports. */
const CONTEXT_CODES = new Set([2304, 2552]);

function snippets(file: string): readonly string[] {
  return [...readFileSync(file, "utf8").matchAll(/^```ts\n([\s\S]*?)^```/gmu)].map(
    (match) => match[1] ?? "",
  );
}

/** `@threenative/x` to this repository's source entry, so a snippet resolves without a build. */
function workspacePaths(): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  for (const directory of readdirSync("packages")) {
    const manifest = path.join("packages", directory, "package.json");
    if (!existsSync(manifest)) continue;
    const name = (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name;
    if (!name?.startsWith("@threenative/")) continue;
    const entry = path.join("packages", directory, "src", "index.ts");
    if (existsSync(entry)) paths[name] = [entry];
  }
  return paths;
}

/** The package whose own `node_modules` the snippet needs, which is where its virtual file lives. */
function hostPackage(source: string): string {
  const imported = /from\s+"@threenative\/([\w-]+)"/u.exec(source)?.[1];
  if (!imported) return "core";
  for (const directory of readdirSync("packages")) {
    const manifest = path.join("packages", directory, "package.json");
    if (!existsSync(manifest)) continue;
    // `workspacePaths` keys on the manifest's scoped name, so this compares like with like.
    if (
      (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name ===
      `@threenative/${imported}`
    )
      return directory;
  }
  return "core";
}

function typecheck(guide: string, index: number, source: string): readonly string[] {
  const directory = `packages/${hostPackage(source)}/.guide-snippets`;
  const file = path.join(directory, `${path.basename(guide, ".md")}-${index}.ts`);
  const options: ts.CompilerOptions = {
    lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2023,
    types: ["node"],
    baseUrl: ".",
    paths: workspacePaths(),
  };
  // An in-memory host keeps the guide the only source of the code: the file never lands on disk, so a
  // passing run cannot come from a stale copy beside the markdown.
  const host = ts.createCompilerHost(options, true);
  const read = host.readFile.bind(host);
  host.readFile = (name) => (path.resolve(name) === path.resolve(file) ? source : read(name));
  host.fileExists = (
    (exists) => (name: string) =>
      path.resolve(name) === path.resolve(file) || exists(name)
  )(host.fileExists.bind(host));
  const program = ts.createProgram([file], options, host);
  return program
    .getSemanticDiagnostics()
    .filter((diagnostic) => !CONTEXT_CODES.has(diagnostic.code))
    .filter((diagnostic) => diagnostic.file?.fileName.endsWith(path.basename(file)))
    .map((diagnostic) => {
      const where = diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
      return `${path.basename(guide)} snippet ${index} line ${(where?.line ?? 0) + 1}: ${message}`;
    });
}

describe("documented guide snippets", () => {
  const pairs = GUIDES.flatMap((guide) =>
    snippets(guide).map((source, index) => ({ guide, index: index + 1, source })),
  );

  it("finds the snippets it checks", () => {
    expect(pairs.length).toBeGreaterThan(5);
  });

  it("typechecks every snippet against the real packages", () => {
    const failures = pairs.flatMap(({ guide, index, source }) => typecheck(guide, index, source));
    expect(failures).toEqual([]);
  });
});
