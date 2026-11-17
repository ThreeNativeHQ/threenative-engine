# PRD-897 — A release stays unpublished until npm serves its cohort

**Status:** NOT STARTED
**Priority:** P2 — PRD-896 runs the upgrade proof before the tag, but every publish still proves **after** `native-release` has made the version's prerelease public, so a red there (a flake, or a registry `latest` that moved during the release's waits) still burns the version. Phase 2 is the other half of the same complaint: the proof still runs only after the merge.
**Complexity:** 6 (MEDIUM)
**Owner:** CI tooling
**Depends on:** PRD-896, PRD-630

## Context

PRD-896 moved the upgrade proof in front of the tag, which closes the shape that burned 0.3.14: a
first-pass release now proves before any release exists. It deliberately did **not** add a way for the
publish to skip its own proof — a receipt-backed reuse was built and deleted in review, because the
publish's proof is the only run that sees the real prebuilt release. Four shapes survive it:

1. **Every publish.** `release:ship` waits for a public release and then publishes
   (`pnpm release --yes --skip-gates --resume`), and that call proves again — necessarily, since it is
   the run that sees the real prebuilt release. The proof therefore always runs behind a public
   prerelease: a flake, a moved `latest`, or a network blip there burns the version, first push
   included. This is the shape to close.
2. **A prerelease that outlives its run.** `native-release.yml:690` creates the release
   `--prerelease`, which is public, before the consumer proofs run; `cleanup-failed-release` deletes
   it when a consumer proof fails, but a cancelled run, or a cleanup job that never runs, leaves the
   public prerelease and no npm cohort.
3. **A registry `latest` that moves mid-release.** The publish proves against whatever `latest` is at
   publish time. A release's waits total up to about 190 minutes, so an N-1 that moved during them is
   proved against a different starting point than the pre-tag proof — and the publish's red is the
   expensive one, because it lands behind the public release.
4. **A partial cohort that a missed bump left, not a crash.** `release:ship` skips the pre-tag proof
   when *any* package of the cohort is already on npm, because that is a crash a `--resume` publish
   finishes. It cannot tell that from a version whose packages were published earlier without a bump;
   for the second, the publish's `unpublishedReleasePackages` then refuses with
   `TN_RELEASE_COHORT_PARTIAL` after the release is already public. Telling the two apart needs the
   same published-before-the-commit-date test `--resume` already applies.
5. **Nothing public follows npm.** The repository still treats a public release as the version's
   announcement while npm may be minutes or hours behind it.

Why the obvious flip — create the release as a draft and promote it after the npm upload — is not a
small change:

- The npm publish preflight **requires** the public prebuilt release. `prebuiltReleaseCensus`
  (`scripts/check-publish-state.ts:457`) probes the release's public manifest URL and fails the
  publish when it is absent, so a draft would fail the cohort it is supposed to unblock.
- The release's own consumer proofs download their assets from the public release URL with
  `contents: read`. A draft release is invisible to a token that cannot write to the repository —
  the constraint `npm-dry-run` pays for with `contents: write` on the rehearsal draft.
- Promotion is read as the verdict in several places (`finalize` in `native-release.yml` flips
  `--prerelease=false --latest` after the consumer proofs), so its meaning moves with it.

## Solution

Close the resume shape first, because it needs no new release state. Phase 2 is the other half of
"do not waste an hour": the same proof, run on the release pull request before the merge, so an
upgrade regression is red before a merge instead of after it.

### Phase 1 — a red publish proof leaves the version shippable

- [ ] A red publish proof leaves the version shippable: the prerelease `native-release` created is deleted (or stays a draft), so the next ship can prove again on the same version instead of a bump. proof: `scripts/__tests__/release-ship.spec.ts` — a publish that throws leaves nothing public, plus one release whose publish was red and whose version shipped afterwards.
- [ ] The tag run's own cleanup covers it: `cleanup-failed-release` deletes a release whose consumer proof failed, and it must also run when the *publish* is the red step. proof: `native-release.yml`'s cleanup `if:` gains that case, and one run shows the release gone after a red publish.

### Phase 2 — the proof runs on the release pull request, before the merge

- [ ] `ci.yml` gains one job, gated on `github.base_ref == 'main'`, that builds the workspace, prepares the native runtime dependencies and runs `pnpm release --prove-upgrade --skip-gates` against the pull request's tree, publishing nothing; its wall time is measured, with the shared build restored rather than repeated. proof: a green run of that job on a develop -> main pull request, with its timing beside the run.
- [ ] `scripts/ci-change-scope.mjs` marks it required for a pull request into `main`, and a red proof turns the pull request red carrying the proof's own report as an artifact. proof: `scripts/__tests__/ci-needs.spec.ts`, plus one scratch branch whose run is red and carries the report.

## Acceptance criteria

- [ ] No step of a release can fail after something about the version is public. proof: the phase 1 spec, then one real release: the Actions log shows every gate green before the release exists.

## Decisions

- 2026-11-16 (agent, filing): shape 4 is out of scope here because it needs `--resume`'s published-at
  test moved into the plan, which is the same redesign phase 1 is about. A cheaper cost is also open:
  `readShipState` and the tag step each read one registry answer per cohort package, so a tag pass
  pays twice for the same census.
- 2026-11-16 (agent, filing): the draft-first shape is deliberately deferred rather than half-done —
  it moves the prebuilt census, the consumer lanes and promotion at once, and PRD-896 removes the
  first-pass burn without it. A landable sketch of it is the first thing to write if the owner prefers
  that shape to phase 2.

## Blocked on

- The owner's call on the draft-first shape (recorded under Decisions) before it replaces anything,
  and one real release to prove both phases. Deleting a public prerelease on a red publish touches
  release state, which the owner decides.
- Phase 2's lane is reported red for two reasons owned by the release branch (`release-0315`), neither
  of them visible in this repository at the time of filing and both **unverified here**: the clean
  room's 15 s `--server-timeout` against a ~21 s cold asset cook, and the reinvention lint rows of
  2026-11-13 rejecting 0.3.13-generated code. That lane's owner decides when both are green.
