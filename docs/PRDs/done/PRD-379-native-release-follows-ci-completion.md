# PRD-379 — native-release follows CI completion instead of polling for it

**Status:** DONE (Phase 2 observed on `main` 2026-09-25; recorded 2026-10-02)
**Complexity:** 3 → LOW; risk override: none (release-gate sensitivity is carried by fail-closed ACs, not extra process)
**Owner:** jonit-dev
**Depends on:** None (follows PRD-373, which owns the develop→main flow this plugs into)

## Context

On 2026-09-12 the Actions queue stopped draining: 17 runs queued (oldest 2.5h+), zero jobs executing org-wide, even trivial first jobs (`Change scope`) with no runner assigned. GitHub Status was green and Actions enabled — the org simply had more demanded runner-hours than its concurrency allows.

The structural driver is self-inflicted fan-out: every push fires CI (~30 jobs) + Native runtime release + Pipeline cache verification together, and `native-release.yml`'s `gates` job holds a runner for up to 150 minutes doing nothing but `sleep 60` polling for the CI run (`.github/workflows/native-release.yml:146-171`, `timeout-minutes: 160`). At this repo's push cadence against a 20-slot concurrency cap, arrivals outrun service. The `native-release-${{ github.ref }}` concurrency group (`native-release.yml:24-38`, `cancel-in-progress: false`) then serializes the backlog instead of shedding it.

Inspected: `.github/workflows/native-release.yml` (gates poll loop, tag path, PR proof path), `.github/workflows/ci.yml:15-17` (concurrency), `scripts/__tests__/ci-structure.spec.ts:880-890` (asserts the serial group + `gh run list --workflow ci.yml`), `:977-986` (asserts the polling strings in `gates`).

## Solution

Trigger `native-release.yml` on `workflow_run` (CI completed on `main`) instead of on `push`, and read the CI result from the `workflow_run` event payload instead of polling for it with `gh`. The `gates` job becomes a minutes-long verdict over `github.event.workflow_run` (conclusion, head SHA, jobs) rather than a 150-minute runner-holding wait. Unchanged paths:

- tag pushes (`runtime-native-v*`) still publish via `validate-tag`/`publish`;
- `pull_request` proof runs still execute without publication;
- the required-job table (`typecheck`, `lint`, `test`, native legs) is still enforced per exact candidate SHA — now sourced from the event, failing closed on mismatch.

Consumer flow: push to `main` → CI completes → exactly one `native-release` run starts → `gates` verdict in minutes → `build`/`build-android`/`clean-consumer` as today. Observable difference: no `gates` job ever polls, and main pushes no longer queue behind each other in `native-release-*`.

Risks: `workflow_run` always reads the workflow file from the default branch, so the new trigger must land on `main` before it fires (Phase 2 proves this); fork-PR token limits don't apply since the trigger is main-push CI only. A red or mismatched CI run must refuse, never retry-to-green — the existing fail-closed assertions move, they don't weaken.

## Acceptance Criteria

- [x] AC-1 [local; actor: agent]: A main-push CI completion starts native-release via `workflow_run`, with no `push`-to-`main` trigger left on the evidence path — Evidence: `workflow_run: workflows: [CI], types: [completed], branches: [main]` in `.github/workflows/native-release.yml:10-13`; push block is tags-only; proven by `main evidence arrives via CI completion` spec + E1 green.
- [x] AC-2 [local; actor: agent]: No `gates` job polls or holds a runner beyond a short verdict (no `sleep 60` loop, no 150-min wait); it reads conclusion + head SHA from `github.event.workflow_run` and refuses anything but exact-candidate success — Evidence: `gates` timeout-minutes 5, `Require the triggering CI completion` step, `rg "sleep 60"` clean; proven by `the main prerequisite verdict reads the event` + 5 `runWorkflowRunGate` specs + E1 green.
- [x] AC-3 [local; actor: agent]: Tag publish path and PR proof-without-publication path behave exactly as before — Evidence: tag `push: tags` trigger, `validate-tag`/`publish`/`finalize` conditions untouched; `Require a green CI run for this commit` script byte-identical (single-shot, wait deleted); existing `runGate` accept/refuse specs unchanged + green. Host proof: native-release PR run 34673827042 (first push of PR #209) fully green — `gates`, all three desktop builds, `build-android`, `clean-consumer` success on the `pull_request` event with the new workflow file. (Second-push run 34673874789 hit a transient `fetch failed` on `libuv`/`quiche` dep downloads with identical code; assets verified reachable, failed jobs re-run.)
- [x] AC-4 [shared; actor: CI on merge to main]: After merge, one CI completion on `main` triggers exactly one native-release run whose `gates` job finishes in minutes with no polling step — Evidence: CI push run 36134527157 on `main` (`279adb2c`) completed twice (run_attempt 2); each completion triggered exactly one `workflow_run` native-release run: 36140281930 (attempt 1) and 36142531873 (attempt 2); `gates` in 36142531873 ran 39 s (13:41:18–13:41:57Z), and its steps contain no wait or poll.
- [x] AC-5 [local; actor: agent]: Main evidence runs no longer serialize behind superseded pushes in a shared `native-release-*` group — Evidence: `group: native-release-${{ github.event_name }}-${{ github.event.workflow_run.head_sha }}-${{ github.ref }}` (per-SHA groups for evidence, per-ref as before otherwise); proven by extended concurrency spec + E1 green.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Native release gating for a main commit | `main` push → CI `completed` → `native-release` `workflow_run` event; file: `.github/workflows/native-release.yml` | `gates` polling loop (`gh run list` + `sleep 60` × 150) deleted; required-job verdict moved onto the event payload | AC-1 / AC-2 / AC-4 |
| Tag publish + PR proof | `runtime-native-v*` tag push; `pull_request` (path-filtered) — both unchanged triggers in the same file | Unchanged — no disposition | AC-3 |

## Execution Phases

#### Phase 1: Retrigger on CI completion, verdict from the event

**Status:** DONE (local verification E1 green 2026-09-12; red proven against pre-change workflow)
**ACs:** AC-1, AC-2, AC-3, AC-5
**Files:**
- `.github/workflows/native-release.yml` — `workflow_run` trigger on CI completion; `gates` rewritten as event-payload verdict; polling steps deleted; concurrency group re-keyed so evidence runs don't serialize (tag publish keeps its guard)
- `scripts/__tests__/ci-structure.spec.ts` — update `preserves main qualification…` (group key) and `requires native release CI to be a successful push on main` (event-payload assertions instead of polling strings); extend, don't weaken
- `scripts/__tests__/native-release-proof.spec.ts`, `scripts/__tests__/native-release-android-staging.spec.ts` — keep covering the refusal controls from their new call site

**Implementation:**
1. Replace the `push: branches: [main]` trigger on the evidence path with `workflow_run: workflows: [CI], types: [completed], branches: [main]`; keep tag-push and `pull_request` triggers for their paths.
2. Rewrite `gates` to assert `github.event.workflow_run.conclusion == 'success'`, `head_sha == candidate`, `head_branch == 'main'`, then validate the required job table from the event's jobs API — fail closed on any mismatch, no retry, no sleep loop.
3. Re-key `concurrency.group` so a new CI completion doesn't queue behind a superseded evidence run (superseded = a newer CI completion for a newer main SHA exists); tag publish keeps strict serialization.
4. Update the constraining specs to the new shape; keep every existing refusal assertion that still applies.

**Verification:** E1 — `pnpm exec vitest run scripts/__tests__/ci-structure.spec.ts scripts/__tests__/native-release-proof.spec.ts scripts/__tests__/native-release-android-staging.spec.ts` green; plus a YAML parse of the workflow asserting `workflow_run` present, `sleep 60` absent, `timeout-minutes` on `gates` back to a single-digit verdict budget. Red (already observed, 2026-09-12): current file contains the poll loop — the updated specs must fail against it.
**Checkpoint:** E1 green 2026-09-12 (151 passed); red confirmed by stashing the workflow change and re-running (7+ failures on old file)

- [x] Trigger block uses `workflow_run` on CI completion; no `push`-to-`main` evidence path remains
- [x] `gates` has no polling loop and a single-digit-minute timeout
- [x] Refusal specs updated and green (E1)
- [x] Tag publish + PR proof paths byte-equivalent in behavior (AC-3 evidence recorded)

#### Phase 2: Prove one real main completion flows through

**Status:** DONE
**ACs:** AC-4
**Files:** none (observation only)
**Implementation:**
1. Open the one draft PR for this PRD against `develop`, apply the `prd:*` label per `pnpm prd:progress`.
2. Land via the normal develop→main promotion; the first CI completion on `main` after the trigger file lands on default branch fires the new path.
3. Link the CI run and the triggered native-release run in this PRD; confirm `gates` duration is minutes and its steps contain no wait/poll.

**Verification:** E2 — CI run URL + triggered native-release run URL, `gates` conclusion and duration recorded; exactly one native-release run per CI completion.
**Checkpoint:** pending

- [x] Draft PR opened, `prd:` label applied from `pnpm prd:progress` — PR #209 (draft vs develop, `prd:50%`)
- [x] Post-merge CI completion triggered exactly one native-release run (URLs recorded) — CI push run 36134527157 on `main` (`279adb2c`) completed twice (run_attempt 2); each completion triggered exactly one `workflow_run` native-release run: 36140281930 (attempt 1) and 36142531873 (attempt 2).
- [x] Triggered run's `gates` finished in minutes with no polling step — 39 s in 36142531873; steps run from "Require the triggering CI completion" to the end, with no wait or poll step.
