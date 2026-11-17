# PRD-897 — A release stays unpublished until npm serves its cohort

**Status:** NOT STARTED
**Priority:** P2 — the remaining exposure is narrow: PRD-896 runs the upgrade proof before the tag, so only a publish that never proved in its own invocation can still prove behind a public release — a *resumed* run, or one whose registry `latest` moved during the release's waits. Phase 2 is the other half of the same complaint: today the proof still runs only after the merge.
**Complexity:** 6 (MEDIUM)
**Owner:** CI tooling
**Depends on:** PRD-896, PRD-630

## Context

PRD-896 moved the upgrade proof in front of the tag, which closes the shape that burned 0.3.14: a
first-pass release now proves before any release exists, and `--upgrade-proved` stops the publish
from proving a second time. Three shapes survive it:

1. **A resumed publish.** `release:ship` resumes at the first step its GitHub state says is not done
   (`nextStep`, `scripts/release-ship.ts`). A run that finds the release already public goes
   straight to `publish`, which is `pnpm release --yes --skip-gates --resume` — and that call proves
   after the release is public, because a resume is not the invocation that proved. A red proof
   there still burns the version.
2. **A prerelease that outlives its run.** `native-release.yml:690` creates the release
   `--prerelease`, which is public, before the consumer proofs run; `cleanup-failed-release` deletes
   it when a consumer proof fails, but a cancelled run, or a cleanup job that never runs, leaves the
   public prerelease and no npm cohort.
3. **A registry `latest` that moves mid-release.** The proof is about the `latest` of the moment it
   ran. A release's waits total up to about 190 minutes, so a run that proves and then waits can find
   its receipt stale, and the publish proves again — behind the public release (PRD-896's receipt
   records `latest` for exactly this reason, and a mismatch means prove again).
4. **Nothing public follows npm.** The repository still treats a public release as the version's
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

### Phase 1 — a resumed publish refuses to prove after the fact

- [ ] A resume on a **fresh runner** has no receipt to read: the proof PRD-896 records lives in the worktree that proved, and `ship` passes `--upgrade-proved` only from its own memory. Persist the proof where a later invocation can read it (an artifact, or release metadata) or make the resume refuse. proof: `scripts/__tests__/release.spec.ts` — a receipt read in a second checkout, and `scripts/__tests__/release-ship.spec.ts` for the plan that refuses when there is none.
- [ ] A plan that reaches `publish` with no proof for its commit stops and says which invocation must prove. proof: `scripts/__tests__/release-ship.spec.ts` — a resume case that refuses, beside the existing green resume. This box depends on the one above it: refusing before the receipt can be read would turn every post-wait rerun into a hard stop.

### Phase 2 — the proof runs on the release pull request, before the merge

- [ ] `ci.yml` gains one job, gated on `github.base_ref == 'main'`, that builds the workspace, prepares the native runtime dependencies and runs `pnpm release --prove-upgrade --skip-gates` against the pull request's tree, publishing nothing; its wall time is measured, with the shared build restored rather than repeated. proof: a green run of that job on a develop -> main pull request, with its timing beside the run.
- [ ] `scripts/ci-change-scope.mjs` marks it required for a pull request into `main`, and a red proof turns the pull request red carrying the proof's own report as an artifact. proof: `scripts/__tests__/ci-needs.spec.ts`, plus one scratch branch whose run is red and carries the report.

## Acceptance criteria

- [ ] No step of a release can fail after something about the version is public. proof: the phase 1 spec, then one real release: the Actions log shows every gate green before the release exists.

## Decisions

- 2026-11-16 (agent, filing): the draft-first shape is deliberately deferred rather than half-done —
  it moves the prebuilt census, the consumer lanes and promotion at once, and PRD-896 removes the
  first-pass burn without it. A landable sketch of it is the first thing to write if the owner prefers
  that shape to phase 2.

## Blocked on

- The owner's call on the draft-first shape (recorded under Decisions) before it replaces anything,
  and one real release to prove both phases.
- Phase 2's lane is currently red for two reasons owned by the release branch, not by this file: the
  clean room's 15 s `--server-timeout` against a ~21 s cold asset cook
  (`scripts/verify-registry-install.ts` is getting `--server-timeout 120000`), and the reinvention
  lint rows of 2026-11-13 rejecting 0.3.13-generated code (`create-threenative`'s `qualityConfig` is
  getting an opt-in `reinventions` flag).
