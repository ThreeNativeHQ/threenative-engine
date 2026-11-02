import { describe, expect, it } from "vitest";

const { findProof, passedProof } = await import(
  new URL("../native-release-reuse.mjs", import.meta.url).href
);

const SHA = "a".repeat(40);
const HEAD = "b".repeat(40);
const TESTED = "c".repeat(40);
const GREEN = [
  "build (linux-x64, true)",
  "build (win32-x64, true)",
  "build-android",
  "build-ios-simulator",
  "publish",
  "clean-consumer",
  "clean-consumer-windows",
  "finalize",
].map((name) => ({ name, conclusion: "success" }));

function reader({
  parents = [{ sha: "d".repeat(40) }, { sha: HEAD }],
  runs = [{ id: 7, run_number: 1 }],
  jobs = GREEN as { name: string; conclusion: string }[],
  testedTree = "tree",
} = {}) {
  return {
    api: (route: string) => {
      if (route.startsWith("commits/")) return { parents };
      if (route.startsWith("actions/workflows/")) {
        expect(route).toContain(`head_sha=${HEAD}`);
        expect(route).toContain("event=pull_request");
        return { workflow_runs: runs };
      }
      return { jobs };
    },
    identityOf: () => ({ candidateSha: TESTED }),
    treeOf: (sha: string) => (sha === TESTED ? testedTree : "tree"),
  };
}

describe("PRD-630 the tag run finds the promotion proof of its tree", () => {
  it("returns the proof when it passed and tested this tree", () => {
    expect(findProof(SHA, reader())).toEqual({ runId: 7 });
  });

  it("returns the newest of two proofs", () => {
    const runs = [
      { id: 7, run_number: 1 },
      { id: 8, run_number: 2 },
    ];
    expect(findProof(SHA, reader({ runs }))).toEqual({ runId: 8 });
  });

  it("builds when the tag commit is no merge", () => {
    expect(findProof(SHA, reader({ parents: [{ sha: HEAD }] })).reason).toContain(
      "not a promotion",
    );
  });

  it("builds when no proof exists", () => {
    expect(findProof(SHA, reader({ runs: [] })).reason).toContain("no green proof");
  });

  it("builds when the proof tested another tree, because main moved", () => {
    expect(findProof(SHA, reader({ testedTree: "other" })).reason).toContain("no green proof");
  });

  it.each(["build (win32-x64, true)", "clean-consumer", "finalize"])(
    "builds when the proof's %s job is red",
    (name) => {
      const jobs = GREEN.map((job) => (job.name === name ? { name, conclusion: "failure" } : job));
      expect(findProof(SHA, reader({ jobs })).reason).toContain("no green proof");
    },
  );

  it("does not take a run that never reached a job as a pass", () => {
    expect(passedProof(GREEN.filter((job) => job.name !== "publish"))).toBe(false);
  });

  it("ignores the iOS consumer job, which is evidence and does not gate", () => {
    expect(passedProof([...GREEN, { name: "clean-consumer-ios", conclusion: "failure" }])).toBe(
      true,
    );
  });
});
