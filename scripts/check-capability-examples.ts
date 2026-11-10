import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";

/**
 * Type-checks every hand-authored `@example` in the capability manifest against the real types.
 *
 * The manifest is the first thing a user's agent reads, and its example is the line that agent
 * copies. Eleven of them did not compile — `new RigidBody3D({ context, object, mode: "dynamic" })`
 * named three options the type does not have and omitted the one it requires, and every other
 * physics constructor was wrong the same way. Nothing noticed, because nothing compiled them.
 *
 * An example is a snippet, not a program: it says `ctx`, `object`, `material` without declaring
 * them. So each free name the compiler reports is declared `any` and the file is compiled again,
 * to a fixpoint. What survives is a genuine disagreement between the example and the type.
 */
export interface IExampleFailure {
  readonly symbol: string;
  readonly importPath: string;
  readonly example: string;
  readonly messages: readonly string[];
}

export interface IExampleCheck {
  readonly checked: number;
  readonly failures: readonly IExampleFailure[];
  readonly skipped: readonly string[];
}

interface IManifestEntry {
  readonly symbol: string;
  readonly importPath: string;
  readonly example: string;
}

/**
 * Names the compiler resolves to DOM globals that an example plainly means as its own variable —
 * `frames`, `length`, `status`. Compiling without the DOM library is what makes them free names
 * the harness can declare, instead of silently type-checking a game's sprite frames against
 * `Window`.
 */
const LIBS = ["lib.es2022.d.ts"];

/** The realism-effects rows synthesise `symbol(...)` rather than authoring an example. */
const PLACEHOLDER_EXAMPLE = /^[A-Za-z_$][\w$]*\(\.\.\.\)$/u;

const MISSING_NAME =
  /Cannot find name '([A-Za-z_$][\w$]*)'|No value exists in scope for the shorthand property '([A-Za-z_$][\w$]*)'/u;
const TYPE_POSITION = /'([A-Za-z_$][\w$]*)' refers to a value, but is being used as a type here/u;
const VALUE_POSITION =
  /'([A-Za-z_$][\w$]*)' only refers to a type, but is being used as a value here/u;

const PREAMBLE = [
  // Vite's `import.meta.hot`, which the bundler supplies and this compilation does not.
  "declare global { interface ImportMeta { readonly hot?: any } }",
  "declare namespace JSX { interface IntrinsicElements { [name: string]: unknown } " +
    "interface ElementChildrenAttribute { children: unknown } type Element = unknown }",
].join("\n");

interface ICase {
  readonly entry: IManifestEntry;
  readonly file: string;
  readonly values: Set<string>;
  readonly types: Set<string>;
}

function isCode(example: string): boolean {
  return /[;{(=]/u.test(example) && !example.startsWith("src/");
}

function bodyFor(one: ICase): string {
  const { example, importPath, symbol } = one.entry;
  const needsImport = !example.includes(`from "${importPath}"`);
  // A `catch (error) { … }` example is the interesting half of a statement, not a statement.
  const statement = example.trimStart().startsWith("catch (")
    ? `try { throw new Error("example"); } ${example}`
    : example;
  return [
    PREAMBLE,
    [...one.types].map((name) => `type ${name} = any;`).join("\n"),
    [...one.values].map((name) => `declare const ${name}: any;`).join("\n"),
    needsImport ? `import { ${symbol} } from "${importPath}";` : "",
    `void (${symbol} as unknown);`,
    statement,
    "",
  ].join("\n");
}

/**
 * Where each published entry point's types live, read from the package manifests.
 *
 * Several capabilities are only reachable through a subpath — `@threenative/physics/navigation`,
 * `@threenative/core/world` — and a bare `@threenative/*` mapping resolves none of them. Deriving
 * the table from each package's own `exports` keeps the check pointed at exactly what a game can
 * import, and a package that adds an entry point is covered without editing this file.
 */
function typePaths(root: string): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  // The published types import `three`, and the case files are written to a temp directory
  // outside the repository, where node resolution cannot see the workspace store. Resolve it
  // through a package that already depends on it rather than hard-coding a store path.
  const resolver = createRequire(path.join(root, "packages", "core", "package.json"));
  try {
    const three = path.resolve(path.dirname(resolver.resolve("three")), "..");
    paths.three = [path.join(three, "src", "Three.d.ts")];
    paths["three/*"] = [path.join(three, "*")];
  } catch {
    // Left unmapped on purpose: the instrument control fails loudly rather than passing blind.
  }
  const packages = path.join(root, "packages");
  for (const directory of readdirSync(packages, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const manifestFile = path.join(packages, directory.name, "package.json");
    if (!existsSync(manifestFile)) continue;
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as {
      exports?: Record<string, { types?: string } | string>;
      name?: string;
      types?: string;
    };
    const name = manifest.name;
    if (name === undefined || !name.startsWith("@threenative/")) continue;
    const packageRoot = path.join(packages, directory.name);
    const record = (specifier: string, relative: string | undefined): void => {
      if (relative === undefined) return;
      paths[specifier] = [path.resolve(packageRoot, relative)];
    };
    record(name, manifest.types);
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      if (typeof target === "string" || subpath === "./package.json") continue;
      const specifier = subpath === "." ? name : `${name}/${subpath.replace(/^\.\//u, "")}`;
      record(specifier, target.types);
    }
  }
  return paths;
}

function compilerOptions(root: string): ts.CompilerOptions {
  return {
    baseUrl: root,
    jsx: ts.JsxEmit.Preserve,
    lib: LIBS,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    noImplicitAny: false,
    // Every workspace entry point resolves to the types it publishes. Without this the whole
    // check passes by failing to resolve anything, which is how the first run of it read green.
    paths: typePaths(root),
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
  };
}

function diagnose(cases: readonly ICase[], root: string): Map<string, string[]> {
  const program = ts.createProgram(
    cases.map((one) => one.file),
    compilerOptions(root),
  );
  const byFile = new Map<string, string[]>();
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    const file = diagnostic.file?.fileName;
    if (file === undefined) continue;
    const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
    const existing = byFile.get(file);
    if (existing === undefined) byFile.set(file, [text]);
    else existing.push(text);
  }
  return byFile;
}

export function checkCapabilityExamples(
  manifestFile = path.resolve("packages/core/capabilities.json"),
  root = process.cwd(),
): IExampleCheck {
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as {
    entries: readonly IManifestEntry[];
  };
  const directory = mkdtempSync(path.join(tmpdir(), "threenative-capability-examples-"));
  mkdirSync(directory, { recursive: true });
  try {
    const cases: ICase[] = [];
    const skipped: string[] = [];
    for (const [index, entry] of manifest.entries.entries()) {
      if (!entry.importPath.startsWith("@threenative/") || !isCode(entry.example)) {
        skipped.push(entry.symbol);
        continue;
      }
      if (PLACEHOLDER_EXAMPLE.test(entry.example.trim())) {
        skipped.push(entry.symbol);
        continue;
      }
      const extension = /<[A-Z]/u.test(entry.example) ? "tsx" : "ts";
      cases.push({
        entry,
        file: path.join(directory, `case-${index}.${extension}`),
        types: new Set<string>(),
        values: new Set<string>(),
      });
    }

    let byFile = new Map<string, string[]>();
    for (let round = 0; round < 12; round += 1) {
      for (const one of cases) writeFileSync(one.file, bodyFor(one));
      byFile = diagnose(cases, root);
      let added = 0;
      for (const one of cases) {
        for (const text of byFile.get(one.file) ?? []) {
          const asValue = VALUE_POSITION.exec(text)?.[1];
          if (asValue !== undefined && !one.values.has(asValue)) {
            one.types.delete(asValue);
            one.values.add(asValue);
            added += 1;
            continue;
          }
          const asType = TYPE_POSITION.exec(text)?.[1];
          if (asType !== undefined && !one.types.has(asType)) {
            one.types.add(asType);
            one.values.delete(asType);
            added += 1;
            continue;
          }
          const found = MISSING_NAME.exec(text);
          const missing = found?.[1] ?? found?.[2];
          if (missing === undefined || one.values.has(missing) || one.types.has(missing)) continue;
          one.values.add(missing);
          added += 1;
        }
      }
      if (added === 0) break;
    }

    const failures = cases
      .filter((one) => (byFile.get(one.file) ?? []).length > 0)
      .map((one) => ({
        example: one.entry.example,
        importPath: one.entry.importPath,
        messages: byFile.get(one.file) ?? [],
        symbol: one.entry.symbol,
      }));
    return { checked: cases.length, failures, skipped };
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

/**
 * Proves the checker can still fail before believing that it passed.
 *
 * The first run of this instrument reported 229 of 241 examples clean. It had resolved no
 * `@threenative` module at all, so every symbol was `any` and every example type-checked against
 * nothing. A green from an instrument that cannot go red is not evidence.
 */
export function checkExampleInstrument(root = process.cwd()): {
  readonly resolves: boolean;
  readonly rejects: boolean;
} {
  const directory = mkdtempSync(path.join(tmpdir(), "threenative-example-control-"));
  try {
    const good = path.join(directory, "good.ts");
    const bad = path.join(directory, "bad.ts");
    writeFileSync(
      good,
      'declare const object: any; declare const physics: any;\nimport { CollisionShape3D, RigidBody3D } from "@threenative/physics";\nvoid new RigidBody3D({ object, physics, shape: CollisionShape3D.box(1, 1, 1) });\n',
    );
    writeFileSync(
      bad,
      'declare const object: any; declare const physics: any;\nimport { CollisionShape3D, RigidBody3D } from "@threenative/physics";\nvoid new RigidBody3D({ object, physics, shape: CollisionShape3D.box(1, 1, 1), thisOptionIsNotReal: 7 });\n',
    );
    const program = ts.createProgram([good, bad], compilerOptions(root));
    const messages = new Map<string, string[]>();
    for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
      const file = diagnostic.file?.fileName;
      if (file === undefined) continue;
      const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
      const existing = messages.get(file);
      if (existing === undefined) messages.set(file, [text]);
      else existing.push(text);
    }
    const goodMessages = messages.get(good) ?? [];
    const badMessages = messages.get(bad) ?? [];
    return {
      rejects: badMessages.some((text) => text.includes("thisOptionIsNotReal")),
      resolves:
        goodMessages.length === 0 &&
        !badMessages.some((text) => text.includes("Cannot find module")),
    };
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}
