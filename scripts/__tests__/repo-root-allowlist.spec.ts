import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * PRD-826: the public repo's top level is an allowlist. A new root entry, a tracked log or a
 * per-user file fails here until someone adds it with a reason. Read from `git ls-files`, as
 * `source-hygiene.spec.ts` does, so an ignored local file never counts.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every tracked top-level name, with the reason it belongs in a public MIT repository. */
const ROOT_ENTRIES: Readonly<Record<string, string>> = {
  ".agents": "agent skills for contributors",
  ".claude": "Claude Code project settings, hooks and skills",
  ".codex": "Codex project config",
  ".dockerignore": "image build context",
  ".gitattributes": "git attributes",
  ".github": "workflows and templates",
  ".gitignore": "git ignore rules",
  ".gitleaksignore": "secret-scan allowlist",
  ".ignore": "search ignore rules",
  ".vscode": "shared editor settings",
  "AGENTS.md": "agent rules",
  "CHANGELOG.md": "read by the API-surface gate",
  "CLAUDE.md": "generated agent mirror",
  "CODE_OF_CONDUCT.md": "community file",
  "CONTRIBUTING.md": "community file",
  LICENSE: "licence",
  "PERFORMANCE-LEARNINGS.md": "the perf memory the perf skills read at this path",
  "README.md": "readme",
  "SECURITY.md": "community file",
  "THIRD_PARTY_NOTICES.md": "licence notices",
  "TRADEMARKS.md": "trademark policy",
  benchmark: "engine load-test inputs",
  "benchmark.playwright.config.ts": "benchmark runner config",
  "biome.json": "formatter and linter config",
  docs: "documentation, PRDs and capped evidence",
  examples: "example games",
  githooks: "pre-commit and pre-push hooks",
  "package.json": "workspace manifest",
  packages: "workspace packages",
  patches: "dependency patches",
  playtests: "root playtest fixture",
  "playwright.config.ts": "browser test config",
  "pnpm-lock.yaml": "lockfile",
  "pnpm-workspace.yaml": "workspace and version catalog",
  scripts: "repo tooling",
  "test-support": "shared test helpers",
  tests: "browser tests",
  tools: "CI runner image and Unreal reference scenes",
  "tsconfig.base.json": "TypeScript base config",
  "tsconfig.json": "TypeScript project references",
  "vitest.config.ts": "unit test config",
};

/** Raw command output that a past evidence record cites by path. No new log may join them. */
const CITED_LOG_DIRECTORIES = [
  "docs/verification/findings-2026-09-07-bayview-fix/",
  "docs/verification/startup-measure-reduce-2026-09-09/",
];

const PER_USER_OR_STRAY =
  /(^|\/)(\.linchpin[^/]*|[^/]*\.local\.[^/]+|notify\.log|\.DS_Store|\.env)$|^plans\//u;

function trackedFiles(): string[] {
  return execFileSync("git", ["-C", repoRoot, "ls-files"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter((file) => file.length > 0);
}

describe("repository root allowlist", () => {
  const files = trackedFiles();

  it("tracks only the top-level names the allowlist gives a reason for", () => {
    const names = new Set(files.map((file) => file.split("/")[0] ?? file));
    expect([...names].filter((name) => ROOT_ENTRIES[name] === undefined).sort()).toEqual([]);
  });

  it("tracks no per-user file, stray report folder or local environment file", () => {
    expect(files.filter((file) => PER_USER_OR_STRAY.test(file))).toEqual([]);
  });

  it("tracks a .log file only where a record cites it", () => {
    const logs = files.filter((file) => file.endsWith(".log"));
    expect(
      logs.filter((file) => !CITED_LOG_DIRECTORIES.some((directory) => file.startsWith(directory))),
    ).toEqual([]);
  });
});
