/**
 * A workflow artifact is the only GitHub store with no ref scope, so it is how a V8 payload one run
 * built reaches a pull request's later run (PRD-628). It is also writable by every run, a fork's
 * pull request run included, so the reader must trust a head repository and a branch, never the
 * newest artifact alone.
 */

import { describe, expect, it } from "vitest";

import {
  ARTIFACT_MALFORMED,
  ARTIFACT_NO_BRANCHES,
  artifactsOf,
  pickPublishedArtifact,
} from "../scripts/v8-artifact-pick.mjs";

const REPOSITORY = 903897353;

function artifact(
  id: number,
  options: {
    readonly created?: string;
    readonly expired?: boolean;
    readonly headRepository?: number;
    readonly branch?: string;
  } = {},
) {
  return {
    id,
    name: "v8-android-6d7f399f",
    expired: options.expired ?? false,
    created_at: options.created ?? "2026-11-03T00:00:00Z",
    workflow_run: {
      id,
      repository_id: REPOSITORY,
      head_repository_id: options.headRepository ?? REPOSITORY,
      head_branch: options.branch ?? "goal/628",
    },
  };
}

describe("the published V8 payload picker", () => {
  it("picks the newest artifact this repository published on a trusted branch", () => {
    const picked = pickPublishedArtifact(
      {
        total_count: 3,
        artifacts: [
          artifact(1, { created: "2026-11-01T00:00:00Z" }),
          artifact(3, { created: "2026-11-03T00:00:00Z" }),
          artifact(2, { created: "2026-11-02T00:00:00Z" }),
        ],
      },
      "main develop goal/628",
    );
    expect(picked).toEqual({
      runId: 3,
      headBranch: "goal/628",
      createdAt: "2026-11-03T00:00:00Z",
    });
  });

  it("refuses an artifact a fork's run published, even on this pull request's branch", () => {
    // A fork's pull request run uploads into this repository's store, so only the head repository
    // tells its bytes apart from one this repository built.
    const fork = artifact(7, { headRepository: 1234, created: "2026-11-04T00:00:00Z" });
    const own = artifact(8, { created: "2026-11-03T00:00:00Z" });
    expect(pickPublishedArtifact({ artifacts: [fork, own] }, "main develop goal/628")?.runId).toBe(
      8,
    );
    expect(pickPublishedArtifact({ artifacts: [fork] }, "main develop goal/628")).toBeNull();
  });

  it("refuses a branch that is not main, develop or this pull request's own", () => {
    const otherPullRequest = artifact(9, { branch: "goal/999", created: "2026-11-04T00:00:00Z" });
    const merged = artifact(10, { branch: "develop", created: "2026-11-02T00:00:00Z" });
    expect(
      pickPublishedArtifact({ artifacts: [otherPullRequest, merged] }, "main develop goal/628")
        ?.runId,
    ).toBe(10);
  });

  it("refuses an expired artifact", () => {
    expect(
      pickPublishedArtifact(
        { artifacts: [artifact(11, { expired: true })] },
        "main develop goal/628",
      ),
    ).toBeNull();
  });

  it("takes either the response object or its array, and answers nothing when neither qualifies", () => {
    expect(artifactsOf({ artifacts: [artifact(12)] })).toHaveLength(1);
    expect(pickPublishedArtifact([artifact(12)], "goal/628")?.runId).toBe(12);
    expect(pickPublishedArtifact({ artifacts: [] }, "goal/628")).toBeNull();
  });

  it("refuses an artifact whose repository ids are missing, because two missing ids compare equal", () => {
    // `head_repository_id !== repository_id` passed when the API answered without either field:
    // undefined equals undefined, so an artifact of unknown origin read as this repository's own.
    const noRepository = artifact(14);
    (noRepository.workflow_run as { repository_id?: number }).repository_id = undefined;
    expect(() => pickPublishedArtifact({ artifacts: [noRepository] }, "main")).toThrow(
      ARTIFACT_MALFORMED,
    );
    const noHead = artifact(15);
    (noHead.workflow_run as { head_repository_id?: number }).head_repository_id = undefined;
    expect(() => pickPublishedArtifact({ artifacts: [noHead] }, "main")).toThrow(
      ARTIFACT_MALFORMED,
    );
    // A string id is the same defect with a different spelling.
    const stringIds = artifact(16);
    (stringIds.workflow_run as { repository_id?: number | string }).repository_id = "903897353";
    (stringIds.workflow_run as { head_repository_id?: number | string }).head_repository_id =
      "903897353";
    expect(() => pickPublishedArtifact({ artifacts: [stringIds] }, "main")).toThrow(
      ARTIFACT_MALFORMED,
    );
  });

  it("fails closed on a list it cannot reason about, instead of reading it as no artifact", () => {
    // Every branch trusted is not a default this can take: the caller has to name them.
    expect(() => pickPublishedArtifact({ artifacts: [artifact(1)] }, "  ")).toThrow(
      ARTIFACT_NO_BRANCHES,
    );
    expect(() => pickPublishedArtifact({ nope: true }, "main")).toThrow(ARTIFACT_MALFORMED);
    expect(() =>
      pickPublishedArtifact({ artifacts: [{ id: 13, expired: false }] }, "main"),
    ).toThrow(ARTIFACT_MALFORMED);
  });
});
