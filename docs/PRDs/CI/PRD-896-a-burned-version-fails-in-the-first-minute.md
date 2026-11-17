# PRD-896 — A burned version fails in the first minute, and the upgrade proof runs before anything is public

**Status:** PARTIAL
**Priority:** P1 — one phase box (the develop -> main board gate) is verified only by the next release pull request; until then the new first-minute refusal is wired and tested but unobserved on a real board.
**Complexity:** 4 (LOW-MEDIUM)
**Owner:** CI tooling
**Depends on:** PRD-629, PRD-630

## Context

A version whose git tag already carries a GitHub release, while npm serves no
`@threenative/core` of that version, can never ship. `assertTagMovable`
(`assertTagMovable`, `scripts/release-ship.ts`) refuses to move a tag that has any release, draft or
public, and `nextStep` only skips the tag step when that tag already sits on the commit being
shipped. With npm empty there is nothing to resume — the only move the
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

- [x] `release:ship` refuses through the same `checkReleaseVersion` the board job runs — one call, before the first state read, reading three facts (the release, the tag's commit, core's npm versions) and no run list — and `assertVersionNotBurned` names the move that is actually available: a bump, deleting a draft, or deleting a prerelease the tag run deletes on a rerun. A draft with no tag yet is refused and says so. proof: `node_modules/.bin/vitest run scripts/__tests__/release-ship.spec.ts` — 35 passed, including the three release states, the no-tag draft, the prerelease advice and the npm-already-serves case; the burn cases fail while the call in `ship` is removed.

### Phase 2 — the release pull request's board refuses it in its first minutes

- [x] `pnpm release:check-version` (`scripts/release.ts check-version`) makes the same decision from the tree a release pull request would merge, with the same error and the same instruction. proof: the same spec's `pnpm release:check-version` cases.
- [x] `ci.yml`'s `lint` job — an early job on the required path, gated on a pull request into `main` — runs it before the lint gate, so the release board is red minutes after its first push. proof: `node_modules/.bin/vitest run scripts/__tests__/ci-structure.spec.ts` — 201 passed, including the assertion that pins this step's command, its `github.base_ref == 'main'` condition, its token, and its place before the lint gate. **Two named limits**: a *draft* release is invisible to a `contents: read` token, so `release:ship` (which has write access) is what catches a draft, in its first minute; and a `merge_group` into `main` skips the step, because `github.base_ref` is set only for pull requests and develop -> main merges with an ordinary merge commit.

### Phase 3 — the upgrade proof runs before anything about the version is public

- [x] `pnpm release --prove-upgrade` packs the cohort and proves the previous `latest` upgrades onto it, publishing, tagging and releasing nothing. It refuses to run on an uncommitted tree, refuses a candidate that has nothing left to prove, records a receipt for the commit it proved (git-ignored) after clearing any older one, and `--upgrade-proved` refuses without a receipt for HEAD and consumes it once. proof: `node_modules/.bin/vitest run scripts/__tests__/release.spec.ts` — 49 passed (`upgradeProofApplies`, the refusal, the receipt's lifecycle, the seven flag refusals, the receipt refusal, and the flag-name drift case). **Not proven**: the run itself has never executed end to end — it is the same pack-and-prove code `--yes` runs before its first upload, but its prebuilt-release acknowledgement is one branch no run has exercised. The box below is that claim.
- [ ] A real candidate proves end to end through `pnpm release --prove-upgrade` with no release yet: it packs, proves and exits 0 having published nothing, and the release that follows reuses the receipt. proof: the tag step of the first release after this lands — unrun, so this box stays open.
- [x] `release:ship` proves inside the `tag` step, before the tag is created: a red proof leaves nothing tagged, released, dispatched or published, an admin `--override` keeps its documented skip, and a resumed plan never tells the publish it proved something it did not. proof: `node_modules/.bin/vitest run scripts/__tests__/release-ship.spec.ts` — 35 passed (`proves the upgrade before the tag`, `a red upgrade proof leaves nothing tagged…`, `a resumed plan that never proved…`, the override case).

## Acceptance criteria

- [x] A burned version stops `release:ship` in its first minute: no evidence read, no release-candidate dispatch, one error naming the bump. proof: the spec above plus the transcript in the pull request — `pnpm release:check-version` on this repository's own state, exit 1, naming `f2741d85` and the missing `@threenative/core@0.3.14`; `pnpm release:ship --dry-run` on the same state refuses with the same error before it reads any run. Combined run of the four specs: 346 passed.
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
