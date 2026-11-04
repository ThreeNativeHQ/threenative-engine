// Types for `v8-artifact-pick.mjs`. It is plain JavaScript because the workflow runs it through
// Node directly; only what a caller reads is declared here. The artifact JSON is the GitHub API's,
// read field by field inside the script, so it is not re-declared as a type.

/** The API answered with something this filter cannot reason about. */
export declare const ARTIFACT_MALFORMED: string;

/** A caller named no trusted branch, which would make every branch trusted. */
export declare const ARTIFACT_NO_BRANCHES: string;

/** One artifact a run may download. */
export interface IPickedArtifact {
  readonly runId: number;
  readonly headBranch: string | undefined;
  readonly createdAt: string;
}

/** The artifacts list, whether the caller kept the response object or its array. */
export declare function artifactsOf(payload: unknown): readonly unknown[];

/** The newest artifact `branches` (space-separated) and this repository trust, or `null`. */
export declare function pickPublishedArtifact(
  payload: unknown,
  branches: string,
): IPickedArtifact | null;
