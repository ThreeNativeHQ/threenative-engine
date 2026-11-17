# PRD-897 — A release stays unpublished until npm serves its cohort

**Status:** NOT STARTED
**Priority:** P2 — the remaining exposure is narrow: PRD-896 runs the upgrade proof before the tag, so only a *resumed* publish (one that never proved in its own invocation) can still prove after the release is public and burn the version.
**Complexity:** 6 (MEDIUM)
**Owner:** CI tooling
**Depends on:** PRD-896, PRD-630

## Context

PRD-896 moved the upgrade proof in front of the tag, which closes the shape that burned 0.3.14: a
first-pass release now proves before any release exists, and `--upgrade-proved` stops the publish
from proving a second time. Three shapes survive it:

1. **A resumed publish.** `release:ship` resumes at the first step its GitHub state says is not done
   (`nextStep`, `scripts/release-ship.ts:346`). A run that finds the release already public goes
   straight to `publish`, which is `pnpm release --yes --skip-gates --resume` — and that call proves
   after the release is public, because a resume is not the invocation that proved. A red proof
   there still burns the version.
2. **A prerelease that outlives its run.** `native-release.yml:690` creates the release
   `--prerelease`, which is public, before the consumer proofs run; `cleanup-failed-release` deletes
   it when a consumer proof fails, but a cancelled run, or a cleanup job that never runs, leaves the
   public prerelease and no npm cohort.
3. **Nothing public follows npm.** The repository still treats a public release as the version's
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

Close the resume shape first, because it needs no new release state.

### Phase 1 — a resumed publish refuses to prove after the fact

- [ ] A resume on a **fresh runner** has no receipt to read: the proof PRD-896 records lives in the worktree that proved, and `ship` passes `--upgrade-proved` only from its own memory. Persist the proof where a later invocation can read it (an artifact, or release metadata) or make the resume refuse. proof: `scripts/__tests__/release.spec.ts` — a receipt read in a second checkout, and `scripts/__tests__/release-ship.spec.ts` for the plan that refuses when there is none.
- [ ] A plan that reaches `publish` with no proof for its commit stops and says which invocation must prove. proof: `scripts/__tests__/release-ship.spec.ts` — a resume case that refuses, beside the existing green resume. This box depends on the one above it: refusing before the receipt can be read would turn every post-wait rerun into a hard stop.

### Phase 2 — the release becomes an announcement, not a lock

- [ ] A landable sketch of the draft-first order — which reads move to the API, which tokens need `contents: write`, what `finalize` becomes — sized in files and jobs before any of it is written. proof: this PRD gains the sketch, reviewed on its own.

## Acceptance criteria

- [ ] No step of a release can fail after something about the version is public. proof: the phase 1 spec, then one real release: the Actions log shows every gate green before the release exists.

## Decisions

- 2026-11-16 (agent, filing): the draft-first shape is deliberately deferred rather than half-done —
  it moves the prebuilt census, the consumer lanes and promotion at once, and PRD-896 removes the
  first-pass burn without it.

## Blocked on

- The owner's choice between the shapes above before phase 2 (draft-first versus a release that
  simply never gates npm), and one real release to prove either.
