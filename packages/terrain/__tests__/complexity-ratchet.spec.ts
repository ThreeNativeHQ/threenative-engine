/**
 * PRD-886: a new god function fails the gate.
 *
 * Biome's `noExcessiveCognitiveComplexity` (15) is a repository-wide warning, because the recovered
 * evaluator and the editor still hold the offenders PRD-886 inherited. A warning does not fail a
 * gate, and Biome has no per-tree baseline, so this spec is the baseline: the count per file is
 * committed, and a file that gains one — or a new file with one — fails. A refactor that removes
 * one passes, and the fixture only shrinks.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(root, "..", "..");
const biome = path.join(repoRoot, "node_modules", ".bin", "biome");
const BASELINE = path.join(root, "__tests__", "fixtures", "complexity-baseline.json");

type IComplexityBaseline = { readonly total: number; readonly files: Record<string, number> };

/** Every function over complexity 15 in `packages/terrain/src`, counted per file. */
function offenders(): Record<string, number> {
  const args = ["check", "packages/terrain/src", "--max-diagnostics=1000", "--reporter=json"];
  const output = execFileSync(biome, args, { cwd: repoRoot, encoding: "utf8" });
  const report = JSON.parse(output) as {
    diagnostics: readonly { category: string; location: { path: { file: string } } }[];
  };
  const counts: Record<string, number> = {};
  for (const diagnostic of report.diagnostics) {
    if (diagnostic.category !== "lint/complexity/noExcessiveCognitiveComplexity") continue;
    const file = diagnostic.location.path.file;
    counts[file] = (counts[file] ?? 0) + 1;
  }
  return counts;
}

describe("terrain complexity ratchet", () => {
  it("fails when a terrain file gains a function over complexity 15", () => {
    // A checkout without the repository's own devDependencies cannot run the rule at all; say so
    // instead of passing with no observation.
    expect(existsSync(biome), "run pnpm install at the repository root to run the lint ratchet").toBe(
      true,
    );
    const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as IComplexityBaseline;
    const counted = offenders();
    const grew = Object.entries(counted)
      .filter(([file, count]) => count > (baseline.files[file] ?? 0))
      .map(([file, count]) => `${file}: ${String(count - (baseline.files[file] ?? 0))} new`);
    expect(grew).toEqual([]);
  });
});
