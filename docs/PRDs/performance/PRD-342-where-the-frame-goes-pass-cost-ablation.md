---
prd_contract: v1
---

# PRD-342 — where the frame goes: pass-cost ablation

**Status:** PROPOSED — filed 2026-09-03, measured at `43d03e6a`. Batch:
[docs/PRDs/AAA-visuals](../rendering/aaa-visuals-notes.md). Depends on the render chain naming its stages
(`RENDER_CHAIN_STAGE_ORDER`, present at this revision). Source studied:
[TheLongSilence](https://github.com/achimala/TheLongSilence) `tools/passcost.mjs`,
`tools/drawcost.mjs`.

**Priority:** P2 — Proposed runner mode pinning the scaler and toggling one stage; a measurement tool.
**Goal: "which stage is the frame going to?" is one command, not an afternoon.** Every quality tier
in every template is currently a guess about relative cost that nobody has measured on the device
that has to hold it.

**Complexity:** a runner mode that pins the scaler, toggles one stage, samples, restores = **LOW-
MEDIUM**. The work is in the pinning and the honest reporting, not the loop.

## The problem, measured at `43d03e6a`

### 1. `quality.ts` ranks stages by intuition

Every template ships a `quality.ts` that decides which of `bloom`, `ambientOcclusion`, `ssgi`,
`godRays`, `ssr`, `taa`, `motionBlur` and the rest run at each tier. `FrameBudget` attributes a
frame to `hostGap`, simulation and render — but not to a stage *within* render. So a tier that drops
SSR to save a phone is a hypothesis, and a game that turns SSR back on because it looked better has
no way to learn what it cost.

### 2. `TN_RENDER_CHAIN` already says which stages ran; nothing says what each one was worth

The chain reports applied-or-refused per stage with a reason, which is the harder half. Cost is the
missing half, and it is the half a tier decision needs.

### 3. The measurement has two traps this repository has already paid for

- **Pin the resolution controller first.** The reference does exactly this before its first sample:
  with the adaptive scaler live, turning a stage off frees frame time that the controller
  immediately spends on pixels, and the fps delta comes back as approximately zero for every stage.
  The A/B measures the controller, not the stage.
- **Do not report fps on desktop.** This repository's own finding: under a private Xvfb, presents
  throttle and fps is not the signal — desktop A/Bs read `render.p50`, and FPS verdicts belong to
  the device lane. An ablation tool that prints fps on desktop manufactures a false result on the
  most convenient lane.

## What ships

### `packages/playtest` — `perf --ablate`

```sh
node packages/playtest/dist/runner/cli.js <scenario>.playtest.json \
  --url http://127.0.0.1:5173 --server-command "<dev>" --browser-recipe webgpu \
  --ablate bloom,ambientOcclusion,ssgi,ssr,taa
```

The run: pin the scaler (`scale.pinned`, reported as such), warm past the shader-compile window,
sample a baseline, then for each named stage — disable it through the render chain's own seam, wait
out one cooldown, sample, re-enable, wait, next. Output:

```
tier=high  1600x900 @1.0  scale=pinned  metric=render.p50 (desktop: fps is throttled)
baseline                 8.42 ms
without bloom            7.10 ms   (-1.32)
without ambientOcclusion 6.05 ms   (-2.37)
without ssgi             8.39 ms   (-0.03)   <- refused at this tier, see TN_RENDER_CHAIN
...
```

- **The metric is chosen by target, not by the author.** `render.p50` on desktop and in a private
  Xvfb; fps on `--target android` and `--target ios`, where a device is the authority. The header
  says which and why, every time.
- **A stage that did not actually run is called out**, by cross-checking `TN_RENDER_CHAIN`'s
  applied/refused line. A refused stage showing a −0.03 delta is not "cheap", it is "absent", and
  reporting the first is how a tier ends up shipping a stage that never worked. This is the same
  trap as the TSL stages that silently no-op.
- **Fail closed.** A stage named on `--ablate` that the chain does not expose is an error, not a
  skipped row. A run where the baseline and the restored baseline differ by more than a stated band
  reports the run as unreliable rather than printing deltas measured against a moving floor.

### Where the numbers land

One row per stage into the run's observation record, and — for a runtime/core performance finding —
into `docs/verification/runtime-perf-state.md` in place, per the batch exception in
`docs/PRDs/AGENTS.md`, rather than a new `perf`-report file.

## What does not ship

- No automatic tier authoring. This measures; `quality.ts` still decides, in the game's own source.
- No GPU-timestamp breakdown. `gpuMs` exists where the adapter grants `timestamp-query` and belongs
  to a different instrument; this is a whole-frame A/B, which is the honest thing to do where
  timestamps are refused.
- No per-draw attribution.

## Acceptance criteria

1. **The scaler is pinned and says so.** A run against a template reports `scale=pinned` in its
   header and the drawing-buffer size is identical in every sample.
   *Red-green:* remove the pin; a spec asserting constant buffer size across samples goes red, and
   the deltas collapse toward zero — paste the collapsed table, it is the whole point.
2. **A refused stage is never reported as cheap.** A scenario forcing `low` tier ablates a stage the
   tier refuses; the row is marked refused and the run does not print a cost delta for it.
   *Red-green:* drop the `TN_RENDER_CHAIN` cross-check; the row prints `-0.0x` and the spec goes red.
3. **An unknown stage is an error.** `--ablate notastage` exits non-zero with a named error before
   launching a browser.
   *Red-green:* soften to a warning; the CLI spec goes red.
4. **Desktop does not print fps.** A `--target desktop` run's header names `render.p50`; a spec
   asserts no fps verdict appears in desktop output.
   *Red-green:* print fps on desktop; the spec goes red.
5. **Drift is caught.** Baseline and restored-baseline within the stated band, or the run is marked
   unreliable and exits non-zero.

## Out of scope

Native-host pass ablation inside the C++ runtime, and any change to `quality.ts` defaults — those
follow from what this measures, in their own commits.
