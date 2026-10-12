# PRD-550 — A change merges within 30 minutes of its last push

**Status:** NOT STARTED
**Priority:** P1 — AC-1 to AC-3 are open: a green code PR takes 2 to 15 hours to merge, which blocks every lane in the repository.
**Complexity:** 5 (MEDIUM) — 6–10 files (2), merge-queue concurrency (+2), GitHub API (+1); risk override → HIGH, because a wrong gate lets a red tree land on `develop`.
**Owner:** João (decisions), agent (implementation)
**Depends on:** PRD-480 (runner pool), PRD-481 (tree reuse, merge queue)

## Context

Measured from 253 workflow runs created 2026-10-08T04:30Z to 2026-10-09T04:30Z (`gh run list` and
`gh api .../runs/<id>/jobs`, 88 completed `CI` runs, 1,794 jobs, 10,825 runner-minutes).

**End-to-end time today.** A code PR runs the board twice in sequence: once as `pull_request`, once as
`merge_group`. Each successful board takes 52–86 min of wall time (merge group median 75 min, PR median 76 min).

| Merged PR | Enqueue → merge | Merge-queue attempts |
|---|---|---|
| #461 | 104 min | fail, success |
| #462 | 243 min | fail ×3, cancelled ×2 |
| #457 | 433 min | success, fail ×2, success |
| #449 | 594 min | success, fail ×5, cancelled |
| #455 | 627 min | success, fail, success |
| #456 | 892 min | cancelled, fail ×7, cancelled |
| #465 (docs only) | 132 min | fail, cancelled ×2 |

**Four causes, in order of cost.**

1. **Merge groups fail 62% of the time** (23 of 37). Each failure costs a full 75 min re-run. With
   `max_entries_to_build: 2`, a failure ahead also restarts the entry behind it, so one red group
   costs two boards. First failing job per red group: `integration / auto-exposure` 7, `test` 3,
   `test-unit` 5, `macOS desktop core` 2, others 1 each. The signatures that repeat across
   unrelated PRs are load-sensitive, not code-sensitive:
   - `integration / auto-exposure`: `Resource wait for 'state.sampleFrames' timed out after 60011 ms … last observation 178`
     (178 of 180 frames). The frame budget is a wall-clock wait on a loaded software-GPU runner.
   - `integration / velocity`: `TN_PLAYTEST_RESOURCE_ASSERTION_FAILED … 'p95NoiseExcessMs'`. A
     frame-time noise gate runs on a shared runner (`examples/abyss-framework/playtests/velocity-cost.playtest.json`).
   - `test-unit`: `Test timed out in 60000ms` (7×, e.g. `template-assets-compile-1.spec.ts > rts assets`),
     plus repeated reds in `world-gpu-scene.spec.ts` (9), `check-capability-docs.spec.ts` (8) and
     `create-threenative/__tests__/build.spec.ts` (8). Phase 1 separates real reds from load reds.
2. **Jobs wait for a runner longer than they run.** Hosted queue wait: median 5.5 min, p75 20 min,
   p90 41 min. In successful merge groups, template legs waited 40–62 min to run for 2–17 min. A
   full board is 350–390 runner-minutes but gets only 4.3–5.9 effective slots (work ÷ wall). The
   organization is on the GitHub **free** plan (20 concurrent hosted jobs, shared by every run).
   At 2026-10-09T04:30Z `TN_RUNNER` was unset, so the five heavy `tn-local` slots took no heavy jobs.
3. **Merge groups run the exhaustive board, including docs-only PRs.** `scripts/ci-change-scope.mjs:571`
   lists `test-unit`, `integration`, `template-nonvisual`, `golden-path-template` and `native-platforms`
   in `UNPROVEN_REUSE_BOARDS`. `test-unit` is required on every run, so tree reuse never fires: every
   merge group logs `tree reuse unavailable: required matrix/reusable board test-unit has no authoritative complete expansion and routing`.
   Merge groups used 5,837 of the 10,825 runner-minutes.
4. **Slow native legs sit on the merge path.** Median run time: Windows desktop core 42.4 min, Android
   emulator visual parity 30.8, iOS simulator 23.6, macOS desktop core 20.4, desktop web/native parity
   17.2, `template-nonvisual (shooter)` 17.0. Windows alone is longer than the 30 min goal.

**What fits in 30 min.** The gating core is short. Median run times: scope 0.9, `build-artifacts` 2.3,
`test-unit` shards 3.5–6.2, `test-browser` 5.1, `test` 3.9, `test-playtest` 3.4, `golden-path-template`
2.3–4.1, `typecheck` 0.9, `lint` 0.6, `budgets` 1.1. Its critical path is about 12 min and its total
work is about 45 runner-minutes.

## Solution

Gate the merge on one short board, run it once, and keep it green. Move exhaustive qualification
to the place that already owns it: the `develop → main` promotion and the nightly run.

```mermaid
flowchart LR
  P["push to PR"] --> F["PR board<br/>scope-selected, ≤ 12 min"]
  F --> Q["merge queue"]
  Q --> R{"exact tree<br/>already green?"}
  R -- yes --> M["merge, ≤ 2 min"]
  R -- no --> G["gating board<br/>≤ 15 min"]
  G --> M
  M --> D["develop push:<br/>native matrix, all templates,<br/>perf lanes (post-merge)"]
  D -- red --> I["issue + revert PR<br/>(ci-janitor)"]
  D --> N["develop → main:<br/>full qualification (unchanged)"]
```

Time budget for AC-1: PR board ≤ 12 min, queue entry and scope ≤ 3 min, gating board ≤ 15 min.

**Phase 1 — no load reds in the gate.** Make the three load-sensitive gates count frames, not wall
time, or move them off the gating board. A frame-time noise threshold (`velocity`) needs a quiet
machine, so it moves to the hardware performance lane (`performance-regression.yml`). Classify every
repeated `test-unit` red from the window as code or load; fix the load reds at their timeout source.

**Phase 2 — one gating board, run once.** Split the board into **gating** (the core above plus the
affected template and Linux native contract legs that `scope` selects) and **qualifying** (native
platform legs, all 13 templates, perf integration lanes). Merge groups run only gating. Develop pushes,
the nightly run and `develop → main` run qualifying. A red qualifying run on `develop` opens an issue
and a revert PR through the existing `ci-janitor.yml`. Prove `test-unit` shard expansion so it leaves
`UNPROVEN_REUSE_BOARDS`; then an exact-tree merge group reuses the PR verdict (PRD-481's mechanism).

**Phase 3 — capacity for the gating board.** The gating board needs about 10 free slots for 15 min.
Route gating jobs to the heavy `tn-local` pool first (PRD-480) and leave the hosted pool to the
qualifying legs. Add a small latency audit (`scripts/ci-merge-latency.mjs`) that prints, for merged
PRs in a window: last push → merge, enqueue → merge, attempts, and first failing job. It replaces the
ad-hoc `gh` queries used for this Context.

Risks: a qualifying red lands on `develop` before it is seen. The revert PR bounds that window to one
qualifying run. A PR can still opt in to qualifying on the merge path with a label for native-only changes.

## Acceptance Criteria

- [ ] AC-1 [shared]: Over 10 consecutive code PRs merged after this PRD lands, median last push → merge ≤ 30 min and p90 ≤ 45 min. proof: `node scripts/ci-merge-latency.mjs --since <date>` — Evidence: pending.
- [ ] AC-2 [shared]: Over 20 consecutive merge groups, ≥ 90% succeed on the first attempt. proof: `node scripts/ci-merge-latency.mjs --since <date>` attempts column — Evidence: pending.
- [ ] AC-3 [shared]: A merge group whose tree already passed on the PR merges in ≤ 2 min with `selection: reused`. proof: CI run id — Evidence: pending.

## Blocked on

- Moving native, all-template and perf legs off the merge path changes the rule in root `AGENTS.md` ("Merge groups … use fresh exhaustive qualification") — unblocked by João's decision.
- Heavy `tn-local` slots for gating jobs need `TN_RUNNER` set (unset at 2026-10-09T04:30Z), or a paid GitHub plan for more hosted concurrency — unblocked by João's decision.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Gating board on merge groups | `merge_group` event → `.github/workflows/ci.yml` → `scope` job → `scripts/ci-change-scope.mjs` | Replaces the exhaustive merge-group board | AC-1, AC-2 |
| Exact-tree reuse in the queue | `scope` job → `currentRun`/`coverageMiss` (`scripts/ci-change-scope.mjs:584`) | `test-unit` leaves `UNPROVEN_REUSE_BOARDS` | AC-3 |
| Post-merge qualification | `push` to `develop`, `schedule` → `ci.yml`; red → `ci-janitor.yml` | Takes the legs removed from merge groups | Phase 2 box |
| Merge latency audit | `node scripts/ci-merge-latency.mjs` | Replaces ad-hoc `gh` queries | AC-1, AC-2 |

## Execution Phases

#### Phase 1: No load reds in the gate
**Status:** IN PROGRESS
**Files:** `packages/create-threenative/__tests__/fixtures/auto-exposure/proof.ts`, `.github/workflows/integration.yml`, `.github/workflows/performance-regression.yml`, the `test-unit` specs that phase 1 classifies as load reds.
**Implementation:** Wait on rendered updates with a timeout scaled to the measured frame rate, not a fixed 60 s. Move `velocity` from `integration.yml` to `performance-regression.yml`. For each repeated `test-unit` red, read three failing logs; a red that also fails on an idle `tn-local` run is a code red and leaves this PRD. Committed so far: the temporal-off cost arm. The two red merge groups of 2026-10-09 (37874560157, 37883642740) both fail first on `integration / velocity` with `TN_PLAYTEST_RESOURCE_ASSERTION_FAILED … 'p95NoiseExcessMs'` (`scripts/verify-velocity-history.ts:189`), which is a measurement of noise on a runner twenty other jobs share. That arm now runs on the scheduled `performance-regression.yml` lane (`--variant=cost`) and the merge path runs only the correctness arm (`--variant=history`), so the lane keeps typing and unit-checking the cost code without measuring on a loaded machine. The auto-exposure frame-rate budget and the `test-unit` triage are still open, and all three boxes below need a CI run id.
**Load-red triage** (2026-10-09): three failing `test-unit` shards (jobs 113669815836, 113540990094, 113540990242) hold seven failing items and every one is a wall-clock expiry or a native-host wait — `Hook timed out in 30000ms`, `Test timed out in 15000ms`, two builds killed at a 60 s ceiling, `world-gpu-scene.spec.ts` and `template-assets-compile-1.spec.ts` at 60 s, `TN_PLAYTEST_NATIVE_SCREENSHOT_UNAVAILABLE` — so no code red leaves this PRD from this sample, and one repeated signature, `TN_CSS_SOURCEMAP_AMBIGUOUS`, is explained by no failing item. On an idle machine all four named specs pass (125 cases, exit 0, 218 s). The compile specs are the ones whose budget does not fit their work: 193.7 s and 215.0 s for 22 and 18 cases, 25–45 s per template against the shared 60 s default, now 180 s per case. `world-gpu-scene.spec.ts` is 70 cases in 60.7 s and `check-capability-docs.spec.ts` 15 in 13.9 s, so their reds are the shared-runner class — phase 3 capacity, not a timeout.
**Budget note (2026-10-10):** the `should not ship recast in a build that never imports the navigation entry` case in `packages/create-threenative/__tests__/scaffold.spec.ts` carried an incidental `15_000` timeout added by the PRD-036 replay-review commit `4956609cf`; the shared default is the existing `testTimeout: 60_000` hang detector (`vitest.config.ts:26`). That override expired at 15 s on a genuine CI red ([run 38066515075 job 114255822601](https://github.com/ThreeNativeHQ/threenative-engine/actions/runs/38066515075/job/114255822601)) before the artifact assertions ran, while the case passes locally in 1.152 s. Only the override is removed to inherit the shared budget; assertions, helper and config are unchanged. Focused file after the change: `pnpm exec vitest run packages/create-threenative/__tests__/scaffold.spec.ts` 66/66 passed, 8.73 s. Why CI slowed is unproved; fresh CI and merge latency stay open.
**Import note (2026-10-10):** a CI red ([run 38069329212 job 114264328770](https://github.com/ThreeNativeHQ/threenative-engine/actions/runs/38069329212/job/114264328770)) killed the `does not launch the capture workflow when imported for its classifier` case in `scripts/__tests__/exposure-ab.spec.ts` at its 5 s child timeout; the child import failed at 5.444 s under the unchanged 5 s subprocess budget. The three capture-only imports (`@playwright/test`, `playtest/src/runner/browser.js`, `runtime-native/conformance/metrics.mjs`) move to dynamic `import()` in `main`; the budget, thresholds, assertions and CLI guard are unchanged. Focused 7/7 passed, 1.62 s; smoke 639 ms; typecheck, lint and docs passed. CLI capture exit 0: control mismatch 0 / deltaE 0, exposure mismatch 1 / deltaE 5.81; `adapter` `{}` so hardware identity is unverified. Fresh CI stability open.

- [ ] `integration / auto-exposure` passes 10 of 10 runs on a `tn-local` slot under a parallel full board. proof: CI run ids.
- [ ] `velocity` runs on the hardware lane and is absent from `merge_group` jobs. proof: `performance-regression.yml` run id plus a merge-group job list.
- [ ] No `test-unit` spec times out in 10 consecutive merge groups. proof: `node scripts/ci-merge-latency.mjs` first-failing-job column.

#### Phase 2: One gating board, run once
**Status:** IN PROGRESS
**Files:** `.github/workflows/ci.yml`, `scripts/ci-change-scope.mjs`, `scripts/ci-required.mjs`, `.github/workflows/ci-janitor.yml`, root `AGENTS.md` (+ `pnpm sync:agents`), `scripts/__tests__/ci-structure.spec.ts`.
**Implementation:** Add a `gating` scope for `merge_group`; keep `full` for develop push, schedule, `workflow_dispatch` and `main`. Prove `test-unit` shard expansion from the run's job list and drop it from `UNPROVEN_REUSE_BOARDS`. Extend `ci-janitor.yml` to open an issue and a revert PR on a red qualifying `develop` run. Committed so far: a `merge_group` on develop selects the same narrowed plan a pull request earns (it reviews the exact tree a merge would produce) and a develop push selects `full`, so the exhaustive board moved from the queue to the promotion. Both outcome boxes below stay open until a CI run proves them.
**Repair (2026-10-09):** `validationProfile` compared a raw `baseRef` against `main` and then ORed any `merge_group` to `develop`, so an under-scoped review plan was accepted for `refs/heads/main` and for unknown or missing queue targets. The shared fix normalizes `refs/heads/` once inside `validationProfile` and classifies only explicit `main`/`develop`, removing the blanket `eventName === "merge_group"` fallback so an unproven target stays `other`. Reproduction: the committed regression test in `scripts/__tests__/ci-qualification.spec.ts`. The gate callers (`validateEventPlan`, `sourceVerdict`, `currentRun`) keep explicit develop/main behavior.
**Shared assertion (2026-10-10):** the pull-request base/head parent assertion moved out of `ci-required.mjs` into `scripts/ci-change-scope.mjs` as `assertMergeParentCandidate`, called by `ci-required` in the same place with every condition, error code and error behavior preserved. The shared helper lets an early classifier reject a wrong-parent candidate before the fanout instead of after it. The guard runs only for the live GitHub projection (`--format github`, `pull_request`, not `--local`); local and offline classification keep their existing behavior. Proof: the focused scope, template-selection, efficiency, qualification, structure, needs, runners and dashboard specs pass 431/431 in 8 files (`/tmp/pr476-preflight-focused.log`). Red before green: against the original unguarded classifier, before the guard existed, the new stale-base test failed (1 failed, 53 skipped; the classifier exited 0) (`/tmp/opencode/ci-stale-base-red.log`); the added guard makes it pass. Biome reports 0 errors on the 3 changed code files (4 pre-existing complexity warnings), and `node --check` passes on both JS files. Actual gate note: `pnpm lint` and `pnpm typecheck` passed after rebuilding stale core declarations and running the shipped strata bake; the full local suite remains unqualified; the live CI outcome is pending. The live early-rejection outcome and the phase latency boxes stay open.
- [x] `main` (bare/prefixed) and unknown/missing queue targets reject review plans; `develop` bare/prefixed preserves the valid reduced review. proof: `pnpm exec vitest run scripts/__tests__/ci-qualification.spec.ts` 19/19 after fix; new test was red before fix (18 passed, 1 failed). Profile caller/receipt/template selection specs 281/281 and `ci-structure.spec.ts` 159/159. Broader local gates: `pnpm lint` and `pnpm typecheck` passed; `pnpm test` failed (491 s) in 22 unchanged native cases, including an unexplained 120 s dry-run timeout, missing host binaries, and a missing mailbox response. Fresh shared CI passed on candidate `77bb0ee577ba39c514cd1262c48c8291f2210de2`: [run 38033595736, attempt 1](https://github.com/ThreeNativeHQ/threenative-engine/actions/runs/38033595736), 69 successful jobs including `ci-required`, completed 2026-10-10T07:56:51Z. This single PR run does not close the phase or its repeated merge-group requirements.
- [ ] A merge group runs only gating jobs and finishes in ≤ 15 min wall. proof: CI run id.
- [ ] A red qualifying run on `develop` opens an issue and a revert PR. proof: `ci-janitor.yml` run id on a seeded red branch.

#### Phase 3: Capacity and the latency audit
**Status:** IN PROGRESS
**Files:** `scripts/ci-merge-latency.mjs` (new), `scripts/ci-speed-loop.mjs` (new), `docs/ci-speed/` (ledger and HTML dashboard), `.claude/skills/ci-speed-loop/`, `.github/workflows/ci.yml` and `.github/workflows/integration.yml` `runs-on` expressions, `scripts/__tests__/ci-structure.spec.ts`, `docs/PRDs/CI/EXECUTION-ORDER.md`.
**Implementation:** Route gating jobs to `vars.TN_RUNNER` with hosted fallback; route qualifying jobs to hosted. Write the audit script with `gh api` and no new dependency. `scripts/ci-speed-loop.mjs` records each audit window in `docs/ci-speed/ledger.json` and renders `docs/ci-speed/index.html`, a dashboard of every metric against its goal (skill: `ci-speed-loop`).
- [x] The audit and the dashboard exist, reproduce this PRD's own table, and hold the baseline. proof: `pnpm exec vitest run scripts/__tests__/ci-speed-loop.spec.ts` 14 of 14; `node scripts/ci-merge-latency.mjs --since 2026-10-08` gives #461 104.2, #462 242.9, #457 432.7, #449 593.9, #455 626.9, #456 892.1, #465 131.9 min enqueue → merge (this PRD's table) and 8 `auto-exposure` first failures; ledger iteration #1 = baseline.
**Investigation (2026-10-10):** The current hosted placement of the `template-nonvisual` template legs is intentional — the workflow comment pins them to hosted on purpose, to keep one routing variable from sending the whole burst to a single pool. No routing change is accepted pending queue and capacity proof. A rejected attempt to move the job onto `vars.TN_RUNNER` was reverted in full (`.github/workflows/ci.yml`, `scripts/__tests__/ci-structure.spec.ts`); nothing about this job's routing is changed here.
**Repair (2026-10-10, balancer state):** `scripts/ci-runners.sh` `balance` caches `have_heavy`/`have_light` from its own last write, so a routing variable deleted outside the loop (author unknown; `up` documents the balancer as owner and `down` stops the balancer before it clears them) stays unset while the pool is idle and capacity routes to hosted. In scope: `scripts/ci-runners.sh` (`balance` only) and `scripts/__tests__/ci-runners.spec.ts`. Failure hypothesis: a cached `have_*` never re-reads the actual variable, so an external delete is invisible. Fix: one bounded `gh api repos/$repo/actions/variables` read per poll filtered to the two known routing names, exact expected-label compare, re-advertise while capacity stays debounced-on, skip advertising when the read fails. Live effect observed 2026-10-10T13:34:48Z: both routing variables are restored to their expected labels (`tn-local`, `tn-local-light`) with one `balance` controller running. On candidate `d6c1af145` (run 38056537726) the local build, test, integration and native jobs did run in CI, so variable restoration and job uptake are now observed, while latency acceptance stays open; the `exposure` lane measured 19.5 min in queue. That board failed cold boot: `verifySnap` timed out with `state.cutSampleFrames` expected 180 but last 89 in 60 sec, while the 20-launch `verifyColdBoot` check passed. Whether the cause is speed or the game is unproved and no assertion is loosened. The Windows failure triage is pending, so no full-green board is claimed. The local fake-`gh` harness stays the only behavioural proof of the balancer itself.
**Placement (2026-10-10):** On candidate `d6c1af145` (run 38056537726) the generic Integration lanes shared the six local heavy slots with the builds, test shards and native host builds, so a lane assigned at 13:42:05 waited to 14:01:37 (~19.5 min) and cold-boot to 13:59:06 (~17 min); four test/browser/budgets jobs stayed queued after the controller withdrew `TN_RUNNER` at 13:42:07, which cannot move an already assigned job. The generic Integration lanes now pin `ubuntu-24.04`, splitting hosted integration from the local build/test pool without oversubscription: `paths` and `completion` keep `TN_RUNNER_LIGHT`, every native ARM label, job condition, receipt and reusable input is unchanged, and no variable, input or helper is added. The deliberate `template-nonvisual` hosted split in `ci.yml` is untouched.
- [x] `balance` re-advertises a routing variable deleted while idle capacity stays debounced-on, clears a wrong-label variable while the pool is busy, corrects a wrong label to the expected one once idle is confirmed, skips advertising when the variable list is unreadable, and never re-advertises after the stop file exists. proof: `pnpm exec vitest run scripts/__tests__/ci-runners.spec.ts` 16/16 green after fix; original pre-fix harness was red (4 failed, 10 passed), including the external-delete re-advertisement case. The two wrong-label cases additionally caught an intermediate implementation error (1 failed, 1 passed), not a separate original-HEAD regression; `ci-structure.spec.ts` 159/159 and `ci-needs.spec.ts` 47/47 green; five focused CI/dashboard specs 256/256, lint and typecheck passed; full local `pnpm test` failed in 21 native-host/mailbox cases (159 s), so no local full-suite pass is claimed. Fresh read-only review passed. Logs `/tmp/pr476-balancer-red.log`, `/tmp/pr476-balancer-invalid-green.log`; live pool effect unverified.
- [x] Generic Integration lanes pin GitHub-hosted `ubuntu-24.04` while `paths`/`completion` keep the light switch and native ARM legs keep their label. proof: `pnpm exec vitest run scripts/__tests__/ci-structure.spec.ts` contract green after the pre-change red; live queue-wait effect unverified.
**Placement (2026-10-10, release reports):** On candidate `d6c1af145` (run 38056537726) the native `release-reports` job queued from 14:23:09 behind the heavy build pool while light slots stayed idle, though it only checks out, `pnpm install`s, downloads the android/desktop parity artifacts and writes JSON reports — no compile or GPU leg (unlike `desktop-parity`, which builds). It now selects `TN_RUNNER_LIGHT`; its condition, timeout, steps, receipts and every native/parity build label are unchanged, and no variable, input or helper is added.
- [x] `release-reports` joins the light lane while native build and parity legs keep their heavy routing. proof: `pnpm exec vitest run scripts/__tests__/ci-structure.spec.ts` — contract red before the one-line workflow change (`release-reports is off the light lane`, 1 failed / 159 passed) and green after (160 passed); live queue-wait effect unverified.
**Placement (2026-10-10, collector coverage):** Live run `38069329212` showed the native `performance-coverage` job still queued on `tn-local` at 17:29:25 for at least 7 min while all five heavy slots were busy and three light slots idle, though it only checks out, `pnpm install`s, downloads the `native-*` artifacts and runs `tsx scripts/performance-regression/ci-summary.ts` — a JSON aggregator with no compile or GPU leg. It now selects `TN_RUNNER_LIGHT`; its condition, timeout, steps, receipts, coverage list and every native/parity build label are unchanged, and no variable, input or helper is added. Test-first: the exact routing contract was red before the one-line change (`performance-coverage is off the light lane`, 1 failed / 159 skipped, `/tmp/pr476-collector-route-red.log`) and the five focused CI specs run 331/331 after (`/tmp/pr476-collector-route-green.log`); `biome check scripts/__tests__/ci-structure.spec.ts` exit 0 (pre-existing complexity warnings only) and `git diff --check` clean. New-CI outcome pending, so no box is closed.
- [ ] Gating jobs in a merge group wait ≤ 3 min p90 for a runner. proof: `node scripts/ci-merge-latency.mjs` queue column.
