# docs/PRDs/realism-effects — supporting everything that library does, on every platform we ship

**Batch filed 2026-08-30, measured at `1eeecf1e`.** Read `docs/PRDs/AGENTS.md` for filing rules.
This file is the mining record; the PRDs are the work.

The prompt behind it: *"should we port `0beqz/realism-effects` to WebGPU? We should support all the
effects that library supports, on all native platforms too."*

This batch is the file-by-file read that
docs/PRDs/lighting did not do. That batch judged the repo from its
packaging — GLSL, `WebGLRenderer`, the pmndrs `postprocessing` dependency — and reached the right
verdict for the wrong reason on two of its rows. **Three of its factual claims are corrected
below.**

## The answer to the porting question

**Not a port. Fourteen exports: ten installed equivalents, three template effects, and HBAO explicitly uncovered.**

`0beqz/realism-effects` exports fourteen names from `src/index.js`. Against `three@0.185.1` — the
`catalog:` version already in `pnpm-workspace.yaml` — ten have a TSL equivalent in
`three/addons/tsl/display/` or `three/tsl` that runs on `WebGPURenderer` and therefore crosses the
native seam. Three have no upstream counterpart, total 273 lines of fragment shader between them,
and are pure appearance. `HBAOEffect` remains explicitly uncovered because the required blind
comparison has not been run.

So "supporting everything it does" is not a porting project. It is: turn on what is installed,
write three small template effects, fix one real defect that blocks half the set, and prove the
covered surface runs on four targets instead of one.

## Coverage — every export, checked against the installed tree

`realism-effects` `src/index.js`, all fourteen. Under
[PRD-274](./PRD-274-every-export-has-a-named-tested-equivalent.md) this table is **generated from a
fixture and gated**, because a hand-maintained parallel list in this repository drifts.

<!-- BEGIN GENERATED: realism-effects-coverage -->
| `realism-effects` export | Equivalent here | Where it comes from |
| --- | --- | --- |
| `SSGIEffect` | `SSGINode` | `three/examples/jsm/tsl/display/SSGINode.js` |
| `SSREffect` | `SSRNode` | `three/examples/jsm/tsl/display/SSRNode.js` |
| `TRAAEffect` | `TRAANode` | `three/examples/jsm/tsl/display/TRAANode.js` |
| `TemporalReprojectPass` | `TemporalReprojectNode` | `three/examples/jsm/tsl/display/TemporalReprojectNode.js` |
| `PoissonDenoisePass` | `DenoiseNode`, `RecurrentDenoiseNode` | `three/examples/jsm/tsl/display` |
| `MotionBlurEffect` | `motionBlur` | `three/examples/jsm/tsl/display/MotionBlur.js` |
| `SharpnessEffect` | `SharpenNode` | `three/examples/jsm/tsl/display/SharpenNode.js` |
| `VelocityPass` | `velocity`, `VelocityNode` | `three/src/nodes/accessors/VelocityNode.js` |
| `VelocityDepthNormalPass` | `mrt`, `depth`, `normal` | `three/src/nodes` |
| `TAAPass` | `SSAAPassNode`, `TRAANode` | `three/examples/jsm/tsl/display` |
| `HBAOEffect` | not covered | No HBAO implementation is available in the pinned workspace for the required blind GTAO comparison; do not claim GTAO is equivalent until that comparison is run. |
| `LensDistortionEffect` | `lensDistortion` | `packages/create-threenative/templates/starter/src/render/effects/lensDistortion.ts` |
| `SparkleEffect` | `sparkle` | `packages/create-threenative/templates/starter/src/render/effects/sparkle.ts` |
| `GradualBackgroundEffect` | `gradualBackground` | `packages/create-threenative/templates/starter/src/render/effects/gradualBackground.ts` |
<!-- END GENERATED: realism-effects-coverage -->

The last three go to `templates/*/src/render/` and not to a package because charter rule 3 is a veto
over rule 1: anything that decides how the game looks ships as generated source **at any size**.
Each is one fragment function whose every parameter — distortion coefficient, glint threshold, tint
colour — is a look choice. There is no mechanism in them to own.

## Three corrections to the lighting batch, each with its evidence

### 1. Skinned motion vectors are not a gap — upstream shipped them

The lighting README and
[PRD-269](../PRD-269-motion-vectors-or-the-temporal-filters-lie.md) both state that
`realism-effects`' one contribution upstream does not hand you is correct motion vectors for
skinned and instanced geometry.

`three@0.185.1/src/nodes/accessors/Skinning.js:162` guards on `builder.needsPreviousData()` and
assigns `positionPrevious` from a `_previousBoneMatricesData` WeakMap holding the previous frame's
`skeleton.boneMatrices`. That is the same technique as `realism-effects`' `prevBoneTexture`
(`src/temporal-reproject/pass/VelocityDepthNormalPass.js`, `saveBoneTexture`), already in TSL,
already on `WebGPURenderer`.

### 2. Instanced motion vectors are not a gap either — and `realism-effects` never had them

`three@0.185.1/src/nodes/accessors/Instance.js:215-228` does the same thing per instance:
`positionPrevious.assign( previousInstanceMatrixNode.mul( positionPrevious ).xyz )`.

Meanwhile `realism-effects` handles no instancing at all. Its
`VelocityDepthNormalMaterial.js` vertex body reads `position` directly with no instancing chunk,
and its pass stores exactly one `prevVelocityMatrix` uniform per object. It could not have been the
source for this row.

### 3. The real gap is `BatchedMesh`, and it is worse than a gap

`src/nodes/accessors/Batch.js` is 108 lines, imports `positionLocal` and never `positionPrevious`,
and line 92 applies the batching matrix to the current position with no previous counterpart.
`positionPrevious` therefore stays the raw geometry position, and `VelocityNode` differences a
batched current position against an unbatched previous one.

The result is not zero velocity — it is **the sub-draw's entire batching transform, reported as
motion, every frame, on a scene where nothing moves.** `packages/core/src/projection-apply.ts:685`
constructs `BatchedMesh` in this repository's own material lane, so any scene through that lane
with a temporal stage on has it. That is
[PRD-271](./PRD-271-batchedmesh-reports-its-whole-batching-transform-as-velocity.md), and it
supersedes most of PRD-269.

**PRD-269 should be narrowed to its `BatchedMesh` criterion or archived in favour of PRD-271** —
its section 3 premise, *"nothing in this repository produces velocity today"*, is false:
`VelocityNode` exists, `TRAANode` defaults to it (`TRAANode.js:472`), and three of the four geometry
classes are correct.

## Ideas worth taking, and one worth refusing

Read from source, not from the packaging:

- **Which objects may write velocity.** `src/utils/SceneUtils.js`'s `isChildMaterialRenderable`
  excludes anything not `depthWrite`, not `depthTest`, or transparent with zero opacity. Upstream
  has no equivalent — whatever is in the pass writes velocity, and transparent geometry writing
  velocity corrupts reprojection underneath it. An open detail for whoever builds
  [PRD-271](./PRD-271-batchedmesh-reports-its-whole-batching-transform-as-velocity.md) and
  [PRD-272](./PRD-272-velocity-is-opt-in-and-nothing-reports-whether-it-was-on.md); not worth its
  own PRD until measured.
- **Unjitter the projection before measuring velocity.** `VelocityDepthNormalPass.render` sets
  `camera.view.enabled = false` for the pass so TAA jitter does not pollute the vectors. Upstream
  does the same thing more cleanly with `TRAANode.js:291-296`'s `setProjectionMatrix` —
  worth knowing the two are solving the same problem when debugging either.
- **Packing.** `src/gbuffer/shader/gbuffer_packing.glsl` puts velocity in RG, an octahedral world
  normal in B via `packHalf2x16`, and depth in A — one RGBA float target for four things. If MRT
  bandwidth ever shows up in the frame budget, this is the shape of the fix.
- **Refuse the noise seeding.** `src/utils/BlueNoiseUtils.js` seeds its blue-noise index with
  `Math.random()`. Upstream's nodes are frame-indexed instead (`SSGINode.js:374-375`,
  `frameId % 6`) and `three/addons/tsl/display/` contains no `Math.random` at all. Importing the
  `realism-effects` approach would make every frame non-reproducible and quietly break
  `pnpm visuals:ab` against its baselines.

One provenance note: `VelocityDepthNormalMaterial.js`'s first line credits its shader to
`gkjohnson/threejs-sandbox`. The lighting batch dismissed that repo with *"read it for technique;
nothing lands"* — it is in fact the origin of the single most-cited idea in `realism-effects`.

## Licence

`0beqz/realism-effects` is MIT, as is this repository. Nothing is vendored either way: the
equivalents are upstream `three` (MIT, already a dependency) or rewritten in TSL. Where a rewrite
follows a specific algorithm, the header comment names the source file and preserves that file's own
citation.

## The PRDs

| PRD | Title | Depends on | Complexity |
| --- | --- | --- | --- |
| [PRD-271](./PRD-271-batchedmesh-reports-its-whole-batching-transform-as-velocity.md) | a `BatchedMesh` reports its whole batching transform as velocity, every frame, standing still | 266 | MEDIUM |
| [PRD-272](./PRD-272-velocity-is-opt-in-and-nothing-reports-whether-it-was-on.md) | velocity is opt-in through a flag nobody sets, and nothing reports whether it was on | 266 | LOW |
| [PRD-273](./PRD-273-the-three-effects-with-no-upstream-node-ship-as-template-source.md) | the three effects with no upstream node ship as template source, not as package code | 266 | LOW |
| [PRD-274](./PRD-274-every-export-has-a-named-tested-equivalent.md) | every `realism-effects` export has a named, tested equivalent, and the mapping is a gate | 266, 273 | MEDIUM |
| [PRD-275](./PRD-275-every-effect-runs-on-every-target-or-it-does-not-ship.md) | every effect runs on desktop, Android and iOS, or it does not ship | 271–274 | MEDIUM |

**Order:** 272 first — it is small, and it is the instrument that makes 271's red legible instead
of a screenshot argument. Then 271, the one actual defect. 273 and 274 run in parallel with each
other; 273 is a day's work and 274's AO comparison is the only open question in the batch. 275 last
and gates all of them.

**Relationship to docs/PRDs/lighting:** that batch owns the chain seam
(PRD-266), the lighting stages and their templates (267, 268), and their native parity (270). This
batch owns velocity correctness, the non-lighting effects, and native parity for those. PRD-266 is
a hard dependency for everything here; PRD-269 is superseded by PRD-271.
