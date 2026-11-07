# PRD-847 — native-css runs keyframe animations and motion media like Chromium

**Status:** PARTIAL
**Priority:** P1 — 3 kits ship `@keyframes` (`animate-pulse`, toasts, hint fades), and AC-1 to AC-3 are what lets them build for native-css.
**Complexity:** 6 (MEDIUM) — 1 to 5 files (+1), Rust crate plus TS build (+2), time-based state (+2), Stylo media patch (+1).
**Owner:** ThreeNative maintainers
**Depends on:** PRD-843
**Batch:** [Tailwind parity, 2026-11-07](README.md)

## Context

- Stylo's `DocumentAnimationSet` (`vendor/blitz-dom-0.3.0-beta.2/src/document.rs:236`) runs CSS
  animations and transitions. The build refuses `animation` and `@keyframes` because no fixture
  proves them, not because a measured gap exists.
- The servo build of Stylo has no `prefers-reduced-motion` media feature, so `motion-safe:` and
  `motion-reduce:` resolve wrong. The engine works around this today by forcing
  `transition-duration: 0s`.
- `starting:` (`@starting-style`) and `transition-behavior: allow-discrete` are unproven.

## Solution

Prove keyframes on the meter's stepped clock first. Fix only what it shows. Add the
`prefers-reduced-motion` media feature to the Stylo device (a vendored Stylo patch, or the media
evaluation hook blitz exposes). When it works, delete the forced-duration workaround, because the
media query then does the job. Delete the `animation`, `animation-name` and `@keyframes` rows from
`native-css-compat.ts`.

## Acceptance Criteria

- [ ] AC-1 [local]: every `animate-*` unit and a custom `@keyframes` unit (fill mode, iteration count, direction, steps) pass the meter at all 5 time samples on crate and host, and the judge returns SAME. proof: `parity:tailwind --family PRD-847` plus `--host`, and the judge on `--sheet PRD-847` — Evidence: pending.
- [ ] AC-2 [local]: `motion-safe:` and `motion-reduce:` match Chromium with reduced motion off and on. proof: `parity:tailwind --family PRD-847 --env reduced-motion` — Evidence: pending.
- [ ] AC-3 [local]: `starting:` and `transition-behavior` units pass the meter and the judge. proof: as AC-1 — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Keyframes on native | game Tailwind `animate-*` → Stylo animation tick in `css-ui` | Keyframe rows deleted from `native-css-compat.ts` | AC-1 |
| Reduced-motion media | host reduced-motion flag → Stylo device media feature | Deletes the forced `transition-duration: 0s` workaround | AC-2 |

## Execution Phases

#### Phase 1: Keyframes proven
**Status:** PARTIAL
**Files:** fixes as the meter shows them, `packages/create-threenative/src/native-css-compat.ts`, its spec.

- [x] The motion bar exists: a motion panel is captured at 0, 25, 50, 75 and 100 % on both subjects, and a cell
  passes only when every sample passes. proof: `parity:tailwind --family PRD-847`
  Evidence: the clock is virtual on both sides — Playwright pauses each `Animation` and sets `currentTime`, the
  engine advances by `drive.json` — and the per-cell report carries the five samples. `animate-ping` measures
  1.0, 0.999, 0.996, 1.0, 0.353 from 0 to 1000 ms: the browser animates and the engine does not.
- [ ] Keyframe units pass at every sample, and the keyframe rows leave the denylist. proof: AC-1
  Evidence: NOT met — `animate-ping` fails at the end of its cycle (SSIM 0.353), so the engine does not run the
  keyframe the browser does. `transition-discrete` still does not discriminate: it needs a staged transition.

#### Phase 2: Motion media
**Status:** PARTIAL
**Files:** the Stylo device media hook (vendored), `native/css-ui/src/lib.rs` (delete the workaround), `vendor/PATCHES.md`.

- [ ] `prefers-reduced-motion` matches, and the workaround is gone. proof: AC-2 plus `rg -n 'transition-duration: 0s' packages/runtime-native/native/css-ui/src` returns nothing
  Evidence: NOT met, and now measured: `motion-safe:bg-red-500` and `motion-reduce:bg-red-500` both score 0.6492 —
  the same wrong frame from both — because Stylo's servo build has no `prefers-reduced-motion` media feature. The
  forced `transition-duration: 0s` workaround is still in `native/css-ui/src`.

#### Phase 3: Starting style and discrete transitions
**Status:** PARTIAL
**Files:** as the meter shows, the guide, the floor.

- [ ] `starting:` and `transition-behavior` pass, and the floor rises. proof: AC-3 plus `parity:tailwind --ratchet`

## Open

Measured with `pnpm --filter threenative-native-css-hud parity:tailwind --family PRD-847`: **0 of 5 units pass**,
1 does not discriminate and 1 is exempt.

- **The bar exists and it works.** Five samples per motion panel, a virtual clock on each subject, the worst sample
  reported per cell. `animate-ping` shows the shape a real gap has: agreement at 0 ms (SSIM 1.0) and a hard
  disagreement at 1000 ms (0.353), because the engine never runs the keyframe.
- **`motion-safe:` and `motion-reduce:` are both wrong, identically.** Both score 0.6492, which is what
  "the media feature does not exist" looks like: the engine resolves neither query, so both cells paint the
  variant's utility and differ from Chromium the same way.
- **`transition-discrete` needs a staged transition,** not a static frame: `transition-behavior` only shows when
  something changes, which is a driver this scene does not have yet.
- **`@starting-style` stays exempt** until the transition driver exists.
