---
prd_contract: v1
---

# PRD-270 — no lighting node ships web-only

**Status: SUPERSEDED 2026-10-03 — folded into
[PRD-267](./PRD-267-screen-space-gi-ships-in-the-templates.md) at runbook row C6, which carries this
native proof as its Phase 2 and its "gates PRD-268/269" role as Phase 3's entry. Kept in place with
its text: `docs/PRDs/AGENTS.md` archives *finished* work in `done/`, and a superseded proposal with 0
ticked boxes is not finished. The file below is PROPOSED — filed 2026-08-29, measured at `7e5a9fe1`.
Depends on PRD-266 (landed as
[PRD-278](../done/PRD-278-every-template-ships-the-render-chain-and-says-what-ran.md)) and
[PRD-267](./PRD-267-screen-space-gi-ships-in-the-templates.md); gates
[PRD-268](../rendering/PRD-268-light-that-comes-from-off-screen.md) and
[PRD-269](../done/PRD-269-motion-vectors-or-the-temporal-filters-lie.md). Batch:
[docs/PRDs/lighting](./README.md).

**Priority:** P2 — Its registry guard and conformance-case chain are unwritten, so PRD-268 and PRD-269 stay ungated.
**Goal: every lighting stage this batch turns on is proved to execute on native in the commit that
turns it on.** The root charter's rule — a feature that works on web only is unfinished — is what
disqualified four of the seven shortlisted repos. It has to bind this batch's own work too, or the
evaluation was theatre.

**Complexity:** conformance scenes and registry entries per stage, plus the parity run and the
five registrations each new target needs = **MEDIUM**. Mechanical, and the failure mode is
forgetting one of the five.

## The problem, measured at `7e5a9fe1`

### 1. The conformance registry proves the seam, not what runs through it

`packages/runtime-native/conformance/registry.json` holds 81 cases. `62-postprocessing-pass`
(`required: true`) is the relevant one, and its scene
(`conformance/scenes/shared/postprocessing-pass.js`) asserts precisely three things: the pipeline is
a `THREE.RenderPipeline`, the scene-pass and output values are TSL nodes, and
`pipeline.outputNode === outputNode`. It draws a sphere and a torus knot with
`MeshBasicMaterial`.

That is a good proof that **an** output node installs and renders natively. It is no evidence
whatsoever that `ssgi()`, `ssr()`, `gtao()`, a denoiser, a temporal resolve, godrays, or a probe
sample compile and produce correct pixels through wgpu-native on Android or Dawn on desktop. Those
are the nodes with the heavy TSL — `Loop`, `outputStruct`, `countOneBits`, `shiftRight`,
multi-target writes — and the seam case exercises none of it.

The lighting categories that do exist (`lights`, `shadows`) cover analytic lights and shadow maps,
which is the pre-existing recipe, not this batch.

### 2. Nothing forces a new stage to register anything

A stage can be added to the chain in `packages/core` and turned on in seven templates with no
conformance case, and every gate stays green. The web lane will look correct and the native lane
will silently differ, or fail to compile a shader, or fall back — and the first report of it will
come from a device run days later, attributed to something else. The batch's own evaluation says
GLSL-only libraries are unusable *because* of this seam; a TSL node that happens not to compile on
wgpu-native is the same failure wearing the right file extension.

## What ships

1. **One conformance case per lighting stage this batch enables**, under a new `lighting-gi`
   category in `packages/runtime-native/conformance/registry.json`, each with a shared scene under
   `conformance/scenes/shared/`. Minimum set, added as their owning PRD lands: `ssgi`, `ssr`,
   `gtao`, `denoise`, `temporal-resolve`, and — from PRD-268 and PRD-269 — `probe-volume-sample`
   and `velocity-buffer`.

   Each scene follows the `62-postprocessing-pass` shape: a structural assertion that the stage is
   actually installed in the graph (not merely requested), plus geometry chosen so the effect is
   *visible* in the capture. A GI case lit so flatly that the tolerance passes with the effect off
   proves nothing — each scene states, in a comment, which pixels change when its stage is removed.

2. **Tolerances set from a measured web-vs-native diff, not copied.** The existing rendering cases
   use `pixelMismatchRatio: 0.01, perceptualDeltaE: 3.0`. Temporal and stochastic stages will not
   hold that on the first frame; each new case records the measured diff and sets its tolerance
   from it, with the number in the verification file rather than tuned until green.

3. **A registration guard.** A spec that fails when a stage name known to the PRD-266 chain has no
   corresponding registry case. Hand-maintained parallel lists drift here — this repository already
   carries several — and a new native target needs five registrations, not one.

4. **The parity run.** `pnpm parity` green for the new category on the desktop lane at minimum,
   with the Android lane run where the device is available and its absence stated plainly where it
   is not. No result claims a platform it did not execute.

## Acceptance criteria

1. **A stage in the chain without a conformance case fails the suite.** Adding a stage name to the
   chain's stage table with no registry entry turns the registration guard red, naming the stage.
   *Mutation:* delete one existing registry entry for an enabled stage and the guard goes red —
   pasted before the fix.

2. **Each new case fails when its stage is removed.** For every case added, removing that stage
   from the scene's graph exceeds the case's own tolerance. *Mutation:* this is the case's own
   red-green — a scene whose capture is unchanged by removing its subject is a case that tests
   nothing, and the paste proves it is not one.

3. **The native capture is a real capture.** Each case produces a non-blank frame and reports the
   adapter it ran on; a run that cannot name its adapter fails rather than passes. *Mutation:*
   force the blank-capture path and the case reports `TN_CAPTURE_BLANK` rather than green.

4. **Desktop parity is green for the whole category before any dependent PRD is called done.**
   PRD-267 and PRD-268 do not close on a web-only result. *Mutation:* none — this is a gating
   criterion, and the evidence is the pasted `pnpm parity` output in `docs/verification/`.

5. **Census and registry stay generated.** `pnpm census` runs in the same commit as the
   registry change; hand-edited counts fail the gate.

## Out of scope

iOS execution, which follows the same registrations but has its own lane and its own device
availability. Performance parity — this PRD proves the stages *run and look right* natively; frame
cost on device is a separate measurement and belongs in
`docs/verification/runtime-perf-state.md` rather than here.

## Verification

`pnpm typecheck && pnpm lint && pnpm test`; `pnpm native:build` and `pnpm native:verify:desktop`;
`pnpm parity` for the `lighting-gi` category with output pasted; `pnpm census`. Run the runtime-native
suite deliberately — a red there aborts before the root suite's tests execute, which reads as a
green root suite that never ran.
