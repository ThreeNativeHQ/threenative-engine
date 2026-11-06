import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { kitFragments } from "./kit-agent-docs.js";

const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  "test-results",
  ".runtime",
  ".claude",
  ".cxx",
  ".gradle",
  ".test-tmp",
  ".linchpin",
  ".worktrees",
  "artifacts",
  "build",
  "target",
  "third_party",
]);

// Hosting is an application root, not a workspace package, but its service rules still need a
// generated CLAUDE.md mirror. Keep this explicit as the hosting tree grows its own subdirectories.
const MIRRORED_APPLICATION_ROOTS = new Set(["hosting"]);

/**
 * Trees whose `AGENTS.md` files are evidence rather than repository rules.
 *
 * A sweep archive is a frozen copy of what a builder was given and what it wrote. Framework-arm
 * archives happen to carry a `CLAUDE.md` because the template ships both, so this never bit until
 * round 9 archived the first vanilla arm — whose `AGENTS.md` the sandbox generates on its own. The
 * mirror check then wanted to write a `CLAUDE.md` into a sealed archive, which would edit evidence
 * to satisfy a rule that does not apply to it. Skipped by path, not by directory name, so an
 * ordinary `sweeps/` elsewhere in the repo would still be mirrored.
 */
const SKIP_PATHS = new Set([path.join("docs", "benchmark")]);
const SHARED_FRAGMENT_DIRECTORY = path.join("packages", "create-threenative", "agent-docs");
const TEMPLATE_DIRECTORY = path.join("packages", "create-threenative", "templates");
const SHARED_MARKER_PATTERN = /<!--\s*shared:\s*([^>]+?)\s*-->|<!--\s*\/shared\s*-->/gu;

export const BANNER = "<!-- Generated mirror of AGENTS.md. Do not edit; edit AGENTS.md. -->\n";

export async function agentsFiles(root: string, base = root): Promise<string[]> {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name) && !MIRRORED_APPLICATION_ROOTS.has(entry.name)) continue;
      if (SKIP_PATHS.has(path.relative(base, absolute))) continue;
      found.push(...(await agentsFiles(absolute, base)));
    } else if (entry.name === "AGENTS.md") {
      found.push(absolute);
    }
  }
  return found.sort();
}

export function mirrorContent(agents: string): string {
  return `${BANNER}\n${agents}`;
}

export async function readSharedFragments(root: string): Promise<Map<string, string>> {
  const directory = path.join(root, SHARED_FRAGMENT_DIRECTORY);
  if (!existsSync(directory)) return new Map();

  const fragments = new Map<string, string>();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const name = entry.name.slice(0, -3);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) {
      throw new Error(`Invalid shared fragment filename '${entry.name}'.`);
    }
    if (fragments.has(name)) throw new Error(`Duplicate shared fragment '${name}'.`);
    fragments.set(name, (await readFile(path.join(directory, entry.name), "utf8")).trimEnd());
  }
  return fragments;
}

interface ISharedReplacement {
  readonly end: number;
  readonly start: number;
  readonly value: string;
}

interface IOpenSharedMarker {
  readonly name: string;
  readonly start: number;
}

export function expandSharedRegions(
  agents: string,
  fragments: ReadonlyMap<string, string>,
  file = "AGENTS.md",
): string {
  const replacements: ISharedReplacement[] = [];
  let open: IOpenSharedMarker | undefined;
  for (const match of agents.matchAll(SHARED_MARKER_PATTERN)) {
    const token = match[0];
    const start = match.index ?? 0;
    const name = match[1]?.trim();
    if (name !== undefined) {
      if (open !== undefined) {
        throw new Error(`Nested shared fragment '${name}' in ${file}; close '${open.name}' first.`);
      }
      open = { name, start };
      continue;
    }

    if (open === undefined) throw new Error(`Unexpected shared fragment close in ${file}.`);
    const fragment = fragments.get(open.name);
    if (fragment === undefined) {
      throw new Error(`Unknown shared fragment '${open.name}' in ${file}.`);
    }
    replacements.push({
      end: start + token.length,
      start: open.start,
      value: `<!-- shared: ${open.name} -->\n${fragment}\n<!-- /shared -->`,
    });
    open = undefined;
  }

  if (open !== undefined) throw new Error(`Unclosed shared fragment '${open.name}' in ${file}.`);
  let expanded = agents;
  for (const replacement of replacements.reverse()) {
    expanded =
      expanded.slice(0, replacement.start) + replacement.value + expanded.slice(replacement.end);
  }
  return expanded;
}

async function validateSharedFragmentUsage(
  root: string,
  fragments: ReadonlyMap<string, string>,
): Promise<void> {
  const directory = path.join(root, TEMPLATE_DIRECTORY);
  if (!existsSync(directory) || fragments.size === 0) return;
  const templateTexts: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const agentsPath = path.join(directory, entry.name, "AGENTS.md");
    if (existsSync(agentsPath)) templateTexts.push(await readFile(agentsPath, "utf8"));
  }
  for (const name of fragments.keys()) {
    const marker = new RegExp(`<!--\\s*shared:\\s*${name}\\s*-->`, "u");
    if (!templateTexts.some((text) => marker.test(text))) {
      throw new Error(`Shared fragment '${name}' is not included by any template AGENTS.md.`);
    }
  }
}

/** Shared fragments plus, for a kit template, the regions generated from its own files (PRD-825). */
export async function fragmentsFor(
  agentsPath: string,
  shared: ReadonlyMap<string, string>,
): Promise<ReadonlyMap<string, string>> {
  const generated = await kitFragments(path.dirname(agentsPath));
  return generated.size === 0 ? shared : new Map([...shared, ...generated]);
}

export interface SyncResult {
  readonly changed: string[];
  readonly checked: string[];
}

export async function syncAgentDocs(root: string, check = false): Promise<SyncResult> {
  const changed: string[] = [];
  const checked: string[] = [];
  const fragments = await readSharedFragments(root);
  await validateSharedFragmentUsage(root, fragments);
  for (const agentsPath of await agentsFiles(root)) {
    const claudePath = path.join(path.dirname(agentsPath), "CLAUDE.md");
    const relativeAgentsPath = path.relative(root, agentsPath);
    const currentAgents = await readFile(agentsPath, "utf8");
    const expandedAgents = expandSharedRegions(
      currentAgents,
      await fragmentsFor(agentsPath, fragments),
      relativeAgentsPath,
    );
    if (currentAgents !== expandedAgents) {
      changed.push(relativeAgentsPath);
      if (!check) await writeFile(agentsPath, expandedAgents);
    }
    const expected = mirrorContent(expandedAgents);
    const current = existsSync(claudePath) ? await readFile(claudePath, "utf8") : undefined;
    checked.push(path.relative(root, claudePath));
    if (current === expected) continue;
    const relativeClaudePath = path.relative(root, claudePath);
    changed.push(relativeClaudePath);
    if (!check) await writeFile(claudePath, expected);
  }
  return { changed, checked };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  const check = process.argv.includes("--check");
  syncAgentDocs(process.cwd(), check)
    .then(({ changed, checked }) => {
      if (check && changed.length > 0) {
        console.error(
          `RED observed: agent docs out of sync with shared fragments or AGENTS.md:\n${changed
            .map((file) => `  ${file}`)
            .join("\n")}\nRun: pnpm sync:agents`,
        );
        process.exitCode = 1;
        return;
      }
      console.log(
        check
          ? `agent docs in sync: ${checked.length} CLAUDE.md mirrors`
          : `agent docs synced: ${checked.length} mirrors, ${changed.length} written`,
      );
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
