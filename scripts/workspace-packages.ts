import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

const REPO = path.resolve(import.meta.dirname, "..");
const REPO_ROOT = REPO;
const PACKAGE_NAME_PATTERN = /^@threenative\/[a-z0-9-]+$/u;
const PACKAGE_NAME_TOKEN_PATTERN =
  /@threenative\/[a-z0-9-]+|create-threenative|threenative-[a-z0-9-]+-mcp/u;
const PACKAGE_NAME_GLOBAL_PATTERN =
  /@threenative\/[a-z0-9-]+|create-threenative|threenative-[a-z0-9-]+-mcp/gu;
const WORKFLOW_PACKAGE_COMMAND_PATTERN =
  /\bpnpm[ \t]+[^\n;&|]*?--filter[ \t]+["']?(@threenative\/[a-z0-9-]+|create-threenative|threenative-[a-z0-9-]+-mcp)["']?(?=[ \t\r\n]|$)/gu;
const WORKFLOW_SHELL_CONTINUATION_PATTERN = /\\\r?\n[ \t]*/gu;
// One `run:` step — scalar, literal block or folded block — is one command group.
const WORKFLOW_RUN_HEADER_PATTERN = /^[^\S\n]*(?:-[^\S\n]+)?run:/gmu;
const WORKFLOW_YAML_FOLDED_SCALAR_HEADER_PATTERN =
  /^([ \t]*)(?:-[ \t]+)?run:[ \t]*>(?:[1-9][+-]?|[+-][1-9]?)?(?:[ \t]+#.*)?[ \t]*$/u;
const OTHER_WORKSPACE_NAMES = new Set([
  "create-threenative",
  "threenative-blender-mcp",
  "threenative-engine-mcp",
]);
const IMPLEMENTATION_EXTENSIONS = new Set([".cjs", ".js", ".mjs", ".ts", ".tsx"]);
const WORKFLOW_EXTENSIONS = new Set([".yaml", ".yml"]);
const SKIPPED_DIRECTORY_NAMES = new Set([
  ".claude",
  ".git",
  ".worktrees",
  "artifacts",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

export interface IWorkspacePackage {
  readonly dependencies: readonly string[];
  readonly directory: string;
  /** Export-map subpaths, with `.` representing a root conditional export. */
  readonly exports: readonly string[];
  readonly name: string;
  readonly private: boolean;
  readonly scripts: Readonly<Record<string, string>>;
  readonly version: string;
}

export interface IWorkspacePackageOptions {
  /** Keep fixture-only manifest scans useful when a test omits publication metadata. */
  readonly requireVersion?: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function dependencyNames(manifest: Record<string, unknown>): readonly string[] {
  return ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].flatMap(
    (field) => {
      const block = record(manifest[field]);
      return Object.keys(block);
    },
  );
}

function exportSubpaths(manifest: Record<string, unknown>): readonly string[] {
  const exported = manifest.exports;
  if (exported === undefined) return [];
  if (typeof exported === "string" || Array.isArray(exported)) return ["."];
  const map = record(exported);
  const subpaths = Object.keys(map).filter((key) => key.startsWith("."));
  return subpaths.length === 0 ? ["."] : subpaths;
}

function packageRoot(input: string): string {
  const resolved = path.resolve(input);
  const nested = path.join(resolved, "packages");
  return fs.existsSync(nested) ? nested : resolved;
}

/** Reads the package manifests that are the source of truth for every pipeline package list. */
export function workspacePackages(
  repo = REPO,
  options: IWorkspacePackageOptions = {},
): readonly IWorkspacePackage[] {
  const root = packageRoot(repo);
  const requireVersion = options.requireVersion ?? true;
  if (!fs.existsSync(root))
    throw new Error(`TN_WORKSPACE_PACKAGES_MISSING: ${root} does not exist.`);
  const packages: IWorkspacePackage[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    const manifestPath = path.join(directory, "package.json");
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = record(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
    const name = manifest.name;
    const version = manifest.version;
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      (requireVersion && (typeof version !== "string" || version.length === 0))
    ) {
      throw new Error(`TN_WORKSPACE_PACKAGE_INVALID: ${manifestPath} needs a name and version.`);
    }
    const scripts = record(manifest.scripts);
    packages.push({
      dependencies: dependencyNames(manifest),
      directory,
      exports: exportSubpaths(manifest),
      name,
      private: manifest.private === true,
      scripts: Object.fromEntries(
        Object.entries(scripts).flatMap(([key, value]) =>
          typeof value === "string" ? [[key, value]] : [],
        ),
      ),
      version: typeof version === "string" ? version : "",
    });
  }
  if (packages.length === 0)
    throw new Error("TN_WORKSPACE_PACKAGES_EMPTY: no package manifests were found.");
  const names = new Set<string>();
  for (const item of packages) {
    if (names.has(item.name)) throw new Error(`TN_WORKSPACE_PACKAGE_DUPLICATE: ${item.name}.`);
    names.add(item.name);
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

export function publicWorkspacePackages(
  repo = REPO,
  options: IWorkspacePackageOptions = {},
): readonly IWorkspacePackage[] {
  return workspacePackages(repo, options).filter(({ private: isPrivate }) => !isPrivate);
}

/** Whether a package publishes code beyond the package.json metadata escape hatch. */
export function hasPublicExports(item: Pick<IWorkspacePackage, "exports">): boolean {
  return item.exports.some((subpath) => subpath !== "./package.json");
}

/** Public workspace packages whose manifests publish at least one code export. */
export function publicWorkspacePackagesWithExports(
  repo = REPO,
  options: IWorkspacePackageOptions = {},
): readonly IWorkspacePackage[] {
  return publicWorkspacePackages(repo, options).filter(hasPublicExports);
}

/** Returns packages in deterministic dependency order, with dependencies before dependents. */
export function workspaceBuildOrder(
  repo = REPO,
  packages: readonly IWorkspacePackage[] = publicWorkspacePackages(repo),
): readonly IWorkspacePackage[] {
  const byName = new Map(packages.map((item) => [item.name, item]));
  const ordered: IWorkspacePackage[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (item: IWorkspacePackage): void => {
    if (visited.has(item.name)) return;
    if (visiting.has(item.name)) {
      throw new Error(`TN_WORKSPACE_PACKAGE_CYCLE: dependency cycle reaches ${item.name}.`);
    }
    visiting.add(item.name);
    for (const dependency of [...new Set(item.dependencies)].sort((left, right) =>
      left.localeCompare(right),
    )) {
      const internal = byName.get(dependency);
      if (internal !== undefined) visit(internal);
    }
    visiting.delete(item.name);
    visited.add(item.name);
    ordered.push(item);
  };
  for (const item of [...packages].sort((left, right) => left.name.localeCompare(right.name)))
    visit(item);
  return ordered;
}

export function packageArchivePrefix(name: string): string {
  return `${name.replace(/^@/u, "").replace("/", "-")}-`;
}

export function localPackageEntries(
  repo = REPO,
): readonly (readonly [name: string, prefix: string])[] {
  return workspaceBuildOrder(repo).map(({ name }) => [name, packageArchivePrefix(name)] as const);
}

export function publishSetComment(repo = REPO): string {
  return publicWorkspacePackages(repo)
    .map(({ name }) => `#   ${name}`)
    .join("\n");
}

/** Return the build/pack order and archive prefixes for every workspace package. */
export function workspacePackageArchives(
  repoOrPackages = REPO,
): readonly (readonly [name: string, prefix: string])[] {
  return workspaceBuildOrder(repoOrPackages, workspacePackages(repoOrPackages)).map(
    ({ name }) => [name, packageArchivePrefix(name)] as const,
  );
}

/**
 * Derive the scaffold source flag from the package's actual workspace name.
 *
 * A rule rather than a list: this used to name `threenative-engine-mcp` by hand, and the next
 * unscoped workspace package threw `TN_WORKSPACE_PACKAGE_FLAG_UNSUPPORTED` from a lane that had
 * already added the flag on the CLI side. `package-list-drift.spec.ts` round-trips every workspace
 * package through `packageNameFromFlag`, so the two sides cannot disagree again.
 */
export function workspacePackageSourceFlag(name: string): string {
  if (name === "create-threenative") return "--cli-package";
  if (name.startsWith("@threenative/")) {
    return `--threenative-${name.slice("@threenative/".length)}-package`;
  }
  if (name.startsWith("threenative-")) {
    return `--${name.slice("threenative-".length)}-package`;
  }
  throw new Error(
    `TN_WORKSPACE_PACKAGE_FLAG_UNSUPPORTED: cannot pass ${name} to create-threenative.`,
  );
}

function buildWorkspacePackages(repo: string): void {
  for (const item of workspaceBuildOrder(repo)) {
    if (item.scripts.build === undefined || item.scripts.build.trim().length === 0) continue;
    execFileSync("pnpm", ["--filter", item.name, "run", "build"], {
      cwd: repo,
      stdio: "inherit",
    });
  }
}

function packWorkspacePackages(repo: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true });
  buildWorkspacePackages(repo);
  for (const item of workspaceBuildOrder(repo)) {
    execFileSync("pnpm", ["--filter", item.name, "pack", "--pack-destination", destination], {
      cwd: repo,
      stdio: "inherit",
    });
  }
}

function statExists(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory() || fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function filesWithEnumerationCandidates(root: string): readonly string[] {
  const files: string[] = [];
  const checker = path.resolve(fileURLToPath(import.meta.url));
  function walk(directory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (
        (IMPLEMENTATION_EXTENSIONS.has(path.extname(entry.name)) ||
          (WORKFLOW_EXTENSIONS.has(path.extname(entry.name)) &&
            path
              .relative(root, file)
              .replaceAll(path.sep, "/")
              .startsWith(".github/workflows/"))) &&
        !file.endsWith(".d.ts") &&
        path.resolve(file) !== checker
      )
        files.push(file);
    }
  }
  if (statExists(root)) walk(root);
  return files;
}

function isWorkflowFile(file: string, root: string): boolean {
  return (
    WORKFLOW_EXTENSIONS.has(path.extname(file)) &&
    path.relative(root, file).replaceAll(path.sep, "/").startsWith(".github/workflows/")
  );
}

function yamlLineIndent(line: string): number {
  return line.match(/^[ \t]*/u)?.[0].length ?? 0;
}

function isYamlFoldedScalarBodyLine(line: string, scalarIndent: number): boolean {
  return line.trim().length === 0 || yamlLineIndent(line) > scalarIndent;
}

function yamlFoldedScalarText(line: string): string {
  return line.trim().length === 0 ? "\n" : ` ${line.trimStart()}`;
}

function unfoldYamlFoldedScalars(source: string): string {
  const lines = source.split(/\r?\n/u);
  let result = "";
  let foldedScalarIndent: number | undefined;
  for (const [lineIndex, line] of lines.entries()) {
    if (foldedScalarIndent !== undefined) {
      if (isYamlFoldedScalarBodyLine(line, foldedScalarIndent)) {
        result += yamlFoldedScalarText(line);
        continue;
      }
      result += "\n";
      foldedScalarIndent = undefined;
    }

    const header = line.match(WORKFLOW_YAML_FOLDED_SCALAR_HEADER_PATTERN);
    if (header !== null) {
      result += `${line} `;
      foldedScalarIndent = header[1]?.length ?? 0;
    } else {
      result += line;
      if (lineIndex < lines.length - 1) result += "\n";
    }
  }
  return result;
}

function hasWorkflowPackageEnumeration(source: string): boolean {
  const continuedSource = unfoldYamlFoldedScalars(source).replaceAll(
    WORKFLOW_SHELL_CONTINUATION_PATTERN,
    " ",
  );
  // The defect is a hand-listed package set: several packages named by one command or one run block,
  // or a shell loop over them. Two targeted `--filter` steps in two unrelated jobs are two builds, not
  // a list, and since the per-feature integration workflows folded into one file a single workflow
  // legitimately holds one targeted build per lane.
  const runBlocks = [...continuedSource.matchAll(WORKFLOW_RUN_HEADER_PATTERN)].map(
    (match) => match.index,
  );
  const perRunBlock = new Map<number, Set<string>>();
  for (const match of continuedSource.matchAll(WORKFLOW_PACKAGE_COMMAND_PATTERN)) {
    const name = match[1];
    if (name === undefined) continue;
    const block = runBlocks.filter((at) => at <= (match.index ?? 0)).pop() ?? -1;
    const blockNames = perRunBlock.get(block) ?? new Set<string>();
    blockNames.add(name);
    perRunBlock.set(block, blockNames);
  }
  for (const blockNames of perRunBlock.values()) {
    if (blockNames.size >= 2) return true;
  }

  for (const match of source.matchAll(/\bfor\s+\w+\s+in\s+([\s\S]*?)(?:;\s*do\b|\s+do\b)/gu)) {
    const loopNames = new Set(match[1]?.match(PACKAGE_NAME_GLOBAL_PATTERN) ?? []);
    if (loopNames.size >= 2) return true;
  }
  return false;
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs"))
    return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function packageNamesInEnumeration(array: ts.ArrayLiteralExpression): ReadonlySet<string> {
  const names = new Set<string>();
  // Package/archive call sites are arrays of strings or nested string tuples. Object-literal
  // arrays remain metadata fixtures, not executable package enumerations, so they are ignored by
  // shape rather than by a fixture filename allowlist.
  function visit(element: ts.Expression): void {
    const unwrapped = unwrapExpression(element);
    if (ts.isStringLiteralLike(unwrapped)) {
      if (PACKAGE_NAME_PATTERN.test(unwrapped.text) || OTHER_WORKSPACE_NAMES.has(unwrapped.text))
        names.add(unwrapped.text);
      return;
    }
    if (!ts.isArrayLiteralExpression(unwrapped)) return;
    for (const child of unwrapped.elements) {
      if (ts.isExpression(child)) visit(child);
    }
  }
  for (const element of array.elements) {
    if (ts.isExpression(element)) visit(element);
  }
  return names;
}

function packageEnumerationArray(node: ts.Node): ts.ArrayLiteralExpression | undefined {
  if (ts.isVariableDeclaration(node)) {
    const initializer =
      node.initializer === undefined ? undefined : unwrapExpression(node.initializer);
    return initializer !== undefined && ts.isArrayLiteralExpression(initializer)
      ? initializer
      : undefined;
  }
  if (ts.isForOfStatement(node)) {
    const expression = unwrapExpression(node.expression);
    return ts.isArrayLiteralExpression(expression) ? expression : undefined;
  }
  return undefined;
}

/**
 * Static negative control for L1. Only the helper may contain literal multi-package lists; a
 * reverted caller is reported by path before it can make two archive sets diverge again.
 */
export function findLiteralPackageEnumerationViolations(root = REPO_ROOT): readonly string[] {
  const violations: string[] = [];
  for (const file of filesWithEnumerationCandidates(root)) {
    const source = fs.readFileSync(file, "utf8");
    if (!PACKAGE_NAME_TOKEN_PATTERN.test(source)) continue;
    if (isWorkflowFile(file, root)) {
      if (hasWorkflowPackageEnumeration(source))
        violations.push(path.relative(root, file).replaceAll(path.sep, "/"));
      continue;
    }
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(file),
    );
    let found = false;
    function visit(node: ts.Node): void {
      if (found) return;
      const array = packageEnumerationArray(node);
      if (array !== undefined && packageNamesInEnumeration(array).size >= 2) found = true;
      if (!found) ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    if (found) violations.push(path.relative(root, file).replaceAll(path.sep, "/"));
  }
  return violations.sort();
}

function main(): void {
  if (process.argv.includes("--archives")) {
    for (const [name, prefix] of workspacePackageArchives())
      process.stdout.write(`${name}\t${prefix}\n`);
    return;
  }
  if (process.argv.includes("--json")) {
    process.stdout.write(
      `${JSON.stringify(
        workspacePackages().map(({ directory, name, version }) => ({
          directory: path.relative(REPO_ROOT, directory),
          name,
          version,
        })),
      )}\n`,
    );
    return;
  }
  const command = process.argv[2];
  if (command === "build") {
    buildWorkspacePackages(REPO);
    return;
  }
  if (command === "pack") {
    const destination = process.argv[3];
    if (destination === undefined || destination.length === 0) {
      throw new Error("usage: workspace-packages.ts pack <destination>");
    }
    packWorkspacePackages(REPO, destination);
    return;
  }
  if (command !== undefined) {
    throw new Error("usage: workspace-packages.ts [build|pack|--archives|--json]");
  }
  const violations = findLiteralPackageEnumerationViolations();
  if (violations.length > 0) {
    throw new Error(
      `TN_WORKSPACE_PACKAGE_LITERAL_ENUMERATION: derive package names with workspace-packages.ts; offending files: ${violations.join(", ")}`,
    );
  }
  process.stdout.write(`workspace package derivation ok: ${workspacePackages().length} packages\n`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
