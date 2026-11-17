# PRD-896 — A burned version fails in the first minute, and the upgrade proof runs before anything is public

**Status:** PARTIAL
**Priority:** P1 — one phase box (the develop -> main board gate) is verified only by the next release pull request; until then the new first-minute refusal is wired and tested but unobserved on a real board.
**Complexity:** 4 (LOW-MEDIUM)
**Owner:** CI tooling
**Depends on:** PRD-629, PRD-630

## Context

A version whose git tag already carries a GitHub release, while npm does not serve its
whole cohort, can never ship. `assertTagMovable`
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
   that is public the moment it exists. The publish proves again on purpose: it is the only run that
   sees the real prebuilt release.

### Phase 1 — `release:ship` refuses a burned version before the evidence

- [x] `release:ship` refuses through the same `checkReleaseVersion` the board job runs — one call, before the first state read, reading the release, the tag's commit and how many cohort packages npm serves, and no run list — and `assertVersionNotBurned` names the move that is actually available: a bump (`pnpm release:prepare --bump`), deleting a draft, or, when part of the cohort already reached npm, finishing it from the commit the tag points at. A draft with no tag yet is refused and says so, and deleting a *public* release is never advised. proof: `node_modules/.bin/vitest run scripts/__tests__/release-ship.spec.ts` — 38 passed, including the three release states, the no-tag draft, the "1 of 2 packages" partial-cohort advice, the whole-cohort answer and the prerelease-is-not-a-hand-delete case; the burn cases fail while the call in `ship` is removed.

### Phase 2 — the release pull request's board refuses it in its first minutes

- [x] `pnpm release:check-version` (`scripts/release.ts check-version`) makes the same decision from the tree a release pull request would merge, with the same error and the same instruction. proof: the same spec's `pnpm release:check-version` cases.
- [x] `ci.yml`'s `lint` job — an early job on the required path, gated on a pull request into `main` — runs it before the lint gate, so the release board is red minutes after its first push. proof: `node_modules/.bin/vitest run scripts/__tests__/ci-structure.spec.ts` — 201 passed, including the assertion that pins this step's command, its `github.base_ref == 'main'` condition, its token, and its place before the lint gate. ⚠️ **Wired and pinned, not yet observed**: this pull request targets `develop`, so the step's condition is false here and no run has executed it. The claim that the board goes red belongs to the open acceptance box below. **Two named limits**: a *draft* release is invisible to a `contents: read` token, so `release:ship` (which has write access) is what catches a draft, in its first minute; and a `merge_group` into `main` skips the step, because `github.base_ref` is set only for pull requests and develop -> main merges with an ordinary merge commit.

### Phase 3 — the upgrade proof runs before anything about the version is public

- [x] `pnpm release --prove-upgrade` is a real flag of the publish command: it refuses an uncommitted tree (a proof is a claim about HEAD's bytes) and every flag that would make it report a proof that never ran, and the argv `release:ship` runs is one shared constant with a spec. proof: `node_modules/.bin/vitest run scripts/__tests__/release.spec.ts` — 44 passed (the flag refusals, and the argv case). What the run does end to end is the box below, still open.
- [ ] A real candidate proves end to end through `pnpm release --prove-upgrade` with no release yet: it packs, proves and exits 0 having published nothing. proof: the tag step of the first release after this lands — unrun, so this box stays open.
- [x] `release:ship` proves inside the `tag` step, before the tag is created: a red proof leaves nothing tagged, released, dispatched or published, an admin `--override` keeps its documented skip, a cohort that is already partly on npm is left to its `--resume` publish, and a movable tag stays where it is when the proof is red. proof: `node_modules/.bin/vitest run scripts/__tests__/release-ship.spec.ts` — 38 passed (`proves the upgrade before the tag`, `a red upgrade proof leaves nothing tagged…`, `leaves a movable tag untouched when the upgrade proof is red`, `skips the pre-tag proof when part of the cohort is already on npm`, the override case).

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
- 2026-11-16 (agent, after a review round): a receipt-based reuse of the pre-tag proof — a
  `--upgrade-proved` flag backed by a recorded green proof — was built and then **deleted**. It saved
  one proof run, but it skipped the publish's own proof, which is the *only* run that sees the real
  prebuilt release: a broken prebuilt download would then surface in the clean room after the npm
  upload, and an npm version cannot be taken back. A red proof at the publish costs a version bump and
  publishes nothing, so the extra run is the cheaper mistake. The residue it leaves — a publish that
  proves behind a public release — is PRD-897's first phase.

## Blocked on

- The owner's separate call on the burned `0.3.14` state itself (the public
  `runtime-native-v0.3.14` release and the missing npm cohort). This PRD touches no release, tag or
  registry state, and its pull request merges only after the 0.3.15 release pull request.
