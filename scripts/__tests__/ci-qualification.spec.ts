import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";

const {
  classify,
  coverageMiss,
  selectionPlan,
  TEMPLATE_NAMES,
  validateEventPlan,
  validatePlan,
  validationProfile,
} = await import(new URL("../ci-change-scope.mjs", import.meta.url).href);
const gate = new URL("../ci-required.mjs", import.meta.url).pathname;

function fixture(file: string) {
  const root = makeTempDirSync("ci-qualification-");
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q");
  git("config", "user.name", "CI fixture");
  git("config", "user.email", "ci@example.invalid");
  writeFileSync(path.join(root, "seed"), "base\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), "changed\n");
  git("add", ".");
  git("commit", "-qm", "change");
  return { root, base, head: git("rev-parse", "HEAD") };
}

describe("exact-candidate qualification minimum", () => {
  it("keeps resolved shared-runtime smoke and Android coverage unchanged in the queue", () => {
    const f = fixture("packages/core/src/scene.ts");
    try {
      // PRD-731: the pull request runs the review lane; the queue owns this board.
      const plan = classify({
        ...f,
        candidateSha: f.head,
        target: "develop",
        eventName: "merge_group",
      });
      expect(plan).toMatchObject({
        selection: "full",
        qualification: false,
        nativeTier: "reduced",
      });
      expect(plan.jobs["native-platforms"].required).toBe(true);
      expect(plan.templateMatrix.template).toEqual(["starter"]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("falls back to exhaustive when event identity is absent", () => {
    const f = fixture("docs/inert.md");
    try {
      expect(classify({ ...f, candidateSha: f.head, target: "develop" })).toMatchObject({
        selection: "full",
        qualification: true,
        nativeTier: "full",
      });
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
  // PRD-550: the queue is no longer the exhaustive board. A merge group tests the exact tree a merge
  // would produce on the base branch, so it earns the same selection plan a pull request into
  // develop earns — narrowed by the same changed paths, with the same reduced native tier.
  it.each([
    ["docs/inert.md", "prose"],
    ["scripts/ci-required.mjs", "ci"],
    ["packages/create-threenative/templates/shooter/src/main.ts", "template"],
    ["packages/core/src/scene.ts", "full"],
  ])(
    "gives a develop merge group the plan a develop pull request gets for %s",
    (file, selection) => {
      const f = fixture(file);
      try {
        const queue = classify({
          ...f,
          candidateSha: f.head,
          target: "refs/heads/develop",
          eventName: "merge_group",
        });
        expect(queue).toMatchObject({ selection, qualification: false });
        const pull = classify({
          ...f,
          candidateSha: f.head,
          target: "develop",
          eventName: "pull_request",
        });
        // PRD-731: a narrowed diff earns the same plan on both events; one that owes the whole
        // board earns the thin review lane on the pull request and the board in the queue.
        if (selection === "full") {
          expect(pull).toMatchObject({ selection: "review", lane: "review", qualification: false });
          expect(queue).toMatchObject({ lane: "queue" });
        } else expect(queue).toEqual(pull);
        expect(validatePlan(queue)).toEqual(queue);
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    },
  );

  it.each(["main", "release"])("still qualifies a queue entry targeting %s", (target) => {
    const f = fixture("docs/inert.md");
    try {
      const plan = classify({
        ...f,
        candidateSha: f.head,
        target,
        eventName: "merge_group",
      });
      expect(plan).toMatchObject({
        selection: "full",
        qualification: true,
        native: true,
        nativeTier: "full",
        reusedRunId: 0,
      });
      expect(plan.templateMatrix.template).toEqual(TEMPLATE_NAMES);
      expect(plan.goldenMatrix.template).toEqual(["starter", "platformer"]);
      expect(plan.unitMatrix.shard).toEqual(["1/4", "2/4", "3/4", "4/4"]);
      expect(
        Object.values(plan.jobs).every((job: unknown) => (job as { required: boolean }).required),
      ).toBe(true);
      expect(validatePlan(plan)).toEqual(plan);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  // A develop push promotes an exact tree, so it runs the exhaustive board instead of the cache-only
  // lane, and it keeps publishing the two base-branch caches because a full selection runs both.
  it.each(["develop", "main"])("qualifies a push to %s with the whole board", (target) => {
    const f = fixture("docs/inert.md");
    try {
      expect(classify({ ...f, candidateSha: f.head, target, eventName: "push" })).toMatchObject({
        selection: "full",
        qualification: true,
        native: true,
        nativeTier: "full",
        reusedRunId: 0,
      });
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it.each(["schedule", "workflow_dispatch", "unknown"])(
    "keeps %s exhaustive on develop",
    (eventName) => {
      const f = fixture("packages/core/src/scene.ts");
      try {
        expect(
          classify({ ...f, candidateSha: f.head, target: "develop", eventName }),
        ).toMatchObject({ qualification: true, nativeTier: "full" });
        expect(
          classify({
            ...f,
            candidateSha: f.head,
            target: "develop",
            eventName: "pull_request",
            full: true,
          }),
        ).toMatchObject({ qualification: true, nativeTier: "full" });
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    },
  );

  it("accepts a narrowed develop queue plan and refuses the same plan on every other event", () => {
    const f = fixture("docs/inert.md");
    try {
      const plan = selectionPlan(
        "prose",
        "narrow review",
        ["docs/inert.md"],
        f.head,
        false,
        0,
        "develop",
      );
      expect(
        validateEventPlan(plan, { eventName: "merge_group", baseRef: "refs/heads/develop" }),
      ).toEqual(plan);
      for (const eventName of ["push", "schedule", "workflow_dispatch"]) {
        expect(() => validateEventPlan(plan, { eventName, baseRef: "develop" })).toThrow(
          "CI_REQUIRED_QUALIFICATION_MINIMUM",
        );
      }
      expect(() => validateEventPlan(plan, { eventName: "merge_group", baseRef: "main" })).toThrow(
        "CI_REQUIRED_QUALIFICATION_MINIMUM",
      );
      expect(() =>
        validateEventPlan(plan, {
          eventName: "merge_group",
          baseRef: "develop",
          forceFull: true,
        }),
      ).toThrow("CI_REQUIRED_QUALIFICATION_MINIMUM");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("requires an explicit develop target to keep a reduced queue plan", () => {
    const f = fixture("docs/inert.md");
    try {
      const plan = selectionPlan(
        "prose",
        "narrow review",
        ["docs/inert.md"],
        f.head,
        false,
        0,
        "develop",
      );
      // develop, bare or prefixed, keeps the reduced review the queue earns.
      for (const baseRef of ["develop", "refs/heads/develop"]) {
        expect(validateEventPlan(plan, { eventName: "merge_group", baseRef })).toEqual(plan);
      }
      // main, bare or prefixed, and any unknown or missing target must reject a review plan.
      for (const baseRef of [
        "main",
        "refs/heads/main",
        "refs/heads/release",
        "release",
        "",
        undefined,
      ]) {
        expect(() => validateEventPlan(plan, { eventName: "merge_group", baseRef })).toThrow(
          "CI_REQUIRED_QUALIFICATION_MINIMUM",
        );
      }
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it.each(["prose", "ci", "warm", "full"])(
    "independently rejects a planner-generated %s exemption outside a develop review",
    (selection) => {
      const f = fixture("docs/inert.md");
      try {
        const plan = selectionPlan(
          selection,
          "narrow review",
          ["packages/core/src/scene.ts"],
          f.head,
          selection === "full",
          0,
          "develop",
        );
        expect(validatePlan(plan)).toEqual(plan);
        const needs = {
          scope: { result: "success", outputs: { plan: JSON.stringify(plan) } },
          ...Object.fromEntries(
            Object.entries(plan.jobs).map(([name, job]) => [
              name,
              { result: (job as { required: boolean }).required ? "success" : "skipped" },
            ]),
          ),
        };
        const result = spawnSync(process.execPath, [gate], {
          cwd: f.root,
          encoding: "utf8",
          env: {
            ...process.env,
            TN_CI_EVENT: "workflow_dispatch",
            TN_CI_BASE_REF: "refs/heads/develop",
            TN_CI_BASE_SHA: f.base,
            TN_CI_HEAD_SHA: f.head,
            TN_CI_NEEDS: JSON.stringify(needs),
          },
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("CI_REQUIRED_QUALIFICATION_MINIMUM");
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    },
  );
});

describe("PRD-731 the review lane", () => {
  const REVIEW_JOBS = [
    "budgets",
    "build-artifacts",
    "golden-path",
    "golden-path-template",
    "lint",
    "supply-chain",
    "test",
    "test-unit",
    "typecheck",
  ];
  const review = (file: string) => {
    const f = fixture(file);
    try {
      return classify({
        ...f,
        candidateSha: f.head,
        target: "develop",
        eventName: "pull_request",
      });
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  };

  it("gives a package diff the thin job set and leaves native, integration and the rest to the queue", () => {
    const plan = review("packages/core/src/scene.ts");
    expect(plan).toMatchObject({ selection: "review", lane: "review", native: false });
    const required = Object.entries(plan.jobs as Record<string, { required: boolean }>)
      .filter(([, job]) => job.required)
      .map(([name]) => name)
      .sort();
    expect(required).toEqual(REVIEW_JOBS);
    expect(plan.unitMatrix.shard).toEqual(["1/1"]);
    expect(plan.goldenMatrix.template).toEqual(["starter"]);
    expect(validatePlan(plan)).toEqual(plan);
  });

  it("runs the test job only when a package changed, and the touched template's smoke", () => {
    const outsidePackages = review("scripts/lib/shared.ts");
    expect(outsidePackages.jobs.test.required).toBe(false);
    const template = review("packages/create-threenative/templates/shooter/src/main.ts");
    expect(template.selection).toBe("template");
    const lookalike = review("packages/create-threenative/templates/shooter-lookalike/src/main.ts");
    expect(lookalike).toMatchObject({ selection: "review" });
  });

  it("keeps a diff that did not resolve on the whole board", () => {
    const f = fixture("packages/core/src/scene.ts");
    try {
      expect(
        classify({
          ...f,
          base: "",
          candidateSha: f.head,
          target: "develop",
          eventName: "pull_request",
        }),
      ).toMatchObject({ selection: "full", qualification: true });
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("is a verdict for a pull request into develop only", () => {
    const plan = review("packages/core/src/scene.ts");
    expect(validateEventPlan(plan, { eventName: "pull_request", baseRef: "develop" })).toEqual(
      plan,
    );
    for (const [eventName, baseRef] of [
      ["merge_group", "refs/heads/develop"],
      ["push", "develop"],
      ["schedule", "develop"],
      ["workflow_dispatch", "develop"],
      ["pull_request", "main"],
      ["merge_group", "main"],
    ]) {
      expect(() => validateEventPlan(plan, { eventName, baseRef })).toThrow(
        "CI_REQUIRED_REVIEW_LANE",
      );
    }
  });

  it("makes ci-required refuse a review plan on a merge group", () => {
    const f = fixture("packages/core/src/scene.ts");
    try {
      const plan = classify({
        ...f,
        candidateSha: f.head,
        target: "develop",
        eventName: "pull_request",
      });
      const needs = {
        scope: { result: "success", outputs: { plan: JSON.stringify(plan) } },
        ...Object.fromEntries(
          Object.entries(plan.jobs).map(([name, job]) => [
            name,
            { result: (job as { required: boolean }).required ? "success" : "skipped" },
          ]),
        ),
      };
      const result = spawnSync(process.execPath, [gate], {
        cwd: f.root,
        encoding: "utf8",
        env: {
          ...process.env,
          TN_CI_EVENT: "merge_group",
          TN_CI_BASE_REF: "refs/heads/develop",
          TN_CI_BASE_SHA: f.base,
          TN_CI_HEAD_SHA: f.head,
          TN_CI_NEEDS: JSON.stringify(needs),
        },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("CI_REQUIRED_REVIEW_LANE");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("rejects a review plan with no diff or with native evidence", () => {
    const plan = review("packages/core/src/scene.ts");
    expect(() => validatePlan({ ...plan, files: [] })).toThrow("CI_SCOPE_INVALID_PLAN");
    expect(() => validatePlan({ ...plan, native: true })).toThrow("CI_SCOPE_INVALID_PLAN");
  });

  it("never lets a green review run stand in for a queue or full requirement", () => {
    const queue = validationProfile({ eventName: "merge_group", baseRef: "develop" });
    const pull = validationProfile({ eventName: "pull_request", baseRef: "develop" });
    const push = validationProfile({ eventName: "push", baseRef: "develop" });
    expect([pull.lane, queue.lane, push.lane]).toEqual(["review", "queue", "full"]);
    const view = (profile: unknown) => ({
      profile,
      required: ["typecheck"],
      runnerClasses: new Map(),
    });
    expect(coverageMiss(view(queue), { profile: pull, jobs: [] })).toContain("lane");
    expect(coverageMiss(view(push), { profile: queue, jobs: [] })).toContain("lane");
    expect(coverageMiss(view(pull), { profile: queue, jobs: [] })).not.toContain("lane");
  });
});
