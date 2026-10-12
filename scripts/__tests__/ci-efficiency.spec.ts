import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";
import { ciJobGraph, declaredNeeds, jobSections } from "../ci-workflow.js";

const { copyTemplateOwnership, integrationEvidence } = await import(
  new URL("../../test-support/ci-integration-fixture.ts", import.meta.url).href
);

const repo = path.resolve(import.meta.dirname, "../..");
const source = readFileSync(path.join(repo, ".github/workflows/ci.yml"), "utf8");
const jobs = new Map(jobSections(source));

function job(name: string): string {
  const section = jobs.get(name);
  if (section === undefined) throw new Error(`Missing CI job: ${name}`);
  return section;
}

function ancestors(name: string, visited = new Set<string>()): Set<string> {
  for (const upstream of declaredNeeds(job(name))) {
    if (visited.has(upstream)) continue;
    visited.add(upstream);
    ancestors(upstream, visited);
  }
  return visited;
}

function gateScript(): string {
  const match = /^ {8}run: \|\n((?:^ {10}.*\n|^\n)+)/mu.exec(job("build"));
  if (match?.[1] === undefined) throw new Error("build has no executable verdict assertion");
  return match[1].replace(/^ {10}/gmu, "");
}

function runGate(overrides: Record<string, string> = {}) {
  return spawnSync("bash", ["-c", gateScript()], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      CI_SCOPE_RESULT: "success",
      WORKSPACE_BUILD_RESULT: "success",
      ...overrides,
    },
    timeout: 5_000,
  });
}

describe("CI efficiency without lost evidence", () => {
  it("builds cold-checkout instruction dependencies before importing their contracts", () => {
    const lane = job("lint");
    const prepare = lane.indexOf("name: Prepare instruction contract dependencies");
    const contracts = lane.indexOf("name: Verify selected agent-instruction consumers");
    expect(prepare).toBeGreaterThan(-1);
    expect(prepare).toBeLessThan(contracts);
    const prerequisite = lane.slice(prepare, contracts);
    expect(prerequisite).toContain("needs.scope.outputs.selection != 'full'");
    expect(prerequisite).toContain("fromJSON(needs.scope.outputs.plan).checks.instructions");
    expect(prerequisite).toContain("uses: ./.github/actions/workspace-dist");
    expect(prerequisite).toContain('pack-archives: "false"');
  });

  it("produces workspace artifacts without waiting for native evidence", () => {
    const producer = job("build-artifacts");
    expect(declaredNeeds(producer)).toEqual(["scope"]);
    expect(producer).toContain("needs.scope.outputs.selection == 'full'");
    expect(producer).not.toContain("needs.native-platforms");
    expect(producer).toContain("uses: ./.github/actions/workspace-dist");
    expect(producer).toContain("pnpm --filter abyss-framework build");
    expect(producer).toContain("pnpm exec tsx scripts/check-core-boundary.ts");
    expect(producer).not.toContain("pnpm tsx scripts/workspace-packages.ts --archives");
    expect(
      readFileSync(path.join(repo, ".github/actions/workspace-dist/action.yml"), "utf8"),
    ).toContain("pnpm tsx scripts/workspace-packages.ts --archives");
    expect(producer).toContain("name: workspace-packages");
    expect(producer).toContain("if-no-files-found: error");
  });

  it("keeps the protected build context as a fail-closed join, not a second build", () => {
    const gate = job("build");
    expect(declaredNeeds(gate)).toEqual(["scope", "build-artifacts"]);
    expect(gate).toContain("!cancelled() && needs.scope.outputs.selection == 'full'");
    expect(gate).toContain("CI_SCOPE_RESULT: ${{ needs.scope.result }}");
    expect(gate).toContain("WORKSPACE_BUILD_RESULT: ${{ needs.build-artifacts.result }}");
    // Native evidence is produced but never part of the merge verdict: a 120-minute matrix must
    // not be able to hold every merge, and the release lane validates the native rows instead.
    expect(gate).not.toContain("native-platforms");
    expect(gate).not.toMatch(/^ {4}name:/mu);
    expect(gate).not.toContain("continue-on-error");
    expect(gate).not.toContain("pnpm install");
    expect(gate).not.toContain("uses:");
  });

  it("accepts only a successful scope and workspace build", () => {
    const result = runGate();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  for (const variable of ["CI_SCOPE_RESULT", "WORKSPACE_BUILD_RESULT"]) {
    it.each(["failure", "cancelled", "skipped", "neutral", "timed_out", ""])(
      `rejects ${variable}=%s instead of letting a skipped required check pass`,
      (result) => {
        const execution = runGate({ [variable]: result });
        expect(execution.error).toBeUndefined();
        expect(execution.status).not.toBe(0);
        expect(execution.status).not.toBeNull();
      },
    );
  }

  it.each(["golden-path-template", "template-nonvisual"])(
    "%s consumes this run's artifacts without a transitive native gate",
    (name) => {
      const consumer = job(name);
      expect(declaredNeeds(consumer)).toEqual(["scope", "build-artifacts"]);
      expect(consumer).toContain("actions/download-artifact");
      expect(consumer).toContain("name: workspace-packages");
      expect(ancestors(name).has("native-platforms")).toBe(false);
      expect(ancestors(name).has("build")).toBe(false);
    },
  );

  // These two used to sit at `needs: scope` and restore the workspace key, which meant they started
  // beside the only job that saves it, missed every time and compiled the workspace themselves —
  // 71-95s each. PRD-481 gives them the producer's upload instead, so the edge is real work.
  it.each(["benchmark", "budgets"])(
    "%s downloads this run's workspace rather than compiling its own",
    (name) => {
      expect(declaredNeeds(job(name))).toEqual(["scope", "build-artifacts"]);
      expect(job(name)).toContain("uses: ./.github/actions/workspace-dist");
      expect(job(name)).toContain("shared-artifact: workspace-packages");
      expect(ancestors(name).has("native-platforms")).toBe(false);
    },
  );

  it("performance-contracts starts after scope rather than waiting for artifacts it never downloads", () => {
    expect(declaredNeeds(job("performance-contracts"))).toEqual(["scope"]);
    expect(ancestors("performance-contracts").has("native-platforms")).toBe(false);
    expect(job("performance-contracts")).not.toContain("uses: ./.github/actions/workspace-dist");
  });

  it("reports the new producer as well as every pre-existing job", () => {
    const graph = ciJobGraph(source);
    expect([...declaredNeeds(job("run-summary"))].sort()).toEqual(
      graph
        .map(({ name }) => name)
        .filter((name) => name !== "run-summary")
        .sort(),
    );
  });

  it.each(["android-emulator-parity", "desktop-parity"])(
    "%s restores the verified JS build without caching a native test verdict",
    (name) => {
      const native = new Map(
        jobSections(
          readFileSync(path.join(repo, ".github/workflows/native-platforms.yml"), "utf8"),
        ),
      );
      const section = native.get(name);
      if (section === undefined) throw new Error(`Missing native job: ${name}`);
      expect(section).toContain("uses: ./.github/actions/workspace-dist");
      expect(section).not.toContain("pnpm tsx scripts/workspace-packages.ts build");
      expect(section.indexOf("uses: ./.github/actions/workspace-dist")).toBeLessThan(
        section.indexOf("name: Capture browser references"),
      );
      expect(section).toContain("conformance/run-conformance.mjs");
      expect(section).toContain("check-lane-blocks.mjs");
    },
  );
});

describe("PRD-380 an ordinary pull request owes only the Linux native rows", () => {
  /** This repository's own candidate, so a plan built without a diff still validates. */
  const candidate = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).stdout.trim();

  /** Classify without a merge-base diff: the plan still records the native tier each target owes. */
  function classify(args: string[], format: "json" | "github" = "json"): string {
    const result = spawnSync(
      process.execPath,
      [
        path.join(repo, "scripts/ci-change-scope.mjs"),
        ...args,
        "--candidate-sha",
        candidate,
        "--format",
        format,
      ],
      { cwd: repo, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  }

  const nativeJobs = new Map(
    jobSections(readFileSync(path.join(repo, ".github/workflows/native-platforms.yml"), "utf8")),
  );
  /** The executable half of a job: a comment explaining the tier is not a tier. */
  const executable = new Map(
    [...nativeJobs].map(([name, section]) => [
      name,
      section
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"))
        .join("\n"),
    ]),
  );

  it("keeps unresolved pull requests and qualification events on the full matrix", () => {
    const ordinary = JSON.parse(
      classify(["--event-name", "pull_request", "--target", "develop"]),
    ) as Record<string, unknown>;
    // The tier travels with the plan, so ci-required records it and a reuse can compare it.
    expect(ordinary).toMatchObject({ selection: "full", native: true, nativeTier: "full" });
    expect(
      (ordinary.jobs as Record<string, { required: boolean }>)["native-platforms"]?.required,
    ).toBe(true);
    // An unresolved live pull request rejects before fanout rather than emit a plan it cannot prove.
    const unresolved = spawnSync(
      process.execPath,
      [
        path.join(repo, "scripts/ci-change-scope.mjs"),
        ...["--event-name", "pull_request", "--target", "develop"],
        ...["--candidate-sha", candidate, "--format", "github"],
      ],
      { cwd: repo, encoding: "utf8" },
    );
    expect(unresolved.status, unresolved.stderr).toBe(2);
    expect(unresolved.stderr).toContain("CI_REQUIRED_PR_CANDIDATE_MISMATCH");
    expect(unresolved.stdout).not.toContain("plan=");
    // A queue entry whose base/head this classifier cannot resolve still owes every row: with no
    // proven candidate identity it has no diff to narrow by. (A resolved develop queue run narrows
    // exactly like a pull request — ci-qualification.spec.ts proves that case.)
    expect(
      JSON.parse(classify(["--event-name", "merge_group", "--target", "develop"])),
    ).toMatchObject({ nativeTier: "full" });
    // main pushes, the nightly, an explicit audit and a pull request into main keep every row.
    const full: readonly (readonly [string, string])[] = [
      ["push", ""],
      ["schedule", ""],
      ["workflow_dispatch", ""],
      ["merge_group", "main"],
      ["pull_request", "main"],
    ];
    for (const [event, target] of full) {
      expect(
        JSON.parse(classify(["--event-name", event, "--target", target])),
        `${event} -> ${target}`,
      ).toMatchObject({ nativeTier: "full" });
    }
    // A run that owes no native lane owes no rows at all — ci-needs.spec.ts proves that case
    // against a real narrowed diff.
  });

  it("reads the tier from the planner instead of deciding it per job", () => {
    const gated = [...executable]
      .filter(([name, section]) => name !== "scope" && /^ {4}if: .*native_tier/mu.test(section))
      .map(([name]) => name)
      .sort();
    // Only the macOS, Windows and iOS legs are not Linux rows.
    expect(gated).toEqual(["desktop", "ios-simulator"]);
    expect(executable.get("desktop")).toContain("needs.scope.outputs.native_tier == 'full'");
    expect(executable.get("ios-simulator")).toContain("needs.scope.outputs.native_tier == 'full'");
    // A job's `if` cannot read `matrix`, so the arm64 row drops through the matrix itself, shaped
    // from the same tier: linux-x64 survives a reduced run and both rows survive anything else. The
    // x64 row keeps the routing expression every movable Linux job uses (PRD-480).
    const scope = executable.get("scope") ?? "";
    expect(scope).toContain("native_tier: ${{ steps.classify.outputs.native_tier }}");
    expect(scope).toContain("starter_rows: ${{ steps.rows.outputs.starter_rows }}");
    expect(scope).toContain(
      '{ platform: "linux-x64", runner: "${{ (github.event.pull_request.head.repo.fork || !vars.TN_RUNNER) && \'ubuntu-24.04\' || vars.TN_RUNNER }}"',
    );
    expect(scope).toContain('{ platform: "linux-arm64", runner: "ubuntu-24.04-arm" }');
    expect(scope).toContain("rows.slice(0, 1)");
    expect(executable.get("starter-linux")).toContain(
      "matrix: ${{ fromJSON(needs.scope.outputs.starter_rows) }}",
    );
    expect(job("native-platforms")).toContain("selection_plan: ${{ needs.scope.outputs.plan }}");
    // Every other job is Linux-hosted, so it runs on the reduced tier without asking.
    for (const name of [
      "web-reference",
      "android-v8-source",
      "android-emulator-parity",
      "desktop-parity",
      "starter-linux",
    ]) {
      expect(executable.get(name), name).not.toContain("native_tier");
    }
    // No lane exempts the full matrix by label: the tier is the planner's answer, and a label is
    // not one of its inputs. `release-proof` is the one label exemption PRD-380 phase 1 removed.
    const lanes = [...nativeJobs.values()]
      .map((section) =>
        section
          .split("\n")
          .filter((line) => !line.trim().startsWith("#"))
          .join("\n"),
      )
      .join("\n");
    expect(lanes).not.toContain("pull_request.labels");
    expect(lanes).not.toContain("native-release-proof");
  });

  // Run 37100382876 (2026-10-03, `8d7c5741f`) shaped `starter_rows` as a bare array of row objects
  // and `starter-linux` never started — no job, no error, and the reusable workflow's aggregate
  // still concluded failure, which `ci-required` then reported as a red native lane with every leg
  // green. The same two rows on develop's static `include:` produced both jobs, so the emitter has
  // to write the shape GitHub expands: a keyed object, `{"include":[…]}`. Evaluating the step for
  // each tier is what pins that, rather than asserting the source says so.
  it("shapes starter rows GitHub can expand, for every tier the lane is called with", () => {
    const scope = nativeJobs.get("scope") ?? "";
    const script = scope.match(/node -e '([\s\S]*?)' >> "\$GITHUB_OUTPUT"/u)?.[1];
    if (script === undefined) throw new Error("scope has no starter_rows step to evaluate");
    const concrete = script.replace(/\$\{\{[\s\S]*?\}\}/gu, "tn-local");

    const rows = (tier: string): Record<string, unknown>[] => {
      const run = spawnSync(process.execPath, ["-e", concrete], {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, TN_NATIVE_TIER: tier },
        timeout: 5_000,
      });
      expect(run.status, run.stderr).toBe(0);
      const line = run.stdout.trim();
      expect(line.startsWith("starter_rows="), line).toBe(true);
      const matrix = JSON.parse(line.slice("starter_rows=".length)) as Record<string, unknown>;
      // Never an empty matrix: GitHub expands `include` alone, and `[]` builds no job at all. A run
      // that owes no native lane never reaches this job — ci.yml gates the whole call on
      // `jobs['native-platforms'].required` — so every tier this job can see owes x64 at minimum.
      const include = matrix.include as Record<string, unknown>[] | undefined;
      expect(Array.isArray(include), JSON.stringify(matrix)).toBe(true);
      expect(include?.length ?? 0).toBeGreaterThan(0);
      for (const row of include ?? [])
        expect(Object.keys(row).sort()).toEqual(["platform", "runner"]);
      return include ?? [];
    };

    // The routing expression is the x64 runner's value; the substitution above is only so the step
    // parses as JavaScript outside Actions.
    expect(scope).toContain(
      '{ platform: "linux-x64", runner: "${{ (github.event.pull_request.head.repo.fork || !vars.TN_RUNNER) && \'ubuntu-24.04\' || vars.TN_RUNNER }}"',
    );
    // Reduced: x64 alone, on the runner the expression resolves. Full: both rows, arm64 hosted.
    expect(rows("reduced")).toEqual([{ platform: "linux-x64", runner: "tn-local" }]);
    expect(rows("full")).toEqual([
      { platform: "linux-x64", runner: "tn-local" },
      { platform: "linux-arm64", runner: "ubuntu-24.04-arm" },
    ]);
    // An unreadable tier keeps every row rather than dropping the matrix.
    expect(rows("")).toEqual(rows("full"));
    // The job reads the shaped object, and the x64 leg lands where the expression points.
    expect(executable.get("starter-linux")).toContain(
      "matrix: ${{ fromJSON(needs.scope.outputs.starter_rows) }}",
    );
    expect(executable.get("starter-linux")).toContain("runs-on: ${{ matrix.runner }}");
    // A leg the tier drops is skipped by `if:`, and a skipped leg is neither a failure nor a
    // cascade: the two jobs that need `desktop` read `cancelled()`/`always()`, which is why the
    // run above kept them green while `desktop` was skipped.
    expect(executable.get("desktop")).toContain("needs.scope.outputs.native_tier == 'full'");
    for (const [name, status] of [
      ["performance-coverage", "cancelled()"],
      ["networking-matrix", "always()"],
    ] as const) {
      const section = executable.get(name) ?? "";
      expect(section, name).toContain(
        "needs: [scope, android-emulator-parity, desktop-parity, desktop, ios-simulator]",
      );
      expect(section, name).toContain(status);
    }
  });
});

describe("PRD-373 fail-closed required verdict", () => {
  function fullPlan(): Record<string, unknown> {
    const result = spawnSync(
      process.execPath,
      ["scripts/ci-change-scope.mjs", "--event", "push", "--format", "json"],
      { cwd: repo, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as Record<string, unknown>;
  }

  /**
   * A genuine narrowed plan, classified from a scratch prose-only history but carrying this
   * repository's candidate SHA, so the verdict reaches the selection gate instead of stopping at
   * the candidate assertion. The empty diff is deliberately classified `full`, so it cannot serve.
   */
  function prosePlan(): Record<string, unknown> {
    const root = makeTempDirSync("threenative-ci-required-prose-");
    const git = (...args: string[]) =>
      spawnSync("git", args, {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "CI scope fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.invalid",
          GIT_COMMITTER_NAME: "CI scope fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        },
      });
    git("init", "--quiet", "--initial-branch", "develop");
    writeFileSync(path.join(root, "README.md"), "base\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "base");
    const base = git("rev-parse", "HEAD").stdout.trim();
    writeFileSync(path.join(root, "NOTES.md"), "prose\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "prose");
    const head = git("rev-parse", "HEAD").stdout.trim();
    const candidate = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" });
    const result = spawnSync(
      process.execPath,
      [
        path.join(repo, "scripts/ci-change-scope.mjs"),
        ...["--root", root, "--base", base, "--head", head],
        ...["--target", "develop", "--event", "pull_request"],
        ...["--candidate-sha", candidate.stdout.trim(), "--format", "json"],
      ],
      { cwd: repo, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const plan = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(plan.selection).toBe("prose");
    return plan;
  }

  function verify(
    plan: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
    environment: Record<string, string> = {},
  ) {
    const jobs = plan.jobs as Record<string, { required: boolean }> | undefined;
    const needs: Record<string, unknown> = {
      scope: { result: "success", outputs: { plan: JSON.stringify(plan) } },
      ...Object.fromEntries(
        Object.entries(jobs ?? {}).map(([name, value]) => [
          name,
          { result: value.required ? "success" : "skipped" },
        ]),
      ),
      ...overrides,
    };
    const directory = makeTempDirSync("ci-verdict-evidence-");
    try {
      const evidence = jobs?.integration?.required
        ? integrationEvidence(repo, directory, plan).env
        : {};
      return spawnSync(process.execPath, ["scripts/ci-required.mjs"], {
        cwd: repo,
        encoding: "utf8",
        // Synthetic plans carry their own event identities; never inherit this
        // enclosing Actions run's TN_CI_* context. Explicit adversarial inputs below win.
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.startsWith("TN_CI_")),
          ),
          ...evidence,
          TN_CI_NEEDS: JSON.stringify(needs),
          ...environment,
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it("accepts only a validated classifier and all selected successful jobs", () => {
    const result = verify(fullPlan());
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("isolates synthetic verdict fixtures from the enclosing hosted PR context", () => {
    vi.stubEnv("TN_CI_EVENT", "pull_request");
    vi.stubEnv("TN_CI_BASE_SHA", "a".repeat(40));
    vi.stubEnv("TN_CI_HEAD_SHA", "b".repeat(40));
    try {
      const result = verify(fullPlan());
      expect(result.status, result.stdout + result.stderr).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(["failure", "cancelled", "skipped", "neutral", "timed_out", ""])(
    'rejects a selected job reporting "%s"',
    (result) => {
      const execution = verify(fullPlan(), { "test-native": { result } });
      expect(execution.status).toBe(1);
      expect(execution.stderr).toContain("CI_REQUIRED_JOB_NOT_SUCCESS: test-native");
    },
  );

  it("rejects a missing job, a failed classifier and an empty or forged plan", () => {
    expect(verify(fullPlan(), { "test-native": undefined }).stderr).toContain(
      "CI_REQUIRED_JOB_NOT_SUCCESS: test-native",
    );
    expect(verify(fullPlan(), { scope: { result: "failure" } }).stderr).toContain(
      "CI_REQUIRED_SCOPE_NOT_SUCCESS",
    );
    expect(verify({}).stderr).toContain("CI_SCOPE_INVALID_PLAN");
    const plan = fullPlan();
    plan.jobs = {};
    expect(verify(plan).stderr).toContain("CI_SCOPE_INVALID_PLAN");
  });

  it("rejects a PR verdict not checked out at the proposed head/base merge", () => {
    const result = verify(
      fullPlan(),
      {},
      {
        TN_CI_EVENT: "pull_request",
        TN_CI_BASE_SHA: "a".repeat(40),
        TN_CI_HEAD_SHA: "b".repeat(40),
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CI_REQUIRED_PR_CANDIDATE_MISMATCH");
  });

  it("requires complete verification on main whatever the head branch is named", () => {
    const environment = {
      TN_CI_EVENT: "pull_request",
      TN_CI_CUTOVER: "true",
      TN_CI_BASE_REF: "main",
      TN_CI_HEAD_SHA: "a".repeat(40),
    };
    // The head ref is no longer part of the verdict: the exact base/head parent assertion freezes
    // the candidate, so any narrowed plan reaching main fails on its selection alone.
    for (const headRef of ["develop", "feature/direct-main", `promotion/${"b".repeat(40)}`]) {
      const narrowed = verify(prosePlan(), {}, { ...environment, TN_CI_HEAD_REF: headRef });
      expect(narrowed.status, narrowed.stdout + narrowed.stderr).toBe(1);
      expect(narrowed.stderr).toContain("CI_REQUIRED_QUALIFICATION_MINIMUM");
    }
  });

  it("maps every coverage job to the required verdict and rejects unregistered additions", () => {
    const plan = fullPlan();
    const jobs = plan.jobs as Record<string, { required: boolean }>;
    const coverage = ciJobGraph(source)
      .map(({ name }) => name)
      .filter((name) => !["scope", "ci-required", "run-summary"].includes(name))
      .sort();
    expect(Object.keys(jobs).sort()).toEqual(coverage);
    // The native matrix is a `needs` of ci-required because the plan can require it: a full
    // selection that touches native code, targets main, or cannot prove a clean native-free diff.
    // When the plan exempts it the job is skipped and ci-required.mjs treats an exempt skip as a
    // pass, so the merge waits only for the cases the classifier could not clear.
    expect(declaredNeeds(job("ci-required"))).toContain("native-platforms");
    const requiredCoverage = coverage.filter((name) => jobs[name]?.required);
    expect(
      declaredNeeds(job("ci-required"))
        .filter((name) => name !== "scope")
        .sort(),
    ).toEqual(requiredCoverage);
  });

  it("always evaluates and does not depend on advisory summary work", () => {
    const gate = job("ci-required");
    // `always()` still leads; #340 appends the draft clause that skips the board for a draft PR,
    // so only the clause may follow it. `ci-structure.spec.ts` asserts that clause's behaviour.
    expect(gate).toMatch(/if: \$\{\{ always\(\)/u);
    expect(gate).toContain("toJSON(needs)");
    expect(gate).toContain("node scripts/ci-required.mjs");
    expect(gate).not.toContain("continue-on-error");
    expect(declaredNeeds(gate)).not.toContain("run-summary");
    expect(gate).not.toContain("pnpm install");
  });

  it.each(["typecheck", "test-unit", "benchmark", "budgets"])(
    "%s reuses bundles without repacking archives it does not consume",
    (name) => {
      expect(job(name)).toContain('pack-archives: "false"');
      expect(job("build-artifacts")).not.toContain('pack-archives: "false"');
    },
  );

  it("keeps the package-test build phase independent from cached workspace products", () => {
    expect(job("test")).toContain('TN_SUITE_PHASES: "docs,build,package-test"');
    expect(job("test")).not.toContain("uses: ./.github/actions/workspace-dist");
  });

  it("caches compiled bundles but always repacks and verifies shipped templates", () => {
    const action = readFileSync(
      path.join(repo, ".github/actions/workspace-dist/action.yml"),
      "utf8",
    );
    const cache = action.slice(
      action.indexOf("uses: actions/cache"),
      action.indexOf("- name:", action.indexOf("uses: actions/cache") + 1),
    );
    expect(cache).not.toContain("artifacts/workspace-packages");
    expect(cache).toContain("tsconfig.base.json");
    expect(cache).toContain("pnpm-workspace.yaml");
    const pack = action.slice(
      action.indexOf("- name: Pack current workspace files"),
      action.indexOf("- name: Check every bundling package"),
    );
    expect(pack).toContain("pnpm --filter");
    expect(pack).not.toContain("cache-hit");
    expect(action).toContain("bundle-engine-mcp.mjs");
  });
});

describe("PRD-373 fixed full candidates and current package products", () => {
  it("pins every worker checkout to the captured candidate, including reusable native jobs", () => {
    expect(job("scope")).toContain("vars.TN_DEVELOP_CI_ENABLED == 'true' && 'develop'");
    expect(source).toContain(
      "github.event_name == 'pull_request' && !github.event.pull_request.draft && 'latest' || github.run_id",
    );
    for (const relative of [".github/workflows/ci.yml", ".github/workflows/native-platforms.yml"]) {
      const workflow = readFileSync(path.join(repo, relative), "utf8");
      for (const [name, section] of jobSections(workflow)) {
        if (name === "scope") continue;
        for (const checkout of section.split("uses: actions/checkout@").slice(1)) {
          const step = checkout.split(/^ {6}- /mu)[0] ?? "";
          expect(step, `${relative}: ${name}`).toContain(
            "ref: ${{ needs.scope.outputs.candidate_sha",
          );
        }
      }
    }
    const native = readFileSync(path.join(repo, ".github/workflows/native-platforms.yml"), "utf8");
    const scope = new Map(jobSections(native)).get("scope") ?? "";
    expect(scope).toContain('--validate-plan "$TN_CI_PLAN"');
    expect(scope).not.toContain("--base");
    expect(scope).toContain('--full --candidate-sha "$candidate"');
    expect(scope).toContain('grep -Fx "candidate_sha=$candidate"');
  });

  it("accepts a real develop-to-main merge and rejects a changed base", () => {
    const root = makeTempDirSync("ci-promotion-");
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    try {
      git("init", "-q", "--initial-branch=main");
      git("config", "user.email", "ci@example.invalid");
      git("config", "user.name", "CI fixture");
      mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
      writeFileSync(
        path.join(root, ".github/workflows/integration.yml"),
        readFileSync(path.join(repo, ".github/workflows/integration.yml")),
      );
      writeFileSync(
        path.join(root, ".github/workflows/native-platforms.yml"),
        readFileSync(path.join(repo, ".github/workflows/native-platforms.yml")),
      );
      copyTemplateOwnership(root, repo);
      writeFileSync(path.join(root, "seed"), "seed");
      git("add", ".");
      git("commit", "-qm", "seed");
      git("checkout", "-qb", "develop");
      writeFileSync(path.join(root, "feature"), "feature");
      git("add", ".");
      git("commit", "-qm", "feature");
      const head = git("rev-parse", "HEAD");
      git("checkout", "-q", "main");
      writeFileSync(path.join(root, "base"), "base");
      git("add", ".");
      git("commit", "-qm", "base");
      const base = git("rev-parse", "HEAD");
      git("merge", "--no-ff", "-qm", "candidate", "develop");
      const scope = spawnSync(
        process.execPath,
        [path.join(repo, "scripts/ci-change-scope.mjs"), "--full", "--format", "json"],
        { cwd: root, encoding: "utf8" },
      );
      expect(scope.status, scope.stderr).toBe(0);
      const plan = JSON.parse(scope.stdout) as { jobs: Record<string, { required: boolean }> };
      const needs = {
        scope: { result: "success", outputs: { plan: scope.stdout } },
        ...Object.fromEntries(
          Object.entries(plan.jobs).map(([name, entry]) => [
            name,
            { result: entry.required ? "success" : "skipped" },
          ]),
        ),
      };
      const evidence = integrationEvidence(
        root,
        path.join(root, "fixture-bin"),
        plan,
        true,
        head,
      ).env;
      const check = (baseSha: string) =>
        spawnSync(process.execPath, [path.join(repo, "scripts/ci-required.mjs")], {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            ...evidence,
            TN_CI_NEEDS: JSON.stringify(needs),
            TN_CI_EVENT: "pull_request",
            TN_CI_CUTOVER: "true",
            TN_CI_BASE_REF: "main",
            TN_CI_HEAD_REF: "develop",
            TN_CI_HEAD_SHA: head,
            TN_CI_BASE_SHA: baseSha,
          },
        });
      const valid = check(base);
      expect(valid.status, valid.stderr).toBe(0);
      const stale = check("d".repeat(40));
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain("CI_REQUIRED_PR_CANDIDATE_MISMATCH");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // A stale recorded base must reject before a plan is emitted, exactly as the verdict's parent check does.
  it("rejects a pull-request candidate whose recorded base is stale before emitting a plan", () => {
    const root = makeTempDirSync("ci-stale-base-");
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    try {
      git("init", "-q", "--initial-branch=main");
      git("config", "user.email", "ci@example.invalid");
      git("config", "user.name", "CI fixture");
      writeFileSync(path.join(root, "seed"), "seed");
      git("add", ".");
      git("commit", "-qm", "seed");
      git("checkout", "-qb", "develop");
      writeFileSync(path.join(root, "feature"), "feature");
      git("add", ".");
      git("commit", "-qm", "feature");
      const head = git("rev-parse", "HEAD");
      git("checkout", "-q", "main");
      writeFileSync(path.join(root, "base"), "base");
      git("add", ".");
      git("commit", "-qm", "base");
      const recordedBase = git("rev-parse", "HEAD");
      writeFileSync(path.join(root, "newer"), "newer");
      git("add", ".");
      git("commit", "-qm", "moved base");
      const currentBase = git("rev-parse", "HEAD");
      git("merge", "--no-ff", "-qm", "candidate", "develop");
      const live = ["--event-name", "pull_request", "--target", "develop", "--format", "github"];
      const run = (...args: string[]) =>
        spawnSync(process.execPath, [path.join(repo, "scripts/ci-change-scope.mjs"), ...args], {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env },
        });
      // The same merge fixture proves the guard accepts the candidate's own base and head.
      const valid = run("--base", currentBase, "--head", head, ...live);
      expect(valid.status, valid.stderr).toBe(0);
      expect(valid.stdout).toContain("plan=");
      // Every stale or incomplete base/head reaches the live guard, so each rejects before a plan.
      const rejectedCases: readonly (readonly string[])[] = [
        ["--base", recordedBase, "--head", head],
        ["--base", recordedBase, "--head", head, "--target", "main"],
        ["--base", recordedBase, "--head", head, "--full"],
        ["--head", head],
        ["--base", currentBase],
      ];
      for (const args of rejectedCases) {
        // live first so a per-case --target (main) overrides the shared develop default.
        const rejected = run(...live, ...args);
        expect(rejected.status, rejected.stderr).toBe(2);
        expect(rejected.stderr).toContain("CI_REQUIRED_PR_CANDIDATE_MISMATCH");
        expect(rejected.stdout).not.toContain("plan=");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not label-exempt desktop parity after selecting the full family", () => {
    const native = readFileSync(path.join(repo, ".github/workflows/native-platforms.yml"), "utf8");
    const parity = new Map(jobSections(native)).get("desktop-parity") ?? "";
    expect(
      parity
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"))
        .join("\n"),
    ).not.toContain("labels.*.name");
  });

  it("invalidates complete native products when the compiler image or dependency build inputs change", () => {
    const native = job("test-native");
    const cache =
      native.split("- name: Restore the compiled native tree")[1]?.split("\n      - ")[0] ?? "";
    expect(cache).toContain("steps.native-toolchain.outputs.identity");
    expect(cache).toContain("packages/runtime-native/scripts/**");
    expect(native).toContain("$ImageVersion");
    expect(native).toContain("c++ --version");
    // CMakeCache.txt records its absolute source path, so a tree from another checkout path fails.
    expect(native.split("\n").find((line) => line.includes('identity="$(')) ?? "").toContain(
      "$GITHUB_WORKSPACE",
    );
    expect(cache).not.toContain("restore-keys:");
  });

  it("publishes both base-branch caches from a develop push, ungated by the selection", () => {
    // A pull request's cache is scoped to its own merge ref and no other pull request reads it, so
    // the only thing that can warm the base branch is a run on the base branch — and only if these
    // two jobs actually save when they run there.
    const producer = job("build-artifacts");
    expect(producer).toContain("uses: ./.github/actions/workspace-dist");
    expect(producer).not.toContain('save-bundles: "false"');
    // The shared action publishes on a cache miss, which is the same condition on develop as on any
    // other branch. A gate naming the selection or the branch is what would stop the warm lane.
    const action = readFileSync(
      path.join(repo, ".github/actions/workspace-dist/action.yml"),
      "utf8",
    );
    const save = action.slice(action.indexOf("- name: Save validated workspace bundles"));
    expect(save).toContain("steps.dist.outputs.cache-hit != 'true'");
    expect(save).not.toMatch(/selection|main|develop/u);
  });

  it("leaves the native cache saves to the cache action's own post step", () => {
    const native = job("test-native");
    for (const key of ["native-third-party-", "native-ccache-ci-test-native-", "native-build-"]) {
      expect(native, `the warm lane no longer publishes ${key}`).toContain(`key: ${key}`);
    }
    // `actions/cache` saves in its post step on any successful run, so no step here may be gated on
    // a full selection — that is the gate that would silently stop the develop push from warming.
    expect(native).not.toMatch(/^ {6}if:.*selection == 'full'/mu);
  });

  it("repacks changed template bytes even when compiled bundles remain unchanged", () => {
    const root = makeTempDirSync("ci-repack-");
    try {
      const actualPnpm = spawnSync("bash", ["-c", "command -v pnpm"], {
        encoding: "utf8",
      }).stdout.trim();
      expect(actualPnpm).not.toBe("");
      mkdirSync(path.join(root, "bin"));
      mkdirSync(path.join(root, "packages/starter/dist"), { recursive: true });
      mkdirSync(path.join(root, "packages/starter/templates"), { recursive: true });
      writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
      writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ private: true, packageManager: "pnpm@10.25.0" }),
      );
      writeFileSync(
        path.join(root, "packages/starter/package.json"),
        JSON.stringify({
          name: "@fixture/starter",
          version: "1.0.0",
          files: ["dist", "templates"],
        }),
      );
      writeFileSync(path.join(root, "packages/starter/dist/index.js"), "// unchanged bundle\n");
      writeFileSync(
        path.join(root, "bin/pnpm"),
        '#!/bin/sh\nif [ "$1" = tsx ]; then printf "@fixture/starter\\tfixture-starter-\\n"; else exec "$TN_REAL_PNPM" "$@"; fi\n',
      );
      chmodSync(path.join(root, "bin/pnpm"), 0o755);
      const action = readFileSync(
        path.join(repo, ".github/actions/workspace-dist/action.yml"),
        "utf8",
      );
      const step = action.slice(
        action.indexOf("- name: Pack current workspace files"),
        action.indexOf("- name: Check every bundling package"),
      );
      const shell = step.split("      run: |\n")[1]?.replace(/^ {8}/gmu, "");
      expect(shell).toBeDefined();
      for (const bytes of ["old template", "current template"]) {
        writeFileSync(path.join(root, "packages/starter/templates/main.ts"), bytes);
        const result = spawnSync("bash", ["-c", shell ?? "exit 1"], {
          cwd: root,
          encoding: "utf8",
          timeout: 20_000,
          env: {
            ...process.env,
            PATH: `${root}/bin:${process.env.PATH}`,
            TN_REAL_PNPM: actualPnpm,
          },
        });
        expect(result.status, result.stdout + result.stderr).toBe(0);
        const unpacked = spawnSync(
          "tar",
          [
            "-xOf",
            "artifacts/workspace-packages/fixture-starter-1.0.0.tgz",
            "package/templates/main.ts",
          ],
          { cwd: root, encoding: "utf8" },
        );
        expect(unpacked.status, unpacked.stderr).toBe(0);
        expect(unpacked.stdout).toBe(bytes);
      }
      expect(readFileSync(path.join(root, "packages/starter/dist/index.js"), "utf8")).toBe(
        "// unchanged bundle\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
