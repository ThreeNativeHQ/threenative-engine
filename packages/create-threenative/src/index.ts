#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectCommand, inspectHelp } from "./inspect.js";
import { MCP_SERVERS, serverEntryPath } from "./mcp-servers.js";

export { createEngineFreshnessPlugin, hashEngineDist } from "./engine-freshness.js";
export { createWebBrandPlugin, renderWebManifest } from "./web-brand.js";
export { webRuntimeDecoders } from "./web-engine.js";

export type ScaffoldTemplate = string;

const PACKAGE_SOURCE_FLAGS = {
  "@threenative/core": "--core-package",
  "@threenative/assets": "--assets-package",
  "@threenative/physics": "--physics-package",
  "@threenative/playtest": "--playtest-package",
  "@threenative/runtime-native": "--runtime-native-package",
  "@threenative/ui": "--ui-package",
  "threenative-blender-mcp": "--blender-mcp-package",
  "threenative-engine-mcp": "--engine-mcp-package",
  "create-threenative": "--cli-package",
} as const;

/** The unscoped workspace packages, keyed by their flag suffix. Scoped packages derive their flag
 * from the package name; these three cannot, so the alias and the name live in one table rather
 * than in a chain of equality checks that a fourth unscoped package would have to be added to in
 * two places. */
const UNSCOPED_PACKAGE_FLAG_ALIASES: Readonly<Record<string, string>> = {
  "blender-mcp": "threenative-blender-mcp",
  cli: "create-threenative",
  "engine-mcp": "threenative-engine-mcp",
};

type PackageSourceName = keyof typeof PACKAGE_SOURCE_FLAGS;
type PackageSources = Partial<Record<PackageSourceName, string>> & {
  readonly [packageName: string]: string | undefined;
};

export interface IKitManifest {
  readonly blurb: string;
  readonly genre: string;
  readonly kit: boolean;
  readonly name: ScaffoldTemplate;
  readonly title: string;
}

export interface IScaffoldOptions {
  install?: boolean;
  packageSources?: PackageSources;
  target: string;
  template?: ScaffoldTemplate;
}

export interface IScaffoldResult {
  installed: boolean;
  target: string;
  template: ScaffoldTemplate;
}

const TEXT_FILE_EXTENSIONS = new Set([".css", ".html", ".json", ".md", ".svg", ".ts", ".tsx"]);
const TEMPLATE_NAME = /^[a-z][a-z0-9-]*$/u;
const SHARED_AGENT_MARKER_LINE = /^<!--\s*(?:shared:\s*[^>]+|\/shared)\s*-->\r?\n?/gmu;
const DEFAULT_TEMPLATE = "starter";

export function templateRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../templates");
}

const LOADING_SOURCE_RELATIVE_PATH = path.join("src", "render", "loading.ts");
const LOADING_APPEARANCE_MARKER = "BEGIN THREENATIVE LOADING APPEARANCE";
const TEMPLATE_ICON_NAME = "icon.png";
const LOADING_APPEARANCE_BLOCK_PATTERN =
  /\/\* BEGIN THREENATIVE LOADING APPEARANCE \*\/[\s\S]*?\/\* END THREENATIVE LOADING APPEARANCE \*\//gu;
/**
 * Every kit whose loading screen is stamped from the canonical source, read off disk rather than
 * listed here. A kit added tomorrow is stamped the day it ships its appearance block, and one that
 * drops the block leaves the list by deleting bytes rather than by editing this file.
 */
export function discoverStampedTemplates(root = templateRoot()): readonly ScaffoldTemplate[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))
    .filter((template) => {
      const file = path.join(root, template, LOADING_SOURCE_RELATIVE_PATH);
      return existsSync(file) && readFileSync(file, "utf8").includes(LOADING_APPEARANCE_MARKER);
    });
}

/** The canonical generated loading implementation ships beside, rather than inside, a kit. */
export function canonicalLoadingPath(root = templateRoot()): string {
  const local = path.resolve(root, "..", "template-assets", "loading.ts");
  if (existsSync(local)) return local;
  return path.resolve(templateRoot(), "..", "template-assets", "loading.ts");
}

function loadingAppearanceBlock(source: string, file: string): string {
  const matches = source.match(LOADING_APPEARANCE_BLOCK_PATTERN) ?? [];
  if (matches.length !== 1) {
    throw new Error(
      `TN_LOADING_TEMPLATE_INVALID: ${file}: expected exactly one loading appearance block, found ${matches.length}.`,
    );
  }
  return matches[0];
}

/** Replaces only the declared per-kit appearance block and preserves the canonical implementation. */
export function stampLoadingSource(canonical: string, template: string): string {
  const canonicalBlock = loadingAppearanceBlock(canonical, "canonical loading source");
  const templateBlock = loadingAppearanceBlock(template, "template loading source");
  return canonical.replace(canonicalBlock, templateBlock);
}

/**
 * Render sources every kit copies verbatim and no kit is expected to edit.
 *
 * `src/render/` is a floor the game rewrites, and almost all of it is a per-kit look. The
 * render-chain plumbing is not: it is the same 600 lines in every kit, and keeping seven copies by
 * hand let one fall a revision behind without anything failing. A file belongs here only when a
 * kit editing it would be a mistake rather than a choice.
 */
export const SHARED_RENDER_SOURCES = [
  path.join("src", "render", "worldEnvironment.ts"),
  path.join("src", "render", "autoExposure.ts"),
  path.join("src", "render", "exposureGraph.ts"),
  path.join("src", "render", "exposureReadback.ts"),
  path.join("src", "render", "tonemap.ts"),
  path.join("src", "render", "localExposure.ts"),
  path.join("src", "render", "motionBlur.ts"),
  path.join("src", "render", "unrealBloom.ts"),
  path.join("src", "render", "vignette.ts"),
] as const;

export function canonicalRenderSourcePath(relativePath: string, root = templateRoot()): string {
  const name = path.basename(relativePath);
  const local = path.resolve(root, "..", "template-assets", name);
  if (existsSync(local)) return local;
  return path.resolve(templateRoot(), "..", "template-assets", name);
}

/** Re-copies every shared render source into each kit that ships it. */
export async function restampSharedRenderCopies(root = templateRoot()): Promise<readonly string[]> {
  const stamped: string[] = [];
  for (const relativePath of SHARED_RENDER_SOURCES) {
    const canonical = await readFile(canonicalRenderSourcePath(relativePath, root), "utf8");
    for (const template of readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right))) {
      const file = path.join(root, template, relativePath);
      if (!existsSync(file)) continue;
      await writeFile(file, canonical);
      stamped.push(file);
    }
  }
  return stamped;
}

/** Re-stamps every tracked full kit from the canonical source, preserving each kit's appearance. */
export async function restampTemplateLoadingCopies(
  root = templateRoot(),
): Promise<readonly string[]> {
  const canonical = await readFile(canonicalLoadingPath(root), "utf8");
  const stamped = [] as string[];
  for (const template of discoverStampedTemplates(root)) {
    const file = path.join(root, template, LOADING_SOURCE_RELATIVE_PATH);
    const source = await readFile(file, "utf8");
    await writeFile(file, stampLoadingSource(canonical, source));
    stamped.push(file);
  }
  return stamped;
}

async function stampTemplateLoading(target: string, template: string, root: string): Promise<void> {
  const sourcePath = path.join(template, LOADING_SOURCE_RELATIVE_PATH);
  if (!existsSync(sourcePath)) return;
  const source = await readFile(sourcePath, "utf8");
  if (!source.includes("BEGIN THREENATIVE LOADING APPEARANCE")) return;
  const canonical = await readFile(canonicalLoadingPath(root), "utf8");
  await writeFile(
    path.join(target, LOADING_SOURCE_RELATIVE_PATH),
    stampLoadingSource(canonical, source),
  );
}

/** Copies the one packaged icon to the fixed output path every generated project advertises. */
async function copyTemplateIcon(target: string, templateRootDirectory: string): Promise<void> {
  const source = path.join(
    path.dirname(templateRootDirectory),
    "template-assets",
    TEMPLATE_ICON_NAME,
  );
  if (!existsSync(source)) {
    throw new Error(
      `TN_TEMPLATE_ICON_MISSING: '${source}' is not in the package; every generated project needs the native icon asset.`,
    );
  }
  const destination = path.join(target, "public", TEMPLATE_ICON_NAME);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { errorOnExist: true, force: false });
}

/**
 * Copies each packaged baseline asset — the sky photograph, the mannequin — into the generated
 * project's `assets/` when, and only when, its source names the file. One copy ships in this
 * package however many kits use it, and a game that never loads one never carries its bytes.
 */
async function copySharedAssets(target: string, templateRootDirectory: string): Promise<void> {
  const shared = path.join(path.dirname(templateRootDirectory), "template-assets", "assets");
  if (!existsSync(shared)) return;
  const source = path.join(target, "src");
  const texts: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (/\.(?:ts|tsx)$/u.test(entry.name)) texts.push(await readFile(file, "utf8"));
    }
  };
  if (existsSync(source)) await walk(source);
  for (const name of readdirSync(shared)) {
    if (!texts.some((text) => text.includes(`"${name}"`))) continue;
    const destination = path.join(target, "assets", name);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(shared, name), destination, { errorOnExist: true, force: false });
  }
}

/** Every generated game gets the same two thin configs; the rules live in `create-threenative/quality`
 * and the formatter settings in `biome.json`. Fails closed when the package lacks them. */
async function copyQualityConfig(target: string, templateRootDirectory: string): Promise<void> {
  const shared = path.join(path.dirname(templateRootDirectory), "template-assets", "quality");
  if (!existsSync(shared)) throw new Error(`TN_QUALITY_CONFIG_MISSING: ${shared}`);
  await cp(shared, target, { errorOnExist: true, recursive: true });
}

function invalidManifest(file: string, reason: string): never {
  throw new Error(`TN_KIT_MANIFEST_INVALID: ${file}: ${reason}`);
}

function nonEmptyString(value: unknown, field: string, file: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    return invalidManifest(file, `${field} must be a non-empty string`);
  return value;
}

function loadManifest(directory: string): IKitManifest {
  const file = path.join(directory, "kit.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`TN_KIT_MANIFEST_MISSING: ${file}`);
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    return invalidManifest(file, `JSON could not be parsed: ${String(error)}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return invalidManifest(file, "the root must be an object");
  const record = value as Record<string, unknown>;
  const directoryName = path.basename(directory);
  const name = nonEmptyString(record.name, "name", file);
  if (!TEMPLATE_NAME.test(name))
    return invalidManifest(file, "name must match /^[a-z][a-z0-9-]*$/");
  if (name !== directoryName)
    return invalidManifest(file, `name '${name}' must match directory '${directoryName}'`);
  const kit = record.kit;
  if (typeof kit !== "boolean") return invalidManifest(file, "kit must be a boolean");
  return {
    blurb: nonEmptyString(record.blurb, "blurb", file),
    genre: nonEmptyString(record.genre, "genre", file),
    kit,
    name,
    title: nonEmptyString(record.title, "title", file),
  };
}

/** Reads every template directory on each call so a new kit is live without a TypeScript edit. */
export function discoverKitManifests(root = templateRoot()): readonly IKitManifest[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => loadManifest(path.join(root, entry.name)))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function discoverTemplateNames(root = templateRoot()): readonly ScaffoldTemplate[] {
  return discoverKitManifests(root).map(({ name }) => name);
}

export function kitManifest(template: ScaffoldTemplate, root = templateRoot()): IKitManifest {
  const manifest = discoverKitManifests(root).find(({ name }) => name === template);
  if (manifest === undefined)
    throw new Error(
      `Unknown template '${template}'. Available templates: ${discoverTemplateNames(root).join(", ")}.`,
    );
  return manifest;
}

/** Resolve an exact public genre to its kit. Unknown genres deliberately start from minimal:
 * genre words are authoring input, not an invitation to guess the closest preset. */
export function templateForGenre(genre: string, root = templateRoot()): ScaffoldTemplate {
  const normalized = genre.trim().toLowerCase();
  if (normalized.length === 0) throw new Error("Genre must not be empty.");
  return (
    discoverKitManifests(root).find((manifest) => manifest.genre.toLowerCase() === normalized)
      ?.name ?? "minimal"
  );
}

function templateHelp(manifests: readonly IKitManifest[]): string {
  const width = Math.max(...manifests.map(({ name }) => name.length), 0);
  return manifests
    .map(({ blurb, name, title }) => `  ${name.padEnd(width)}  ${title}: ${blurb}`)
    .join("\n");
}

export function scaffoldCompletionMessage(
  manifests: readonly IKitManifest[],
  defaultTemplate = DEFAULT_TEMPLATE,
): string {
  const names = manifests
    .map(({ name }) => (name === defaultTemplate ? `${name} (default)` : name))
    .join(", ");
  return `Templates: ${names}. Choose with --template <name>.\n`;
}

export function cliHelp(): string {
  const manifests = discoverKitManifests();
  return `${[
    "Usage: npx create-threenative <directory> [options]",
    "       npx create-threenative inspect <file.glb> [--json]",
    "",
    "Commands:",
    "  inspect <file>      Report the facts in a glTF asset.",
    "",
    "Options:",
    "  --template <name>  Choose a template.",
    "  --genre <name>     Choose an exact genre kit; unknown genres use minimal.",
    "  --no-install       Copy the project without running pnpm install.",
    "  --help             Show this help.",
    "",
    "Templates:",
    templateHelp(manifests),
  ].join("\n")}\n`;
}

function packageName(target: string): string {
  const name = path
    .basename(target)
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-");
  if (name.length === 0 || name === "-" || name === "_") {
    throw new Error(`Cannot derive a package name from '${target}'.`);
  }
  return name;
}

async function isEmpty(directory: string): Promise<boolean> {
  const entries = await readdir(directory).catch((error: unknown) =>
    (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" ? [] : undefined,
  );
  if (entries === undefined) return false;
  return entries.length === 0;
}

function substituteTemplateVariables(
  content: string,
  replacements: Readonly<Record<string, string>>,
): string {
  let rendered = content;
  for (const [placeholder, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(placeholder, value);
  }
  return rendered;
}

async function renderTemplate(
  directory: string,
  replacements: Readonly<Record<string, string>>,
): Promise<void> {
  const files = await readdir(directory, { withFileTypes: true });
  for (const entry of files) {
    const source = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await renderTemplate(source, replacements);
      continue;
    }
    if (!TEXT_FILE_EXTENSIONS.has(path.extname(entry.name))) continue;
    const content = await readFile(source, "utf8");
    let rendered = substituteTemplateVariables(content, replacements);
    if (entry.name === "AGENTS.md" || entry.name === "CLAUDE.md") {
      rendered = rendered.replace(SHARED_AGENT_MARKER_LINE, "");
    }
    await writeFile(source, rendered);
  }
}

/** Long recipes live in this package and are read where it installs them: every generated project
 * already depends on `create-threenative`, so the scaffold copies no `agent-docs/` of its own
 * (PRD-449). This is the one definition of that path; the link pattern and the existence check
 * both read it. */
const REFERENCE_BUNDLE_PREFIX = "node_modules/create-threenative/agent-docs/references/";
const REFERENCE_FILE_NAME = /^[a-z0-9][a-z0-9-]*\.md$/u;
const AGENT_FILES_DIRECTORY = "agent-files";
const AUTHORING_GITIGNORE_RULES = [
  "# ThreeNative local authoring state and dependency secrets",
  ".dream-loop/",
  "node_modules/",
  ".env",
  ".env.*",
  "!.env.example",
  // The asset pipeline's compiled outputs: any project with an assets/ folder gets them in public/
  // on its first dev run or build. Hand-owned public files (favicon, icons) stay committed.
  "public/assets.manifest.json",
  "public/bake.receipt.json",
  "public/*.[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f].*",
] as const;
/** Backticked paths and Markdown links share one prefix so both readers resolve identically. */
const REFERENCE_TOKEN_PATTERN = new RegExp(
  `\`${REFERENCE_BUNDLE_PREFIX}([a-z0-9][a-z0-9./-]*\\.md)\`|` +
    `\\[[^\\]]*\\]\\(${REFERENCE_BUNDLE_PREFIX}([^)#]+\\.md)\\)`,
  "gu",
);

/** Links each stored skill into the Claude host directory. Both host directories must resolve the
 * same bytes, and a duplicated skill drifts the day one adapter is edited, so `.claude/skills` is a
 * relative symlink into the single `.agents/skills` copy — except where Claude Code takes the
 * workflow as a subagent instead, which it already has under `.claude/agents/<name>.md`.
 *
 * Symlinks need a privilege Windows only grants with developer mode, so a failed link falls back
 * to a copy: a duplicated skill beats a scaffold that cannot be created. */
async function linkClaudeSkills(target: string): Promise<void> {
  const stored = path.join(target, ".agents", "skills");
  if (!existsSync(stored)) return;
  const hostSkills = path.join(target, ".claude", "skills");
  const subagents = path.join(target, ".claude", "agents");
  await mkdir(hostSkills, { recursive: true });
  for (const entry of await readdir(stored, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (existsSync(path.join(subagents, `${entry.name}.md`))) continue;
    const link = path.join(hostSkills, entry.name);
    const relative = path.relative(hostSkills, path.join(stored, entry.name));
    try {
      await symlink(relative, link, "dir");
    } catch (error) {
      // Only the privilege refusal falls back; any other failure is a scaffold bug, not a host.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EACCES") throw error;
      await cp(path.join(stored, entry.name), link, { recursive: true });
    }
  }
}

/** Copies the canonical role contracts and thin provider adapters after the selected template. */
async function copyAgentFiles(target: string, templateRootDirectory: string): Promise<void> {
  const source = path.join(path.dirname(templateRootDirectory), AGENT_FILES_DIRECTORY);
  if (!existsSync(source)) {
    throw new Error(
      `TN_AGENT_FILES_MISSING: '${source}' is not in the package; every generated project needs the canonical agent roles.`,
    );
  }
  await cp(source, target, { recursive: true });
  await linkClaudeSkills(target);
}

/** Installs the same authoring/dependency ignores for every kit without replacing a kit's own
 * asset rules. A packed npm tarball cannot carry `.gitignore`, so templates keep `gitignore` and
 * this live scaffold path is the one place that creates the real file. */
async function installAuthoringGitignore(target: string): Promise<void> {
  const file = path.join(target, ".gitignore");
  const existing = existsSync(file) ? await readFile(file, "utf8") : "";
  const present = new Set(existing.split(/\r?\n/u));
  const missing = AUTHORING_GITIGNORE_RULES.filter((entry) => !present.has(entry));
  if (missing.length === 0) return;
  const prefix = existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
  await writeFile(
    file,
    `${prefix}${prefix.length > 0 && !prefix.endsWith("\n\n") ? "\n" : ""}${missing.join("\n")}\n`,
  );
}

/** Fails closed: an instruction that names a recipe the package does not ship strands the agent
 * on a link that goes nowhere. The pages are read from the package's own bundle directory — the
 * exact directory its `files` list installs — because the project has no copy at scaffold time. */
async function assertReferenceBundle(target: string, templateRootDirectory: string): Promise<void> {
  const bundleDirectory = path.join(
    path.dirname(templateRootDirectory),
    "agent-docs",
    "references",
  );
  for (const file of [
    "AGENTS.md",
    "CLAUDE.md",
    ".agents/skills/threenative-visuals/SKILL.md",
    ".claude/skills/threenative-visuals/SKILL.md",
    ".agents/skills/threenative-assets/SKILL.md",
    ".claude/skills/threenative-assets/SKILL.md",
  ]) {
    const filePath = path.join(target, file);
    if (existsSync(filePath)) await assertReferenceTargets(file, filePath, bundleDirectory);
  }
}

async function assertReferenceTargets(
  from: string,
  filePath: string,
  bundleDirectory: string,
): Promise<void> {
  const content = await readFile(filePath, "utf8");
  for (const match of content.matchAll(REFERENCE_TOKEN_PATTERN)) {
    const referenced = match[1] ?? match[2];
    if (referenced === undefined) continue;
    if (!REFERENCE_FILE_NAME.test(referenced) || referenced.includes("/")) {
      throw new Error(
        `RED observed: referenced recipe missing: '${from}' names '${referenced}', which is not a shipped reference page.`,
      );
    }
    if (!existsSync(path.join(bundleDirectory, referenced))) {
      throw new Error(
        `RED observed: referenced recipe missing: '${from}' links '${REFERENCE_BUNDLE_PREFIX}${referenced}', which the package does not ship.`,
      );
    }
  }
}

async function applyPackageSources(
  target: string,
  packageSources: IScaffoldOptions["packageSources"],
): Promise<void> {
  if (packageSources === undefined) return;
  const packagePath = path.join(target, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    pnpm?: { overrides?: Record<string, string> };
  };
  const localSource = (source: string): string => {
    const filePath = source.startsWith("file:") ? source.slice("file:".length) : source;
    return `file:${path.resolve(filePath)}`;
  };
  for (const [name, source] of Object.entries(packageSources)) {
    if (source === undefined) continue;
    const resolvedSource = localSource(source);
    const isExistingDevDependency = packageJson.devDependencies?.[name] !== undefined;
    if (packageJson.optionalDependencies?.[name] !== undefined) {
      packageJson.optionalDependencies[name] = resolvedSource;
    } else if (
      isExistingDevDependency ||
      name === "@threenative/playtest" ||
      name === "create-threenative" ||
      name === "threenative-engine-mcp"
    ) {
      packageJson.devDependencies ??= {};
      packageJson.devDependencies[name] = resolvedSource;
    } else {
      packageJson.dependencies ??= {};
      packageJson.dependencies[name] = resolvedSource;
    }
    // Every local source also overrides transitive resolution: the packed CLI itself depends
    // on @threenative/assets, which no direct pin in this manifest reaches — and which is not
    // on the registry, so an install without the override 404s.
    packageJson.pnpm ??= {};
    packageJson.pnpm.overrides ??= {};
    packageJson.pnpm.overrides[name] = resolvedSource;
  }
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

const FRAMEWORK_PATCH_DIRECTORY = "patches";
const FRAMEWORK_PATCH_SOURCES: Readonly<Record<string, string>> = {
  "three@0.185.1.patch": "../core/patches/three@0.185.1.patch",
  "vite@8.2.0.patch": "../../patches/vite@8.2.0.patch",
  "@tailwindcss__node@4.3.3.patch": "../../patches/@tailwindcss__node@4.3.3.patch",
};

async function copyFrameworkPatches(target: string, templateRootDirectory: string): Promise<void> {
  // Copy exactly the dependency patches declared by this template. In particular, minimal
  // installs no Tailwind, so pnpm must not receive an unused Tailwind patch.
  const manifest = JSON.parse(await readFile(path.join(target, "package.json"), "utf8")) as {
    pnpm?: { patchedDependencies?: Record<string, string> };
  };
  const packageRoot = path.dirname(templateRoot());
  for (const relative of Object.values(manifest.pnpm?.patchedDependencies ?? {})) {
    const name = path.basename(relative);
    const fallback = FRAMEWORK_PATCH_SOURCES[name];
    if (fallback === undefined || relative !== `${FRAMEWORK_PATCH_DIRECTORY}/${name}`) {
      throw new Error(`TN_FRAMEWORK_PATCH_MISSING: unsupported template patch '${relative}'.`);
    }
    const candidates = [...new Set([path.dirname(templateRootDirectory), packageRoot])].map(
      (root) => path.join(root, "template-assets", FRAMEWORK_PATCH_DIRECTORY, name),
    );
    const canonical = path.resolve(packageRoot, fallback);
    // A source checkout can have an ignored prepack copy from an earlier build. Packaged CLIs
    // omit src/, so they continue to use only the patch bytes delivered in their tarball.
    if (existsSync(path.join(packageRoot, "src", "index.ts"))) candidates.unshift(canonical);
    else candidates.push(canonical);
    const source = candidates.find((candidate) => existsSync(candidate));
    if (source === undefined) {
      throw new Error(
        `TN_FRAMEWORK_PATCH_MISSING: dependency patch '${name}' is absent from the CLI package.`,
      );
    }
    const destination = path.join(target, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination);
  }
}

const NODE_MODULES_PREFIX = "./node_modules/";
// Every server launches through a shim inside `@threenative/core`, the one package a ThreeNative
// project always has as a direct dependency. Pointing straight at `threenative-asset-mcp` only
// works where the package manager hoists, so a project that installed the library without
// scaffolding — or one on pnpm whose lockfile nests differently — silently lost its asset tools.
//
// Derived from core's table rather than retyped beside it: a server added there must appear in a
// scaffolded project, and a hand-kept copy here would have let the scaffold pass while shipping
// a project that is missing it.
const REQUIRED_MCP_SERVERS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(MCP_SERVERS).map(([name, server]) => [name, serverEntryPath(server)]),
);

function mcpPackageName(entry: string): string {
  const segments = entry.slice(NODE_MODULES_PREFIX.length).split("/");
  return entry.startsWith(`${NODE_MODULES_PREFIX}@`)
    ? segments.slice(0, 2).join("/")
    : (segments[0] ?? "");
}

/** Fails closed: a project whose MCP config is missing, incomplete, or points at a package it
 * does not install would silently hand the user's agent none of its authoring tools. */
async function assertMcpConfig(target: string): Promise<void> {
  const configPath = path.join(target, ".mcp.json");
  const raw = await readFile(configPath, "utf8").catch(() => {
    throw new Error(`Scaffold produced no .mcp.json at '${configPath}'.`);
  });
  const { mcpServers } = JSON.parse(raw) as {
    mcpServers?: Record<
      string,
      { args?: string[]; command?: string; env?: Record<string, string> }
    >;
  };
  if (mcpServers === undefined || Object.keys(mcpServers).length === 0) {
    throw new Error(`'${configPath}' declares no mcpServers.`);
  }
  for (const name of Object.keys(REQUIRED_MCP_SERVERS)) {
    if (mcpServers[name] === undefined) {
      throw new Error(`'${configPath}' is missing required MCP server '${name}'.`);
    }
  }
  const manifest = JSON.parse(await readFile(path.join(target, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]);
  for (const [name, server] of Object.entries(mcpServers)) {
    const entry = server.args?.[0];
    if (entry === undefined || !entry.startsWith(NODE_MODULES_PREFIX)) {
      throw new Error(
        `MCP server '${name}' must launch from '${NODE_MODULES_PREFIX}', not '${entry ?? "nothing"}'.`,
      );
    }
    const dependency = mcpPackageName(entry);
    if (!declared.has(dependency)) {
      throw new Error(
        `MCP server '${name}' launches '${dependency}', which this project does not depend on.`,
      );
    }
    // Without a download directory the server writes into ~/Downloads, so a downloaded asset
    // never reaches the game and the agent cannot tell. An absolute or escaping path is the
    // same bug with a different destination.
    for (const [key, value] of Object.entries(server.env ?? {})) {
      if (!key.endsWith("_DOWNLOAD_DIR")) continue;
      if (!value.startsWith("./") || value.includes("..")) {
        throw new Error(
          `MCP server '${name}' sets ${key}='${value}'; it must be a './' path inside the project.`,
        );
      }
    }
  }
  for (const [name, entry] of Object.entries(REQUIRED_MCP_SERVERS)) {
    if (mcpServers[name]?.args?.[0] !== entry) {
      throw new Error(
        `MCP server '${name}' must launch '${entry}', not '${mcpServers[name]?.args?.[0] ?? "nothing"}'.`,
      );
    }
  }
  const codexPath = path.join(target, ".codex", "config.toml");
  const codex = await readFile(codexPath, "utf8").catch(() => {
    throw new Error(`Scaffold produced no Codex MCP config at '${codexPath}'.`);
  });
  for (const [name, entry] of Object.entries(REQUIRED_MCP_SERVERS)) {
    if (!codex.includes(`[mcp_servers.${name}]`) || !codex.includes(`args = ["${entry}"]`)) {
      throw new Error(`'${codexPath}' does not wire required MCP server '${name}' to '${entry}'.`);
    }
  }
}

async function runInstall(target: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pnpm", ["install"], { cwd: target, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pnpm install exited with code ${code ?? "unknown"}.`));
    });
  });
}

/** Removes what a failed scaffold wrote. A target the scaffold created goes whole. A target that
 * existed was empty when the scaffold began, so every entry in it now is the scaffold's own. */
async function discardScaffold(target: string, existedBefore: boolean): Promise<void> {
  if (!existedBefore) {
    await rm(target, { force: true, recursive: true });
    return;
  }
  for (const entry of await readdir(target)) {
    await rm(path.join(target, entry), { force: true, recursive: true });
  }
}

export async function createProject(
  options: IScaffoldOptions,
  cwd = process.cwd(),
  root = templateRoot(),
): Promise<IScaffoldResult> {
  const manifests = discoverKitManifests(root);
  const template = options.template ?? DEFAULT_TEMPLATE;
  if (!manifests.some(({ name }) => name === template)) kitManifest(template, root);
  const target = path.resolve(cwd, options.target);
  const targetExists = await isEmpty(target).catch(() => false);
  if (!targetExists) {
    throw new Error(`Target '${target}' already exists and is not empty.`);
  }

  const existedBefore = existsSync(target);
  await mkdir(target, { recursive: true });
  const installed = options.install ?? true;
  try {
    const source = path.join(root, template);
    await cp(source, target, { recursive: true, errorOnExist: true });
    await copyTemplateIcon(target, root);
    await copySharedAssets(target, root);
    await copyQualityConfig(target, root);
    // pnpm pack strips `.gitignore` from published tarballs, so the template carries the asset
    // pipeline's ignore rules under a dotless name and the scaffold installs the real one.
    if (existsSync(path.join(target, "gitignore"))) {
      await rename(path.join(target, "gitignore"), path.join(target, ".gitignore"));
    }
    await installAuthoringGitignore(target);
    const projectName = packageName(target);
    const compactProjectId = projectName.toLowerCase().replace(/[^a-z0-9]+/gu, "") || "game";
    const projectId = /^[a-z]/u.test(compactProjectId)
      ? compactProjectId
      : `game${compactProjectId}`;
    // Entries rather than an object literal: these are template tokens, not identifiers. Written as
    // property names they read as names the naming rule must judge, and `__PROJECT_NAME__` is
    // neither ours to rename nor expressible in camelCase.
    const replacements = Object.fromEntries([
      ["__PROJECT_NAME__", projectName],
      ["__PROJECT_ID__", projectId],
    ]) as Readonly<Record<string, string>>;
    await stampTemplateLoading(target, source, root);
    await copyAgentFiles(target, root);
    await renderTemplate(target, replacements);
    await copyFrameworkPatches(target, root);
    await applyPackageSources(target, options.packageSources);
    await assertMcpConfig(target);
    await assertReferenceBundle(target, root);
    if (installed) await runInstall(target);
  } catch (error) {
    await discardScaffold(target, existedBefore);
    throw error;
  }
  return { installed, target, template };
}

const PACKAGE_SOURCE_FLAG = /^--([a-z0-9-]+)-package$/u;
const SCOPED_PACKAGE_FLAG_PREFIX = "threenative-";

/** The inverse of `scripts/workspace-packages.ts`'s `workspacePackageSourceFlag`; exported so
 * the pair is gated rather than trusted. */
export function packageNameFromFlag(flag: string): string | undefined {
  const match = flag.match(PACKAGE_SOURCE_FLAG);
  if (match === null) return undefined;
  const suffix = match[1];
  if (suffix === undefined) return undefined;
  // Legacy aliases are retained for the two existing unscoped workspace packages. Scoped package
  // flags use the namespaced spelling generated from the actual package name, so a scoped package
  // can never overwrite one of those unscoped aliases.
  if (suffix.startsWith(SCOPED_PACKAGE_FLAG_PREFIX)) {
    const scopedSuffix = suffix.slice(SCOPED_PACKAGE_FLAG_PREFIX.length);
    return scopedSuffix.length === 0 ? undefined : `@threenative/${scopedSuffix}`;
  }
  if (suffix === "runtime") return undefined;
  const unscoped = UNSCOPED_PACKAGE_FLAG_ALIASES[suffix];
  if (unscoped !== undefined) return unscoped;
  return `@threenative/${suffix}`;
}

const BOOLEAN_FLAGS = new Set(["--no-install", "--help", "-h"]);
const VALUE_FLAGS = new Set<string>([
  "--template",
  "--genre",
  "--runtime-package",
  ...Object.values(PACKAGE_SOURCE_FLAGS),
]);
const SCAFFOLD_USAGE = "Usage: pnpm create threenative my-game";

export function parseArgs(argv: readonly string[]): IScaffoldOptions {
  // A real token walk, not a positional guess: flags may precede the target, and every option
  // must be either known or a named failure — a silently ignored flag is how `--tempalte`
  // scaffolds the wrong template without a word of warning.
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const targets: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (!token.startsWith("-")) {
      targets.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    const name = equals === -1 ? token : token.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : token.slice(equals + 1);
    if (BOOLEAN_FLAGS.has(name)) {
      if (inlineValue !== undefined)
        throw new Error(`Option '${name}' takes no value. ${SCAFFOLD_USAGE}`);
      booleans.add(name);
      continue;
    }
    if (!VALUE_FLAGS.has(name) && !PACKAGE_SOURCE_FLAG.test(name))
      throw new Error(`Unknown option '${name}'. ${SCAFFOLD_USAGE}`);
    const next = argv[index + 1];
    const value = inlineValue ?? next;
    if (value === undefined || value.length === 0 || value.startsWith("-"))
      throw new Error(`Option '${name}' requires a value. ${SCAFFOLD_USAGE}`);
    values.set(name, value);
    if (inlineValue === undefined) index += 1;
  }
  const target = targets[0];
  if (target === undefined) throw new Error(`Missing target directory. ${SCAFFOLD_USAGE}`);
  if (targets.length > 1)
    throw new Error(`Unexpected extra argument '${targets.at(1)}'. ${SCAFFOLD_USAGE}`);
  const template = values.get("--template") as ScaffoldTemplate | undefined;
  if (template !== undefined) kitManifest(template);
  const genre = values.get("--genre");
  if (template !== undefined && genre !== undefined)
    throw new Error(`Options '--template' and '--genre' cannot be combined. ${SCAFFOLD_USAGE}`);
  const resolvedTemplate = genre === undefined ? template : templateForGenre(genre);
  const packageSources: Record<string, string> = {};
  const knownPackageFlags = new Set<string>(Object.values(PACKAGE_SOURCE_FLAGS));
  for (const [name, flag] of Object.entries(PACKAGE_SOURCE_FLAGS)) {
    const source = values.get(flag);
    if (source !== undefined) packageSources[name] = source;
  }
  for (const [flag, source] of values) {
    if (knownPackageFlags.has(flag)) continue;
    const name = packageNameFromFlag(flag);
    if (name !== undefined) packageSources[name] = source;
  }
  const shortRuntimeSource = values.get("--runtime-package");
  if (shortRuntimeSource !== undefined) {
    packageSources["@threenative/runtime-native"] = shortRuntimeSource;
  }
  return {
    install: !booleans.has("--no-install"),
    target,
    ...(Object.keys(packageSources).length === 0 ? {} : { packageSources }),
    ...(resolvedTemplate === undefined ? {} : { template: resolvedTemplate }),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "inspect") {
    if (argv.includes("--help") || argv.includes("-h")) {
      process.stdout.write(inspectHelp());
      return;
    }
    await inspectCommand(argv.slice(1));
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(cliHelp());
    return;
  }
  const result = await createProject(parseArgs(argv));
  process.stdout.write(`Created ${result.template} project at ${result.target}\n`);
  process.stdout.write(scaffoldCompletionMessage(discoverKitManifests()));
  if (!result.installed)
    process.stdout.write("Skipped install (--no-install). Run pnpm install, then pnpm dev.\n");
  else process.stdout.write("Next: cd into the project and run pnpm dev.\n");
}

// `realpathSync`, not `path.resolve`. A package manager installs a `bin` as a symlink, so the
// installed CLI runs as `node_modules/.bin/create-threenative` while `import.meta.url` is the
// real `dist/index.js`. `path.resolve` normalises a path but does not follow symlinks, so the
// two never matched, this guard was false, and the published CLI exited 0 having done nothing —
// no project, no error, no output. It worked in this workspace only because the tests invoke
// `dist/index.js` directly.
//
// `packages/playtest/src/runner/cli.ts:180` carries the same fix for the same reason; its
// regression test is `__tests__/cli-bin.spec.ts`.
const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  existsSync(entryPath) &&
  realpathSync(path.resolve(entryPath)) === realpathSync(fileURLToPath(import.meta.url))
) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
