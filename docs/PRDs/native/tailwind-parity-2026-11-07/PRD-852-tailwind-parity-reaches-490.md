# PRD-852 — Tailwind parity reaches 490 of 490, and the native-css profile limit is gone

**Status:** NOT STARTED
**Priority:** P1 — AC-1 to AC-3 are the batch outcome the owner asked for: every kit HUD builds for native-css, and CI keeps the score.
**Complexity:** 4 (MEDIUM) — 6 to 10 files (+2), CI job in an existing workflow (+2).
**Owner:** ThreeNative maintainers
**Depends on:** PRD-843, PRD-844, PRD-845, PRD-846, PRD-847, PRD-848, PRD-849, PRD-850, PRD-851
**Batch:** [Tailwind parity, 2026-11-07](README.md)

## Context

Each family PRD deletes its own denylist rows and raises the floor. This PRD closes the batch:
the last rows go, the guide stops describing a "Core profile", and CI holds the score.

## Solution

1. Delete `UNSUPPORTED_*` data from `native-css-compat.ts`. If nothing is left, delete the scanner
   and its `build.ts` call. Keep the lazy-stylesheet refusal, which is a packaging rule, not a
   profile gap.
2. Rewrite `docs/guides/native-css-support.md` as "Tailwind 4.3.3: 490 of 490, measured by
   `parity:tailwind`", with the remaining restrictions (platforms, fonts, DPR).
3. Add the meter with `--ratchet` as a job in an existing workflow (no new workflow file) that
   runs when `native/css-ui/`, the compat scanner or the scene change.

## Acceptance Criteria

- [ ] AC-1 [local]: the meter prints `tailwind-parity: 490/490` on the crate subject and on the host subject. proof: `parity:tailwind` and `parity:tailwind --host` — Evidence: pending.
- [ ] AC-2 [local]: all 14 Tailwind kits build for `ui.renderer: "native-css"` with no findings and no refusal. proof: a scripted loop of `threenative build --target desktop` over each scaffolded kit with `ui.renderer: "native-css"` — Evidence: pending.
- [ ] AC-3 [shared]: the CI job runs `parity:tailwind --ratchet` and fails on a deliberate one-unit regression on a draft branch. proof: the CI run link — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Native-css build gate | `threenative build` → `packages/create-threenative/src/build.ts:703` | Denylist deleted, or the scanner removed | AC-2 |
| Parity in CI | the existing workflow job → `parity:tailwind --ratchet` | New job, no new workflow file | AC-3 |

## Execution Phases

#### Phase 1: Profile limit removed
**Status:** NOT STARTED
**Files:** `packages/create-threenative/src/native-css-compat.ts`, `build.ts`, their specs, `docs/guides/native-css-support.md`.

- [ ] The denylist is empty or deleted, and the guide states 490 of 490. proof: AC-1 plus `pnpm check:docs`
- [ ] Every kit builds clean. proof: AC-2

#### Phase 2: CI keeps it
**Status:** NOT STARTED
**Files:** the existing native workflow under `.github/workflows/`, `scripts/__tests__/ci-structure.spec.ts`.

- [ ] The ratchet job runs on the change paths and goes red on a regression. proof: AC-3
