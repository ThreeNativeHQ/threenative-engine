# PRD-897 — A release stays unpublished until npm serves its cohort

**Status:** NOT STARTED
**Priority:** P2 — the remaining exposure is narrow: PRD-896 runs the upgrade proof before the tag, so only a *resumed* publish (one that never proved in its own invocation) can still prove after the release is public and burn the version.
**Complexity:** 6 (MEDIUM)
**Owner:** CI tooling
**Depends on:** PRD-896, PRD-630

## Context

PRD-896 moved the upgrade proof in front of the tag, which closes the shape that burned 0.3.14: a
first-pass release now proves before any release exists, and `--upgrade-proved` stops the publish
from proving a second time. Two shapes survive it:

1. **A resumed publish.** `release:ship` resumes at the first step its GitHub state says is not done
   (`nextStep`, `scripts/release-ship.ts:346`). A run that finds the release already public goes
   straight to `publish`, which is `pnpm release --yes --skip-gates --resume` — and that call proves
   after the release is public. A red proof there still burns the version.
2. **Nothing public follows npm.** The repository still treats a public release as the version's
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

- [ ] A plan that reaches `publish` without having proved stops and says which invocation must prove, instead of proving behind a public release. proof: `scripts/__tests__/release-ship.spec.ts` — a resume case that refuses, beside the existing green resume.
- [ ] The tag-day record that a proof passed is readable by the plan that resumes, so a genuine resume names the proof it is relying on (`gh` read of a recorded artifact or the tag run's summary). proof: the same spec, plus the file or run field it reads.

### Phase 2 — the release becomes an announcement, not a lock

- [ ] A landable sketch of the draft-first order — which reads move to the API, which tokens need `contents: write`, what `finalize` becomes — sized in files and jobs before any of it is written. proof: this PRD gains the sketch, reviewed on its own.

## Acceptance criteria

- [ ] No step of a release can fail after something about the version is public. proof: the phase 1 spec, then one real release: the Actions log shows every gate green before the release exists.

## Decisions

- 2026-11-16 (agent, filing): the draft-first shape is deliberately deferred rather than half-done —
  it moves the prebuilt census, the consumer lanes and promotion at once, and PRD-896 removes the
  first-pass burn without it.

## Blocked on

- The owner's choice between the two shapes above before phase 2 (draft-first versus a release that
  simply never gates npm), and one real release to prove either.
