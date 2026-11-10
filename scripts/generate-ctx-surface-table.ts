import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Generates the supersession half of the context skill from `capabilities.json`, so the table an
 * agent reads and the constructs the reinvention gate enforces are the same fact (PRD-187 phase
 * 3). The hand-maintained part of the skill keeps documenting `ctx` property signatures — a
 * different job; this region owns every construct `pnpm budgets` will fail on.
 *
 * Runs inside `pnpm build` after the manifest is generated; `--check` turns a hand-edit of the
 * region into a red gate instead of silent drift.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_RELATIVE_PATH = path.join("packages", "core", "capabilities.json");
const TARGET_RELATIVE_PATH = path.join(
  "packages",
  "create-threenative",
  "agent-files",
  ".agents",
  "skills",
  "threenative-context",
  "SKILL.md",
);
// The skill is stored once; the scaffold links `.claude/skills` into it (PRD-449).
const TARGET_RELATIVE_PATHS = [TARGET_RELATIVE_PATH] as const;

export const GENERATED_REGION_START = "<!-- generated: superseded-constructs -->";
const GENERATED_REGION_END = "<!-- /generated -->";

export interface IManifestEntry {
  readonly importPath: string;
  readonly kind: string;
  readonly supersedes: readonly string[];
  readonly symbol: string;
}

/** One markdown table row per (capability × construct); the gate fails per construct. */
export function buildSupersessionRows(entries: readonly IManifestEntry[]): string {
  const rows: string[] = [];
  const sorted = [...entries].sort((left, right) =>
    `${left.importPath}:${left.symbol}`.localeCompare(`${right.importPath}:${right.symbol}`),
  );
  for (const entry of sorted) {
    if (!/@threenative\/(?:core|physics)/u.test(entry.importPath)) continue;
    for (const construct of entry.supersedes) {
      rows.push(
        `| \`${construct.replaceAll("|", "\\|")}\` | \`${entry.symbol}\` | \`${entry.importPath}\` |`,
      );
    }
  }
  return [...rows].join("\n");
}

/** Replace (or append) the generated region in the skill body. */
export function applyRegion(skill: string, entries: readonly IManifestEntry[]): string {
  const start = skill.indexOf(GENERATED_REGION_START);
  const section = [
    GENERATED_REGION_START,
    "",
    "**Reinvention fails CI.** `pnpm budgets` scans this project's `src/` for these raw",
    "constructs and fails, naming the capability instead. The list and the gate are generated",
    "from the capabilities' own doc tags, so they cannot disagree:",
    "",
    "| Rather than write | Use instead | Import from |",
    "|---|---|---|",
    buildSupersessionRows(entries),
    "",
    "When the raw construct is genuinely right, annotate that exact line with a non-empty",
    "reason — a bare `// engine-override:` still fails:",
    "",
    "```ts",
    "const bounds = new Box3().setFromObject(viewmodel); // engine-override: measuring, not scaling",
    "```",
    "",
    GENERATED_REGION_END,
  ].join("\n");

  if (start === -1) return `${skill.trimEnd()}\n\n${section}\n`;
  const end = skill.indexOf(GENERATED_REGION_END, start);
  if (end === -1) throw new Error("generated region is missing its close marker");
  return `${skill.slice(0, start)}${section}${skill.slice(end + GENERATED_REGION_END.length)}`;
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const manifestFile = path.join(repoRoot, MANIFEST_RELATIVE_PATH);
  const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as {
    entries: IManifestEntry[];
  };
  const canonicalPath = path.join(repoRoot, TARGET_RELATIVE_PATH);
  const canonical = await readFile(canonicalPath, "utf8");
  const expected = applyRegion(canonical, manifest.entries);
  const actuals = await Promise.all(
    TARGET_RELATIVE_PATHS.map((relativePath) =>
      readFile(path.join(repoRoot, relativePath), "utf8"),
    ),
  );
  const stale = TARGET_RELATIVE_PATHS.filter((_, index) => actuals[index] !== expected);
  if (check) {
    if (stale.length > 0) {
      console.error(
        `RED observed: ${stale.join(", ")} disagrees with capabilities.json; run pnpm build`,
      );
      process.exitCode = 1;
      return;
    }
    console.log("threenative-context supersession table in sync with capabilities.json");
    return;
  }
  if (stale.length > 0) {
    for (const relativePath of stale) await writeFile(path.join(repoRoot, relativePath), expected);
    console.log(`threenative-context supersession table regenerated in ${stale.join(", ")}`);
  } else {
    console.log("threenative-context supersession table already in sync");
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  await main();
}
