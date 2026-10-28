import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "typescript";
import { publicWorkspacePackagesWithExports, workspacePackages } from "./workspace-packages.js";

export interface ICapabilityExport {
  readonly packageName: string;
  readonly subpath: string;
  readonly name: string;
  readonly entry: string;
}

/**
 * What complete capability documentation means (PRD-187 phase 4). An export must say what it is,
 * when to reach for it, and show one working call — checked against the manifest the engine
 * compiles from those same doc tags, so the gate and `capabilities.json` cannot disagree.
 */
export type DocTagRequirement = "@example" | "@situation" | "summary";

export interface ICapabilityTagGap {
  readonly capability: ICapabilityExport;
  readonly missing: readonly DocTagRequirement[];
}

export interface ICapabilityDocReport {
  readonly exports: readonly ICapabilityExport[];
  readonly gaps: readonly ICapabilityTagGap[];
}

export interface ICapabilityPackageCensusReport {
  readonly allowlisted: readonly string[];
  readonly inScope: readonly string[];
  readonly walked: readonly string[];
}

/**
 * Public helpers that are intentionally not game-authoring capabilities.
 *
 * Keep this list small and reasoned: adding an entry hides a symbol from every scaffold doc, so
 * an empty or multi-line reason is rejected by the gate.
 */
export const INTERNAL_ALLOWLIST: Readonly<Record<string, string>> = {
  "@threenative/core/hot#assertPortableState":
    "Hot-update implementation detail; game code calls acceptHotUpdate instead.",
};

/**
 * Public packages whose exports are tooling or platform plumbing rather than game-authoring
 * capabilities. Each omission is explicit so adding a new public package cannot disappear from
 * the manifest without a reason.
 */
export const CAPABILITY_PACKAGE_ALLOWLIST: Readonly<Record<string, string>> = {
  "@threenative/runtime-native":
    "Native C++ host and platform packaging; it has no TypeScript game-authoring surface.",
  "create-threenative":
    "Scaffold CLI implementation; game authors consume the generated project, not its helpers.",
  "threenative-animation-mcp":
    "MCP transport and build-time GLB editing; a game imports no symbol from it, only its tools.",
  "threenative-blender-mcp":
    "MCP transport and Blender process boundary; a game imports no symbol from it, only its tools.",
  "threenative-engine-mcp":
    "MCP transport implementation; the generated capability manifest is the authoring surface.",
};

interface IPackageSpec {
  readonly name: string;
  readonly directory: string;
}

interface IPackageManifest {
  readonly exports?: unknown;
}

const MANIFEST_RELATIVE_PATH = path.join("packages", "create-threenative", "capabilities.json");

/**
 * The manifest also contains generated-source guidance for render stages. Those entries are not
 * package exports: `src/render/*` belongs to the scaffold and `@threenative/template/*` is an
 * alias created inside a generated project. Package and Three.js imports are the built surface
 * this gate can resolve from the repository's export maps.
 */
function isBuiltImportPath(importPath: string): boolean {
  return !importPath.startsWith("src/") && !importPath.startsWith("@threenative/template/");
}

export function validateCapabilityPackageAllowlist(
  allowlist: Readonly<Record<string, string>> = CAPABILITY_PACKAGE_ALLOWLIST,
): void {
  const invalid = Object.entries(allowlist).filter(
    ([name, reason]) =>
      name.trim().length === 0 ||
      typeof reason !== "string" ||
      reason.trim().length === 0 ||
      /[\r\n]/u.test(reason),
  );
  if (invalid.length === 0) return;
  throw new Error(
    `CAPABILITY_PACKAGE_ALLOWLIST_INVALID: every entry needs a non-empty one-line reason: ${invalid
      .map(([name]) => name)
      .join(", ")}`,
  );
}

/** Derive the packages whose public code exports must carry capability documentation. */
export function capabilityPackageSpecs(
  root: string,
  allowlist: Readonly<Record<string, string>> = CAPABILITY_PACKAGE_ALLOWLIST,
): readonly IPackageSpec[] {
  validateCapabilityPackageAllowlist(allowlist);
  return publicWorkspacePackagesWithExports(root)
    .filter(({ name }) => allowlist[name] === undefined)
    .map(({ name, directory }) => ({ name, directory: path.relative(root, directory) }));
}

interface IManifestEntry {
  readonly example: string;
  readonly importPath: string;
  readonly situations: readonly string[];
  readonly summary: string;
  readonly symbol: string;
}

export interface ICapabilityBuiltImportReport {
  readonly checkedImportPaths: number;
  readonly checkedSymbols: number;
  readonly skippedSourceEntries: number;
}

function moduleSpecifier(capability: ICapabilityExport): string {
  return `${capability.packageName}${capability.subpath === "." ? "" : capability.subpath.slice(1)}`;
}

export function capabilityKey(capability: ICapabilityExport): string {
  return `${moduleSpecifier(capability)}#${capability.name}`;
}

export function validateInternalAllowlist(
  allowlist: Readonly<Record<string, string>> = INTERNAL_ALLOWLIST,
): void {
  const invalid = Object.entries(allowlist).filter(
    ([, reason]) =>
      typeof reason !== "string" || reason.trim().length === 0 || /[\r\n]/u.test(reason),
  );
  if (invalid.length > 0) {
    throw new Error(
      `CAPABILITY_DOCS_INTERNAL_ALLOWLIST_INVALID: every entry needs one-line reason: ${invalid
        .map(([key]) => key)
        .join(", ")}`,
    );
  }
}

function exportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const target = exportTarget(item);
      if (target !== undefined) return target;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const conditions = value as Record<string, unknown>;
  for (const condition of ["import", "default", "types"]) {
    const target = exportTarget(conditions[condition]);
    if (target !== undefined) return target;
  }
  return undefined;
}

function exportMapEntries(value: unknown): readonly [string, unknown][] {
  if (typeof value === "string" || Array.isArray(value)) return [[".", value]];
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const subpaths = Object.keys(record).filter((key) => key.startsWith("."));
  if (subpaths.length === 0) return [[".", value]];
  return subpaths.map((subpath) => [subpath, record[subpath]] as [string, unknown]);
}

function packageSpecifier(importPath: string): { packageName: string; subpath: string } {
  const parts = importPath.split("/");
  const packagePartCount = importPath.startsWith("@") ? 2 : 1;
  const packageName = parts.slice(0, packagePartCount).join("/");
  return {
    packageName,
    subpath:
      parts.length === packagePartCount ? "." : `./${parts.slice(packagePartCount).join("/")}`,
  };
}

function packageRootCandidates(root: string, packageName: string): readonly string[] {
  const workspaceCandidates: string[] = [];
  if (existsSync(path.join(root, "packages"))) {
    for (const entry of readdirSync(path.join(root, "packages"), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(root, "packages", entry.name);
      try {
        const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")) as {
          name?: unknown;
        };
        if (manifest.name === packageName) workspaceCandidates.push(directory);
      } catch {
        // Dependency directories and incomplete fixtures are not workspace packages.
      }
      workspaceCandidates.push(path.join(directory, "node_modules", packageName));
    }
  }
  return [...workspaceCandidates, path.join(root, "node_modules", packageName)];
}

async function locatePackageRoot(root: string, packageName: string): Promise<string | undefined> {
  for (const candidate of packageRootCandidates(root, packageName)) {
    if (existsSync(path.join(candidate, "package.json"))) return path.resolve(candidate);
  }
  return undefined;
}

function exportDefinition(exports: unknown, subpath: string): unknown {
  const entries = exportMapEntries(exports);
  const exact = entries.find(([key]) => key === subpath);
  if (exact !== undefined) return exact[1];
  const pattern = entries.find(
    ([key]) => key.includes("*") && subpath.startsWith(key.split("*")[0] ?? ""),
  );
  if (pattern === undefined) return undefined;
  const [key, definition] = pattern;
  const prefix = key.split("*")[0] ?? "";
  const suffix = key.split("*")[1] ?? "";
  const match = subpath.slice(prefix.length, subpath.length - suffix.length || undefined);
  const target = exportTarget(definition);
  return target?.replaceAll("*", match);
}

function hasBuiltSymbol(namespace: Record<string, unknown>, symbol: string): boolean {
  return Object.hasOwn(namespace, symbol);
}

async function resolveBuiltCapabilityImport(root: string, importPath: string): Promise<string> {
  const { packageName, subpath } = packageSpecifier(importPath);
  const packageRoot = await locatePackageRoot(root, packageName);
  if (packageRoot === undefined) {
    throw new Error(`package ${packageName} is not installed in the workspace`);
  }
  const manifestPath = path.join(packageRoot, "package.json");
  let manifest: IPackageManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as IPackageManifest;
  } catch (error) {
    throw new Error(
      `could not read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const target = exportTarget(exportDefinition(manifest.exports, subpath));
  if (target === undefined) {
    throw new Error(`${packageName}${subpath} is absent from ${manifestPath}`);
  }
  const resolved = path.resolve(packageRoot, target);
  if (!resolved.startsWith(`${packageRoot}${path.sep}`) || !existsSync(resolved)) {
    throw new Error(`${packageName}${subpath} targets missing built file ${resolved}`);
  }
  return resolved;
}

function sourceEntry(packageRoot: string, target: string): string {
  const relativeTarget = target.replace(/^\.\//u, "");
  const sourceRelative = relativeTarget
    .replace(/^dist\//u, "src/")
    .replace(/\.d\.ts$/u, ".ts")
    .replace(/\.js$/u, ".ts");
  const entry = path.join(packageRoot, sourceRelative);
  if (!existsSync(entry)) {
    throw new Error(`CAPABILITY_DOCS_ENTRY_MISSING: ${entry}`);
  }
  return entry;
}

async function packageEntries(
  root: string,
  spec: IPackageSpec,
): Promise<readonly { subpath: ICapabilityExport["subpath"]; entry: string }[]> {
  const packageRoot = path.join(root, spec.directory);
  const manifestPath = path.join(packageRoot, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as IPackageManifest;
  if (manifest.exports === undefined) {
    throw new Error(`CAPABILITY_DOCS_EXPORTS_MISSING: ${manifestPath}`);
  }

  const entries: { subpath: string; entry: string }[] = [];
  for (const [subpath, targetDefinition] of exportMapEntries(manifest.exports)) {
    if (subpath === "./package.json") continue;
    const target = exportTarget(targetDefinition);
    if (target === undefined) {
      throw new Error(`CAPABILITY_DOCS_TARGET_MISSING: ${spec.name}${subpath}`);
    }
    entries.push({
      subpath,
      entry: sourceEntry(packageRoot, target),
    });
  }
  if (entries.length === 0) throw new Error(`CAPABILITY_DOCS_NO_CODE_EXPORTS: ${spec.name}`);
  return entries;
}

function sourceProgram(
  root: string,
  entries: readonly string[],
  specs: readonly IPackageSpec[],
): ts.Program {
  const paths: Record<string, string[]> = {};
  for (const spec of specs) {
    const sourceDirectory = path.join(spec.directory, "src").replaceAll(path.sep, "/");
    paths[spec.name] = [`${sourceDirectory}/index.ts`];
    paths[`${spec.name}/*`] = [`${sourceDirectory}/*`];
  }
  return ts.createProgram({
    rootNames: entries,
    options: {
      allowJs: false,
      baseUrl: root,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      paths,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
    },
  });
}

/**
 * True for a callable or constructible export, however it was written.
 *
 * `export function f() {}` and `export const f = () => {}` are the same capability to a game's
 * agent and were not the same thing to this gate: only the declaration forms were counted, so the
 * day a helper is written as an arrow const it leaves the scan silently and its absence stops
 * being a release defect. A gate that quietly narrows what it covers is the failure this
 * repository names as the most dangerous one, so the form is not the test — being a function or
 * a class is.
 */
export function isPublicClassOrFunction(checker: ts.TypeChecker, symbol: ts.Symbol): boolean {
  const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  if ((resolved.flags & ts.SymbolFlags.Value) === 0) return false;
  // `export const alias = other` and `export const f = upstream.f` are the same capability as
  // `export function f`, and slipped past every syntactic form below: the type decides.
  const type = checker.getTypeOfSymbol(resolved);
  if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) return true;
  return (resolved.declarations ?? []).some((declaration) => {
    if (ts.isClassDeclaration(declaration) || ts.isFunctionDeclaration(declaration)) return true;
    if (!ts.isVariableDeclaration(declaration)) return false;
    const initializer = declaration.initializer;
    if (initializer === undefined) return false;
    return (
      ts.isArrowFunction(initializer) ||
      ts.isFunctionExpression(initializer) ||
      ts.isClassExpression(initializer)
    );
  });
}

function exportedValueNames(checker: ts.TypeChecker, entry: ts.SourceFile): readonly string[] {
  const module = checker.getSymbolAtLocation(entry);
  if (module === undefined) throw new Error(`CAPABILITY_DOCS_MODULE_MISSING: ${entry.fileName}`);
  return checker
    .getExportsOfModule(module)
    .filter((symbol) => isPublicClassOrFunction(checker, symbol))
    .map((symbol) => symbol.getName())
    .sort();
}

/** Walk the main entry and every code subpath in each non-allowlisted public package. */
export async function collectPublicExports(root: string): Promise<readonly ICapabilityExport[]> {
  const discovered: ICapabilityExport[] = [];
  const specs = capabilityPackageSpecs(root);
  const entryRecords = (
    await Promise.all(
      specs.map(async (spec) => ({
        spec,
        entries: await packageEntries(root, spec),
      })),
    )
  ).flatMap(({ spec, entries }) => entries.map((entry) => ({ ...entry, packageName: spec.name })));
  const program = sourceProgram(
    root,
    entryRecords.map(({ entry }) => entry),
    specs,
  );
  const checker = program.getTypeChecker();
  for (const { packageName, subpath, entry } of entryRecords) {
    for (const name of exportedValueNames(checker, program.getSourceFile(entry) as ts.SourceFile)) {
      discovered.push({ packageName, subpath, name, entry });
    }
  }
  const unique = new Map<string, ICapabilityExport>();
  for (const capability of discovered) unique.set(capabilityKey(capability), capability);
  return [...unique.values()].sort((left, right) =>
    capabilityKey(left).localeCompare(capabilityKey(right)),
  );
}

/** The doc-tag completeness verdict for one manifest entry. */
export function missingDocTags(entry: IManifestEntry | undefined): readonly DocTagRequirement[] {
  if (entry === undefined) return ["@example", "@situation", "summary"];
  const missing: DocTagRequirement[] = [];
  // The manifest generator stores `symbol` in place of an empty summary, so a summary equal to
  // the symbol means nobody wrote one.
  if (entry.summary.trim().length === 0 || entry.summary.trim() === entry.symbol)
    missing.push("summary");
  if (entry.situations.length === 0) missing.push("@situation");
  if (entry.example.trim().length === 0) missing.push("@example");
  return missing;
}

interface ICapabilityManifestPackageEntry {
  readonly package?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function manifestPackageNames(root: string): Promise<ReadonlySet<string>> {
  const manifestFile = path.join(root, MANIFEST_RELATIVE_PATH);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestFile, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `CAPABILITY_PACKAGE_CENSUS_MANIFEST_INVALID: ${manifestFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.entries)) {
    throw new Error(
      `CAPABILITY_PACKAGE_CENSUS_MANIFEST_INVALID: ${manifestFile} must contain an entries array.`,
    );
  }
  const packages = new Set<string>();
  for (const [index, rawEntry] of parsed.entries.entries()) {
    if (!isRecord(rawEntry)) {
      throw new Error(
        `CAPABILITY_PACKAGE_CENSUS_MANIFEST_INVALID: ${manifestFile} entry ${String(index)} is not an object.`,
      );
    }
    const packageName = (rawEntry as ICapabilityManifestPackageEntry).package;
    if (typeof packageName !== "string" || packageName.trim().length === 0) {
      throw new Error(
        `CAPABILITY_PACKAGE_CENSUS_MANIFEST_INVALID: ${manifestFile} entry ${String(index)} has no package name.`,
      );
    }
    packages.add(packageName);
  }
  return packages;
}

/**
 * Import every package-backed capability from its published export map. This intentionally uses
 * the package's built output; rewriting export-map targets to `src` would prove the development
 * tree while leaving the package an agent installs untested.
 */
export async function checkBuiltCapabilityImports(
  root: string,
): Promise<ICapabilityBuiltImportReport> {
  const manifestFile = path.join(root, MANIFEST_RELATIVE_PATH);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestFile, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `CAPABILITY_BUILT_IMPORT_MANIFEST_INVALID: ${manifestFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.entries)) {
    throw new Error(
      `CAPABILITY_BUILT_IMPORT_MANIFEST_INVALID: ${manifestFile} must contain an entries array.`,
    );
  }

  const byImportPath = new Map<string, string[]>();
  let skippedSourceEntries = 0;
  for (const [index, rawEntry] of parsed.entries.entries()) {
    if (
      !isRecord(rawEntry) ||
      typeof rawEntry.importPath !== "string" ||
      typeof rawEntry.symbol !== "string"
    ) {
      throw new Error(
        `CAPABILITY_BUILT_IMPORT_MANIFEST_INVALID: ${manifestFile} entry ${String(index)} needs importPath and symbol strings.`,
      );
    }
    if (!isBuiltImportPath(rawEntry.importPath)) {
      skippedSourceEntries += 1;
      continue;
    }
    const symbols = byImportPath.get(rawEntry.importPath) ?? [];
    if (!symbols.includes(rawEntry.symbol)) symbols.push(rawEntry.symbol);
    byImportPath.set(rawEntry.importPath, symbols);
  }

  let checkedSymbols = 0;
  for (const [importPath, symbols] of byImportPath) {
    const firstSymbol = symbols[0] ?? "<unknown>";
    let resolved: string;
    try {
      resolved = await resolveBuiltCapabilityImport(root, importPath);
    } catch (error) {
      throw new Error(
        `CAPABILITY_BUILT_IMPORT_MISSING: ${importPath}#${firstSymbol} could not resolve from the package export map: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (importPath.startsWith("@threenative/") && !resolved.split(path.sep).includes("dist")) {
      throw new Error(
        `CAPABILITY_BUILT_IMPORT_NOT_DIST: ${importPath}#${firstSymbol} resolved to ${resolved}; engine capability imports must resolve from dist.`,
      );
    }
    let namespace: Record<string, unknown>;
    try {
      namespace = (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `CAPABILITY_BUILT_IMPORT_FAILED: ${importPath}#${firstSymbol} could not import ${resolved}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const symbol of symbols) {
      checkedSymbols += 1;
      if (hasBuiltSymbol(namespace, symbol)) continue;
      throw new Error(
        `CAPABILITY_BUILT_SYMBOL_MISSING: ${importPath}#${symbol} is not an own named export of ${resolved}.`,
      );
    }
  }
  return {
    checkedImportPaths: byImportPath.size,
    checkedSymbols,
    skippedSourceEntries,
  };
}

export function formatCapabilityBuiltImportReport(report: ICapabilityBuiltImportReport): string {
  return `capability built imports: ${report.checkedSymbols} symbols across ${report.checkedImportPaths} import paths verified from built package output (${report.skippedSourceEntries} generated-source entries skipped)`;
}

/**
 * Ensure every public workspace package with code exports is either represented in the generated
 * manifest or explicitly omitted with a reason. The manifest is the observable walked set: this
 * catches a stale or reverted package walk as well as a newly added package.
 */
export async function checkCapabilityPackageCensus(
  root: string,
  allowlist: Readonly<Record<string, string>> = CAPABILITY_PACKAGE_ALLOWLIST,
): Promise<ICapabilityPackageCensusReport> {
  validateCapabilityPackageAllowlist(allowlist);
  const allPackages = workspacePackages(root);
  const inScope = publicWorkspacePackagesWithExports(root)
    .map(({ name }) => name)
    .sort();
  const allowlisted = Object.keys(allowlist)
    .filter((name) => allPackages.some((item) => item.name === name))
    .sort();
  const manifestPackages = await manifestPackageNames(root);
  const walked = inScope.filter((name) => manifestPackages.has(name));
  const uncovered = inScope.filter(
    (name) => !manifestPackages.has(name) && allowlist[name] === undefined,
  );
  if (uncovered.length > 0) {
    throw new Error(
      `CAPABILITY_PACKAGE_CENSUS_UNCOVERED: ${uncovered.join(", ")} has a public exports map and no capability coverage; add the package to the derived manifest walk or allowlist it with a non-empty one-line reason.`,
    );
  }
  return { allowlisted, inScope, walked };
}

export function formatCapabilityPackageCensus(report: ICapabilityPackageCensusReport): string {
  return `capability package census: ${report.walked.length} walked, ${report.allowlisted.length} allowlisted, ${report.inScope.length} public packages with code exports`;
}

/**
 * Check every scanned export against the committed manifest's doc tags. The manifest itself is
 * freshness-gated by `check-budgets.ts`, so these tags are the tree's own words, never stale.
 */
export async function findDocTagGaps(
  root: string,
  capabilities: readonly ICapabilityExport[],
  allowlist: Readonly<Record<string, string>> = INTERNAL_ALLOWLIST,
): Promise<readonly ICapabilityTagGap[]> {
  validateInternalAllowlist(allowlist);
  const manifestFile = path.join(root, MANIFEST_RELATIVE_PATH);
  const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as {
    entries: IManifestEntry[];
  };
  const byKey = new Map(
    manifest.entries.map((entry) => [`${entry.importPath}#${entry.symbol}`, entry]),
  );
  const gaps: ICapabilityTagGap[] = [];
  for (const capability of capabilities) {
    if (allowlist[capabilityKey(capability)] !== undefined) continue;
    const missing = missingDocTags(byKey.get(capabilityKey(capability)));
    if (missing.length > 0) gaps.push({ capability, missing });
  }
  return gaps;
}

export async function checkCapabilityDocs(root: string): Promise<ICapabilityDocReport> {
  validateInternalAllowlist();
  const exports = await collectPublicExports(root);
  if (exports.length === 0) throw new Error("CAPABILITY_DOCS_NO_PUBLIC_EXPORTS: scan was empty");
  return { exports, gaps: await findDocTagGaps(root, exports) };
}

export function formatCapabilityReport(report: ICapabilityDocReport): string {
  if (report.gaps.length === 0) {
    return `capability docs: ${report.exports.length} public class/function exports carry complete doc tags`;
  }
  const lines = [
    `CAPABILITY_DOCS_INCOMPLETE: ${report.gaps.length} public class/function exports have incomplete doc tags`,
  ];
  for (const { capability, missing } of report.gaps) {
    lines.push(
      `- ${moduleSpecifier(capability)}: ${capability.name}; missing ${missing.join(", ")}`,
    );
  }
  return lines.join("\n");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  if (process.argv.slice(2).some((argument) => argument !== "--census")) {
    console.error("usage: check-capability-docs.ts [--census]");
    process.exitCode = 1;
  } else {
    Promise.all([
      checkCapabilityPackageCensus(process.cwd()),
      checkCapabilityDocs(process.cwd()),
      checkBuiltCapabilityImports(process.cwd()),
    ])
      .then(([census, report, builtImports]) => {
        console.log(formatCapabilityPackageCensus(census));
        console.log(formatCapabilityBuiltImportReport(builtImports));
        const output = formatCapabilityReport(report);
        if (report.gaps.length > 0) {
          console.error(output);
          process.exitCode = 1;
        } else {
          console.log(output);
        }
      })
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
