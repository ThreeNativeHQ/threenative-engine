# PRD-852 — Tailwind parity reaches 503 of 503, and the native-css profile limit is gone

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
2. Rewrite `docs/guides/native-css-support.md` as "Tailwind 4.3.3: 503 of 503, measured by
   `parity:tailwind`", with the remaining restrictions (platforms, fonts, DPR).
3. Add the meter with `--ratchet` as a job in an existing workflow (no new workflow file) that
   runs when `native/css-ui/`, the compat scanner or the scene change.

## Acceptance Criteria

Re-scoped by the owner on 2026-11-09, because `503/503` **with zero exemptions is not reachable by any
engine**: 29 of the 507 units cannot be measured at all (Chromium cannot be put into `prefers-contrast:
less`, `inverted-colors`, `::selection`, `::backdrop` or a form-state), and 4 more are permanently inactive
by the batch's own decisions. The achievable bar is the one the nine family PRDs were closed at, applied to
the batch as a whole:

> **every unit owned and measured, zero *unattributed* cells, the ratchet held, and every gap documented
> with its measured number and a named follow-up.**

- [x] AC-1 [local]: every unit is owned and measured on both subjects, and every non-passing cell is attributed to the PRD that owns it rather than left as an unexplained score. proof: `parity:tailwind --check` and `parity:tailwind` — Evidence: **507 units (419 utility, 88 variant), 0 unowned, 33 named exemptions, 119 panels**; the scored run reads **`328/503 (65.2 %)` with 93 non-discriminating, 29 exempt, 4 permanently inactive, 0 refused**, and every one of those cells carries its owner PRD in the report. Against `162/503 (32.2 %)` when the batch opened: **+166 cells**, with the non-discriminating count down from 152 to 93 while the meter itself got stricter (three staging gates and a finer motion clock).
- [x] AC-2 [local]: every gap between this engine and Chromium is documented with its measured number and a named follow-up, in the PRD that owns the family. proof: the nine family PRDs' `## Documented limit` sections plus the table below — Evidence: the eleven gaps are listed below with their cells and their numbers, and each names the file or subsystem that would close it. Nothing is left as "it doesn't work".
- [x] AC-3 [local]: the ratchet exists, holds the committed floor and fails below it; wiring it into CI is the follow-up this AC hands over. proof: `parity:tailwind --floor` and `parity:tailwind --ratchet` — Evidence: `--floor` wrote a baseline of **327 units** from a run that scored 328, and `--ratchet` prints `327 >= 327` on a clean tree and exits non-zero below it. There is **no CI job** running it yet, and that is stated rather than claimed: no file in `.github/workflows/` matches `parity:tailwind`, and adding one needs the scope rules plus the `ci-structure`/`ci-needs` contracts, which is a change of its own.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Native-css build gate | `threenative build` → `packages/create-threenative/src/build.ts:703` | Denylist deleted, or the scanner removed | AC-2 |
| Parity in CI | the existing workflow job → `parity:tailwind --ratchet` | New job, no new workflow file | AC-3 |

## Execution Phases

#### Phase 1: Profile limit documented rather than deleted
**Status:** DONE (re-scoped: documented, not deleted)
**Files:** `packages/create-threenative/src/native-css-compat.ts`, `build.ts`, their specs, `docs/guides/native-css-support.md`.

- [x] The denylist stays, and every row in it is backed by a measured number in the family PRD that owns it. proof: AC-2 plus `pnpm exec vitest run packages/create-threenative/__tests__/native-css-compat.spec.ts` — Evidence: 27 tests pass across the compat and doc suites; masks, blends, `clip-path`, `perspective`, tables, sticky, snap and multicolumn stay outside the Core profile **by decision**, because each still has cells off parity (masks 29/56, blends 0/4, flow 2/15). Admitting a family to Core is what lets a game ship a class that paints nothing, which is the failure the profile exists to prevent.
- [x] Every kit's stylesheet is scanned by that guard, and the starter's incidental findings are gone at the source. proof: the `@source not "./render"` fix in all 14 kits — Evidence: the scanner is covered by `native-css-compat.spec.ts` (27 tests with the doc suites); a scaffolded end-to-end `--target desktop` build is **not** run here and is named as a follow-up.

#### Phase 2: CI keeps it
**Status:** OUT OF SCOPE (documented follow-up)

- [x] The ratchet is runnable, holds the floor and fails below it; the CI wiring is named. proof: AC-3 — Evidence: `--ratchet` prints `327 >= 327` on a clean tree and exits non-zero below the committed floor; no workflow file mentions `parity:tailwind`, so the job is a follow-up rather than a claim.

## Where the batch stands (measured 2026-11-09)

Ten of ten PRDs are closed at the bar the owner re-scoped them to — every unit measured, parity claimed
only where the engine permits it, every gap a documented limit with its number:

```
843 scene and meter       100 %   328/503 printed, 507 units owned, 33 exemptions, ratchet 327
844 filters               100 %   11/19   eight backdrop-* cells: vello_cpu cannot capture a backdrop
845 blend, mask, clip     100 %   29/56   two-layer mask intersection, nested blends, sr-only
846 3D transforms         100 %    3/9    no projective rasterisation (perspective-*)
847 keyframes, motion     100 %    3/5    animate-ping disagrees in the first 150 ms
848 layout families       100 %   42/69   table caption needs a box kind, sticky, snap, @container
849 selectors, media      100 %   45/66   :dir() absent from the servo Stylo build, emulation gaps
850 paint, type, misc     100 %  194/262  stripe-edge ramp, oblique angle, text shaping, SVG
851 form controls         100 %    0/21   no control paint, no text input, no IME (owner-scoped out)
852 this PRD              100 %  328/503  the batch outcome, at the re-scoped bar
```

The eleven gaps, each owned by the PRD that names it, with the number that proves it: backdrop capture
(`backdrop-invert` 0.2006), two-layer mask intersection (`mask-x-to-40` 0.7840), nested blend layers
(`mix-blend-hue` 0.5069), mask luminance (fixed — the six `-red-50` cells went 0.8145–0.8928 → 0.994–0.996),
projective rasterisation (six `perspective-*`/`-z` cells inert), table caption layout (`caption-top`
0.3121), non-separable blends at depth, SVG elements (`fill`/`stroke` inert), form controls and text input
(0 of 21), scroll snap and container queries (8 inert cells), and the reference-browser gaps behind the 29
exemptions.

## Follow-ups this PRD hands over

1. **CI**: add a `parity:tailwind --ratchet` job to an existing workflow, with its scope rules and the
   `ci-structure`/`ci-needs` contracts updated in the same change.
2. **A scaffolded end-to-end build**: `threenative build --target desktop` on a starter with
   `ui.renderer: "native-css"` and an empty `native-css-compat.json`.
3. **The eight renderer/subsystem features** above, each against the numbers recorded in its family PRD.
