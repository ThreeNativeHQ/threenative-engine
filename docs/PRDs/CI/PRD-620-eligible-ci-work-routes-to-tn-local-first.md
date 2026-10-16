# PRD-620 — Eligible post-push CI work routes to idle tn-local first

**Status:** NOT STARTED
**Priority:** P1 — Open boxes move queued post-push work off hosted queues onto 3 idle tn-local runners; every lane waits on this elapsed time.
**Complexity:** HIGH (base 3 LOW + risk override: misrouting runs fork code on the owner machine or drops a required receipt)
**Owner:** CI tooling
**Depends on:** none (reuses landed PRD-480 pool; PRD-550 parent goal and PRD-481 complementary are context, not prerequisites)

Complexity: 3 → LOW (1–5 files +1, routing-concurrency +2; no new API integration — `gh api …/jobs` is measurement only); risk override → HIGH: misrouting runs fork code on the owner machine or drops a required receipt.

## Context

Develop push run [38824021621](https://github.com/ThreeNativeHQ/threenative-engine/actions/runs/38824021621) (2026-10-15→16, 77 min wall, all sampled jobs hosted) is queue-dominated:
conformance reference queued 17m39, executed 5m48 (created 23:32:40, started 23:50:19, done 23:56:07);
Android emulator visual parity (job 116735149785) queued 14m48, executed 34m11 (created 23:56:07, started 00:10:55, ended
00:45:06); fog capture queued 45m33 (6m26 run); budgets queued 37m43 (58 s run). Three tn-local repo
runners were online idle; only repo variable `TN_DEVELOP_CI_ENABLED` visible, org variables API 403 —
repo-level vars suffice for this scope, so org visibility is context, not a blocker.

Step split (job 116735149785 via jobs API): setup 00:10:56→00:12:18 (~82 s); `Run checksum-locked APKs
on the emulator` 00:12:18→00:44:08 = 31m50 in ONE step; one AVD (`test`, pixel_6, android-35 x86_64,
`hw.cpu.ncore=2`, api-level 35 4 KB image). The 31m50 is conformance execution, not repeated
builds/setup — no dedup claim inside this lane (fact, not estimate).

Routing today: movable Linux jobs use the `TN_RUNNER`/`TN_RUNNER_LIGHT` switch with hosted fallback
(`tools/ci-runners/README.md:10-27`); fork PRs always hosted; macOS/Windows/iOS/linux-arm64/
`supply-chain`/emulator always hosted (README:20). The emulator is pinned hosted for measured cause:
`native-platforms.yml:364-366` — a 4-thread tn-local slot spent 41 of 45 min still running APKs on run
37082733117 (hosted ~30 min, SwiftShader CPU rendering). Pool shape: 3 heavy slots (3 cores/9 GB) +
3 light slots, 2 host cores reserved, `--device /dev/kvm` when present (`scripts/ci-runners.sh:33-55`).
Existing auto-balancer (`scripts/ci-runners.sh:236-286`, determined once): advertises each label only
after 2 consecutive polls (~40 s) see an idle runner, withdraws it as soon as no runner is idle;
variable snapshots are not atomic capacity reservation, so overflow to hosted is best-effort fallback,
not a guaranteed immediate route. Explicit bounds: 3 heavy + 3 light slots behind hosted ~20-way
concurrency; queue measured against AC-1 and resource concurrency fixed, fallback is hosted. No new scheduler.
Why `TN_RUNNER` was unset during the sampled push may be intentional balancer withdrawal (busy pool)
or pool down — diagnosis is a Phase 1 box before any routing change. Eligible jobs are the movable
Linux legs not yet pinned to tn-local; already-switched jobs are those already on the
`TN_RUNNER`/`TN_RUNNER_LIGHT` expression. Actual pool on/off state is UNKNOWN and stays a runnable
qualification on the pool host (`scripts/ci-runners.sh status`); never assume runner installation is needed.
`ci:local` exists and does not satisfy `ci-required`; no local verdict reuse is claimed. Speed ledger (`docs/ci-speed/ledger.json`) goals: push→merge p50 30 min,
p90 45 min, board wall median 15 min (20 iterations).

V8 cold path (bounded, not in scope): cancelled merge-group run [38824053251](https://github.com/ThreeNativeHQ/threenative-engine/actions/runs/38824053251) (155 min total),
`Android V8 source payload` (job 116729534477) queued 24m42, executed 00:03:56→02:04:44 = 120m48 OK.
Log `/tmp/tn-ci-r3-android-v8.clean.log`: `No published v8-android-1a2463b5….tgz; falling back…`,
`Cache not found` for payload and source keys. Recipe = hash of build-android-v8.mjs,
check-android-16kb-alignment.mjs, download-deps.mjs, gradle.properties
(`.github/actions/android-v8-source/action.yml:29-34`); recipe changed vs the run that hit in 53 s,
so a cold build was correct. Publishing happens only on non-PR main/develop via `publish-android-v8`
(`native-platforms.yml:224-234`), deliberately hosted-only (contents:write never handed to pool
containers). Do NOT assume publishing an unmerged payload is authorized or safe.

Duplicates: PRD-550 owns end-to-end 30-min merge (this PRD is one queue-relief slice, context only);
PRD-480 owns the pool (already landed — this PRD reuses it as-is, no replanning, no open acceptance required);
PRD-481 owns dedup (workspace-dist rebuilds etc. — untouched here); PRD-615 owns build-once-cache-by-recipe
for linux-arm64 V8 (Android V8 is its precedent, cited not repeated).

## Solution

Route eligible Linux work to idle tn-local slots with hosted/fork/platform fallback and a contention
bound; prove queue-vs-execution split on comparable runs; keep every required job, receipt, candidate
and attempt check. Emulator stays hosted (measured above). V8 publish-on-recipe-change is an explicit
separate follow-up, not this PRD — no speculative publishing.

Consumer flow: develop push → scope → eligible Linux jobs land on `tn-local`/`tn-local-light` runner
names when idle, else hosted → `ci-required` green on the same candidate → ledger entry with
queue-vs-execution separated. Reused: `TN_RUNNER` switch, balancer, ledger, `gh api …/jobs` timings.

## Acceptance Criteria

| ID | Outcome (lane, actor) | Proved by phase boxes |
|---|---|---|
| AC-1 [shared Linux queue lane, actor: balancer + workflow routing] | Initial slice: comparable full board ≤ 60 min wall AND eligible Linux queue p50 ≤ 2 min, on at least 2 comparable full after-runs; warm unchanged-V8-recipe population only, cold runs recorded separately; different workload/cache/dep changes cannot count as routing gain; failure leaves the box open | Phase 1 boxes 1–2, Phase 2 boxes 1–3 |
| AC-2 [shared verdict lane, actor: `ci-required` on same candidate] | Full green official CI incl. `ci-required` on the tested candidate; runner names show `tn-local`, required-job/receipt/candidate/attempt checks preserved | Phase 1 boxes 2–4, Phase 2 box 4 |

## Integration Ledger

Balancer + workflow routing (`scripts/ci-runners.sh`, `.github/workflows/ci.yml`, `.github/workflows/native-platforms.yml`) => runner assignment (runner names on live runs) => `ci-required` verdict on the same candidate, recorded as a speed-ledger row with queue-vs-execution split and file paths; AC-1 proved by Phase 2 boxes 1–2, AC-2 by Phase 1 boxes 3–4 and Phase 2 boxes 3–4.

## Decisions

- 2026-10-16 (agent): V8 cold path deferred, not in scope here; unmerged-payload publishing is neither authorized nor safe to assume. No follow-up PRD created here.
- 2026-10-16 (agent): Android emulator lane stays hosted per the measured 41-vs-30 min note in `native-platforms.yml:364-366`.

## Execution Phases

#### Phase 1: Eligible work lands on idle tn-local, everything else unchanged

**Status:** NOT STARTED
**Files:** `.github/workflows/native-platforms.yml` + `ci.yml` routing expressions (if changed), `scripts/ci-runners.sh` (balancer), `tools/ci-runners/README.md`
**Implementation:** Keep fork-always-hosted and the macOS/Windows/iOS/arm64/supply-chain/emulator hosted
allow-list (`ci-structure.spec.ts`); reuse the existing balancer only — advertise after 2 consecutive idle polls (~40 s), withdraw when none idle; snapshots are not atomic reservation, so overflow is best-effort with explicit 3-heavy + 3-light vs hosted ~20-way bounds and hosted fallback.
**Verification:** runner names on a live run plus contract specs.

- [ ] Diagnosis before change: why `TN_RUNNER` was unset on run 38824021621 (balancer withdrawal vs pool down) from balancer log/status, plus the explicit eligible-job list vs already-switched jobs. proof: `~/.local/state/threenative/ci-runners/balance.log` + `scripts/ci-runners.sh status` — Evidence: pending.
- [ ] Movable Linux legs show `tn-local`/`tn-local-light` runner names with hosted fallback intact. proof: `gh api repos/ThreeNativeHQ/threenative-engine/actions/runs/<id>/jobs` + `pnpm exec vitest run scripts/__tests__/ci-structure.spec.ts` — Evidence: pending.
- [ ] Busy-pool best-effort overflow to hosted; joins use separate LIGHT capacity (LIGHT vars); existing hysteresis/thresholds unchanged. proof: `pnpm exec vitest run scripts/__tests__/ci-runners.spec.ts` + queue-time split from the same run — Evidence: pending.
- [ ] Fork/platform allow-list unchanged (emulator, arm64, macOS, Windows, iOS, supply-chain hosted); `ci-required`/`ci-needs` contracts guarding changed routes green. proof: `pnpm exec vitest run scripts/__tests__/ci-structure.spec.ts scripts/__tests__/ci-needs.spec.ts scripts/__tests__/ci-qualification.spec.ts` — Evidence: pending.

#### Phase 2: Prove the elapsed-time win on comparable runs, checks preserved

**Status:** NOT STARTED
**Files:** `docs/ci-speed/ledger.json` (+ `index.html` if generated)
**Implementation:** Baseline run 38824021621 (77 min, splits above) vs at least 2 after-runs on comparable workload; two samples may be triggered manually at identical candidate/workload to avoid manufacturing code changes;
record queue vs execution per job; warm unchanged-V8-recipe population only, cold recorded separately; different workload/cache/dep changes do not count.
**Verification:** official CI on the tested candidate.

- [ ] Two comparable full after-runs with queue-vs-execution split recorded in the speed ledger (warm only; cold separated). proof: `gh api repos/ThreeNativeHQ/threenative-engine/actions/runs/<id>/jobs` + ledger entry — Evidence: pending.
- [ ] Initial slice wall: comparable full board ≤ 60 min wall on EACH of ≥2 comparable after-runs (not average of convenient run), comparability recorded; failure leaves the box open. proof: `gh api repos/ThreeNativeHQ/threenative-engine/actions/runs/<id>/jobs` precise started_at/completed_at elapsed — Evidence: pending.
- [ ] Initial slice queue: eligible Linux queue p50 ≤ 2 min on EACH of ≥2 comparable after-runs (not average of convenient run), comparability recorded; failure leaves the box open. proof: `gh api repos/ThreeNativeHQ/threenative-engine/actions/runs/<id>/jobs` created_at/started_at queue per job — Evidence: pending.
- [ ] Full green incl. `ci-required` on the same candidate; required-job/receipt/candidate/attempt checks preserved (fail closed on missing/stale receipts). proof: `gh run view <id>` — Evidence: pending.
