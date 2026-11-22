# PRD-904 — Android conformance runs in two shards on one APK, and the tiny integration lanes share one setup

**Status:** NOT STARTED
**Priority:** P2 — the Android emulator parity job (34–44 min) is the wall-time floor of every full board, and neither box below is started.
**Complexity:** 6 (MEDIUM); risk override: HIGH — changes a required native receipt.
**Owner:** CI tooling
**Depends on:** [PRD-903](../BLOCKED/requires-next-release/PRD-903-cut-release-deploy-and-ci-time-by-fixing-carry-and-cutting-duplicate-and-junk-tests.md)

## Context

Split out of PRD-903 Phase 3 on 2026-11-21 (owner chose "review lane only" for PRD-903, and this work needs native CI runs to prove).

- `android-emulator-parity` in `.github/workflows/native-platforms.yml` builds the APK and then runs all 110 active conformance cases serially at about 14.5 s each (26.5 min of the 34–44 min job, run `44878180530`).
- `run-conformance.mjs --only-tests` already selects a subset.
- Two shards cannot each build their own APK: `scripts/ci-native-receipts.mjs` requires every executed row's `runtimeLibraries.x86_64` to equal one `artifactSha256`, and it validates the report against the full `conformance/registry.json`.
- Six `integration/*` web lanes (`csg`, `ik`, `playstation`, `decals`, `fluid-collision`, `exposure`) run 0.5–1.5 min each and each pay full checkout, install and queue setup.

## Solution

1. One job builds the APK and uploads it. Two shard jobs download it, boot the emulator and run `--only-tests` halves of the registry. A merge job joins the two partial reports into one full report, then runs the existing parity ledger, `check-lane-blocks.mjs` and the receipt writer on it, so the receipt contract does not change.
2. The six small integration lanes run as steps of one job, and `scripts/ci-integration-scope.mjs` keeps one receipt key per lane.

## Acceptance Criteria

- [ ] AC-1 [shared]: A full board's Android parity wall time is 25 min or less (baseline 34–44 min), with the same 110 executed cases and a valid native receipt. proof: a `native-platforms` run ID and `pnpm ci:speed record && pnpm ci:speed show` — Evidence: pending.

## Execution Phases

#### Phase 1: Shard Android conformance on one APK
**Status:** NOT STARTED

- [ ] The APK producer, two shard jobs and the report merge pass `ci-native-receipts.mjs` with one `artifactSha256`. proof: `pnpm exec vitest run scripts/__tests__/ci-native-chain.spec.ts scripts/__tests__/ci-native-profile.spec.ts scripts/__tests__/ci-structure.spec.ts` and one green `native-platforms` run — covers AC-1.

#### Phase 2: One setup for the tiny integration lanes
**Status:** NOT STARTED

- [ ] The six small `integration/*` lanes run in one job and every lane keeps its receipt key. proof: `pnpm exec vitest run scripts/__tests__/ci-integration-scope.spec.ts` and one green `integration` run — covers AC-1.
