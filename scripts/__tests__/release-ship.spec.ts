import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expectedReleaseReportReference } from "../release-candidate-gate.js";
import {
  type IShipDeps,
  assertCandidateDispatchable,
  assertTagMovable,
  nextStep,
  runShip,
  ship,
} from "../release-ship.js";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const REPOSITORY = "ThreeNativeHQ/threenative-engine";
const VERSION = (
  JSON.parse(
    readFileSync(
      path.resolve(import.meta.dirname, "../../packages/runtime-native/package.json"),
      "utf8",
    ),
  ) as { version: string }
).version;
const TAG = `runtime-native-v${VERSION}`;

interface IFakeRun {
  conclusion: string;
  databaseId: number;
  event: string;
  headBranch: string;
  headSha: string;
  status: string;
}

const run = (id: number, event: string, over: Partial<IFakeRun> = {}): IFakeRun => ({
  conclusion: "success",
  databaseId: id,
  event,
  headBranch: "main",
  headSha: SHA,
  status: "completed",
  ...over,
});

/** A mutable GitHub: the fake `gh` and `git` read it, and the commands that change state edit it. */
function world(over: Partial<Record<string, unknown>> = {}) {
  const state = {
    candidate: [] as IFakeRun[],
    ci: [run(1, "push")] as IFakeRun[],
    core: undefined as string[] | undefined,
    main: SHA,
    npm: [] as string[],
    release: null as null | { isDraft: boolean; isPrerelease: boolean },
    tagCommit: undefined as string | undefined,
    tagRuns: [] as IFakeRun[],
    ...over,
  };
  const calls: string[] = [];
  const logs: string[] = [];
  const deps: IShipDeps = {
    gh: (args) => {
      const [a, b] = args;
      if (a === "run" && b === "list") {
        const workflow = args[args.indexOf("--workflow") + 1];
        const table: Record<string, IFakeRun[]> = {
          "ci.yml": state.ci,
          "release-candidate.yml": state.candidate,
          "native-release.yml": state.tagRuns,
        };
        return JSON.stringify(table[workflow as string] ?? []);
      }
      if (a === "release" && b === "view") {
        if (state.release === null) throw new Error("release not found");
        return JSON.stringify(state.release);
      }
      if (a === "api" && b === "--method") {
        calls.push(`gh ${args.join(" ")}`);
        state.tagCommit = SHA;
        return "";
      }
      if (a === "api") return `${state.main}\n`;
      if (a === "workflow") {
        calls.push(`gh ${args.join(" ")}`);
        if (args[2] === "native-release.yml") {
          state.tagRuns.push(
            run(20 + state.tagRuns.length, "workflow_dispatch", { headBranch: TAG }),
          );
          state.release = { isDraft: false, isPrerelease: false };
        } else state.candidate.push(run(10, "workflow_dispatch"));
        return "";
      }
      throw new Error(`unexpected gh ${args.join(" ")}`);
    },
    git: (args) => {
      if (args[0] === "rev-parse") return `${SHA}\n`;
      if (args[0] === "show") return JSON.stringify({ version: VERSION });
      if (args[0] === "ls-remote")
        return state.tagCommit === undefined ? "" : `${state.tagCommit}\t${args[2]}\n`;
      calls.push(`git ${args.join(" ")}`);
      return "";
    },
    log: (line) => logs.push(line),
    cohort: () => [
      { name: "@threenative/core", version: VERSION },
      { name: "@threenative/runtime-native", version: VERSION },
    ],
    npmVersions: (name) => (name === "@threenative/core" ? (state.core ?? state.npm) : state.npm),
    publish: (override) => calls.push(override ? "publish --override" : "publish"),
    repository: REPOSITORY,
    sleep: async () => undefined,
    verify: () => calls.push("verify"),
  };
  return { calls, deps, logs, state };
}

describe("pnpm release:ship --dry-run", () => {
  it("finds the CI run id, builds a request the gate accepts and dispatches nothing", async () => {
    const first = world();
    const acted = await ship(first.deps, { dryRun: true, sha: SHA });
    expect(acted).toEqual([]);
    expect(first.calls).toEqual([]);
    const request = JSON.parse(
      first.logs.find((line) => line.startsWith("request: "))?.slice("request: ".length) ?? "null",
    );
    expect(request).toMatchObject({
      candidateSha: SHA,
      repository: REPOSITORY,
      requiredRunIds: { ci: 1 },
      runtimeVersion: VERSION,
      tag: TAG,
    });
    expect(request.reportArtifacts.parity).toEqual(expectedReleaseReportReference("parity", 1));
    expect(first.logs).toContain(`next: dispatch release-candidate.yml for ${SHA}.`);

    const second = world();
    await ship(second.deps, { dryRun: true, sha: SHA });
    expect(second.logs).toEqual(first.logs);
  });

  it("reports the run that blocks the plan, and a real run refuses to start", async () => {
    const queued = world({ ci: [run(1, "push", { conclusion: "", status: "queued" })] });
    await ship(queued.deps, { dryRun: true, sha: SHA });
    expect(queued.logs).toContain("next: blocked: CI is not green (run 1 is queued).");
    await expect(ship(queued.deps, { dryRun: false, sha: SHA })).rejects.toThrow(
      /TN_SHIP_EVIDENCE/u,
    );
    expect(queued.calls).toEqual([]);
  });

  it("builds only from the commit it ships: a real run needs the checkout, a plan does not", async () => {
    await expect(ship(world().deps, { dryRun: false, sha: OTHER })).rejects.toThrow(
      /TN_SHIP_CHECKOUT/u,
    );
    const { deps, logs } = world({ ci: [run(1, "push", { headSha: OTHER })] });
    await ship(deps, { dryRun: true, sha: OTHER });
    expect(logs[0]).toMatch(/^note: TN_SHIP_CHECKOUT/u);
  });
});

describe("pnpm release:ship refuses what cannot be undone", () => {
  it.each([
    ["a public release", { isDraft: false, isPrerelease: false }],
    ["a prerelease", { isDraft: false, isPrerelease: true }],
    ["a draft", { isDraft: true, isPrerelease: false }],
  ])("does not move a tag that has %s", async (_label, release) => {
    const { calls, deps } = world({
      candidate: [run(10, "workflow_dispatch")],
      release,
      tagCommit: OTHER,
    });
    await expect(ship(deps, { dryRun: false, sha: SHA })).rejects.toThrow(
      /TN_SHIP_TAG_HAS_RELEASE/u,
    );
    expect(calls).toEqual([]);
  });

  it("does not move a tag while its run is still going", () => {
    const { state } = world({
      tagRuns: [run(20, "workflow_dispatch", { headBranch: TAG, status: "in_progress" })],
    });
    expect(() =>
      assertTagMovable({ ...stateOf(state), release: "none", tagRun: "running" }, TAG),
    ).toThrow(/TN_SHIP_TAG_RUN_ACTIVE/u);
  });

  it("does not dispatch a second release-candidate for a commit that already has a successful one", async () => {
    const { calls, deps, state } = world({ candidate: [run(10, "workflow_dispatch")] });
    expect(() => assertCandidateDispatchable(stateOf(state, { successes: 1 }), SHA)).toThrow(
      /TN_SHIP_CANDIDATE_EXISTS/u,
    );
    // The command never reaches the dispatch: the plan starts after the candidate step.
    await ship(deps, { dryRun: false, sha: SHA });
    expect(calls.some((call) => call.includes("release-candidate.yml"))).toBe(false);
  });

  it("does not dispatch while a candidate run is in flight or main has moved on", () => {
    const { state } = world();
    expect(() => assertCandidateDispatchable(stateOf(state, { inFlight: true }), SHA)).toThrow(
      /TN_SHIP_CANDIDATE_RUNNING/u,
    );
    expect(() => assertCandidateDispatchable({ ...stateOf(state), mainHead: OTHER }, SHA)).toThrow(
      /TN_SHIP_MAIN_MOVED/u,
    );
  });
});

describe("pnpm release:ship resumes", () => {
  it("runs every step from a green commit, in order", async () => {
    const { calls, deps } = world();
    const acted = await ship(deps, { dryRun: false, sha: SHA });
    expect(acted).toEqual(["candidate", "tag", "dispatch", "publish"]);
    expect(calls.map((call) => call.split(" ").slice(0, 4).join(" "))).toEqual([
      "gh workflow run release-candidate.yml",
      "gh api --method POST",
      "gh workflow run native-release.yml",
      "publish",
    ]);
  });

  it("dispatches a tag run once, while the run list lags", async () => {
    const { calls, deps, state } = world({
      candidate: [run(10, "workflow_dispatch")],
      tagCommit: SHA,
    });
    const gh = deps.gh;
    let lag = 2;
    const lagging = {
      ...deps,
      gh: (args: readonly string[]) =>
        args[0] === "run" && args.includes("native-release.yml") && lag-- > 0 ? "[]" : gh(args),
    };
    await ship(lagging, { dryRun: false, sha: SHA });
    expect(calls.filter((call) => call.includes("native-release.yml"))).toHaveLength(1);
    expect(state.tagRuns).toHaveLength(1);
  });

  it("finishes a cohort that a crash left half published", async () => {
    const { calls, deps } = world({
      candidate: [run(10, "workflow_dispatch")],
      release: { isDraft: false, isPrerelease: false },
      tagCommit: SHA,
      tagRuns: [run(20, "workflow_dispatch", { headBranch: TAG })],
      core: [VERSION],
    });
    expect(await ship(deps, { dryRun: false, sha: SHA })).toEqual(["publish"]);
    expect(calls).toEqual(["publish"]);
  });

  it("does nothing in the CI lane when the cohort is already on npm", async () => {
    const { calls, deps } = world({ npm: [VERSION] });
    expect(await ship(deps, { auto: true, dryRun: false, sha: SHA })).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("an override goes straight to the tag run and names its reason there", async () => {
    const { calls, deps } = world({ ci: [] });
    const acted = await ship(deps, { dryRun: false, override: "hotfix", sha: SHA });
    expect(acted).toEqual(["tag", "dispatch", "publish"]);
    expect(calls).not.toContain(expect.stringContaining("release-candidate.yml"));
    expect(calls.find((call) => call.includes("native-release.yml"))).toContain("override=hotfix");
    expect(calls).toContain("publish --override");
  });

  it("stops on a failed lookup, because a failed read is not a missing release", async () => {
    const { calls, deps } = world({ ci: [], tagCommit: SHA });
    const gh = deps.gh;
    const down: typeof deps = {
      ...deps,
      gh: (args) => {
        if (args[0] === "release") throw new Error("HTTP 502: bad gateway");
        return gh(args);
      },
    };
    await expect(ship(down, { dryRun: false, sha: SHA })).rejects.toThrow(/HTTP 502/u);
    expect(calls.some((call) => call.includes("--method"))).toBe(false);
  });

  it("an override starts a new tag run after a failed one", async () => {
    const { calls, deps } = world({
      ci: [],
      tagCommit: SHA,
      tagRuns: [run(20, "workflow_dispatch", { conclusion: "failure", headBranch: TAG })],
    });
    const acted = await ship(deps, { dryRun: false, override: "hotfix", sha: SHA });
    expect(acted).toEqual(["dispatch", "publish"]);
    expect(calls.filter((call) => call.includes("native-release.yml"))).toHaveLength(1);
  });

  it("refuses an override with no reason", async () => {
    await expect(runShip(["--override", " "])).rejects.toThrow("TN_SHIP_OVERRIDE");
  });

  it("moves a tag that points at a commit with no release", async () => {
    const { calls, deps } = world({ candidate: [run(10, "workflow_dispatch")], tagCommit: OTHER });
    await ship(deps, { dryRun: false, sha: SHA });
    expect(calls.find((call) => call.includes("--method PATCH"))).toContain(`sha=${SHA}`);
  });

  it("skips what is done: a pushed tag and a public release go straight to the publish", async () => {
    const { calls, deps } = world({
      candidate: [run(10, "workflow_dispatch")],
      release: { isDraft: false, isPrerelease: false },
      tagCommit: SHA,
      tagRuns: [run(20, "workflow_dispatch", { headBranch: TAG })],
    });
    expect(await ship(deps, { dryRun: false, sha: SHA })).toEqual(["publish"]);
    expect(calls).toEqual(["publish"]);
  });

  // The 0.3.5, 0.3.6 and 0.3.7 tag runs concluded failure on the non-gating iOS job, so reading the
  // run's own conclusion made `release:ship` stop on a release `finalize` had already promoted.
  it("publishes a promoted release even when the iOS evidence job failed the run", async () => {
    const { calls, deps } = world({
      candidate: [run(10, "workflow_dispatch")],
      release: { isDraft: false, isPrerelease: false },
      tagCommit: SHA,
      tagRuns: [run(20, "workflow_dispatch", { conclusion: "failure", headBranch: TAG })],
    });
    expect(await ship(deps, { dryRun: false, sha: SHA })).toEqual(["publish"]);
    expect(calls).toEqual(["publish"]);
  });

  it("stops on a failed tag run that never promoted its release", async () => {
    const { deps } = world({
      candidate: [run(10, "workflow_dispatch")],
      release: { isDraft: false, isPrerelease: true },
      tagCommit: SHA,
      tagRuns: [run(20, "workflow_dispatch", { conclusion: "failure", headBranch: TAG })],
    });
    await expect(ship(deps, { dryRun: false, sha: SHA })).rejects.toThrow("TN_SHIP_TAG_RUN_FAILED");
  });

  it("only verifies when the cohort is already on npm", async () => {
    const { calls, deps } = world({ candidate: [run(10, "workflow_dispatch")], npm: [VERSION] });
    expect(await ship(deps, { dryRun: false, sha: SHA })).toEqual(["verify"]);
    expect(calls).toEqual(["verify"]);
  });
});

describe("nextStep", () => {
  it("names the first step that is not done", () => {
    const { state } = world();
    const done = stateOf(state, { successes: 1 });
    expect(nextStep(done, SHA)).toBe("tag");
    expect(nextStep({ ...done, tag: { commit: SHA } }, SHA)).toBe("dispatch");
    expect(nextStep({ ...done, tag: { commit: SHA }, tagRun: "running" }, SHA)).toBe("wait");
    expect(nextStep({ ...done, ci: "run 1 is queued" }, SHA)).toBe("evidence");
  });
});

/** An `IShipState` for the pure helpers, with the fixture's green runs and no release yet. */
function stateOf(
  _state: unknown,
  candidate: { inFlight?: boolean; successes?: number } = {},
): Parameters<typeof nextStep>[0] {
  return {
    candidate: {
      failed: [],
      inFlight: candidate.inFlight ?? false,
      successes: candidate.successes ?? 0,
    },
    ci: 1,
    mainHead: SHA,
    npmPublished: false,
    release: "none",
    tag: {},
    tagRun: "none",
  };
}
