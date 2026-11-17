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
proof here is the publish's own evidence that the tree it is about to upload works, and a reused
receipt would carry a claim about early bytes nobody re-read. What the publish's own proof still
covers, and the pre-tag one cannot, is the real prebuilt download and its checksum: before the tag no
release exists, so `install-prebuilt` only warns and continues, while on publish night it fetches the
public release the candidate install was built against. It also reads a registry `latest` that may
have moved. Four shapes survive it:

1. **Every publish.** `release:ship` waits for a public release and then publishes
   (`pnpm release --yes --skip-gates --resume`), and that call proves again. The proof therefore always runs behind a public
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

### Phase 1 — a red publish proof leaves the version shippable

- [ ] A red publish proof leaves the version shippable: the prerelease `native-release` created is deleted (or stays a draft), so the next ship can prove again on the same version instead of a bump. proof: `scripts/__tests__/release-ship.spec.ts` — a publish that throws leaves nothing public, plus one release whose publish was red and whose version shipped afterwards.
- [ ] The tag run's own cleanup covers it: `cleanup-failed-release` deletes a release whose consumer proof failed, and it must also run when the *publish* is the red step. proof: `native-release.yml`'s cleanup `if:` gains that case, and one run shows the release gone after a red publish.

### Phase 2 — the proof runs on the release pull request, before the merge

- [ ] `ci.yml` gains one job, gated on `github.base_ref == 'main'`, that builds the workspace, prepares the native runtime dependencies and runs `pnpm release --prove-upgrade --skip-gates` against the pull request's tree, publishing nothing; its wall time is measured, with the shared build restored rather than repeated. proof: a green run of that job on a develop -> main pull request, with its timing beside the run.
- [ ] `scripts/ci-change-scope.mjs` marks it required for a pull request into `main`, and a red proof turns the pull request red carrying the proof's own report as an artifact. proof: `scripts/__tests__/ci-needs.spec.ts`, plus one scratch branch whose run is red and carries the report.

## Acceptance criteria

- [ ] A red step after the release is public leaves the version shippable without a bump. proof: the phase 1 spec, then one real release where the publish proof goes red: the next run finishes that version instead of refusing it.

## Decisions

- 2026-11-16 (agent, filing): a cheaper cost is open: `readShipState` and `checkReleaseVersion` each
  read one registry answer per cohort package, so a tag pass pays twice for the same census.
- 2026-11-16 (agent, filing): the draft-first shape is deliberately deferred rather than half-done —
  it moves the prebuilt census, the consumer lanes and promotion at once, and PRD-896 removes the
  first-pass burn without it. A landable sketch of it is the first thing to write if the owner prefers
  that shape to phase 2.

## Known gaps

- The version comes from `--sha` while the cohort comes from the checkout, so a `--dry-run` plan for an
  older commit reads the wrong versions; `readShipState` shares the shape. A census keyed on the commit
  belongs with phase 2.

## Blocked on

- The owner's call on the draft-first shape (recorded under Decisions) before it replaces anything,
  and one real release to prove both phases. Deleting a public prerelease on a red publish touches
  release state, which the owner decides.
- Dropping the publish's re-proof is an option phase 1 should weigh, now that the proof runs before the
  tag: the residue it would leave is a publish that uploads rebuilt bytes nothing re-read, against a
  `latest` that may have moved after the tag was cut. That is the owner's call, not this phase's.
