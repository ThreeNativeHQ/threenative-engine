import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * PRD-357: the default search path is the code.
 *
 * Three rules that only exist if a gate holds them:
 *
 * - The worktree directories are ignored by files that ship with the clone. `.worktrees` always
 *   was; `.claude/worktrees` was held by line 12 of a hand-written, per-clone
 *   `.git/info/exclude`, so on CI, a fresh machine or a sandbox ripgrep crossed 629,652 files
 *   and stopped being the fast path.
 * - The root `AGENTS.md` never-search clause names both directories, not one. The global
 *   worktree convention mandates `<repo-root>/.claude/worktrees/`, and the sentence did not
 *   name it.
 * - The tracked `.ignore` keeps finished records out of the *default* search path while leaving
 *   them reachable to every gate. That second half is the load-bearing one: `.ignore` is read by
 *   ripgrep, invisible to git and invisible to `fs`, so it may not move a single byte for
 *   `pnpm sync:agents --check`, `pnpm budgets`, `pnpm quality` or `primary-docs.spec.ts`. Those
 *   four gates are run whole and pasted in docs/verification/prd-357-search-noise.md; what this
 *   spec pins is the mechanism that makes them indifferent — they reach the ignored paths
 *   through `fs` and git, and no live call site hands ripgrep a directory.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

interface ICheckIgnoreResult {
  readonly pattern: string;
  readonly source: string;
}

/** `git check-ignore -v` prints `<source>:<line>:<pattern>\t<pathname>`; the source is the file
 * that won, which is the whole question here. Absent from the output means "not ignored". */
function checkIgnore(pathname: string): ICheckIgnoreResult | undefined {
  const result = spawnSync("git", ["check-ignore", "-v", "--no-index", pathname], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error !== undefined) throw result.error;
  const line = result.stdout.split("\n").find((entry) => entry.includes("\t"));
  if (line === undefined) return undefined;
  const [description] = line.split("\t");
  const parts = (description ?? "").split(":");
  const pattern = parts.slice(2).join(":");
  const source = parts[0] ?? "";
  return { pattern, source: path.relative(repoRoot, path.resolve(repoRoot, source)) };
}

async function readRepoFile(relative: string): Promise<string> {
  return readFile(path.join(repoRoot, relative), "utf8");
}

function trackedFiles(...args: readonly string[]): readonly string[] {
  const result = spawnSync("git", ["ls-files", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
  });
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr}`);
  return result.stdout.split("\n").filter((entry) => entry.length > 0);
}

/** The one sentence that says which directories are never searched — not the paragraph around
 * it. The paragraph names `.claude/worktrees/` a second time while explaining the history, so a
 * paragraph-wide assertion stays green through the mutation this criterion declares (checked:
 * deleting the directory from the rule itself left a paragraph-wide check passing). */
function neverSearchSentence(text: string): string {
  const start = text.indexOf("other agents' lanes");
  if (start < 0) return "";
  const paragraphStart = text.lastIndexOf("\n\n", start);
  const paragraphEnd = text.indexOf("\n\n", start);
  const paragraph = text.slice(
    paragraphStart < 0 ? 0 : paragraphStart,
    paragraphEnd < 0 ? text.length : paragraphEnd,
  );
  return paragraph.split(/(?<=\.)\s+/u).find((sentence) => sentence.includes("never search")) ?? "";
}

describe("worktree ignore rules ship with the clone (PRD-357 F1)", () => {
  it("should ignore .claude/worktrees from .gitignore, not .git/info/exclude", () => {
    const match = checkIgnore(".claude/worktrees");
    expect(match, ".claude/worktrees is not ignored at all").toBeDefined();
    // The mutation this criterion states: drop the `.gitignore` line and the winning source
    // falls back to the per-clone `.git/info/exclude`, which a fresh clone does not have.
    expect(match?.source).toBe(".gitignore");
  });

  it("should ignore a file inside .claude/worktrees from .gitignore", () => {
    const match = checkIgnore(path.join(".claude", "worktrees", "lane", "packages", "a.ts"));
    expect(match?.source).toBe(".gitignore");
  });

  it("should keep ignoring .worktrees from .gitignore", () => {
    expect(checkIgnore(".worktrees")?.source).toBe(".gitignore");
  });
});

describe("the never-search clause names both worktree roots (PRD-357 F1)", () => {
  it("should name .claude/worktrees in the root AGENTS.md never-search clause", async () => {
    const sentence = neverSearchSentence(await readRepoFile("AGENTS.md"));
    expect(sentence, "no never-search sentence found in AGENTS.md").not.toBe("");
    expect(sentence).toContain("`.worktrees/`");
    expect(sentence).toContain("`.claude/worktrees/`");
  });

  it("should carry the same clause into the generated CLAUDE.md mirror", async () => {
    const sentence = neverSearchSentence(await readRepoFile("CLAUDE.md"));
    expect(sentence).toContain("`.claude/worktrees/`");
  });
});

describe("the tracked .ignore (PRD-357 F2/F5)", () => {
  it("should exist, be tracked, and list the finished records and the mirrors", async () => {
    expect(trackedFiles(".ignore")).toEqual([".ignore"]);
    const entries = (await readRepoFile(".ignore"))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    expect(entries).toContain("docs/PRDs/done/");
    expect(entries).toContain("CLAUDE.md");
  });

  it("should name the flag that reaches the ignored records", async () => {
    // An ignore rule an agent cannot undo is a deletion. The file says how to cross it.
    expect(await readRepoFile(".ignore")).toContain("--no-ignore");
  });

  it("should leave the archived PRDs and the mirrors reachable through git and fs", async () => {
    const donePrds = trackedFiles("docs/PRDs/done");
    expect(donePrds.length).toBeGreaterThan(200);
    const onDisk = await readdir(path.join(repoRoot, "docs", "PRDs", "done"));
    expect(onDisk.filter((entry) => entry.endsWith(".md")).length).toBeGreaterThan(200);

    const mirrors = trackedFiles("CLAUDE.md", "*/CLAUDE.md", "*/*/CLAUDE.md", "*/*/*/CLAUDE.md");
    expect(mirrors).toContain("CLAUDE.md");
    expect(mirrors.length).toBeGreaterThan(15);
    for (const mirror of mirrors) {
      expect(await readRepoFile(mirror)).toContain("Generated mirror of AGENTS.md");
    }
  });

  it("should keep every live ripgrep call site off directory arguments", () => {
    // The safety fact `.ignore` rests on: nothing in this repository shells out to `rg` with a
    // directory to walk, so no gate result can change because a path became ignored. A new call
    // site has to be looked at, which is what this list makes happen.
    const result = spawnSync(
      "git",
      [
        "grep",
        "-nE",
        "(^|[^-[:alnum:]_/.])rg[[:space:]]+-",
        "--",
        "scripts",
        "packages",
        ".github",
        "package.json",
      ],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 1024 * 1024 * 32 },
    );
    const sites = result.stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => line.split(":").slice(0, 2).join(":"));
    expect(sites).toEqual([
      // Takes a log file path, not a directory.
      "packages/playtest/__tests__/orphan-cleanup.sh:163",
      // Inert: an expected-substring literal inside a spec, never executed.
      "scripts/__tests__/sweep-delta.spec.ts:193",
    ]);
  });
});
