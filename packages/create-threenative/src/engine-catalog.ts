import path from "node:path";
import { loadConfig } from "./config.js";
import { upstreamRefusals } from "./web-engine.js";

/**
 * A `three` export the Wasm engine refuses throws `TN_NATIVE_…` at its first use, which a game
 * meets as an aborted scene or a blank frame several minutes after the edit (PRD-830). This plugin
 * fails the import line instead: the dev overlay and `threenative build` both name the code and
 * `file:line:column`. The installed runtime decides which names it refuses (`upstreamRefusals`),
 * so the plugin cannot refuse a name the page binds. Member and argument gaps (a `partial` entry)
 * stay runtime diagnostics: they need the value, not the name.
 */

/** The entry points the runtime binds name by name (browser-entry.ts `UPSTREAM_SOURCES`). */
const CHECKED_SOURCES = new Set(["three", "three/webgpu", "three/tsl"]);
const IMPORTS_THREE = /from\s*["']three(?:\/webgpu|\/tsl)?["']/u;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/u;
const OVERRIDE =
  'createEngineCatalogPlugin({ mode: "warn" }) in vite.config.ts reports instead of failing; engine: "threejs" in threenative.config.ts binds every name.';

export interface IEngineCatalogOptions {
  /** "error" (the default) fails the edit and the build; "warn" reports, and the page throws at first use. */
  readonly mode?: "error" | "warn";
}

interface IRefusedImport {
  readonly code: string;
  readonly column: number;
  readonly line: number;
  readonly name: string;
  readonly source: string;
}

interface ITransformContext {
  error(failure: {
    readonly message: string;
    readonly id: string;
    readonly loc?: { readonly file: string; readonly line: number; readonly column: number };
  }): never;
  warn(message: string): void;
}

export interface IEngineCatalogVitePlugin {
  readonly name: string;
  readonly enforce: "pre";
  config(): { worker: { plugins: () => object[] } };
  configResolved(config: { readonly root: string }): Promise<void>;
  transform(this: ITransformContext, code: string, id: string): Promise<null>;
}

type Ts = typeof import("typescript");

/** The `{ … }` list and source of a value import or re-export, or undefined for anything else. */
function namedList(
  ts: Ts,
  statement: import("typescript").Statement,
):
  | { elements: readonly import("typescript").ImportOrExportSpecifier[]; source: string }
  | undefined {
  const declaration =
    ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly !== true
      ? { bindings: statement.importClause?.namedBindings, specifier: statement.moduleSpecifier }
      : ts.isExportDeclaration(statement) && !statement.isTypeOnly
        ? { bindings: statement.exportClause, specifier: statement.moduleSpecifier }
        : undefined;
  const bindings = declaration?.bindings;
  const specifier = declaration?.specifier;
  if (bindings === undefined || specifier === undefined || !ts.isStringLiteral(specifier))
    return undefined;
  if (!CHECKED_SOURCES.has(specifier.text)) return undefined;
  return ts.isNamedImports(bindings) || ts.isNamedExports(bindings)
    ? { elements: bindings.elements, source: specifier.text }
    : undefined;
}

/** Each statically imported name from a checked source that `refusals` holds, with its 1-based line. */
async function refusedImports(
  code: string,
  file: string,
  refusals: ReadonlyMap<string, string>,
): Promise<IRefusedImport[]> {
  const ts = (await import("typescript")).default;
  const sourceFile = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const found: IRefusedImport[] = [];
  for (const statement of sourceFile.statements) {
    const list = namedList(ts, statement);
    for (const element of list?.elements ?? []) {
      const name = (element.propertyName ?? element.name).text;
      const refusal = refusals.get(name);
      if (element.isTypeOnly || refusal === undefined || list === undefined) continue;
      const position = sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile));
      found.push({
        code: refusal,
        column: position.character,
        line: position.line + 1,
        name,
        source: list.source,
      });
    }
  }
  return found;
}

/**
 * Fails a game file's `import { X } from "three"` when the Wasm engine refuses `X` (PRD-830). Off,
 * and reported once, under `engine: "threejs"` and for the native host's bundle.
 */
export function createEngineCatalogPlugin(
  options: IEngineCatalogOptions = {},
): IEngineCatalogVitePlugin {
  const mode = options.mode ?? "error";
  let root = process.cwd();
  let active = false;
  let bootWarned = false;
  let refusals: Promise<ReadonlyMap<string, string> | Error> | undefined;
  async function transform(this: ITransformContext, code: string, id: string): Promise<null> {
    const file = id.split("?")[0] ?? id;
    // Game source only: a linked engine package resolves outside the root, an installed one under node_modules.
    const where = path.relative(root, file);
    if (!active || id.startsWith("\0") || where.startsWith("..") || path.isAbsolute(where))
      return null;
    if (where.split(path.sep).includes("node_modules")) return null;
    if (!SOURCE_FILE.test(file) || !IMPORTS_THREE.test(code)) return null;
    // A boot failure is one engine pair the page cannot bind either: named once, never a refusal.
    refusals ??= upstreamRefusals(root).catch(
      (error: unknown) =>
        new Error(
          `TN_ENGINE_CATALOG: the installed Wasm engine did not boot under this create-threenative, so the page cannot bind it either (${error instanceof Error ? error.message : String(error)}). Install one release of both: pnpm up --latest create-threenative @threenative/*`,
        ),
    );
    const known = await refusals;
    if (known instanceof Error) {
      if (mode === "error") return this.error({ message: known.message, id: file });
      if (!bootWarned) this.warn(known.message);
      bootWarned = true;
      return null;
    }
    const found = await refusedImports(code, file, known);
    const first = found[0];
    if (first === undefined) return null;
    const message = [
      ...found.map(
        (refused) =>
          `${refused.code}: ${refused.name} from "${refused.source}" is not available on the Wasm engine (${where}:${refused.line}:${refused.column + 1}).`,
      ),
      OVERRIDE,
    ].join("\n");
    if (mode === "warn") {
      this.warn(message);
      return null;
    }
    return this.error({
      message,
      id: file,
      loc: { file, line: first.line, column: first.column },
    });
  }
  return {
    name: "threenative-engine-catalog",
    enforce: "pre",
    // A game booted in a worker (the kits' default page) bundles through `worker.plugins` only.
    config: () => ({
      worker: {
        plugins: () => [{ name: "threenative-engine-catalog-worker", enforce: "pre", transform }],
      },
    }),
    async configResolved(config) {
      root = config.root;
      const { engine } = await loadConfig(root);
      // The native host's bundle binds through its own engine, not the Wasm page runtime.
      const off =
        engine !== "threenative"
          ? `engine ${engine}`
          : process.env.THREENATIVE_NATIVE_BUNDLE !== undefined
            ? "native host bundle"
            : undefined;
      active = off === undefined;
      if (off !== undefined) console.info(`TN_ENGINE_CATALOG: off (${off})`);
      else if (mode === "warn")
        console.info(
          'TN_ENGINE_CATALOG: warn (mode "warn": a refused import is reported, and the page throws at its first use)',
        );
    },
    transform,
  };
}
