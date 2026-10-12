import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";
const moduleUrl = new URL("../ci-change-scope.mjs", import.meta.url).href;
const { TEMPLATE_NAMES, changedTemplates, classify, selectionPlan, validatePlan } = await import(
  moduleUrl
);
function fixture() {
  const root = makeTempDirSync("ci-template-scope-");
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  writeFileSync(path.join(root, "README.md"), "base\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  return {
    root,
    git,
    base,
    change(file: string) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), "changed\n");
      git("add", ".");
      git("commit", "-qm", "change");
      return git("rev-parse", "HEAD");
    },
  };
}
describe("impact-driven template coverage", () => {
  it.each(["pull_request", "merge_group"])(
    "selects only an exact changed kit for %s",
    (eventName) => {
      const f = fixture();
      try {
        const head = f.change("packages/create-threenative/templates/shooter/src/game.ts");
        const plan = classify({
          root: f.root,
          base: f.base,
          head,
          candidateSha: head,
          target: "develop",
          eventName,
        });
        expect(plan.selection).toBe("template");
        expect(plan.templateMatrix.template).toEqual(["shooter"]);
        expect(plan.goldenMatrix.template).toEqual(["shooter"]);
        for (const name of ["test-native", "native-platforms", "test-browser", "benchmark"])
          expect(plan.jobs[name].required).toBe(false);
        for (const name of [
          "build-artifacts",
          "template-nonvisual",
          "golden-path-template",
          "supply-chain",
        ])
          expect(plan.jobs[name].required).toBe(true);
        expect(validatePlan(plan)).toEqual(plan);
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    },
  );
  it.each(["pull_request", "merge_group"])("keeps CI and docs narrow on %s", (eventName) => {
    for (const [file, selection] of [
      ["docs/PRDs/inert.md", "prose"],
      ["scripts/ci-required.mjs", "ci"],
    ] as const) {
      const f = fixture();
      try {
        const head = f.change(file);
        const plan = classify({
          root: f.root,
          base: f.base,
          head,
          candidateSha: head,
          target: "develop",
          eventName,
        });
        expect(plan.selection).toBe(selection);
        expect(plan.jobs["template-nonvisual"].required).toBe(false);
        expect(plan.jobs["test-native"].required).toBe(false);
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    }
  });
  it.each([
    "packages/create-threenative/src/scaffold.ts",
    "scripts/stamp-template-render.ts",
    "packages/core/src/index.ts",
    "packages/create-threenative/templates/shooter-lookalike/src/main.ts",
    "unknown/meaningful.ts",
  ])("retains full fanout for shared or unknown %s", (file) => {
    const f = fixture();
    try {
      const head = f.change(file);
      const plan = classify({
        root: f.root,
        base: f.base,
        head,
        candidateSha: head,
        target: "develop",
        eventName: "pull_request",
      });
      expect(plan.selection).toBe("full");
      expect(plan.templateMatrix.template).toEqual(
        file.startsWith("unknown/") ||
          file.includes("lookalike") ||
          file === "scripts/stamp-template-render.ts"
          ? TEMPLATE_NAMES
          : ["starter"],
      );
      if (file.startsWith("packages/core/")) expect(plan.jobs["test-native"].required).toBe(true);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
  it("normalizes the queue target and unions every constituent template change", () => {
    const f = fixture();
    try {
      f.change("packages/create-threenative/templates/shooter/src/x.ts");
      const head = f.change("packages/create-threenative/templates/snow/src/y.ts");
      const plan = classify({
        root: f.root,
        base: f.base,
        head,
        candidateSha: head,
        target: "refs/heads/develop",
        eventName: "merge_group",
      });
      // The queue is narrowed exactly like a pull request into develop: the changed kits prove
      // themselves and starter exercises the default scaffold route.
      expect(plan.selection).toBe("template");
      expect(plan.qualification).toBe(false);
      expect(plan.templateMatrix.template).toEqual(["shooter", "snow"]);
      expect(plan.goldenMatrix.template).toEqual(["shooter"]);
      expect(plan.unitMatrix.shard).toEqual(["1/1"]);
      expect(validatePlan(plan)).toEqual(plan);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
  it("skips inert template Markdown and preserves full main qualification", () => {
    const f = fixture();
    try {
      const head = f.change("packages/create-threenative/templates/shooter/README.md");
      for (const [target, selection] of [
        ["develop", "prose"],
        ["main", "full"],
      ] as const) {
        const plan = classify({
          root: f.root,
          base: f.base,
          head,
          candidateSha: head,
          target,
          eventName: "merge_group",
        });
        expect(plan.selection).toBe(selection);
      }
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
  it("retains CI contracts for a queue containing CI and template changes", () => {
    const f = fixture();
    try {
      f.change("scripts/ci-required.mjs");
      const head = f.change("packages/create-threenative/templates/shooter/src/x.ts");
      const plan = classify({
        root: f.root,
        base: f.base,
        head,
        candidateSha: head,
        target: "develop",
        eventName: "merge_group",
      });
      expect(plan.selection).toBe("template");
      expect(plan.checks.ci).toBe(true);
      expect(plan.templateMatrix.template).toEqual(["shooter"]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
  it.each([
    "packages/core/tsup.config.ts",
    "scripts/workspace-packages.ts",
    "scripts/xvfb.sh",
    "unknown/meaningful.ts",
  ])("retains native evidence for unproven shared consumer %s", (file) => {
    const f = fixture();
    try {
      const head = f.change(file);
      const plan = classify({
        root: f.root,
        base: f.base,
        head,
        candidateSha: head,
        target: "develop",
        eventName: "pull_request",
      });
      expect(plan.jobs["test-native"].required).toBe(true);
      expect(plan.jobs["native-platforms"].required).toBe(true);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
  it("requires resolved queue history and independently refuses missing Integration evidence", () => {
    const f = fixture();
    const clone = makeTempDirSync("ci-shallow-queue-");
    try {
      // A shared-runtime change keeps the queue plan narrow enough for a review lane while still
      // requiring the exact-candidate Integration join, which is what this gate re-derives.
      const head = f.change("packages/core/src/scene.ts");
      const plan = classify({
        root: f.root,
        base: f.base,
        head,
        candidateSha: head,
        target: "develop",
        eventName: "merge_group",
      });
      expect(plan.jobs.integration.required).toBe(true);
      const cloned = spawnSync(
        "git",
        ["clone", "--quiet", "--depth", "1", `file://${f.root}`, clone],
        { encoding: "utf8" },
      );
      expect(cloned.status, cloned.stderr).toBe(0);
      const needs = {
        scope: { result: "success", outputs: { plan: JSON.stringify(plan) } },
        ...Object.fromEntries(Object.keys(plan.jobs).map((name) => [name, { result: "success" }])),
      };
      const run = () =>
        spawnSync(process.execPath, [new URL("../ci-required.mjs", import.meta.url).pathname], {
          cwd: clone,
          encoding: "utf8",
          env: {
            ...process.env,
            TN_CI_EVENT: "merge_group",
            TN_CI_BASE_REF: "refs/heads/develop",
            TN_CI_BASE_SHA: f.base,
            TN_CI_HEAD_SHA: head,
            TN_CI_NEEDS: JSON.stringify(needs),
          },
        });
      expect(run().stderr).toContain("CI_REQUIRED_QUEUE_CANDIDATE_MISMATCH");
      const fetched = spawnSync("git", ["fetch", "--quiet", "--unshallow", "origin"], {
        cwd: clone,
        encoding: "utf8",
      });
      expect(fetched.status, fetched.stderr).toBe(0);
      const verified = run();
      expect(verified.status).toBe(1);
      expect(verified.stderr).not.toContain("CI_REQUIRED_QUEUE_CANDIDATE_MISMATCH");
      expect(verified.stderr).toContain("CI_INTEGRATION_RECEIPT_IDENTITY");
      const workflow = readFileSync(
        new URL("../.github/workflows/ci.yml", new URL("../", import.meta.url)),
        "utf8",
      );
      expect(workflow.slice(workflow.indexOf("  ci-required:"))).toMatch(
        /with:\s*\n\s+fetch-depth: 0/u,
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
      rmSync(clone, { recursive: true, force: true });
    }
  });
  it("covers all kit identities without duplicate matrix entries and rejects tampering", () => {
    const full = selectionPlan("full", "audit", [], "a".repeat(40), true, 0, "main");
    expect(full.templateMatrix.template).toEqual(TEMPLATE_NAMES);
    expect(new Set(TEMPLATE_NAMES).size).toBe(TEMPLATE_NAMES.length);
    expect(() => validatePlan({ ...full, templateMatrix: { template: ["starter"] } })).toThrow();
    expect(
      changedTemplates([
        "packages/create-threenative/templates/starter/src/x.ts",
        "packages/create-threenative/template-playtests/shooter/a.playtest.json",
      ]),
    ).toEqual(["shooter", "starter"]);
  });
  it("rejects an unrelated or unresolved merge-group source", () => {
    const f = fixture();
    try {
      const head = f.change("docs/x.md");
      for (const options of [
        { base: "unknown", head },
        { base: f.base, head: f.base },
      ] as const) {
        // An unresolved base/head identity cannot prove what the queue would merge, so it stays
        // exhaustive even though every other develop queue input is narrowed.
        expect(
          classify({
            root: f.root,
            ...options,
            candidateSha: head,
            target: "develop",
            eventName: "merge_group",
          }),
        ).toMatchObject({ selection: "full", qualification: true, nativeTier: "full" });
      }
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

it("keeps the exhaustive board at one complete job per manifest plus both retained golden journeys", () => {
  const plan = selectionPlan("full", "qualification", [], "a".repeat(40), true);
  expect(plan.templateMatrix.template).toEqual(TEMPLATE_NAMES);
  expect(plan.goldenMatrix.template).toEqual(["starter", "platformer"]);
  expect(plan.templateMatrix.template.length + plan.goldenMatrix.template.length).toBe(
    TEMPLATE_NAMES.length + 2,
  );
});

describe("representative develop smoke with exhaustive qualification", () => {
  it.each([
    "packages/core/src/renderer.ts",
    "packages/core/tsup.config.ts",
    "packages/runtime-native/src/main.cpp",
  ])("keeps starter for the classified producer %s", (file) => {
    const plan = selectionPlan(
      "full",
      "resolved dependency",
      [file],
      "a".repeat(40),
      true,
      0,
      "develop",
    );
    expect(plan.templateMatrix.template).toEqual(["starter"]);
    expect(plan.goldenMatrix.template).toEqual(["starter"]);
    expect(validatePlan(plan)).toEqual(plan);
    expect(() => validatePlan({ ...plan, templateMatrix: { template: ["minimal"] } })).toThrow();
  });
  it("unions explicit runtime kits but ignores kit instructions and inert Markdown", () => {
    const files = [
      "packages/core/src/game.ts",
      "packages/create-threenative/templates/shooter/src/game.ts",
      "packages/create-threenative/templates/snow/AGENTS.md",
      "packages/create-threenative/templates/rain/CLAUDE.md",
      "packages/create-threenative/templates/racing/README.md",
    ];
    const plan = selectionPlan(
      "full",
      "resolved dependency",
      files,
      "a".repeat(40),
      true,
      0,
      "develop",
    );
    expect(changedTemplates(files)).toEqual(["shooter"]);
    expect(plan.templateMatrix.template).toEqual(["shooter", "starter"]);
    expect(plan.goldenMatrix.template).toEqual(["starter"]);
  });
  it.each(["main", ""])("keeps exhaustive qualification for %s", (target) => {
    const plan = selectionPlan(
      "full",
      "qualification",
      ["packages/core/src/game.ts"],
      "a".repeat(40),
      true,
      0,
      target,
    );
    expect(plan.templateMatrix.template).toEqual(TEMPLATE_NAMES);
    expect(plan.goldenMatrix.template).toEqual(["starter", "platformer"]);
  });
  it.each([{ files: [] }, { files: ["unknown/new.ts"] }, { files: ["scripts/unclassified.ts"] }])(
    "keeps unknown or explicit audit inputs exhaustive: %s",
    ({ files }) => {
      const plan = selectionPlan(
        "full",
        "unresolved or audit",
        files,
        "a".repeat(40),
        true,
        0,
        "develop",
      );
      expect(plan.templateMatrix.template).toEqual(TEMPLATE_NAMES);
    },
  );
  it("checks scaffold/instruction contracts without runtime template legs for template instruction changes", () => {
    const f = fixture();
    try {
      const head = f.change("packages/create-threenative/templates/snow/AGENTS.md");
      const plan = classify({
        root: f.root,
        base: f.base,
        head,
        candidateSha: head,
        target: "develop",
        eventName: "pull_request",
      });
      expect(plan.selection).toBe("ci");
      expect(plan.checks.instructions).toBe(true);
      expect(plan.jobs["template-nonvisual"].required).toBe(false);
      expect(plan.jobs["test-unit"].required).toBe(true);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

it("retains both renamed kit endpoints and deleted kit source coverage", () => {
  const f = fixture();
  try {
    const base = f.change("packages/create-threenative/templates/shooter/src/old.ts");
    mkdirSync(path.join(f.root, "packages/create-threenative/templates/snow/src"), {
      recursive: true,
    });
    f.git(
      "mv",
      "packages/create-threenative/templates/shooter/src/old.ts",
      "packages/create-threenative/templates/snow/src/new.ts",
    );
    f.git("commit", "-qm", "rename");
    const head = f.git("rev-parse", "HEAD");
    const plan = classify({
      root: f.root,
      base,
      head,
      candidateSha: head,
      target: "develop",
      eventName: "pull_request",
    });
    expect(plan.templateMatrix.template).toEqual(["shooter", "snow"]);
    f.git("rm", "packages/create-threenative/templates/snow/src/new.ts");
    f.git("commit", "-qm", "delete");
    const deleted = f.git("rev-parse", "HEAD");
    expect(
      classify({
        root: f.root,
        base: head,
        head: deleted,
        candidateSha: deleted,
        target: "develop",
        eventName: "pull_request",
      }).templateMatrix.template,
    ).toEqual(["snow"]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
