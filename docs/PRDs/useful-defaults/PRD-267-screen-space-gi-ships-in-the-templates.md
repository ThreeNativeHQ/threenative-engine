---
prd_contract: v1
---

# PRD-267 — off-screen GI: the look ships in the templates, the light off screen, the native proof

**Status: CONSOLIDATED — 2026-10-03, at runbook row
[C6](../open-world/RUNBOOK-machinefall-120fps-with-fab-quality.md).** Filed 2026-08-29, measured at
`7e5a9fe1`. This file is now the single plan for off-screen GI. It keeps PRD-267's own scope and
folds in the three siblings that had been PROPOSED with 0 boxes since 2026-08-29:
[PRD-245](../rendering/PRD-245-indirect-light-is-a-node-the-game-composites.md) (the charter veto,
the borrowed architecture, the cost verdict), [PRD-268](../rendering/PRD-268-light-that-comes-from-off-screen.md)
(the off-screen mechanism) and [PRD-270](./PRD-270-no-lighting-node-ships-web-only.md) (the native
proof). All three are marked SUPERSEDED on 2026-10-03 and **left where they are**: `docs/PRDs/AGENTS.md`
files *finished* work in `done/` and *blocked-only* work in `BLOCKED/<reason>/`, and a superseded plan
is neither — it has no ticked box to preserve, so archiving it would lose the decisions it records.
**Nothing here has been executed. 0 boxes are ticked.**

The abstraction this PRD used to depend on — `PRD-266`, which filed as the browser-lane PRD
([PRD-266](../tooling/PRD-266-the-hot-reload-proof-and-the-browser-lane-run-anywhere.md)) — **landed as
[PRD-278](../done/PRD-278-every-template-ships-the-render-chain-and-says-what-ran.md)**. Read the
sources' "depends on PRD-266" lines as satisfied, and see *What landed since filing* below for the
five claims that filing date made stale.

**Goal: a scaffolded game looks lit by bounced light on the first run, from source the game owns and
can delete, on the same lane the player is on.** This is the adopt-upstream half of the batch
evaluation: no code is vendored, nothing new is installed, every appearance decision lands in
generated user source, and every stage it turns on is proved to execute natively in the commit that
turns it on.

**Complexity:** Phase 1 is **LOW** in mechanism, **MEDIUM** in taste. Phase 2 is **MEDIUM** and
mechanical — the failure mode is forgetting one of the five registrations a new native target
needs. Phase 3 is **HIGH**: a WebGPU port of an upstream WebGL class plus native parity. Budget it as
the long pole and land it last. Batch: [docs/PRDs/lighting](./README.md).

## What landed since filing — five claims that are now stale, and what replaced them

| The sources said | The tree today |
| --- | --- |
| "None of this is reachable today because there is no chain to install it into." | The chain is `WorldEnvironment`, in every one of the **13** templates' `src/render/worldEnvironment.ts`, built by `postprocessing.ts` from per-tier presets in `quality.ts` (PRD-278). Templates at filing were seven. |
| "All seven templates ship the same lighting recipe: four analytic lights … and bloom-only post." | The recipe is still four analytic lights, and `gtao` is now on by default in every template's presets. **`ssgiEnabled: false` is still what the shipped presets say** — that is the part of Phase 1 that is left. |
| Phase 1 writes the `WorldEnvironment` request into `postprocessing.ts`. | It writes the request's **tier choices** into `quality.ts` — which that file's header already tells the game to edit for exactly this. |
| A scenario asserts `worldEnvironment.tier` is not `off` and the SSGI stage is in `environment.applied`. | The observation is `renderChain`: `tier`, `stages.includes`, `order` and `contributions.graphOutputChanged`, asserted as `assert.renderChain` behind the `runtime.renderChain` capability (`packages/playtest/src/assertion-schema.ts`). |
| `lighting.ts` "gains the `ClusteredLighting` opt-in". | Unchanged, and still Phase 1's job. |

## The problem, measured at `7e5a9fe1`

### 1. The analytic recipe is the ceiling of what analytic lights reach

No surface is lit by the surface next to it, so a red wall never tints the white floor beside it, and
an unlit interior corner reads as flat ambient rather than as shadow with bounce in it.

### 2. Screen-space GI is blind to everything off screen, by construction

`ssgi()` marches the depth buffer. Light from behind the camera, behind a wall, or outside the
frustum contributes nothing, so panning the camera changes the lighting of surfaces that did not
move. In an interior — the case Lumen is bought for — most bounce arrives from exactly there. No
amount of `sliceCount` fixes this; it is not a quality setting, it is the technique's domain.

### 3. Upstream ships the classes, and one of them does not run here

`three@0.185.1` — already the catalog dependency — ships all of this in `three/addons/tsl/display/`,
WebGPU, MIT, uninstalled effort:

| Node | What it buys |
| --- | --- |
| `SSGINode` | Screen-space diffuse GI. Its docblock cites `cdrinmatane/SSRT3` and exposes the same `sliceCount`/`stepCount` presets. |
| `SSRNode` | Screen-space reflections |
| `GTAONode` | Ground-truth ambient occlusion, contact darkening SSGI does not resolve |
| `DenoiseNode` / `RecurrentDenoiseNode` / `BilateralBlurNode` | Removes the sample noise both of the above produce |
| `TRAANode` | Temporal resolve |
| `GodraysNode` | Raymarched godrays. Its docblock recommends a bilateral blur after it. |
| `ClusteredLighting` / `DynamicLighting` (`three/addons/lighting/`) | Forward+ clustering for many emissive lights; batched light uniforms so adding a light stops recompiling materials |

`three/addons/lighting/LightProbeGrid.js` is the one that closes the §2 gap — a 3D grid of L2
spherical-harmonic irradiance probes with a `CubeCamera` bake, an SH projection pass and a padded 3D
texture atlas — and it cannot run here. Its own docblock says:

> Note that this class can only be used with `WebGLRenderer`. A version for `WebGPURenderer` will
> be added at a later point.

Confirmed by its imports: `WebGL3DRenderTarget`, `WebGLCubeRenderTarget`, `WebGLRenderTarget`,
`ShaderMaterial`. The native runtime is `WebGPURenderer`-only (`packages/runtime-native/AGENTS.md`),
so the class as shipped is unreachable on desktop, Android and iOS — and per the root charter a
web-only feature is unfinished. **This is the repo-mining item of the batch: not a vendor, a port.**

### 4. The conformance registry proves the seam, not what runs through it

`packages/runtime-native/conformance/registry.json` holds 81 cases. `62-postprocessing-pass`
(`required: true`) is the relevant one, and its scene asserts precisely three things: the pipeline is
a `THREE.RenderPipeline`, the scene-pass and output values are TSL nodes, and
`pipeline.outputNode === outputNode`. It draws a sphere and a torus knot with `MeshBasicMaterial`.

That is a good proof that **an** output node installs and renders natively. It is no evidence
whatsoever that `ssgi()`, `ssr()`, `gtao()`, a denoiser, a temporal resolve, godrays, or a probe sample
compile and produce correct pixels through wgpu-native on Android or Dawn on desktop. Those are the
nodes with the heavy TSL — `Loop`, `outputStruct`, `countOneBits`, `shiftRight`, multi-target writes —
and the seam case exercises none of it. The lighting categories that do exist (`lights`, `shadows`)
cover analytic lights and shadow maps, which is the pre-existing recipe, not this batch.

## The hard veto, answered first

> **The test, and it is a hard veto:** can the game change the appearance completely without editing
> framework code? If any answer is no, the whole thing ships as generated source in `src/render/`.
> There is no partial credit and no "sensible default" that a game reaches through a config option —
> `postprocessing: ['bloom']` is still the v1 mistake, and it is still removed.
> — CHARTER §5b

| Appearance decision | Who makes it under this design |
| --- | --- |
| Whether indirect light appears at all | **The game.** If `src/render/postprocessing.ts` does not reference the node, nothing changes on screen. |
| How it is composited — added, multiplied, energy-conserving, tonemapped before or after | **The game**, in its own output node. |
| Bounce strength, colour bleed, saturation | **The game**, as TSL it writes. |
| Materials, albedo, lights that feed the solve | **The game.** They already do. |
| Surfel budget, ray count, update cadence | The framework, as **performance** parameters with no look defaults, documented in milliseconds rather than in adjectives. |

The framework owns the off-screen volume's placement, bake scheduling, atlas layout, GPU upload and
sample node — the same kind of thing `GPUParticles3D` owns — and hands back **one TSL node**. It
ships no preset, no default composite and no `gi: true` config flag. A game that wants off-screen light
writes one line in a file it owns:

```ts
// src/render/postprocessing.ts — generated for you, edit or delete it freely
world.outputNode = fxaa(directLight.add(probeVolume.indirectLight.mul(0.8)));
```

That line is the whole opt-in, and it is in the game's repository. Deleting it removes the feature,
which is also this PRD's negative control. **How the light arrives** is the one thing the framework
owns outright: probe placement, bake scheduling, atlas layout, GPU upload and the sample node are
exactly the plumbing every game would repeat and none should write. The game supplies volume bounds,
probe density and when to re-bake. The game supplies nothing about colour, intensity or falloff —
those come out of the scene it already authored.

The split already exists upstream, so this PRD is not inventing it:
`jure/webgiya/src/main.ts:709-722` assembles `postProcessing.outputNode` from `directLight` and
`indirectLight` in application code. Read §11.1 honestly: *"something that passes both becomes
framework code once one game writes it more than twice"* — **not yet satisfied by count**, and the
owner's call on whether the framework leads here is open. See `## Blocked on`.

### Phase 1 — the look ships in generated source (browser lane, `packages/core` gains nothing)

Every knob lives in `templates/*/src/render/`. Per-template tuning is the point: one preset for every
genre is the preset system the charter closed with evidence.

- [ ] **Bounce is installed in every template and each scenario names the stage.** proof:
      `pnpm test:templates`, with the red pasted in the PR body.
- [ ] **The whole template lane is green, not green up to the first failure.** proof:
      `pnpm test:templates`, full output naming every template reached.
- [ ] **The look is baselined and rated, not asserted by eye.** proof: `pnpm visuals:baseline &&
      pnpm visuals`, plus the `pnpm visuals:ab --raters 3` bundle in the PR body.
- [ ] **The frame cost is measured, not assumed.** proof: the per-template `TN_FRAME_BUDGET` table in
      the PR body.

      One playtest scenario per template asserts `renderChain.stages.includes: ["ssgi"]`, that the
      tier is not `off`, and that `contributions.graphOutputChanged` names `ssgi` — a named stage,
      not a screenshot diff, which colour drift alone could satisfy. *Red recorded first:* remove the
      SSGI request from one template's `quality.ts` and its scenario fails naming the missing stage.

      The second box waits on the known capture-lane red in the shooter template
      (`TN_CAPTURE_BLANK 0.01987`, which aborts the gate before `starter` is reached): diagnose or
      explicitly quarantine it before claiming green. A gate that stops early has not tested what it
      did not reach.

      The fourth box records each template's `render` phase before and after, on the browser lane, at
      a fixed resolution; a template whose `render` phase more than doubles drops to the next tier
      down in its own `quality.ts` and the number is recorded. Desktop A/Bs read `render.p50`, never
      fps — the Xvfb present throttle makes desktop fps meaningless.

Per-template intent, carried from filing and re-measured against what the presets say now:

- **starter, minimal** — SSGI at the low preset plus denoise, on top of the GTAO already on. Cheap
  enough for the first-run machine; the point is that bounce is visible, not that it is maximal.
- **action-rpg** — SSGI medium, SSR on the floor materials, godrays through the sky rig.
- **shooter** — SSGI low with TRAA; frame time is the constraint, and this template already owns the
  tightest capture tolerance in the visuals gate.
- **platformer, tower-defense, racing, rain, snow, sailing, puzzle, rts, runner** — SSGI low, GTAO, no
  SSR. Stylised palettes get little from reflections and pay full price.

`lighting.ts` in each template gains the `ClusteredLighting` opt-in **commented, with the numbers
that make it worth switching on** — the existing four-light rig stays the default because it is
correct for four lights.

Two structural properties stay true and are cheap to keep proving:

- **Deleting the file still boots the game.** With `postprocessing.ts` emptied to a no-op, the template
  still reaches a non-blank capture, and no package-side code reads a symbol from it. Any package
  code that does turns the delete-the-file spec red — the charter's "change the appearance completely
  without editing package code" test, made executable. proof: the delete-the-file spec in
  `packages/create-threenative/__tests__/`.
- **No appearance constant in a package.** Every SSGI/SSR/GTAO knob above is a template literal.
  proof: `pnpm exec vitest run packages/create-threenative/__tests__/template-quality.spec.ts`, whose
  preset-literal and quality-module checks already cover this folder.

### Phase 2 — every stage this batch turns on is proved to execute on native

The charter's rule — a feature that works on web only is unfinished — is what disqualified four of the
seven shortlisted repos. It has to bind this batch's own work too, or the evaluation was theatre. This
phase is where "no lighting node ships web-only" stops being a sentence.

- [ ] **One conformance case per stage this batch enables, under a new `lighting-gi` category.** proof: `pnpm native:build && pnpm native:verify:desktop`, each case's red-green pasted.
- [ ] **A stage with no conformance case fails the suite.** proof: the registration-guard spec, red
      pasted from deleting an existing entry, then green.
- [ ] **Tolerances are set from a measured web-vs-native diff, not copied.** proof: the measured diff
      beside each case's tolerance in the PR body.
- [ ] **Desktop parity is green for the whole category before any dependent phase is called done.** proof: `pnpm parity` for `lighting-gi`, pasted.
- [ ] **Registry and census stay generated.** proof: `pnpm census` in the same commit as the registry
      change.

      The first box covers `ssgi`, `ssr`, `gtao`, `denoise`, `temporal-resolve`, `godrays`, and — from
      Phase 3 — `probe-volume-sample`; `velocity-buffer` joins when
      [PRD-269](../done/PRD-269-motion-vectors-or-the-temporal-filters-lie.md) lands. Each scene
      follows the `62-postprocessing-pass` shape: a structural assertion that the stage is actually
      **installed in the graph**, not merely requested, plus geometry chosen so the effect is
      *visible*. Each scene states in a comment which pixels change when its stage is removed, and
      removing that stage must exceed the case's own tolerance.

      The second box is a spec that fails when a stage name known to the chain has no registry entry,
      naming the stage. Hand-maintained parallel lists drift here — this repository already carries
      several — and a new native target needs five registrations, not one.

      The third box: the existing rendering cases use `pixelMismatchRatio: 0.01,
      perceptualDeltaE: 3.0`, and temporal and stochastic stages will not hold that on the first
      frame. Each new case records its measured diff and sets its tolerance from it, with the number
      in the PR body rather than tuned until green.

      The fourth box: each case produces a non-blank frame and **names the adapter it ran on**; a run
      that cannot name its adapter fails rather than passes, and the blank-capture path reports
      `TN_CAPTURE_BLANK` instead of green. Android runs where a device is available, and its absence
      is stated plainly where it is not.

Phase 1 and Phase 2 are ordered deliberately, and they interleave: a stage turned on in the templates
before its conformance case exists is a stage that "will silently differ, or fail to compile a shader,
or fall back — and the first report of it will come from a device run days later, attributed to
something else". Each case lands in the same commit as the stage it covers.

### Phase 3 — light from off screen, as mechanism in `packages/core`

`packages/core/src/render/probe-volume.ts`, exported from `@threenative/core`:

- **Bake** — render each probe's surroundings and project to L2 SH, on `WebGPURenderer`. Upstream's
  cubemap-plus-SH-projection path reimplemented with `three/webgpu` render targets and a TSL
  projection pass; the SH maths, the atlas padding rule (`ATLAS_PADDING = 1` per sub-volume boundary)
  and the repack layout are ported as-is, since that is the part worth taking. The padding exists so
  hardware trilinear filtering does not bleed across sub-volume seams; drop it and the seams show.
- **Storage** — one padded 3D texture atlas, sub-volume per axis-split, sized from the requested
  density.
- **Sample** — a TSL node returning irradiance at a world position, composable into the chain
  **before** `ssgi()`, so screen-space GI adds on-screen detail on top of the off-screen base rather
  than competing with it.
- **Scheduling** — bakes amortised across frames against the `FrameBudget` `render` phase, in the
  `ResolutionScaler` shape: a pre-registered budget, never a synchronous stall. A full bake of a dense
  volume must never land in one frame the player is watching.
- **Reporting** — probe count, atlas bytes, bake progress, and staleness (how many frames since the
  probes covering the camera were last baked), under a `TN_PROBE_VOLUME` marker. Sampling probes
  that have never been baked reports a stale/unbaked state; it does not return black as though it
  were an answer.

**Deliberately static-lighting-first.** Probes bake on demand and on request, not every frame. That is
not Lumen's fully dynamic path and the docs must say so plainly rather than imply it.

- [ ] **A surface is lit by an emitter it cannot see.** proof:
      `pnpm exec vitest run packages/core/__tests__/probe-volume.spec.ts`, red then green, plus the
      off-screen-emitter playtest with its capture pasted.
- [ ] **No WebGL path survives the port.** proof: the same spec's no-`WebGL*RenderTarget` block, red
      from importing the upstream class.
- [ ] **Atlas seams do not bleed.** proof: that spec's boundary block, with `ATLAS_PADDING = 0` red.
- [ ] **A bake never stalls a frame.** proof: that spec's bake-budget block, a synchronous one-call
      bake red.
- [ ] **It fails closed on malformed input.** proof: that spec's fail-closed block, a clamped volume
      red.
- [ ] **The charter veto holds on the shipped port.** proof: the delete-the-line spec, the four greps
      in the PR body, and the draw-call/timing comparison against HEAD.
- [ ] **The cost verdict, with the authority to refuse.** proof: the paired arms' `render.p50`
      numbers recorded in this PRD (see `## Blocked on` for the device).

      The first box is a fixture scene with a saturated emissive panel outside the camera frustum and a
      neutral wall inside it. With the volume baked, the wall's sampled irradiance carries the
      emitter's hue above a pinned threshold; with the volume absent it does not. *Red first:* return
      zero from the sample node and the spec fails on the hue delta — a screenshot-only assertion
      would not, since bloom and tonemapping move the same pixels.

      The second box: `probe-volume.ts` and its transitive imports reference no `WebGL*RenderTarget`
      and no `three/addons/lighting/LightProbeGrid.js`. This is the guard that keeps the port a port.

      The third box: sampling either side of a sub-volume boundary returns values consistent with
      their own sub-volume within tolerance.

      The fourth box: baking a volume larger than the per-frame budget spreads across frames with no
      single frame exceeding the budget by more than the pre-registered slack.

      The fifth box: zero or negative density, an inverted or degenerate bounds box, or a density
      whose atlas would exceed the device texture limit throws at construction with the limit named —
      never a silently clamped volume. *Red first:* clamp instead of throwing and this box's proof
      goes green, which is the bug.

      The sixth box is the charter test made executable: the sample is one TSL node the game
      composites in its own `src/render/postprocessing.ts`; deleting that line reverts the frame to the
      direct-only baseline; changing the emitter's material colour changes the light with no framework
      file edited; there is no preset, no `gi: true`, no default composite and no appearance constant
      in `packages/` (grep pasted for each pattern); and a game that never constructs the node has
      identical draw calls and identical frame timing to HEAD.

      The seventh box is PRD-245's authority to refuse, kept whole: paired arms, on/off, cool device,
      cold launch. If the cost does not fit a 30 fps floor with headroom, this PRD **closes as REFUSED
      ON COST** with the number recorded and the volume is deleted rather than shipped disabled — a GI
      feature that ships and is then always turned off for performance is worse than no GI feature,
      because the manifest advertises it. **That outcome is a success for this document, not a
      failure:** a subsystem admitted without a device number would be the largest unmeasured thing in
      the repository. The perf finding also lands in
      [runtime-perf-state.md](../../verification/runtime-perf-state.md).

- [ ] **The capability is discoverable in plain words.** proof: `pnpm build` in the same commit as the
      regenerated `packages/create-threenative/capabilities.json`.

      The manifest entry is phrased so a plain-words search — *"light bouncing from a room I cannot
      see"* — finds it.

## Acceptance criteria

Preserved from the four sources, one claim per box, each naming the proof that may tick it. Per-phase
boxes above are the progress record; these close the PRD.

**The look (PRD-267).**

- [ ] A scaffolded template renders bounced light on the browser lane: for each template the scenario asserts the SSGI stage is in the applied stage list and the tier is not `off`. proof: `pnpm test:templates`.
- [ ] `pnpm visuals:baseline` is regenerated in the same commit and `pnpm visuals` is green afterwards, with the A/B pair pasted. proof: `pnpm visuals:baseline && pnpm visuals`.
- [ ] Emptying `postprocessing.ts` to a no-op still reaches a non-blank capture, and no package code reads a symbol from that file. proof: the delete-the-file spec.
- [ ] `pnpm test:templates` is green on every template, not just up to the first failure. proof:
      `pnpm test:templates`.
- [ ] Each template's `render` phase from `TN_FRAME_BUDGET` is recorded before and after on the browser lane at a fixed resolution. proof: the per-template table in the PR body.

**The native proof (PRD-270).**

- [ ] A stage in the chain without a conformance case fails the suite, naming the stage. proof: the
      registration-guard spec, red from deleting an existing entry, then green.
- [ ] Every case added fails when its stage is removed from its scene's graph, beyond the case's own tolerance. proof: each case's own red-green, pasted.
- [ ] Each case produces a non-blank frame and names the adapter it ran on. proof:
      `pnpm native:verify:desktop` output.
- [ ] Desktop parity is green for the whole `lighting-gi` category before any dependent PRD is called done. proof: `pnpm parity` output pasted.
- [ ] `pnpm census` runs in the same commit as the registry change; hand-edited counts fail the gate. proof: `pnpm census`.

**The off-screen mechanism (PRD-268, under PRD-245's veto).**

- [ ] A fixture scene shows a surface lit by an emitter outside the frustum above a pinned hue threshold, and shows nothing without the volume. proof: `pnpm exec vitest run packages/core/__tests__/probe-volume.spec.ts` plus the off-screen-emitter playtest.
- [ ] `probe-volume.ts` and its transitive imports reference no `WebGL*RenderTarget` and no `three/addons/lighting/LightProbeGrid.js`. proof: that spec's no-webgl-import block.
- [ ] Sampling either side of a sub-volume boundary is consistent within tolerance, and `ATLAS_PADDING = 0` fails it. proof: that spec's boundary block.
- [ ] No single frame's `render` phase exceeds the pre-registered bake budget by more than the slack, and a synchronous one-call bake fails it. proof: that spec's bake-budget block.
- [ ] Zero or negative density, a degenerate bounds box, or an atlas over the device texture limit throws at construction with the limit named. proof: that spec's fail-closed block.
- [ ] Sampling never-baked probes reports a stale/unbaked state through `TN_PROBE_VOLUME` instead of returning black. proof: that spec's staleness block, red when the field is dropped.
- [ ] It runs on native through a conformance case from Phase 2, on the desktop lane at minimum, or this PRD does not close. proof: `pnpm parity` for `probe-volume-sample`.
- [ ] A shipped template shows light from off screen in a measured A/B. proof: the A/B capture pair in
      the PR body.
- [ ] Changing the emitter's material colour changes the light, with no framework file edited. proof:
      the colour-change scenario.
- [ ] No preset, no `gi: true`, no default composite, no appearance constant in `packages/`. proof: the
      four greps pasted in the PR body.
- [ ] A game that never constructs the node has identical draw calls and identical frame timing to HEAD. proof: the draw-call/timing comparison.
- [ ] Frame cost on a physical Pixel 8 is recorded, and this PRD states whether it passed or was refused on it. proof: the paired device arms — **see `## Blocked on`: the physical device is not attached today, so the interim number is the emulator or attached-device arm, labelled as such.**
- [ ] `pnpm budgets` passes, including §10b's line-count justification if the subsystem crosses it. proof: `pnpm budgets`.

## Decisions

- **2026-10-03 — three PRDs superseded into this one, in place, not archived.** Runbook row C6 asked
  for a merge or a split into at most 3 phases. `docs/PRDs/AGENTS.md` files finished work in `done/`
  and blocked-only work in `BLOCKED/<reason>/`; a superseded proposal with 0 ticked boxes is neither,
  so PRD-245, PRD-268 and PRD-270 keep their files, their text and their borrow maps, and carry a
  SUPERSEDED status pointing here. Owner instruction for this consolidation.
- **2026-10-03 — the probe volume is the shipped off-screen mechanism; the surfel port is not built.**
  PRD-245's surfel system (`packages/core/src/gi/`, a 7 500-line port of `jure/webgiya`) is a
  *different algorithm* for the same goal, not a phase of it; building both in one plan would be two
  mechanisms racing for the same pixels. Its charter constraints (the veto above, one TSL node, the
  one-line opt-in) and its measurement discipline survive as Phase 3's rules; its file map and borrow
  map survive below for whoever reopens it. **It is reopened only when probe density is *measured* to
  be the limiting factor** — the same trigger PRD-268 gave voxel cone tracing.
- **2026-10-03 — Phase 2 runs alongside Phase 1, not strictly after it.** Each conformance case lands
  in the same commit as the stage it covers. Serialising them would mean shipping web-only stages on
  purpose for one phase.
- **2026-10-03 — 3 phases and 17 phase boxes, against R5's "about 8".** R5's remedy for bigger work
  is a split into separate PRDs; runbook row C6 and the owner asked for one plan instead, so the count
  follows from preserving four files' criteria with one claim per box. Merging boxes to hit the count
  would make them untickable. If Phase 3 slips, split *that* into its own PRD rather than shrinking
  these boxes.
- **2026-10-03 — the `PRD-266` dependency is retired; the chain landed as PRD-278.** Filing-date
  claims about the chain, the template count and the playtest assertion vocabulary are corrected in
  *What landed since filing* rather than left to mislead the executor.

## Blocked on

- **A physical Pixel 8** for PRD-245's authority-to-refuse cost arm. Attempted 2026-10-03: `adb
  devices` lists none. Until a device is attached, the cost verdict runs on the emulator or an
  attached-device lane via `perf --logcat`, is labelled as such in the box above, and the PRD does not
  claim the physical-device number.
- **An owner call on whether the framework leads off-screen light at all.** §11.1's clause — *"something
  that passes both becomes framework code once one game writes it more than twice"* — is not satisfied
  by count, and PRD-245 said so rather than pretending. If the answer is "wait for a second game to
  write it", Phase 3 parks with that recorded and the game's own version stays writable against
  buffers the framework already maintains.

## Out of scope

Voxel cone tracing (`compix/VoxelConeTracingGI`) — the technique that would beat this on quality and
the only shortlist entry worth revisiting later; reopen only when probe density is measured to be the
limiting factor. Specular probe fallback: SSR's off-screen blind spot has the same shape and the same
fix (sample the probe atlas as a rough reflection fallback), filed separately once the diffuse volume
is measured — adding it here doubles a PRD that is already the long pole. Probe relighting without a
re-bake.

Motion vectors ([PRD-269](../done/PRD-269-motion-vectors-or-the-temporal-filters-lie.md)): until
they land, TRAA is requested only on templates without skinned characters, and the reason is written
in the file.

iOS execution, which follows the same registrations but has its own lane and its own device
availability. Performance *parity* — Phase 2 proves the stages run and look right natively; frame cost
on device is Phase 3's single measurement, recorded in
[runtime-perf-state.md](../../verification/runtime-perf-state.md).

## Kill switch

§11.2 applies retroactively and unsentimentally. Phase 3's cost verdict has the standing to delete
the subsystem, and Phase 1's frame-cost table has the standing to turn a stage back off before it
ships. Neither is a formality: a GI system that ships and is then always turned off for performance is
worse than no GI system, because the manifest advertises it.

## Borrow map — where to read what

Read these before writing anything; they are the reference, not the dependency. Source of the borrowed
architecture: [`jure/webgiya`](https://github.com/jure/webgiya), MIT, cloned at depth 1 on 2026-08-28
and read (7 509 lines across `src/`). **Nothing is copied.** Pinned to the commit PRD-245 was written
against, so the line numbers still mean something: **`jure/webgiya` @ `0cd7f968`**.

| To implement | Read |
| --- | --- |
| probe bake + SH projection (Phase 3's port target) | `three/addons/lighting/LightProbeGrid.js` — WebGPU-only reimplementation; the SH maths, `ATLAS_PADDING = 1` and the repack layout are the parts worth taking |
| surfel pool and allocation (reopened route only) | `src/surfelPool.ts:1-319`, `src/surfelAllocatePass.ts:1-298` |
| the spatial hash grid (reopened route only) | `src/surfelHashGrid.ts:1-934` |
| ray integration (reopened route only) | `src/surfelIntegratePass.ts:1-1266` |
| coverage detection and ageing (reopened route only) | `src/surfelFindMissingPass.ts:1-595`, `src/surfelAgePass.ts:1-186` |
| the resolve that produces the node we hand back (reopened route only) | `src/surfelGIResolvePass.ts:1-373` |
| GPU-computed indirect dispatch args (reopened route only) | `src/surfelDispatchArgs.ts`, `src/integratorDispatchArgs.ts` |
| **the line that stays in the game**, and the proof the split already exists upstream | `src/main.ts:709-722` — `postProcessing.outputNode = fxaa(directLight.add(indirectLight))` |
| **do NOT borrow** — look and demo scaffolding | `src/lighting.ts`, `src/content.ts`, `src/ui.ts` |

The per-template numbers in Phase 1 should start from what the working chain prototype measured
rather than from upstream's generic presets — evidence in
[lighting-chain-2026-08-30.md](../../verification/lighting-chain-2026-08-30.md).

## Verification

`pnpm typecheck && pnpm lint && pnpm test`, then `pnpm test:templates` end-to-end, `pnpm visuals` with
the A/B bundle, `pnpm native:build && pnpm native:verify:desktop`, `pnpm parity` for `lighting-gi`,
`pnpm census` and the per-template frame-budget table. Run the runtime-native suite deliberately — a
red there aborts before the root suite's tests execute, which reads as a green root suite that never
ran. **No result in this PRD claims a platform it did not execute.**