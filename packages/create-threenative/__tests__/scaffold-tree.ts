// The two hashes a scaffolded tree is pinned by, and the rule that decides which is which.
//
// One hash per kit could not answer the question a re-pin asks: did this change come from the kit, or
// from a shared input every kit receives? `c93b427d0` moved 16 pins for one look change in a shared
// file, and every pin looked the same. Two buckets make the answer part of the pin: a shared edit
// moves only `shared`, a kit edit moves only `kit`.
//
// The classification is derived, not listed: a file the kit's own template directory holds is the
// kit's, and anything the scaffolder rendered from `agent-docs`, `agent-files`, `template-assets` or
// core's tables is shared. Two kinds of file are the kit's own bytes but the shared contract, so they
// name themselves here: the generated instruction pair, which is a router over shared fragments, and
// the shared render sources the scaffolder restamps into every kit.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { SHARED_RENDER_SOURCES, templateRoot } from "../src/index.js";
import { kitMainDelta } from "../src/plumbing.js";

/** Output, not source: the same exclusions the tree pin always had. */
const GENERATED_SCAFFOLD_METADATA =
  /^(?:node_modules(?:\/|$)|dist(?:\/|$)|\.vite(?:\/|$)|coverage(?:\/|$)|pnpm-lock\.yaml$|package-lock\.json$|yarn\.lock$)/u;

/** A copy of a package's own patch: the file hashes by name, and the copy is guarded on its own. */
const FRAMEWORK_PATCH = /^patches\/[^/]+\.patch$/u;

/** `pnpm release:prepare` moves these on every release, so a version bump alone must not move a tree. */
const COHORT_PIN =
  /("(?:@threenative\/[\w-]+|create-threenative|threenative-[\w-]+)":\s*)"\d+\.\d+\.\d+(?:-[\w.]+)?"/gu;

/**
 * Files that live in the kit's tree but are generated from one source, so a change to that source
 * moves the `shared` hash rather than sixteen `kit` hashes: the instruction routers, and the build
 * plumbing `src/plumbing.ts` writes. A kit that declares its entry hand-written keeps that entry in
 * its own bucket (see `isSharedScaffoldPath`), so an edit there moves one `kit` hash.
 */
const GENERATED_INSTRUCTION_FILES: ReadonlySet<string> = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "tsconfig.json",
  "vite.config.ts",
  "src/main.ts",
]);

/** A template file the scaffolder renames on the way out, so the kit holds it under another name. */
const RENAMED_BY_SCAFFOLDER: Readonly<Record<string, string>> = { ".gitignore": "gitignore" };

/** The two hashes a kit is pinned by. */
export interface IScaffoldTreePin {
  /** The hash of everything the scaffolder built from outside this kit's own tree. */
  readonly shared: string;
  /** The hash of the kit's own files. */
  readonly kit: string;
}

/** A pin plus the paths behind each hash, for a tool that has to say what moved. */
export interface IScaffoldTreeBuckets extends IScaffoldTreePin {
  readonly sharedPaths: readonly string[];
  readonly kitPaths: readonly string[];
}

/**
 * Whether `relativePath` in a scaffold of `template` came from a shared input.
 *
 * Exported because the pin tool reports against the same rule the spec asserts with: two copies of
 * "what counts as shared" would drift the moment a new synthesized file ships.
 */
export function isSharedScaffoldPath(
  relativePath: string,
  template: string,
  root = templateRoot(),
): boolean {
  // A kit's entry is generated from one source, except where the kit declares its own: that file is
  // the kit's bytes and a hand edit there must move the kit hash, not the shared one.
  if (relativePath === "src/main.ts" && kitMainDelta(template, root).handWritten) return false;
  if (GENERATED_INSTRUCTION_FILES.has(relativePath)) return true;
  if (SHARED_RENDER_SOURCES.includes(relativePath)) return true;
  const source = RENAMED_BY_SCAFFOLDER[relativePath] ?? relativePath;
  return !existsSync(path.join(root, template, source));
}

/** Every file in a scaffolded tree, relative to it, sorted, minus what the build generates. */
export async function scaffoldTreeFiles(directory: string): Promise<readonly string[]> {
  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const file = path.join(current, entry.name);
      // A linked skill directory reports isDirectory() false, so it needs the stat to be walked
      // like the real one — otherwise the tree hash silently drops half of every skill.
      if (entry.isDirectory() || (entry.isSymbolicLink() && (await stat(file)).isDirectory())) {
        await walk(file);
        continue;
      }
      const relative = path.relative(directory, file);
      if (!GENERATED_SCAFFOLD_METADATA.test(relative)) files.push(relative);
    }
  }
  await walk(directory);
  return files;
}

/** The bytes a pin sees: a framework patch by name, a cohort pin as one placeholder. */
async function pinnedBytes(file: string, relativePath: string): Promise<Buffer> {
  if (FRAMEWORK_PATCH.test(relativePath)) return Buffer.from("<framework patch>");
  const bytes = await readFile(file);
  if (path.basename(relativePath) !== "package.json") return bytes;
  return Buffer.from(bytes.toString("utf8").replace(COHORT_PIN, '$1"<cohort>"'));
}

function digest(entries: readonly (readonly [string, Buffer])[]): string {
  const hash = createHash("sha256");
  for (const [relativePath, contents] of entries) {
    hash.update(relativePath).update("\0").update(contents).update("\0");
  }
  return hash.digest("hex");
}

/** The two hashes of one scaffolded tree, plus the paths each covers. */
export async function scaffoldTreeBuckets(
  target: string,
  template: string,
  root = templateRoot(),
): Promise<IScaffoldTreeBuckets> {
  const shared: [string, Buffer][] = [];
  const kit: [string, Buffer][] = [];
  for (const relativePath of await scaffoldTreeFiles(target)) {
    const entry: [string, Buffer] = [
      relativePath,
      await pinnedBytes(path.join(target, relativePath), relativePath),
    ];
    (isSharedScaffoldPath(relativePath, template, root) ? shared : kit).push(entry);
  }
  return {
    shared: digest(shared),
    kit: digest(kit),
    sharedPaths: shared.map(([relativePath]) => relativePath),
    kitPaths: kit.map(([relativePath]) => relativePath),
  };
}
