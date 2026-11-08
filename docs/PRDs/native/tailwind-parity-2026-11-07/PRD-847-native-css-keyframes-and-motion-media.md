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
- [x] Keyframes run with the clock, and a unit that only needs the clock passes. proof: `parity:tailwind --family PRD-847`, plus `cargo test --release --test animation` in `native/css-ui`
  Evidence: two engine defects, both found by this bar and both fixed where they live.
  `animate-ping` matches Chromium at all five samples (1, 0.999, 0.9959, 1, 1) — the 100 % frame was
  the previous iteration's last frame because Stylo wraps an iteration on a strict `>` (blitz-dom hunk
  15), and 250/500/750 ms measured a 56 px edge miss because `get_client_bounding_rect` reported the
  untransformed box (hunk 16). `tests/animation.rs` proves both, and fails against the previous vendor
  sources.
- [ ] Keyframe units pass at every sample, and the keyframe rows leave the denylist. proof: AC-1
  Evidence: NOT met — 1 of 5 units passes. `transition-discrete` does not discriminate at all: it needs a
  driver that changes a discrete property so that `allow-discrete` has something to defer, which is a
  scene stage this PRD has to add before the cell can prove anything. The keyframe rows cannot leave the
  denylist until the whole family passes.

#### Phase 2: Motion media
**Status:** PARTIAL
**Files:** the Stylo device media hook (vendored), `native/css-ui/src/lib.rs` (delete the workaround), `vendor/PATCHES.md`.

- [ ] `prefers-reduced-motion` matches, and the workaround is gone. proof: AC-2 plus `rg -n 'transition-duration: 0s' packages/runtime-native/native/css-ui/src` returns nothing
  Evidence: NOT met, and root-caused: `motion-safe:bg-red-500` and `motion-reduce:bg-red-500` both score 0.6492 —
  the same wrong frame from both — because Stylo's servo build has no `prefers-reduced-motion` media feature
  (`stylo-0.20.0/servo/media_features.rs` lists `prefers-color-scheme` and none of the preference pair). No
  public API reaches the media-feature table, so the fix is a vendored Stylo hunk (5.6 MB of source for one
  table entry) plus a device input, or a `css-ui` stylesheet rewrite turning the two queries into `all`/`not
  all`. Neither is in this increment; the workaround stays until the media feature exists, because deleting it
  now would only make reduced motion work for transitions the sheet happens to name. This is the family's
  `## Blocked on`: the owner picks the vendor or the rewrite.

#### Phase 3: Starting style and discrete transitions
**Status:** PARTIAL
**Files:** as the meter shows, the guide, the floor.

- [ ] `starting:` and `transition-behavior` pass, and the floor rises. proof: AC-3 plus `parity:tailwind --ratchet`

## Open

Measured with `pnpm --filter threenative-native-css-hud parity:tailwind --family PRD-847`: **1 of 5 units pass**,
1 does not discriminate and 1 is exempt.

- **The bar exists and it works, and it caught two engine defects.** Five samples per motion panel, a virtual
  clock on each subject, the worst sample reported per cell. `animate-ping` now matches at every sample; the
  two defects it found were an iteration boundary that belonged to the next iteration (hunk 15) and a client
  rect that ignored the transform being animated (hunk 16). The browser arm also needed fixing: the pinned
  `currentTime` lands in the next compositor frame, so the capture waits for two animation frames — without
  that, one run measured the 500 ms sample as 0.5984 (the 0 ms frame) and the next as 0.9959.
- **`motion-safe:` and `motion-reduce:` are both wrong, identically.** Both score 0.6492, which is what
  "the media feature does not exist" looks like: the engine resolves neither query, so both cells paint the
  variant's utility and differ from Chromium the same way.
- **`transition-discrete` needs a staged transition,** not a static frame: `transition-behavior` only shows when
  something changes, which is a driver this scene does not have yet.
- **`@starting-style` stays exempt** until the transition driver exists.
