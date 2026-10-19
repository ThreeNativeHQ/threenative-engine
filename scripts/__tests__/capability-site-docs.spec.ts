import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";
import { jobSections } from "../ci-workflow.js";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const { classify } = await import(new URL("../ci-change-scope.mjs", import.meta.url).href);

/** The path filters `site-docs.yml` dispatches the site's redeploy on. */
function dispatchPaths(): readonly string[] {
  const source = readFileSync(path.join(REPO, ".github/workflows/site-docs.yml"), "utf8");
  const list = /paths:\n((?: {6}- .*\n)+)/u.exec(source)?.[1] ?? "";
  return list
    .split("\n")
    .map((line) =>
      line
        .replace(/^ {6}- /u, "")
        .trim()
        .replace(/^"|"$/gu, ""),
    )
    .filter((pattern) => pattern !== "");
}

/** GitHub path filters: `*` never crosses a `/`, `**` does. */
function matches(pattern: string, file: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0000", ".*");
  return new RegExp(`^${escaped}$`, "u").test(file);
}

/** Every module the generator imports, which is every file whose bytes can move the manifest. */
function generatorImports(): readonly string[] {
  const source = readFileSync(path.join(REPO, "scripts/build-capability-manifest.ts"), "utf8");
  return [...source.matchAll(/from "(\.[^"]+)"/gu)].map((match) =>
    path
      .relative(REPO, path.resolve(REPO, "scripts", (match[1] ?? "").replace(/\.js$/u, ".ts")))
      .split(path.sep)
      .join("/"),
  );
}

/**
 * One real file from each directory the generator reads beside its imports: an export map, the
 * sources it points at, the template closure whose imports must resolve, and the manifests written.
 */
const GENERATED_FROM: readonly string[] = [
  "packages/core/package.json",
  "packages/core/src/animation.ts",
  "packages/ui/package.json",
  "packages/ui/src/index.ts",
  "packages/create-threenative/templates/starter/package.json",
  "packages/create-threenative/templates/starter/src/game.ts",
  "packages/create-threenative/capabilities.json",
  "packages/core/capabilities.json",
];

function gitFixture() {
  const root = makeTempDirSync("threenative-capability-dispatch-");
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q");
  git("config", "user.email", "capability@example.com");
  git("config", "user.name", "capability");
  writeFileSync(path.join(root, "README.md"), "base\n");
  git("add", ".");
  git("commit", "-qm", "base");
  return {
    root,
    change(file: string) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), "export const changed = 1;\n");
      git("add", ".");
      git("commit", "-qm", "change");
      return { base: git("rev-parse", "HEAD~1"), head: git("rev-parse", "HEAD") };
    },
  };
}

describe("the capability manifest reaches threenative.com", () => {
  it("dispatches the site for every module the manifest generator imports", () => {
    const patterns = dispatchPaths();
    expect(patterns.length).toBeGreaterThan(0);
    for (const file of generatorImports()) {
      expect(existsSync(path.join(REPO, file)), `generator import ${file} moved`).toBe(true);
      expect(
        patterns.some((pattern) => matches(pattern, file)),
        `${file} changes the manifest but site-docs.yml does not dispatch the site for it`,
      ).toBe(true);
    }
  });

  it("dispatches the site for the package sources, export maps, templates and manifests it reads", () => {
    const patterns = dispatchPaths();
    for (const file of GENERATED_FROM) {
      expect(existsSync(path.join(REPO, file)), `${file} moved`).toBe(true);
      expect(
        patterns.some((pattern) => matches(pattern, file)),
        `${file} changes the manifest but site-docs.yml does not dispatch the site for it`,
      ).toBe(true);
    }
  });
});

describe("a stale manifest cannot reach develop", () => {
  it("runs the freshness gate in a job every selection that can carry a stale manifest reaches", () => {
    const ci = readFileSync(path.join(REPO, ".github/workflows/ci.yml"), "utf8");
    const budgets = jobSections(ci).find(([name]) => name === "budgets")?.[1] ?? "";
    // `pnpm budgets` reaches `checkCapabilityManifest`; the manifest spec that also refuses a stale
    // copy runs under `full` only, so this job is the gate and it has to cover the other selections.
    expect(budgets).toContain("pnpm budgets");
    for (const selection of ["full", "template", "ci"]) {
      expect(budgets).toContain(`selection == '${selection}'`);
    }
    const checkBudgets = readFileSync(path.join(REPO, "scripts/check-budgets.ts"), "utf8");
    expect(checkBudgets).toContain("await capabilityManifestErrors(root)");
  });

  it.each([
    "packages/core/src/animation.ts",
    "packages/create-threenative/templates/starter/package.json",
    "scripts/build-capability-manifest.ts",
  ])("keeps the freshness gate required for a change to %s", (file) => {
    const fixture = gitFixture();
    try {
      const { base, head } = fixture.change(file);
      const plan = classify({
        root: fixture.root,
        base,
        head,
        candidateSha: head,
        target: "develop",
        eventName: "pull_request",
      });
      expect(plan.jobs.budgets?.required, `${file} selected ${plan.selection}`).toBe(true);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
