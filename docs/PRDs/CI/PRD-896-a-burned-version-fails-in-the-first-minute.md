# PRD-896 — A burned version fails in the first minute, and the upgrade proof runs before anything is public

**Status:** PARTIAL
**Priority:** P1 — one phase box (the develop -> main board gate) is verified only by the next release pull request; until then the new first-minute refusal is wired and tested but unobserved on a real board.
**Complexity:** 4 (LOW-MEDIUM)
**Owner:** CI tooling
**Depends on:** PRD-629, PRD-630

## Context

A version whose git tag already carries a GitHub release, while npm serves no
`@threenative/core` of that version, can never ship. `assertTagMovable`
(`scripts/release-ship.ts:351`) refuses to move a tag that has any release, draft or public, and
`nextStep` only skips the tag step when that tag already sits on the commit being shipped
(`scripts/release-ship.ts:340`). With npm empty there is nothing to resume — the only move the
repository has is a version bump, and nothing said so until the last step of a long road.

Two releases burned on this, verified through the Actions API and the repository state:

- **2026-11-12**, npm-release run 43294207203 shipped main `f2741d85` as 0.3.14. It tagged
  `runtime-native-v0.3.14`, the native-release run made that release public at 20:01:59Z, and only
  then did the publish step's upgrade check fail: `TN_RELEASE_UPGRADE_RED` — "a game on the previous
  latest does not upgrade onto this candidate. Nothing was published." A public 0.3.14 release, no
  `@threenative/core@0.3.14` on npm. The proof is the last gate before the first npm upload, and it
  ran after the release was already public.
- **2026-11-16**, release PR #676 (develop -> main) ran the full board, about an hour, merged as
  `75dc4082`. npm-release run 43977377921 then spent evidence plus a roughly 20-minute
  release-candidate run, and failed at the `tag` step: `TN_SHIP_TAG_HAS_RELEASE`. Nothing had told
  anyone before the merge.

## Solution

Three parts, one rule each:

1. Read the burn's three facts — the release on the tag, the commit the tag points at, and whether
   npm serves `@threenative/core` at the version — and refuse in `release:ship`'s first minute with
   the fix named. One shared `assertVersionNotBurned`, so the two call sites cannot disagree.
2. Run the same decision on the release pull request's own early board job, so a burned version is
   red before the merge instead of after it.
3. Prove the previous `latest` upgrades onto the candidate **before** the tag creates the release
   that is public the moment it exists, and let the publish that follows reuse that proof.

### Phase 1 — `release:ship` refuses a burned version before the evidence

- [x] `readShipState` answers `corePublished` for this tree's version from the same memoised registry reads as `npmPublished`, and `assertVersionNotBurned` refuses a release at another commit with no core on npm, naming the bump as the fix. proof: `node_modules/.bin/vitest run scripts/__tests__/release-ship.spec.ts` — 34 passed, and the four burn tests fail while the call in `ship` is removed.
- [x] `release:ship` calls it on the first state read, before the evidence and before the candidate: a burned version dispatches nothing, reads no candidate run, and never names a plan step. proof: the same spec's `refuses a version whose tag already has …` and `says what to do about a burned version, and a plan reports it too` cases.

### Phase 2 — the release pull request's board refuses it in its first minutes

- [x] `pnpm release:check-version` (`scripts/release.ts check-version`) makes the same decision from the tree a release pull request would merge, with the same error and the same instruction. proof: the same spec's `pnpm check:release-version` cases.
- [x] `ci.yml`'s `lint` job — an early job on the required path, gated on a pull request into `main` — runs it before the lint gate, so the release board is red minutes after its first push. proof: `node_modules/.bin/vitest run scripts/__tests__/ci-structure.spec.ts scripts/__tests__/ci-needs.spec.ts` green (335 passed across the four related specs), and the same run parses the workflow.

### Phase 3 — the upgrade proof runs before anything about the version is public

- [x] `pnpm release --prove-upgrade` packs the cohort and proves the previous `latest` upgrades onto it, publishing, tagging and releasing nothing; `--upgrade-proved` tells the publish that follows to reuse that proof instead of spending the browser lanes twice, and `--prove-upgrade` beside `--yes` refuses. proof: `node_modules/.bin/vitest run scripts/__tests__/release.spec.ts` — 39 passed (`upgradeProofApplies`, and the CLI conflict case).
- [x] `release:ship` proves inside the `tag` step, before the tag is created: a red proof leaves nothing tagged, released, dispatched or published, an admin `--override` keeps its documented skip, and a resumed plan never tells the publish it proved something it did not. proof: `node_modules/.bin/vitest run scripts/__tests__/release-ship.spec.ts` — 33 passed (`proves the upgrade before the tag`, `a red upgrade proof leaves nothing tagged…`, `a resumed plan that never proved…`, the override case).

## Acceptance criteria

- [x] A burned version stops `release:ship` in its first minute: no evidence read, no release-candidate dispatch, one error naming the bump. proof: the spec above plus the transcript in the pull request — `pnpm release:check-version` on this repository's own state, exit 1, naming `f2741d85` and the missing `@threenative/core@0.3.14`; `pnpm release:ship --dry-run` on the same state refuses with the same error before it reads any run.
- [ ] The develop -> main release pull request is red on its own board before the merge, so a burned version never reaches `main`. proof: the first develop -> main pull request opened after this lands — unrun, so this box stays open.

## Decisions

- 2026-11-16 (agent, per the owner's brief and the orchestrator's "Part B matters most"): the
  fail-fast gate and the proof-before-the-tag ordering both land here. Keeping the release a draft
  until npm serves the cohort is **not** attempted: the npm publish preflight requires the public
  prebuilt release (`scripts/check-publish-state.ts:457`), and the consumer lanes read public asset
  URLs, so that shape reaches further into the release path than the burn does. Its residue — a
  resumed publish still proves after the release is public — is filed as PRD-897.
- 2026-11-16 (agent): the proof runs twice unless told otherwise. `release:ship` passes
  `--upgrade-proved` only when the same invocation proved before the tag, and that flag refuses
  without a receipt for the shipped commit, so a resumed plan (which never proved) keeps proving at
  the publish exactly as before. Cost: one proof per release, not two.

## Blocked on

- The owner's separate call on the burned `0.3.14` state itself (the public
  `runtime-native-v0.3.14` release and the missing npm cohort). This PRD touches no release, tag or
  registry state, and its pull request merges only after the 0.3.15 release pull request.
