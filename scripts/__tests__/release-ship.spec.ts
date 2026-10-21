import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expectedReleaseReportReference } from "../release-candidate-gate.js";
import {
  type IShipDeps,
  assertCandidateDispatchable,
  assertTagMovable,
  nextStep,
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
    main: SHA,
    native: [run(2, "workflow_dispatch")] as IFakeRun[],
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
          "native-platforms.yml": state.native,
          "release-candidate.yml": state.candidate,
          "native-release.yml": state.tagRuns,
        };
        return JSON.stringify(table[workflow as string] ?? []);
      }
      if (a === "release" && b === "view") {
        if (state.release === null) throw new Error("release not found");
        return JSON.stringify(state.release);
      }
      if (a === "api") return `${state.main}\n`;
      if (a === "workflow") {
        calls.push(`gh ${args.join(" ")}`);
        state.candidate.push(run(10, "workflow_dispatch"));
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
      if (args[0] === "push") {
        state.tagCommit = SHA;
        state.tagRuns.push(run(20, "push", { headBranch: TAG }));
        state.release = { isDraft: false, isPrerelease: false };
      }
      return "";
    },
    log: (line) => logs.push(line),
    npmVersions: () => state.npm,
    publish: () => calls.push("publish"),
    repository: REPOSITORY,
    sleep: async () => undefined,
    verify: () => calls.push("verify"),
  };
  return { calls, deps, logs, state };
}

describe("pnpm release:ship --dry-run", () => {
  it("finds both run ids, builds a request the gate accepts and dispatches nothing", async () => {
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
      requiredRunIds: { ci: 1, native: 2 },
      runtimeVersion: VERSION,
      tag: TAG,
    });
    expect(request.reportArtifacts.parity).toEqual(expectedReleaseReportReference("parity", 2));
    expect(first.logs).toContain(`next: dispatch release-candidate.yml for ${SHA}.`);

    const second = world();
    await ship(second.deps, { dryRun: true, sha: SHA });
    expect(second.logs).toEqual(first.logs);
  });

  it("reports the run that blocks the plan, and a real run refuses to start", async () => {
    const queued = world({ ci: [run(1, "push", { conclusion: "", status: "queued" })] });
    await ship(queued.deps, { dryRun: true, sha: SHA });
    expect(queued.logs).toContain(
      "next: blocked: CI is not green (run 1 is queued); native-platforms is green (run 2).",
    );
    await expect(ship(queued.deps, { dryRun: false, sha: SHA })).rejects.toThrow(
      /TN_SHIP_EVIDENCE/u,
    );
    expect(queued.calls).toEqual([]);
  });

  it("builds only from the commit it ships: a real run needs the checkout, a plan does not", async () => {
    await expect(ship(world().deps, { dryRun: false, sha: OTHER })).rejects.toThrow(
      /TN_SHIP_CHECKOUT/u,
    );
    const { deps, logs } = world({ ci: [run(1, "push", { headSha: OTHER })], native: [] });
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
      tagRuns: [run(20, "push", { headBranch: TAG, status: "in_progress" })],
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
    expect(calls.some((call) => call.startsWith("gh workflow run"))).toBe(false);
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
    expect(acted).toEqual(["candidate", "tag", "publish"]);
    expect(calls.map((call) => call.split(" ").slice(0, 3).join(" "))).toEqual([
      "gh workflow run",
      "git tag -f",
      "git push --force",
      "publish",
    ]);
  });

  it("moves a tag that points at a commit with no release", async () => {
    const { calls, deps } = world({ candidate: [run(10, "workflow_dispatch")], tagCommit: OTHER });
    await ship(deps, { dryRun: false, sha: SHA });
    expect(calls).toContain(`git tag -f ${TAG} ${SHA}`);
  });

  it("skips what is done: a pushed tag and a public release go straight to the publish", async () => {
    const { calls, deps } = world({
      candidate: [run(10, "workflow_dispatch")],
      release: { isDraft: false, isPrerelease: false },
      tagCommit: SHA,
      tagRuns: [run(20, "push", { headBranch: TAG })],
    });
    expect(await ship(deps, { dryRun: false, sha: SHA })).toEqual(["publish"]);
    expect(calls).toEqual(["publish"]);
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
    expect(nextStep({ ...done, tag: { commit: SHA } }, SHA)).toBe("wait");
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
    native: 2,
    npmPublished: false,
    release: "none",
    tag: {},
    tagRun: "none",
  };
}
