import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TEMPLATE_NAMES,
  carryDeps,
  selectionPlan,
  validateEventPlan,
  validatePlan,
  withCarriedLegs,
} from "../ci-change-scope.mjs";
import { integrationJobNamesByLane, integrationSelection } from "../ci-integration-scope.mjs";
import {
  CARRIABLE_JOBS,
  RELEASE_GATE_JOBS,
  applyCarried,
  carriedFailures,
  findCarried,
  jobText,
  legsOf,
  reaches,
  versionOnly,
} from "../ci-leg-carry.mjs";

const SOURCE = "a".repeat(40);
const CANDIDATE = "b".repeat(40);
const { pathFamily } = await import(new URL("../ci-change-scope.mjs", import.meta.url).href);
const isProse = (file: string) => file.endsWith(".md");
const fullPlan = (sha = CANDIDATE) =>
  selectionPlan("full", "a test board", [], sha, true, 0, "main", true);
const kit = (name: string, value: string) => ({
  job: "template-nonvisual",
  leg: `template-nonvisual (${value})`,
  inputs: "template",
  value,
  name,
});

describe("which changed path reaches a leg", () => {
  it.each([
    ["packages/create-threenative/agent-docs/references/finding-assets.md", false],
    ["packages/create-threenative/agent-files/.agents/skills/ponytail/SKILL.md", false],
    ["packages/create-threenative/README.md", true],
    ["docs/PRDs/CI/PRD-1-x.md", true],
  ])("treats %s as prose: %s, because the scaffold throws without the first two", (file, prose) => {
    expect(pathFamily(file, true) === "prose").toBe(prose);
  });

  const unit = { job: "test", leg: "test", inputs: "unit" };
  const workspace = { job: "typecheck", leg: "typecheck", inputs: "workspace" };
  const native = { job: "native-platforms", leg: "native-platforms", inputs: "native" };
  const shooter = kit("template-nonvisual", "shooter");

  it("sends every path no rule names to every leg", () => {
    for (const leg of [unit, workspace, native, shooter])
      expect(reaches(leg, "tools/brand-new-input.mjs", isProse)).toBe(true);
  });

  it("keeps prose out of every leg", () => {
    for (const leg of [unit, workspace, native, shooter])
      expect(reaches(leg, "README.md", isProse)).toBe(false);
  });

  it("keeps a spec file in the unit legs and out of the kit legs", () => {
    const spec = "scripts/__tests__/ci-needs.spec.ts";
    expect(reaches(unit, spec, isProse)).toBe(true);
    expect(reaches(shooter, spec, isProse)).toBe(false);
    expect(reaches(native, spec, isProse)).toBe(false);
  });

  it("keeps package spec files in the native legs, which run some of them", () => {
    const spec = "packages/playtest/__tests__/ios-driver.spec.ts";
    expect(reaches(native, spec, isProse)).toBe(true);
    expect(reaches(shooter, spec, isProse)).toBe(false);
  });

  it("keeps a docs manifest in the native legs, which read it, and out of the kit legs", () => {
    const manifest = "docs/PRDs/networking/qualification-lanes.json";
    expect(reaches(native, manifest, isProse)).toBe(true);
    expect(reaches(shooter, manifest, isProse)).toBe(false);
  });

  it("keeps a test fixture in the kit legs", () => {
    const fixture = "packages/physics/__tests__/fixtures/physics-parity.scenario.json";
    expect(reaches(shooter, fixture, isProse)).toBe(true);
  });

  it("sends a kit's files to that kit and every native leg", () => {
    const file = (name: string) => `packages/create-threenative/templates/${name}/src/main.ts`;
    expect(reaches(shooter, file("shooter"), isProse)).toBe(true);
    expect(reaches(shooter, file("racing"), isProse)).toBe(false);
    // `examples/native-smoke/src/adapter-policy.mjs` reads templates/minimal, and a native-engine test
    // reads templates/sailing/assets/ship.glb.
    expect(reaches(native, file("minimal"), isProse)).toBe(true);
    expect(reaches(native, file("sailing"), isProse)).toBe(true);
    expect(reaches(workspace, file("racing"), isProse)).toBe(true);
  });

  it("sends the starter kit to every kit leg, because a scaffold copies its render sources", () => {
    const file = "packages/create-threenative/templates/starter/src/render/temporalDetailStage.ts";
    expect(reaches(kit("template-nonvisual", "collectathon"), file, isProse)).toBe(true);
    expect(reaches(kit("template-nonvisual", "shooter"), file, isProse)).toBe(true);
  });

  it("sends each kit manifest to every kit leg, because the scaffolder reads them all", () => {
    const file = "packages/create-threenative/templates/racing/kit.json";
    expect(reaches(shooter, file, isProse)).toBe(true);
  });

  it("reads a composite action as an input of every leg", () => {
    for (const leg of [unit, workspace, native, shooter])
      expect(reaches(leg, ".github/actions/pnpm/action.yml", isProse)).toBe(true);
  });

  it("leaves workflow text to the unit legs, except the native matrix's own file", () => {
    expect(reaches(unit, ".github/workflows/ci.yml", isProse)).toBe(true);
    expect(reaches(workspace, ".github/workflows/ci.yml", isProse)).toBe(false);
    expect(reaches(native, ".github/workflows/native-platforms.yml", isProse)).toBe(true);
    expect(reaches(shooter, ".github/workflows/native-platforms.yml", isProse)).toBe(false);
  });
});

describe("a release bump", () => {
  const manifest = (version: string, three: string, playtest: string) =>
    JSON.stringify({
      name: "@threenative/core",
      version,
      dependencies: { three, "@threenative/assets": playtest },
      peerDependencies: { "@threenative/playtest": `>=${playtest} <0.4.0` },
    });

  it("is version-only when only the cohort moves", () => {
    expect(
      versionOnly(
        "packages/core/package.json",
        manifest("0.3.7", "0.186.0", "0.3.7"),
        manifest("0.3.8", "0.186.0", "0.3.8"),
      ),
    ).toBe(true);
  });

  it("stays a change when a third-party version moves with it", () => {
    expect(
      versionOnly(
        "packages/core/package.json",
        manifest("0.3.7", "0.186.0", "0.3.7"),
        manifest("0.3.8", "0.187.0", "0.3.8"),
      ),
    ).toBe(false);
  });

  it("stays a change when a cohort dependency is removed or added", () => {
    const withCore = JSON.stringify({ dependencies: { "@threenative/core": "0.3.7" } });
    const without = JSON.stringify({ dependencies: {} });
    expect(
      versionOnly("packages/create-threenative/templates/x/package.json", withCore, without),
    ).toBe(false);
    expect(
      versionOnly("packages/create-threenative/templates/x/package.json", without, withCore),
    ).toBe(false);
  });

  it("stays a change when a cohort dependency leaves the workspace protocol", () => {
    const before = JSON.stringify({ dependencies: { "@threenative/core": "workspace:*" } });
    const after = JSON.stringify({ dependencies: { "@threenative/core": "0.3.8" } });
    expect(versionOnly("packages/ui/package.json", before, after)).toBe(false);
  });

  it("stays a change when a manifest script moves with it", () => {
    const before = JSON.stringify({ version: "0.3.7", scripts: { build: "tsup" } });
    const after = JSON.stringify({ version: "0.3.8", scripts: { build: "tsc" } });
    expect(versionOnly("packages/core/package.json", before, after)).toBe(false);
  });

  it("masks a version only in the files a bump rewrites", () => {
    const before = 'export const VERSION = "0.3.7";\n';
    const after = 'export const VERSION = "0.3.8";\n';
    expect(versionOnly("packages/core/src/version.ts", before, after)).toBe(true);
    expect(versionOnly("packages/core/src/other.ts", before, after)).toBe(false);
    expect(versionOnly("packages/core/src/version.ts", before, 'export const V = "0.3.8";\n')).toBe(
      false,
    );
  });

  it("covers the files the real 0.3.8 bump rewrote", () => {
    for (const file of [
      "packages/engine-mcp/__tests__/server.spec.ts",
      "examples/abyss-framework/playtests/replay.playtest.json",
    ])
      expect(versionOnly(file, 'x: "0.3.7"', 'x: "0.3.8"')).toBe(true);
  });

  it("reads an unparsable manifest as a change", () => {
    expect(versionOnly("packages/core/package.json", "{", "{")).toBe(false);
  });
});

describe("a plan with carried legs", () => {
  const carried = (leg: string, job: string) => ({ job, leg, runId: 7, sourceSha: SOURCE });

  it("drops a matrix value and keeps the job while another value runs", () => {
    const plan = applyCarried(fullPlan(), [
      carried("template-nonvisual (shooter)", "template-nonvisual"),
    ]);
    expect(plan.templateMatrix.template).not.toContain("shooter");
    expect(plan.templateMatrix.template.length).toBe(TEMPLATE_NAMES.length - 1);
    expect(plan.jobs["template-nonvisual"].required).toBe(true);
    expect(plan.carriedJobs).toEqual([]);
  });

  it("exempts the job when its last matrix value is carried", () => {
    const plan = applyCarried(
      fullPlan(),
      TEMPLATE_NAMES.map((name: string) =>
        carried(`template-nonvisual (${name})`, "template-nonvisual"),
      ),
    );
    expect(plan.templateMatrix.template).toEqual([]);
    expect(plan.jobs["template-nonvisual"].required).toBe(false);
    expect(plan.carriedJobs).toEqual(["template-nonvisual"]);
  });

  it("is unchanged by an empty carry", () => {
    expect(applyCarried(fullPlan(), [])).toEqual(fullPlan());
  });

  it.each([
    ["a leg the plan does not owe", carried("lint", "lint")],
    ["a value outside the matrix", carried("template-nonvisual (nope)", "template-nonvisual")],
    ["a run id that is not one", { ...carried("test", "test"), runId: 0 }],
    ["a source that is not a commit", { ...carried("test", "test"), sourceSha: "main" }],
  ])("rejects %s", (_name, entry) => {
    expect(() => applyCarried(fullPlan(), [entry])).toThrow("CI_SCOPE_INVALID_PLAN");
  });

  it("rejects a carry on a plan that is not a full board", () => {
    const review = selectionPlan("review", "thin", ["a.ts"], CANDIDATE, false, 0, "develop", false);
    expect(() => applyCarried(review, [carried("test", "test")])).toThrow("need a full plan");
  });

  it("survives validatePlan, which recomputes it", () => {
    const plan = applyCarried(fullPlan(), [carried("test", "test")]);
    expect(validatePlan(JSON.parse(JSON.stringify(plan))).jobs.test.required).toBe(false);
  });

  it("rejects a plan that exempts a job with no carried entry behind it", () => {
    const forged = structuredClone(fullPlan());
    forged.jobs.test = { required: false, reason: "Carried: trust me" };
    expect(() => validatePlan(forged)).toThrow("CI_SCOPE_INVALID_PLAN");
    const emptied = structuredClone(fullPlan());
    emptied.templateMatrix.template = ["starter"];
    expect(() => validatePlan(emptied)).toThrow("CI_SCOPE_INVALID_PLAN");
  });

  it("still meets the qualification minimum on a main push", () => {
    const plan = applyCarried(fullPlan(), [
      carried("template-nonvisual (shooter)", "template-nonvisual"),
      carried("benchmark", "benchmark"),
    ]);
    expect(() => validateEventPlan(plan, { eventName: "push", baseRef: "main" })).not.toThrow();
  });

  it("is refused on a scheduled audit and on a forced full run", () => {
    const plan = applyCarried(fullPlan(), [carried("benchmark", "benchmark")]);
    expect(() => validateEventPlan(plan, { eventName: "schedule", baseRef: "main" })).toThrow(
      "CI_REQUIRED_QUALIFICATION_MINIMUM",
    );
    expect(() =>
      validateEventPlan(plan, { eventName: "push", baseRef: "main", forceFull: true }),
    ).toThrow("CI_REQUIRED_QUALIFICATION_MINIMUM");
  });
});

describe("the walk over recent runs", () => {
  let root: string;
  const previousRepository = process.env.GITHUB_REPOSITORY;
  const previousRun = process.env.GITHUB_RUN_ID;
  const realCi = readFileSync(".github/workflows/ci.yml", "utf8");
  const realIntegration = readFileSync(".github/workflows/integration.yml", "utf8");

  const git = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  const commit = (message: string) => {
    expect(git(["add", "-A"]).status).toBe(0);
    expect(git(["commit", "-q", "--allow-empty", "-m", message]).status).toBe(0);
    return git(["rev-parse", "HEAD"]).stdout.trim();
  };

  const greenJobs = (plan: ReturnType<typeof fullPlan>, except: string[] = []) =>
    [
      ...legsOf(plan)
        .filter((leg: { job: string }) => leg.job !== "native-platforms")
        .map((leg: { leg: string }) => leg.leg),
      ...Object.values(integrationJobNamesByLane(realIntegration)).flat(),
      "native-platforms / one",
    ]
      .filter((name) => !except.includes(name))
      .map((name) => ({ name, status: "completed", conclusion: "success" }));

  const deps = (runs: unknown[], jobsFor: (id: string) => unknown) => ({
    git,
    gh: () => ({ value: { workflow_runs: runs } }),
    runJobs: (id: string) => ({ jobs: jobsFor(id) }),
    receiptCandidate: () => ({ error: "no receipts" }),
    isProse,
    integrationWorkflow: ".github/workflows/integration.yml",
    integrationSelection,
    integrationJobs: integrationJobNamesByLane,
    nativeJobs: () => ["native-platforms / one"],
  });
  const run = (id: number, sha: string, extra = {}) => ({
    id,
    head_sha: sha,
    event: "push",
    head_repository: { full_name: "o/r" },
    ...extra,
  });
  const legs = (carried: { leg: string }[]) => carried.map((entry) => entry.leg);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tn-leg-carry-"));
    process.env.GITHUB_REPOSITORY = "o/r";
    process.env.GITHUB_RUN_ID = "999";
    expect(git(["init", "-q"]).status).toBe(0);
    git(["config", "user.email", "ci@example.test"]);
    git(["config", "user.name", "ci"]);
    write(".github/workflows/ci.yml", realCi);
    write(".github/workflows/integration.yml", realIntegration);
    write("packages/core/src/index.ts", "export const a = 1;\n");
    write("packages/core/package.json", JSON.stringify({ version: "0.3.7" }));
    write("packages/create-threenative/templates/shooter/src/main.ts", "1\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    process.env.GITHUB_REPOSITORY = previousRepository;
    process.env.GITHUB_RUN_ID = previousRun;
  });

  it("carries every leg, integration lanes too, across an identical tree", () => {
    const source = commit("source");
    const candidate = commit("candidate");
    const plan = fullPlan(candidate);
    const carried = findCarried(
      plan,
      deps([run(1, source)], () => greenJobs(plan)),
    );
    expect(legs(carried)).toEqual(
      expect.arrayContaining([
        "test",
        "native-platforms",
        "template-nonvisual (shooter)",
        "test-unit (1/4)",
      ]),
    );
    expect(carried.filter((entry) => entry.job === "integration").length).toBeGreaterThan(5);
    expect(carried.every((entry) => entry.sourceSha === source)).toBe(true);
    expect(
      carriedFailures(
        plan,
        plan,
        deps([], () => greenJobs(plan)),
      ),
    ).toEqual([]);
  });

  it("reruns only what a one-kit change reaches", () => {
    const source = commit("source");
    write("packages/create-threenative/templates/shooter/src/main.ts", "2\n");
    const candidate = commit("kit");
    const plan = fullPlan(candidate);
    const carried = legs(
      findCarried(
        plan,
        deps([run(1, source)], () => greenJobs(plan)),
      ),
    );
    expect(carried).toContain("template-nonvisual (racing)");
    expect(carried).not.toContain("native-platforms");
    expect(carried).not.toContain("template-nonvisual (shooter)");
    expect(carried).not.toContain("typecheck");
    expect(carried).not.toContain("test");
  });

  it("carries past a release bump, except the unit legs that read versions", () => {
    const source = commit("source");
    write("packages/core/package.json", JSON.stringify({ version: "0.3.8" }));
    const candidate = commit("bump");
    const plan = fullPlan(candidate);
    const carried = legs(
      findCarried(
        plan,
        deps([run(1, source)], () => greenJobs(plan)),
      ),
    );
    expect(carried).toContain("typecheck");
    expect(carried).toContain("native-platforms");
    expect(carried).toContain("template-nonvisual (shooter)");
    expect(carried).not.toContain("test");
    expect(carried).not.toContain("test-unit (1/4)");
  });

  it("carries nothing but prose-safe legs when an unnamed path changes", () => {
    const source = commit("source");
    write("tools/new.mjs", "1\n");
    const candidate = commit("new input");
    const plan = fullPlan(candidate);
    expect(
      legs(
        findCarried(
          plan,
          deps([run(1, source)], () => greenJobs(plan)),
        ),
      ).filter((leg) => !leg.startsWith("integration:")),
    ).toEqual([]);
  });

  it("runs a job whose own workflow text changed and carries its neighbours", () => {
    const source = commit("source");
    write(
      ".github/workflows/ci.yml",
      realCi.replace("  budgets:\n", "  budgets:\n    # changed\n"),
    );
    const candidate = commit("workflow");
    const plan = fullPlan(candidate);
    const carried = legs(
      findCarried(
        plan,
        deps([run(1, source)], () => greenJobs(plan)),
      ),
    );
    expect(carried).not.toContain("budgets");
    expect(carried).toContain("typecheck");
  });

  it("takes an older green run when the newest run never ran the job", () => {
    const older = commit("older");
    const newer = commit("newer");
    const candidate = commit("candidate");
    const plan = fullPlan(candidate);
    const carried = findCarried(
      plan,
      deps([run(2, newer), run(1, older)], (id) => greenJobs(plan, id === "2" ? ["budgets"] : [])),
    );
    expect(carried.find((entry) => entry.leg === "budgets")?.runId).toBe(1);
    expect(carried.find((entry) => entry.leg === "typecheck")?.runId).toBe(2);
  });

  it.each(["failure", "timed_out"])(
    "runs a job whose newest result on the same inputs is %s, even with an older green",
    (conclusion) => {
      const older = commit("older");
      const newer = commit("newer");
      const candidate = commit("candidate");
      const plan = fullPlan(candidate);
      const carried = legs(
        findCarried(
          plan,
          deps([run(2, newer), run(1, older)], (id) =>
            greenJobs(plan).map((job) =>
              id === "2" && job.name === "budgets" ? { ...job, conclusion } : job,
            ),
          ),
        ),
      );
      expect(carried).not.toContain("budgets");
      expect(carried).toContain("typecheck");
    },
  );

  it("runs an integration lane whose newest result on the same inputs is red", () => {
    const older = commit("older");
    const newer = commit("newer");
    const candidate = commit("candidate");
    const plan = fullPlan(candidate);
    const carried = legs(
      findCarried(
        plan,
        deps([run(2, newer), run(1, older)], (id) =>
          greenJobs(plan).map((job) =>
            id === "2" && job.name === "integration / csg"
              ? { ...job, conclusion: "failure" }
              : job,
          ),
        ),
      ),
    );
    expect(carried).not.toContain("integration:csg");
    expect(carried).toContain("integration:ik");
  });

  it("ignores a scheduled run, whose head_sha is not the commit it tested", () => {
    const source = commit("source");
    const candidate = commit("candidate");
    const plan = fullPlan(candidate);
    expect(
      findCarried(
        plan,
        deps([run(1, source, { event: "schedule" })], () => greenJobs(plan)),
      ),
    ).toEqual([]);
  });

  it("runs the consumers when the job that builds their bytes changed", () => {
    const source = commit("source");
    write(
      ".github/workflows/ci.yml",
      realCi.replace("  build-artifacts:\n", "  build-artifacts:\n    # changed pack step\n"),
    );
    const candidate = commit("producer");
    const plan = fullPlan(candidate);
    const carried = legs(
      findCarried(
        plan,
        deps([run(1, source)], () => greenJobs(plan)),
      ),
    );
    expect(carried).not.toContain("template-nonvisual (shooter)");
    expect(carried).not.toContain("typecheck");
  });

  it("ignores a fork's run, its own run, and a pull-request run with no tested commit", () => {
    const source = commit("source");
    const candidate = commit("candidate");
    const plan = fullPlan(candidate);
    const runs = [
      run(1, source, { head_repository: { full_name: "fork/r" } }),
      run(999, source),
      run(3, source, { event: "pull_request" }),
    ];
    expect(
      findCarried(
        plan,
        deps(runs, () => greenJobs(plan)),
      ),
    ).toEqual([]);
  });

  it("keeps what the release gate reads on a main push", () => {
    const source = commit("source");
    const candidate = commit("candidate");
    const plan = fullPlan(candidate);
    const carried = legs(
      findCarried(plan, {
        ...deps([run(1, source)], () => greenJobs(plan)),
        reserved: RELEASE_GATE_JOBS,
      }),
    );
    for (const job of RELEASE_GATE_JOBS) expect(carried).not.toContain(job);
    expect(carried).toContain("benchmark");
  });

  it("carries nothing when the run listing cannot be read", () => {
    const plan = fullPlan(commit("only"));
    expect(findCarried(plan, { ...deps([], () => []), gh: () => ({ error: "502" }) })).toEqual([]);
  });

  it("fails the verdict when a carried source is not green or its inputs moved", () => {
    const source = commit("source");
    const candidate = commit("candidate");
    const plan = fullPlan(candidate);
    const carriedPlan = applyCarried(plan, [
      { job: "budgets", leg: "budgets", runId: 1, sourceSha: source },
    ]);
    expect(
      carriedFailures(
        carriedPlan,
        plan,
        deps([], () => greenJobs(plan, ["budgets"])),
      ),
    ).toEqual([expect.stringContaining("CI_REQUIRED_CARRIED_LEG: budgets")]);
    write("packages/core/src/index.ts", "export const a = 2;\n");
    const moved = commit("moved");
    const movedPlan = fullPlan(moved);
    const stale = applyCarried(movedPlan, [
      { job: "budgets", leg: "budgets", runId: 1, sourceSha: source },
    ]);
    expect(
      carriedFailures(
        stale,
        movedPlan,
        deps([], () => greenJobs(movedPlan)),
      ),
    ).toEqual([expect.stringContaining("has changed inputs")]);
    expect(
      carriedFailures(stale, movedPlan, {
        ...deps([], () => []),
        runJobs: () => ({ error: "502" }),
      }),
    ).toEqual([expect.stringContaining("could not be read")]);
  });
});

describe("which runs may carry at all", () => {
  const previous = process.env.GITHUB_ACTIONS;
  beforeEach(() => {
    process.env.GITHUB_ACTIONS = "true";
  });
  afterEach(() => {
    process.env.GITHUB_ACTIONS = previous;
  });

  it.each([
    ["a scheduled audit", { eventName: "schedule", root: "." }],
    ["a cold or forced full run", { eventName: "workflow_dispatch", full: true, root: "." }],
    ["a forced full push", { eventName: "push", full: true, root: "." }],
    ["a run that asked for no reuse", { eventName: "push", noReuse: true, root: "." }],
  ])("%s keeps every leg", async (_name, options) => {
    const plan = fullPlan();
    expect(await withCarriedLegs(plan, options)).toBe(plan);
  });

  it("the native matrix answers for its blocking legs, not the iOS one", async () => {
    const plan = fullPlan();
    const names = (await carryDeps(".", plan)).nativeJobs(plan);
    expect(names).toContain("native-platforms / Android emulator visual parity");
    expect(names.some((name: string) => name.includes("iOS"))).toBe(false);
  });

  it("a developer machine keeps every leg", async () => {
    process.env.GITHUB_ACTIONS = "";
    const plan = fullPlan();
    for (const eventName of ["push", "workflow_dispatch"])
      expect(await withCarriedLegs(plan, { eventName, root: "." })).toBe(plan);
  });
});

describe("the workflows honour a carried job", () => {
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");

  // `&&` binds tighter than `||`, so a gate appended to `a || b` applies only to `b`.
  it.each(CARRIABLE_JOBS.filter((job: string) => job !== "native-platforms"))(
    "%s's gate applies to the whole condition",
    (job) => {
      const condition =
        /^ {4}if: (?:\$\{\{ )?(.*?)(?: \}\})?$/mu.exec(jobText(ci, job) ?? "")?.[1] ?? "";
      const gate = ` && !contains(fromJSON(needs.scope.outputs.plan).carriedJobs, '${job}')`;
      expect(condition.endsWith(gate)).toBe(true);
      let depth = 0;
      const rest = condition.slice(0, -gate.length);
      for (let index = 0; index < rest.length; index += 1) {
        if (rest[index] === "(") depth += 1;
        if (rest[index] === ")") depth -= 1;
        if (depth === 0) expect(rest.slice(index, index + 2)).not.toBe("||");
      }
    },
  );

  it("run-summary requires a performance lane only when its job ran", () => {
    const summary = jobText(ci, "run-summary") ?? "";
    expect(summary).toContain("carriedJobs, 'performance-contracts'");
    expect(summary).toContain("carriedJobs, 'test-native'");
  });

  it.each(CARRIABLE_JOBS.filter((job: string) => job !== "native-platforms"))(
    "%s has a job gate",
    (job) => {
      expect(jobText(ci, job)).toContain(
        `!contains(fromJSON(needs.scope.outputs.plan).carriedJobs, '${job}')`,
      );
    },
  );

  it("native-platforms reads the plan's required flag, which a carry clears", () => {
    expect(jobText(ci, "native-platforms")).toContain(
      "fromJSON(needs.scope.outputs.plan).jobs['native-platforms'].required",
    );
  });

  it("golden-path passes when its template legs were carried", () => {
    expect(jobText(ci, "golden-path")).toContain(
      "contains(fromJSON(needs.scope.outputs.plan).carriedJobs, 'golden-path-template')",
    );
  });

  it("a main push keeps every job the release gate reads", () => {
    const release = readFileSync(".github/workflows/native-release.yml", "utf8");
    const table = /const requiredNames = \[([\s\S]*?)\];/u.exec(release)?.[1] ?? "";
    const names = [...table.matchAll(/"([^"]+)"/gu)].map((match) => match[1] ?? "");
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const job = name.startsWith("native-platforms / ") ? "native-platforms" : name;
      if (CARRIABLE_JOBS.includes(job)) expect(RELEASE_GATE_JOBS).toContain(job);
    }
  });
});

it("a job's text stops at the next job and includes the workflow env", () => {
  const workflow = "name: x\nenv:\n  A: 1\njobs:\n  one:\n    runs-on: a\n  two:\n    runs-on: b\n";
  expect(jobText(workflow, "one")).toBe("env:\n  A: 1\n  one:\n    runs-on: a\n");
  expect(jobText(workflow, "missing")).toBeNull();
});
