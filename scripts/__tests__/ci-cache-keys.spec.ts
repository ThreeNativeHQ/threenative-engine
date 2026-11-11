/**
 * A cache key a run can restore has a stable head and a per-run tail.
 *
 * Round 4 measured the consequence of getting that wrong: `test-native` reported
 * `Hits: 229 / 1076 (21.28%)` in run 41688813459 while `native-engine` and both `starter-linux`
 * legs reported 100% on the same board. Its `restore-keys` repeated the job key's own
 * `hashFiles()` over `CMakeLists.txt` and every `*.cmake`, so any native change produced a prefix
 * no saved entry could match, and the previous develop run's entry (`…-gcc-3ea15707…`) was
 * unreachable from a branch whose files hashed to `…-gcc-ccb139…`.
 *
 * The compiler cache does not need that match. ccache keys every object by its compiler, its flags
 * and its source, so an object restored from another tree is either identical or a miss; the
 * restore prefix may name the lane alone. `test-native` also has to save on `develop`, because a
 * pull request reads its own merge ref, its base branch and the default branch, and nothing else.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { jobSections } from "../ci-workflow.js";

const repo = join(import.meta.dirname, "..", "..");

function readWorkflow(name: string): string {
  return readFileSync(join(repo, ".github/workflows", name), "utf8");
}

function job(source: string, name: string): string {
  const found = jobSections(source).find(([jobName]) => jobName === name)?.[1];
  if (found === undefined) throw new Error(`the workflow declares no ${name} job`);
  return found;
}

/** One step block of a job: from its `- name:` heading to the next step or the job's end. */
function step(source: string, name: string): string {
  const at = source.indexOf(`- name: ${name}`);
  if (at < 0) throw new Error(`the job declares no step named ${name}`);
  return source.slice(at).split("\n      - ")[0] ?? "";
}

function field(block: string, name: "key" | "restore-keys"): string {
  const match = new RegExp(`^ {10}${name}: (.*)$`, "mu").exec(block);
  if (match?.[1] === undefined) throw new Error(`the step declares no ${name}`);
  const scalar = match[1].trim();
  // `>-` folds its continuation lines with a single space, which is exactly how a literal space
  // ends up inside a key; `|` keeps one value per line. Either way the value is what this returns.
  if (scalar !== ">-" && scalar !== "|") return scalar;
  const rest = block
    .slice((match.index ?? 0) + match[0].length)
    .split("\n")
    .slice(1);
  const values: string[] = [];
  for (const line of rest) {
    if (!line.startsWith("            ")) break;
    values.push(line.trim());
  }
  return scalar === ">-" ? values.join(" ") : (values[0] ?? "");
}

describe("the test-native compiler cache key", () => {
  const native = job(readWorkflow("ci.yml"), "test-native");

  it("restores from a prefix that a native change cannot invalidate", () => {
    const block = step(native, "Restore native compiler cache");
    const key = field(block, "key");
    const restore = field(block, "restore-keys");
    // The head of the key names the lane, the operating system and the architecture, and nothing
    // that moves with the source tree.
    expect(restore).toBe("native-ccache-ci-test-native-${{ runner.os }}-${{ runner.arch }}-gcc-");
    expect(key.startsWith(restore)).toBe(true);
    // The per-run part stays last: `actions/cache` saves when the exact key is absent, and every
    // run has to be able to store what it compiled.
    expect(key.endsWith("-${{ github.run_id }}")).toBe(true);
  });

  it("never lets a hash of the source tree into the restore prefix", () => {
    const block = step(native, "Restore native compiler cache");
    expect(field(block, "restore-keys")).not.toContain("hashFiles(");
    // The exact key may carry the source hash; a restore may not depend on it.
    expect(field(block, "key")).toContain("hashFiles(");
  });
});

describe("the Android dependency key a new ref restores", () => {
  it("names the platform, then the content hash, with nothing between them", () => {
    const android = job(readWorkflow("native-platforms.yml"), "android-emulator-parity");
    const block = step(android, "Restore native third-party dependencies");
    const key = field(block, "key");
    // The folded `>-` block put a space between `-` and the hash:
    // `native-android-third-party-Linux-X64- 4c553d1e…` in run 41718838521's job log. A key is
    // matched as text, so a key that carries a space is a key no reader of this workflow expects.
    // Whitespace inside `${{ … }}` is the expression's, and it evaluates away.
    expect(key.replace(/\$\{\{.*?\}\}/gu, "X")).not.toMatch(/\s/u);
    expect(key).toMatch(
      /^native-android-third-party-\$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}-\$\{\{/u,
    );
  });
});

describe("the built web engine key", () => {
  // The action's own dependency loop decides which sources the engine links. #658 added basisu to
  // it, the key did not move, and the cache kept serving an engine that refused KHR_texture_basisu.
  it("changes when the action's dependency list changes", () => {
    const action = readFileSync(
      join(repo, ".github/actions/native-engine-wasm/action.yml"),
      "utf8",
    );
    const key = action.match(/key: native-engine-web-wasm-[^\n]*/)?.[0];
    expect(key).toBeDefined();
    expect(action).toMatch(/for dependency in [^\n]*basisu/);
    expect(key).toContain("'.github/actions/native-engine-wasm/action.yml'");
  });
});
