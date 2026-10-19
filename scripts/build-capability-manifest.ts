import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

import { RELEVANCE_FLOOR, capabilitySituationTokens } from "../packages/engine-mcp/src/index.js";
import { CAPABILITY_PACKAGE_ALLOWLIST, isPublicClassOrFunction } from "./check-capability-docs.js";
import { type INotOwnedCapability, NOT_OWNED_CAPABILITIES } from "./not-owned-capabilities.js";
import {
  REALISM_EFFECTS_COVERAGE,
  REALISM_EFFECTS_MANIFEST_ENTRIES,
  validateRealismEffectsCoverage,
} from "./realism-effects-coverage.js";
import { RENDER_CHAIN_MANIFEST_ENTRIES } from "./render-chain-capabilities.js";
import { publicWorkspacePackagesWithExports } from "./workspace-packages.js";

export const CAPABILITY_MANIFEST_RELATIVE_PATH = "packages/create-threenative/capabilities.json";
// `@threenative/core` ships the same manifest so the capability MCP server still answers in a
// project that was not scaffolded and therefore has no committed copy of its own.
export const CAPABILITY_MANIFEST_MIRROR_PATH = "packages/core/capabilities.json";

const MANIFEST_VERSION = 2 as const;

export type CapabilityKind = "class" | "function";

export interface ICapabilityManifestEntry {
  readonly symbol: string;
  readonly package: string;
  readonly importPath: string;
  readonly kind: CapabilityKind;
  readonly signature: string;
  readonly summary: string;
  readonly situations: readonly string[];
  readonly aliases?: readonly string[];
  readonly example: string;
  readonly constraints: readonly string[];
  readonly overrides: readonly string[];
  readonly requires?: readonly string[];
  readonly supersedes: readonly string[];
  readonly deprecated?: readonly string[];
}

export interface ICapabilityManifest {
  readonly version: typeof MANIFEST_VERSION;
  readonly entries: readonly ICapabilityManifestEntry[];
  readonly notOwned: readonly INotOwnedCapability[];
}

export interface ICapabilityAllowlistEntry {
  readonly package: string;
  readonly symbol: string;
  readonly reason: string;
}

interface IParsedDocumentation {
  readonly summary: string;
  readonly situations: readonly string[];
  readonly aliases: readonly string[];
  readonly example: string;
  readonly constraints: readonly string[];
  readonly overrides: readonly string[];
  readonly requires: readonly string[];
  readonly supersedes: readonly string[];
  readonly deprecated: readonly string[];
}

interface IRawExport {
  readonly symbol: string;
  readonly declaration: ts.Declaration;
  readonly documentation: IParsedDocumentation;
}

interface ICapabilityCandidate extends IRawExport {
  readonly packageName: string;
  readonly importPath: string;
  readonly kind: CapabilityKind;
}

const EMPTY_DOCUMENTATION: IParsedDocumentation = {
  aliases: [],
  constraints: [],
  deprecated: [],
  example: "",
  overrides: [],
  requires: [],
  situations: [],
  summary: "",
  supersedes: [],
};

/**
 * Exports intentionally excluded from this manifest must be named here with a reason. The list is
 * empty today: every exported class and function is a discoverable engine capability.
 */
export const CAPABILITY_ALLOWLIST: readonly ICapabilityAllowlistEntry[] = [];

export function validateCapabilityAllowlist(allowlist: readonly ICapabilityAllowlistEntry[]): void {
  const invalid = allowlist.filter(
    (entry) =>
      entry.reason.trim().length === 0 ||
      entry.package.trim().length === 0 ||
      entry.symbol.trim().length === 0,
  );
  if (invalid.length === 0) return;
  throw new Error(
    `Capability allowlist entries require non-empty package, symbol, and reason: ${invalid
      .map((entry) => `${entry.package}:${entry.symbol}`)
      .join(", ")}`,
  );
}

function packageName(packageDirectory: string): string {
  const packageFile = path.join(packageDirectory, "package.json");
  const manifest = JSON.parse(readFileSync(packageFile)) as { name?: unknown };
  if (typeof manifest.name !== "string" || manifest.name.trim().length === 0) {
    throw new Error(`Capability package manifest has no name: ${packageFile}`);
  }
  return manifest.name;
}

function readFileSync(file: string): string {
  // The package manifests are tiny and this keeps export-map discovery synchronous while the AST
  // walk remains deterministic. All generated output is still written asynchronously below.
  return ts.sys.readFile(file) ?? "";
}

function conditionTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const target = conditionTarget(item);
      if (target !== undefined) return target;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["types", "import", "default", "require"]) {
    const target = conditionTarget(record[key]);
    if (target !== undefined) return target;
  }
  for (const item of Object.values(record)) {
    const target = conditionTarget(item);
    if (target !== undefined) return target;
  }
  return undefined;
}

function exportMapEntries(value: unknown): Array<[string, string]> {
  if (typeof value === "string" || Array.isArray(value)) {
    const target = conditionTarget(value);
    return target === undefined ? [] : [[".", target]];
  }
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const subpaths = Object.keys(record).filter((key) => key.startsWith("."));
  if (subpaths.length === 0) {
    const target = conditionTarget(value);
    return target === undefined ? [] : [[".", target]];
  }
  return subpaths.flatMap((subpath) => {
    const target = conditionTarget(record[subpath]);
    return target === undefined ? [] : [[subpath, target]];
  });
}

function sourceCandidates(packageDirectory: string, target: string): string[] {
  const relative = target
    .replace(/^\.\/dist\//u, "src/")
    .replace(/^\.\/src\//u, "src/")
    .replace(/^dist\//u, "src/")
    .replace(/^src\//u, "src/");
  const withoutDeclaration = relative.endsWith(".d.ts")
    ? relative.slice(0, -5)
    : relative.replace(/\.tsx?$/u, "");
  const candidates = [
    path.join(packageDirectory, `${withoutDeclaration}.ts`),
    path.join(packageDirectory, `${withoutDeclaration}.tsx`),
    path.join(packageDirectory, withoutDeclaration, "index.ts"),
    path.join(packageDirectory, withoutDeclaration, "index.tsx"),
  ];
  return [...new Set(candidates)];
}

function sourceFileForTarget(packageDirectory: string, target: string): string {
  const source = sourceCandidates(packageDirectory, target).find((file) => existsSync(file));
  if (source === undefined) {
    throw new Error(
      `Capability export target has no source file: ${path.join(packageDirectory, "package.json")} -> ${target}`,
    );
  }
  return source;
}

function parseSource(file: string): ts.SourceFile {
  const source = ts.sys.readFile(file);
  if (source === undefined) throw new Error(`Capability source file is unreadable: ${file}`);
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function resolveRelativeModule(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const withoutExtension = specifier.replace(/\.(?:[cm]?js|jsx|tsx?)$/u, "");
  const base = path.resolve(path.dirname(from), withoutExtension);
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];
  return candidates.find((file) => existsSync(file));
}

function documentationComment(source: ts.SourceFile, node: ts.Node): string | undefined {
  const prefix = source.text.slice(node.getFullStart(), node.getStart(source));
  const comments = [...prefix.matchAll(/\/\*\*([\s\S]*?)\*\//gu)];
  const comment = comments.at(-1)?.[1];
  return comment;
}

function parseDocumentation(comment: string | undefined): IParsedDocumentation {
  if (comment === undefined) return EMPTY_DOCUMENTATION;
  const lines = comment.split(/\r?\n/u).map((line) => line.replace(/^\s*\* ?/u, "").trimEnd());
  const situations: string[] = [];
  const aliases: string[] = [];
  const constraints: string[] = [];
  const overrides: string[] = [];
  const requires: string[] = [];
  const supersedes: string[] = [];
  const deprecated: string[] = [];
  const exampleLines: string[] = [];
  const summaryLines: string[] = [];
  let inExample = false;
  for (const line of lines) {
    const tag =
      /^@(situation|alias|constraint|example|override|requires|supersedes|deprecatedOption)\b(?:\s+(.*))?$/u.exec(
        line,
      );
    if (tag !== null) {
      inExample = tag[1] === "example";
      const value = tag[2]?.trim() ?? "";
      if (tag[1] === "situation" && value.length > 0) situations.push(value);
      if (tag[1] === "alias" && value.length > 0) aliases.push(value);
      if (tag[1] === "constraint" && value.length > 0) constraints.push(value);
      if (tag[1] === "override" && value.length > 0) overrides.push(value);
      if (tag[1] === "requires" && value.length > 0) requires.push(value);
      if (tag[1] === "supersedes" && value.length > 0) supersedes.push(value);
      if (tag[1] === "deprecatedOption" && value.length > 0) deprecated.push(value);
      if (tag[1] === "example" && value.length > 0) exampleLines.push(value);
      continue;
    }
    if (inExample) {
      if (line.length > 0) exampleLines.push(line);
      continue;
    }
    if (line.length > 0) summaryLines.push(line);
  }
  const example = exampleLines
    .filter((line) => !/^```/u.test(line))
    .join("\n")
    .trim();
  return {
    aliases: [...new Set(aliases)],
    constraints: [...new Set(constraints)],
    deprecated: [...new Set(deprecated)],
    example,
    overrides: [...new Set(overrides)],
    requires: [...new Set(requires)],
    situations: [...new Set(situations)],
    summary: summaryLines.join(" ").trim(),
    supersedes: [...new Set(supersedes)],
  };
}

function mergeDocumentation(
  primary: IParsedDocumentation,
  fallback: IParsedDocumentation,
): IParsedDocumentation {
  return {
    aliases: [...new Set([...primary.aliases, ...fallback.aliases])],
    constraints: [...new Set([...primary.constraints, ...fallback.constraints])],
    deprecated: [...new Set([...primary.deprecated, ...fallback.deprecated])],
    example: primary.example || fallback.example,
    overrides: [...new Set([...primary.overrides, ...fallback.overrides])],
    requires: [...new Set([...primary.requires, ...fallback.requires])],
    situations: [...new Set([...primary.situations, ...fallback.situations])],
    summary: primary.summary || fallback.summary,
    supersedes: [...new Set([...primary.supersedes, ...fallback.supersedes])],
  };
}

function declarationName(node: ts.Node): string | undefined {
  if (
    ts.isClassDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node)
  ) {
    return node.name?.text;
  }
  if (ts.isVariableStatement(node)) return undefined;
  if (ts.isVariableDeclaration(node)) {
    return ts.isIdentifier(node.name) ? node.name.text : undefined;
  }
  return undefined;
}

function localDeclaration(source: ts.SourceFile, name: string): ts.Declaration | undefined {
  for (const statement of source.statements) {
    const directName = declarationName(statement);
    if (directName === name) return statement as unknown as ts.Declaration;
    if (ts.isVariableStatement(statement)) {
      const variable = statement.declarationList.declarations.find(
        (declaration) => declarationName(declaration) === name,
      );
      if (variable !== undefined) return variable;
    }
  }
  return undefined;
}

function classifyDeclaration(node: ts.Declaration): CapabilityKind | undefined {
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isVariableDeclaration(node)) {
    const initializer = node.initializer;
    if (
      initializer !== undefined &&
      (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
    ) {
      return "function";
    }
  }
  return undefined;
}

function declarationDocumentation(node: ts.Declaration): IParsedDocumentation {
  return parseDocumentation(documentationComment(node.getSourceFile(), node));
}

function exportedName(specifier: ts.ExportSpecifier): string {
  return specifier.name.text;
}

function collectModuleExports(file: string, seen: Set<string> = new Set()): IRawExport[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const source = parseSource(file);
  const result: IRawExport[] = [];
  const byName = new Map<string, IRawExport>();
  const add = (entry: IRawExport): void => {
    if (!byName.has(entry.symbol)) {
      byName.set(entry.symbol, entry);
      result.push(entry);
    }
  };
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      const moduleSpecifier = statement.moduleSpecifier;
      if (moduleSpecifier === undefined || !ts.isStringLiteral(moduleSpecifier)) continue;
      const target = resolveRelativeModule(file, moduleSpecifier.text);
      if (target === undefined) continue;
      const targetExports = collectModuleExports(target, new Set(seen));
      const statementDocumentation = parseDocumentation(documentationComment(source, statement));
      if (statement.exportClause === undefined) {
        for (const entry of targetExports) {
          add({
            ...entry,
            documentation: mergeDocumentation(statementDocumentation, entry.documentation),
          });
        }
        continue;
      }
      if (!ts.isNamedExports(statement.exportClause)) continue;
      for (const specifier of statement.exportClause.elements) {
        if (specifier.isTypeOnly) continue;
        const original = (specifier.propertyName ?? specifier.name).text;
        const targetEntry = targetExports.find((entry) => entry.symbol === original);
        if (targetEntry === undefined) continue;
        const specifierDocumentation = parseDocumentation(documentationComment(source, specifier));
        add({
          ...targetEntry,
          documentation: mergeDocumentation(
            mergeDocumentation(statementDocumentation, specifierDocumentation),
            targetEntry.documentation,
          ),
          symbol: exportedName(specifier),
        });
      }
      continue;
    }

    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) !== true)
      continue;
    if (ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) {
      const name = statement.name?.text;
      if (name === undefined) continue;
      add({
        declaration: statement,
        documentation: declarationDocumentation(statement),
        symbol: name,
      });
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      const statementDocumentation = parseDocumentation(documentationComment(source, statement));
      for (const variable of statement.declarationList.declarations) {
        const name = declarationName(variable);
        if (name === undefined) continue;
        add({
          declaration: variable,
          documentation: mergeDocumentation(
            statementDocumentation,
            declarationDocumentation(variable),
          ),
          symbol: name,
        });
      }
    }
  }
  return result;
}

function signature(node: ts.Declaration): string {
  const text = node.getText(node.getSourceFile()).replace(/\s+/gu, " ").trim();
  const brace = text.indexOf("{");
  const header = brace === -1 ? text : `${text.slice(0, brace).trim()} { … }`;
  return header.length > 500 ? `${header.slice(0, 497)}...` : header;
}

function importPath(packageNameValue: string, subpath: string): string {
  return subpath === "." ? packageNameValue : `${packageNameValue}${subpath.slice(1)}`;
}

/** Derive the walked package directories from public workspace export maps. */
function capabilityPackageDirectories(root: string): readonly string[] {
  return publicWorkspacePackagesWithExports(root, { requireVersion: false })
    .filter(({ name }) => CAPABILITY_PACKAGE_ALLOWLIST[name] === undefined)
    .map(({ directory }) => directory);
}

interface IPackageEntrySource {
  readonly packageName: string;
  readonly subpath: string;
  readonly source: string;
}

function packageEntrySources(packageDirectory: string): IPackageEntrySource[] {
  const packageFile = path.join(packageDirectory, "package.json");
  if (!existsSync(packageFile)) return [];
  const manifest = JSON.parse(readFileSync(packageFile)) as { exports?: unknown };
  if (manifest.exports === undefined) return [];
  const name = packageName(packageDirectory);
  return exportMapEntries(manifest.exports)
    .filter(([subpath]) => subpath !== "./package.json")
    .map(([subpath, target]) => ({
      packageName: name,
      source: sourceFileForTarget(packageDirectory, target),
      subpath,
    }));
}

/**
 * The export names the type checker sees as callable or constructible, per entry source. The
 * syntactic classifier alone let `export const alias = other` and `export const f = upstream.f`
 * ship without a manifest entry; this is the same predicate the docs gate uses, so the two agree.
 */
function callableExportNames(sources: readonly string[]): ReadonlyMap<string, ReadonlySet<string>> {
  const program = ts.createProgram({
    options: {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
    },
    rootNames: [...sources],
  });
  const checker = program.getTypeChecker();
  const result = new Map<string, ReadonlySet<string>>();
  for (const source of sources) {
    const file = program.getSourceFile(source);
    const module = file === undefined ? undefined : checker.getSymbolAtLocation(file);
    const names = new Set<string>();
    for (const symbol of module === undefined ? [] : checker.getExportsOfModule(module)) {
      if (isPublicClassOrFunction(checker, symbol)) names.add(symbol.getName());
    }
    result.set(source, names);
  }
  return result;
}

function packageExportCandidates(root: string): ICapabilityCandidate[] {
  const entries = capabilityPackageDirectories(root).flatMap(packageEntrySources);
  const callable = callableExportNames(entries.map(({ source }) => source));
  return entries.flatMap(({ packageName: name, source, subpath }) =>
    collectModuleExports(source).flatMap((entry): ICapabilityCandidate[] => {
      const kind =
        classifyDeclaration(entry.declaration) ??
        (callable.get(source)?.has(entry.symbol) === true ? "function" : undefined);
      if (kind === undefined) return [];
      return [{ ...entry, importPath: importPath(name, subpath), kind, packageName: name }];
    }),
  );
}

function validateDocumentation(candidates: readonly ICapabilityCandidate[]): void {
  const missing = candidates.filter((candidate) => candidate.documentation.situations.length === 0);
  const oversized = candidates.filter(
    (candidate) =>
      candidate.documentation.example.split("\n").filter((line) => line.length > 0).length > 10,
  );
  const errors: string[] = [];
  if (missing.length > 0) {
    errors.push(
      `public exports without @situation tags: ${missing
        .map(
          (candidate) => `${candidate.packageName}:${candidate.symbol} (${candidate.importPath})`,
        )
        .join(", ")}`,
    );
  }
  if (oversized.length > 0) {
    errors.push(
      `examples must be at most 10 lines: ${oversized
        .map((candidate) => `${candidate.packageName}:${candidate.symbol}`)
        .join(", ")}`,
    );
  }
  if (errors.length > 0)
    throw new Error(`Capability manifest generation failed:\n${errors.join("\n")}`);
}

function notOwnedOverlap(
  situation: string,
  entry: ICapabilityManifestEntry,
):
  | { readonly matchedSituation: string; readonly overlap: number; readonly score: number }
  | undefined {
  const query = capabilitySituationTokens(situation);
  if (query.length === 0) return undefined;
  const queryText = query.join(" ");
  let best:
    | { readonly matchedSituation: string; readonly overlap: number; readonly score: number }
    | undefined;
  for (const ownedSituation of [...entry.situations, ...(entry.aliases ?? [])]) {
    const phrase = capabilitySituationTokens(ownedSituation);
    const overlap = new Set(phrase.filter((token) => query.includes(token))).size;
    const baseScore = overlap / Math.max(query.length, phrase.length);
    const phraseBonus =
      phrase.join(" ").includes(queryText) || queryText.includes(phrase.join(" ")) ? 1 : 0;
    if (overlap < (query.length >= 4 ? 2 : 1) && phraseBonus === 0) continue;
    const score = baseScore + phraseBonus;
    if (best === undefined || score > best.score) {
      best = { matchedSituation: ownedSituation, overlap, score };
    }
  }
  return best;
}

export const MAX_ALIAS_FANOUT = 2;

function validateAliasFanout(entries: readonly ICapabilityManifestEntry[]): void {
  const fanout = new Map<
    string,
    {
      readonly display: string;
      readonly owners: Array<{ readonly importPath: string; readonly symbol: string }>;
    }
  >();
  for (const entry of entries) {
    const normalizedAliases = new Map(
      (entry.aliases ?? [])
        .map((alias) => [capabilitySituationTokens(alias).join("\u0000"), alias] as const)
        .filter(([alias]) => alias.length > 0),
    );
    for (const [alias, authoredAlias] of normalizedAliases) {
      const group = fanout.get(alias) ?? {
        display: authoredAlias
          .toLocaleLowerCase()
          .replace(/[^a-z0-9]+/gu, " ")
          .trim(),
        owners: [],
      };
      group.owners.push({ importPath: entry.importPath, symbol: entry.symbol });
      fanout.set(alias, group);
    }
  }
  const violations = [...fanout.entries()]
    .filter(([, group]) => group.owners.length > MAX_ALIAS_FANOUT)
    .map(
      ([, group]) =>
        `alias '${group.display}' appears in ${group.owners.length} entries (maximum ${MAX_ALIAS_FANOUT}): ${group.owners
          .map((owner) => `${owner.symbol} (${owner.importPath})`)
          .join(", ")}`,
    );
  if (violations.length > 0) {
    throw new Error(
      `Capability manifest generation failed; alias fanout exceeded:\n${violations.join("\n")}`,
    );
  }
}

export function validateNotOwned(
  entries: readonly ICapabilityManifestEntry[],
  notOwned: readonly INotOwnedCapability[],
): void {
  const conflicts: string[] = [];
  for (const notOwnedEntry of notOwned) {
    for (const entry of entries) {
      const overlap = notOwnedEntry.situations
        .map((situation) => ({ situation, result: notOwnedOverlap(situation, entry) }))
        .find(
          (
            candidate,
          ): candidate is {
            readonly situation: string;
            readonly result: {
              readonly matchedSituation: string;
              readonly overlap: number;
              readonly score: number;
            };
          } =>
            candidate.result !== undefined &&
            candidate.result.score >= RELEVANCE_FLOOR &&
            (candidate.result.overlap >= 2 ||
              capabilitySituationTokens(candidate.result.matchedSituation)
                .join(" ")
                .includes(capabilitySituationTokens(candidate.situation).join(" ")) ||
              capabilitySituationTokens(candidate.situation)
                .join(" ")
                .includes(capabilitySituationTokens(candidate.result.matchedSituation).join(" "))),
        );
      if (overlap !== undefined) {
        conflicts.push(
          `notOwned '${notOwnedEntry.id}' situation '${overlap.situation}' overlaps owned capability '${entry.symbol}' situation '${overlap.result.matchedSituation}' at score ${overlap.result.score.toFixed(6)}`,
        );
      }
    }
  }
  if (conflicts.length > 0) {
    throw new Error(
      `Capability manifest generation failed; a mechanic cannot be both owned and not owned:\n${conflicts.join("\n")}`,
    );
  }
}

export function buildCapabilityManifest(
  root: string,
  allowlist: readonly ICapabilityAllowlistEntry[] = CAPABILITY_ALLOWLIST,
  notOwned: readonly INotOwnedCapability[] = NOT_OWNED_CAPABILITIES,
): ICapabilityManifest {
  validateCapabilityAllowlist(allowlist);
  const candidates = packageExportCandidates(root);
  const allowlisted = new Set(allowlist.map((entry) => `${entry.package}:${entry.symbol}`));
  const documentedCandidates = candidates.filter(
    (candidate) => !allowlisted.has(`${candidate.packageName}:${candidate.symbol}`),
  );
  validateDocumentation(documentedCandidates);
  const entries: ICapabilityManifestEntry[] = [
    ...documentedCandidates.map((candidate) => ({
      aliases: candidate.documentation.aliases,
      constraints: candidate.documentation.constraints,
      // Optional and omitted when untagged: a capability with nothing deprecated must not answer
      // a detail lookup with a key, or every reader learns to check for an empty list.
      ...(candidate.documentation.deprecated.length > 0
        ? { deprecated: candidate.documentation.deprecated }
        : {}),
      example: candidate.documentation.example,
      importPath: candidate.importPath,
      kind: candidate.kind,
      overrides: candidate.documentation.overrides,
      package: candidate.packageName,
      ...(candidate.documentation.requires.length > 0
        ? { requires: candidate.documentation.requires }
        : {}),
      signature: signature(candidate.declaration),
      situations: candidate.documentation.situations,
      summary: candidate.documentation.summary || candidate.symbol,
      supersedes: candidate.documentation.supersedes,
      symbol: candidate.symbol,
    })),
    ...REALISM_EFFECTS_MANIFEST_ENTRIES.map((entry) => ({ ...entry, aliases: [] })),
    ...RENDER_CHAIN_MANIFEST_ENTRIES.map((entry) => ({
      ...entry,
      aliases: entry.aliases ?? [],
    })),
  ].sort((left, right) =>
    `${left.importPath}:${left.symbol}`.localeCompare(`${right.importPath}:${right.symbol}`),
  );
  validateAliasFanout(entries);
  validateNotOwned(entries, notOwned);
  // Fixture roots used by the manifest unit tests intentionally contain only synthetic package
  // sources. The checked-in realism-effects mapping is validated when the repository has its PRD
  // record; requiring those unrelated fixture trees to copy Three and every template would make
  // the generic manifest builder impossible to exercise in isolation.
  if (existsSync(path.join(root, "docs", "PRDs", "realism-effects"))) {
    const coverageErrors = validateRealismEffectsCoverage({
      coverage: REALISM_EFFECTS_COVERAGE,
      manifest: entries,
      root,
    });
    if (coverageErrors.length > 0) {
      throw new Error(`Realism-effects coverage validation failed:\n${coverageErrors.join("\n")}`);
    }
  }
  return { entries, notOwned, version: MANIFEST_VERSION };
}

function manifestPath(root: string): string {
  return path.join(root, CAPABILITY_MANIFEST_RELATIVE_PATH);
}

function manifestPaths(root: string): readonly string[] {
  return [manifestPath(root), path.join(root, CAPABILITY_MANIFEST_MIRROR_PATH)];
}

export interface IScaffoldDependencyClosure {
  readonly packages: readonly string[];
  readonly sourceImports: readonly string[];
  readonly template: string;
}

export interface ICapabilityScaffoldImportProblem {
  readonly importPath: string;
  readonly packageName: string;
  readonly reason: string;
  readonly symbol: string;
  readonly template: string;
}

export interface ICapabilityScaffoldImportReport {
  readonly checkedEntries: number;
  readonly problems: readonly ICapabilityScaffoldImportProblem[];
  readonly requiredEntries: number;
  readonly resolvedEntries: number;
  readonly templates: readonly IScaffoldDependencyClosure[];
}

const TEMPLATE_SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);
const TEMPLATE_SOURCE_EXCLUSIONS = new Set(["dist", "node_modules"]);
const TEMPLATE_PACKAGE_FIELDS = ["dependencies", "devDependencies"] as const;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function manifestImportPackageName(importPathValue: string): string | undefined {
  if (
    importPathValue.startsWith("src/") ||
    importPathValue.startsWith("@threenative/template/") ||
    importPathValue.startsWith(".") ||
    importPathValue.startsWith("node:")
  )
    return undefined;
  const parts = importPathValue.split("/");
  const count = importPathValue.startsWith("@") ? 2 : 1;
  const name = parts.slice(0, count).join("/");
  return name.length === 0 ? undefined : name;
}

function templatePackageNames(manifest: Record<string, unknown>): readonly string[] {
  const packages = new Set<string>();
  for (const field of TEMPLATE_PACKAGE_FIELDS) {
    const block = manifest[field];
    if (!isObjectRecord(block)) continue;
    for (const name of Object.keys(block)) packages.add(name);
  }
  return [...packages].sort((left, right) => left.localeCompare(right));
}

async function templateFilesUnder(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (TEMPLATE_SOURCE_EXCLUSIONS.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await templateFilesUnder(absolute)));
    } else if (entry.isFile() && TEMPLATE_SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(absolute);
    }
  }
  return files;
}

function sourceKind(file: string): ts.ScriptKind {
  const extension = path.extname(file);
  if (extension === ".tsx" || extension === ".jsx") return ts.ScriptKind.TSX;
  if (extension === ".js") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function importedPackageName(specifier: string): string | undefined {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    specifier.startsWith("node:")
  )
    return undefined;
  const parts = specifier.split("/");
  const count = specifier.startsWith("@") ? 2 : 1;
  const name = parts.slice(0, count).join("/");
  return name.length === 0 ? undefined : name;
}

async function templateSourceImportPackages(directory: string): Promise<readonly string[]> {
  const packages = new Set<string>();
  for (const file of await templateFilesUnder(directory)) {
    const source = ts.createSourceFile(
      file,
      await readFile(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      sourceKind(file),
    );
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const name = importedPackageName(node.moduleSpecifier.text);
        if (name !== undefined) packages.add(name);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0];
        if (node.arguments.length === 1 && argument !== undefined && ts.isStringLiteral(argument)) {
          const name = importedPackageName(argument.text);
          if (name !== undefined) packages.add(name);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...packages].sort((left, right) => left.localeCompare(right));
}

export async function scaffoldDependencyClosures(
  root: string,
): Promise<readonly IScaffoldDependencyClosure[]> {
  const templatesRoot = path.join(root, "packages", "create-threenative", "templates");
  if (!existsSync(templatesRoot)) {
    throw new Error(`capability scaffold imports: templates root is missing at ${templatesRoot}`);
  }
  const templates: IScaffoldDependencyClosure[] = [];
  const entries = await readdir(templatesRoot, { withFileTypes: true }).catch((error: unknown) => {
    throw new Error(
      `capability scaffold imports: templates root is unreadable at ${templatesRoot}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  const templateDirectories = entries
    .filter((candidate) => candidate.isDirectory() && !candidate.name.startsWith("."))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (templateDirectories.length === 0) {
    throw new Error(
      `capability scaffold imports: no template closures discovered under ${templatesRoot}`,
    );
  }
  for (const entry of templateDirectories) {
    const directory = path.join(templatesRoot, entry.name);
    const packageFile = path.join(directory, "package.json");
    if (!existsSync(packageFile)) {
      throw new Error(
        `capability scaffold imports: template ${entry.name} package.json is missing at ${packageFile}`,
      );
    }
    let rawManifest: string;
    try {
      rawManifest = await readFile(packageFile, "utf8");
    } catch (error) {
      throw new Error(
        `capability scaffold imports: template ${entry.name} package.json is unreadable at ${packageFile}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(rawManifest);
    } catch (error) {
      throw new Error(
        `capability scaffold imports: template ${entry.name} package.json is invalid at ${packageFile}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!isObjectRecord(manifest)) {
      throw new Error(
        `capability scaffold imports: template ${entry.name} package.json is invalid at ${packageFile}: expected an object`,
      );
    }
    templates.push({
      packages: templatePackageNames(manifest),
      sourceImports: await templateSourceImportPackages(directory),
      template: entry.name,
    });
  }
  return templates;
}

function entryRequires(entry: ICapabilityManifestEntry): readonly string[] {
  return entry.requires ?? [];
}

export async function capabilityScaffoldImportReport(
  root: string,
  manifest: ICapabilityManifest,
): Promise<ICapabilityScaffoldImportReport> {
  const templates = await scaffoldDependencyClosures(root);
  if (templates.length === 0) {
    return {
      checkedEntries: 0,
      problems: [],
      requiredEntries: 0,
      resolvedEntries: 0,
      templates,
    };
  }

  const entriesByPackage = new Map<string, ICapabilityManifestEntry[]>();
  let checkedEntries = 0;
  let requiredEntries = 0;
  for (const entry of manifest.entries) {
    const packageNameValue = manifestImportPackageName(entry.importPath);
    if (packageNameValue === undefined) continue;
    checkedEntries += 1;
    if (entryRequires(entry).length > 0) requiredEntries += 1;
    const group = entriesByPackage.get(packageNameValue) ?? [];
    group.push(entry);
    entriesByPackage.set(packageNameValue, group);
  }

  // Every template is a project an agent can be working in, so each closure is checked on its
  // own: a package another template installs does not resolve in this one.
  const problems: ICapabilityScaffoldImportProblem[] = [];
  for (const template of templates) {
    const installed = new Set(template.packages);
    const imported = new Set(template.sourceImports);
    for (const [packageNameValue, entries] of entriesByPackage) {
      if (installed.has(packageNameValue)) continue;
      const sourceImported = imported.has(packageNameValue);
      for (const entry of entries) {
        if (!sourceImported && entryRequires(entry).length > 0) continue;
        problems.push({
          importPath: entry.importPath,
          packageName: packageNameValue,
          reason: sourceImported
            ? "template source imports this package but the generated package.json dependency closure omits it"
            : "this template's dependency closure does not install this package and the capability has no @requires install instruction",
          symbol: entry.symbol,
          template: template.template,
        });
      }
    }
  }
  const unresolved = new Set(problems.map((problem) => `${problem.importPath}#${problem.symbol}`));
  const unresolvedUndocumented = [...entriesByPackage.values()]
    .flat()
    .filter(
      (entry) =>
        entryRequires(entry).length === 0 && unresolved.has(`${entry.importPath}#${entry.symbol}`),
    ).length;

  return {
    checkedEntries,
    problems,
    requiredEntries,
    resolvedEntries: checkedEntries - requiredEntries - unresolvedUndocumented,
    templates,
  };
}

export function formatCapabilityScaffoldImportReport(
  report: ICapabilityScaffoldImportReport,
): string {
  return `capability scaffold imports: ${report.resolvedEntries + report.requiredEntries} of ${report.checkedEntries} package-backed entries resolvable or documented across ${report.templates.length} template closures (${report.requiredEntries} require install instructions, ${report.problems.length} unresolved template imports)`;
}

function formatCapabilityScaffoldImportErrors(report: ICapabilityScaffoldImportReport): string {
  return [
    `CAPABILITY_SCAFFOLD_IMPORT_UNRESOLVED: ${report.problems.length} manifest imports are unusable from scaffolded projects`,
    ...report.problems.map(
      (problem) =>
        `- ${problem.template}: ${problem.symbol} -> ${problem.importPath} (${problem.packageName}); ${problem.reason}`,
    ),
  ].join("\n");
}

export async function checkCapabilityScaffoldImports(
  root: string,
  manifest: ICapabilityManifest,
): Promise<ICapabilityScaffoldImportReport> {
  const report = await capabilityScaffoldImportReport(root, manifest);
  if (report.problems.length === 0) return report;
  throw new Error(formatCapabilityScaffoldImportErrors(report));
}

const JSON_LINE_WIDTH = 100;

function jsonIndent(level: number): string {
  return " ".repeat(level * 2);
}

function serialiseJson(value: unknown, level: number, propertyPrefix = ""): string {
  if (Array.isArray(value)) {
    const compact = `[${value.map((item) => JSON.stringify(item) ?? "null").join(", ")}]`;
    if ((jsonIndent(level) + propertyPrefix + compact).length < JSON_LINE_WIDTH) return compact;
    return `[
${value.map((item) => `${jsonIndent(level + 1)}${serialiseJson(item, level + 1)}`).join(",\n")}
${jsonIndent(level)}]`;
  }
  if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "null";
  const entries = Object.entries(value);
  return `{
${entries
  .map(([key, item], index) => {
    const prefix = `${JSON.stringify(key)}: `;
    const comma = index === entries.length - 1 ? "" : ",";
    return `${jsonIndent(level + 1)}${prefix}${serialiseJson(item, level + 1, prefix)}${comma}`;
  })
  .join("\n")}
${jsonIndent(level)}}`;
}

function serialiseManifest(manifest: ICapabilityManifest): string {
  return `${serialiseJson(manifest, 0)}\n`;
}

export async function writeCapabilityManifest(root: string): Promise<ICapabilityManifest> {
  const manifest = buildCapabilityManifest(root);
  const serialised = serialiseManifest(manifest);
  for (const file of manifestPaths(root)) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, serialised);
  }
  return manifest;
}

export async function checkCapabilityManifest(root: string): Promise<ICapabilityManifest> {
  const expectedManifest = buildCapabilityManifest(root);
  const expected = serialiseManifest(expectedManifest);
  const errors: string[] = [];
  const scaffoldReport = await capabilityScaffoldImportReport(root, expectedManifest);
  if (scaffoldReport.problems.length > 0) {
    errors.push(formatCapabilityScaffoldImportErrors(scaffoldReport));
  }
  let parsed: ICapabilityManifest | undefined;
  for (const file of manifestPaths(root)) {
    let actual: string;
    try {
      actual = await readFile(file, "utf8");
    } catch (error) {
      throw new Error(`Capability manifest is missing or unreadable at ${file}: ${String(error)}`);
    }
    try {
      parsed = JSON.parse(actual) as ICapabilityManifest;
    } catch (error) {
      throw new Error(`Capability manifest is unparseable at ${file}: ${String(error)}`);
    }
    if (actual !== expected) {
      errors.push(`Capability manifest is stale at ${file}; run pnpm build to regenerate it.`);
    }
  }
  if (parsed === undefined) throw new Error("Capability manifest has no destination to check.");
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return parsed;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const check = process.argv.includes("--check");
  const manifest = check
    ? await checkCapabilityManifest(root)
    : await writeCapabilityManifest(root);
  const scaffoldReport = await checkCapabilityScaffoldImports(root, manifest);
  process.stdout.write(
    `${check ? "capability manifest fresh" : "capability manifest generated"}: ${manifest.entries.length} entries and ${manifest.notOwned.length} notOwned rows at ${manifestPath(root)}\n`,
  );
  process.stdout.write(`${formatCapabilityScaffoldImportReport(scaffoldReport)}\n`);
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
