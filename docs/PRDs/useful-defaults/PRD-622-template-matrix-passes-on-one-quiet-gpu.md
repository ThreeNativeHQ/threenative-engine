# PRD-622 — The 13-template playtest matrix passes in one run on one GPU

**Status:** NOT STARTED
**Priority:** P2 — closes the one proof PRD-619 shipped without: no single run of `pnpm test:templates` has been green on this desktop or on the Debian laptop, with or without PRD-619.
**Complexity:** 3 (MEDIUM) — diagnosis first; the fix may sit in the driver or lane setup, in the engine, or in per-template frame budgets.
**Owner:** unassigned
**Depends on:** none. Related: PRD-619 (owner waived its whole-matrix gate on 2026-10-17).

## Problem

PRD-619 changed the fixed-step loop for every game, so its proof wanted the whole template matrix green. Neither local lane could produce that run, and develop shows the same reds, so the reds are not PRD-619's:

- Desktop (RTX 2080, Xvfb): `VK_ERROR_DEVICE_LOST` / `TN_DEVICE_LOST` ended random action-RPG scenarios on develop base `8e7c96490` and on the PR branch alike, two runs each, a different set of scenarios every run.
- Desktop full matrix on the PR head, run 1: 113 scenarios passed; action-rpg ended with `TN_PLAYTEST_RUNNER_FAILED`; shooter `performance` (p95 131 ms) and tower-defense `production-performance` (p95 41.6 ms) missed the 33 ms budget, with a host load average of 10 to 13 from other sessions.
- Laptop (Intel Iris Xe, real display), base against branch: identical. 55 scenarios passed on both; the same three frame-time budgets failed (action-rpg, rain, rts) and `pnpm install` failed for runner, sailing, shooter, snow and tower-defense.

## Phases

### Phase 1 — Find the cause
- [ ] Name the layer of the desktop device loss (driver, shared GPU, Xvfb present path or engine) with a run that reproduces it on develop and a run that does not. proof: playtest `doctor --text` output plus the two runs' `TN_DEVICE_LOST` counts.
- [ ] Name why `pnpm install` fails on the laptop for five templates. proof: the first error line of one failing install.

### Phase 2 — One green matrix
- [ ] One run of `pnpm test:templates` exits 0 on a quiet machine. proof: command, exit code and scenario count in this box.
- [ ] Frame-time budgets either hold on the lane that runs them or name the adapter class they apply to. proof: the budget diff and a passing run on that lane.

## Decisions

- 2026-10-17: filed by the PRD-619 close-out, so the waived whole-matrix proof has an owner file.
