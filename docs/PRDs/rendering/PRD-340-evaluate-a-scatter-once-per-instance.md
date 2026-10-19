---
prd_contract: v1
---

# PRD-340 — evaluate a scatter once per instance, not once per vertex

**Status:** PROPOSED — filed 2026-09-03, measured at `43d03e6a`. Batch:
[docs/PRDs/AAA-visuals](aaa-visuals-notes.md). Judged with
[PRD-342](../performance/PRD-342-where-the-frame-goes-pass-cost-ablation.md). Source studied:
[TheLongSilence](https://github.com/achimala/TheLongSilence) `src/world/Surface.js:3873-4030`, the
`PLACE_VERT` / `PLACE_FRAG` / `PLACE_FETCH` trio.

**Priority:** P2 — Proposed per-instance scatter evaluation with unrun playtest and malformed-input rules.
**Goal: a game can scatter tens of thousands of props across a world by writing one rule, and pay
for that rule once per prop rather than once per vertex.** Density is most of what separates an AAA
exterior from a Three.js demo, and the naive way to get it is vertex-bound in a way no resolution
control can reach.

**Complexity:** one GPU pass with a storage-buffer output, a fetch preamble the game's material
composes in, and a rejection convention = **MEDIUM-HIGH**. The hard part is the native/WebGPU
storage path and proving it on a device, not the idea.

## The problem, measured at `43d03e6a`

### 1. The framework hands out instancing and then abandons the game at the interesting part

`InstancedBatch3D`, `ClusteredBatch3D` and `ClusteredMesh3D` collapse many copies of a shape into
one draw. None of them helps decide **whether** a copy exists, **where** the ground is under it,
**which way** it faces, or **whether it is in shadow** — and those are exactly the questions a
scatter has to answer per instance. A game asking them in its vertex shader answers them once per
vertex:

```
grep -n 'instanceId\|per-instance' packages/core/src/instanced-batch.ts packages/core/src/compute-driven.ts
(no matches)
```

### 2. The cost is vertex-stage, so the resolution scaler cannot touch it

The reference measured this precisely. Thirty thousand grass tufts of thirty vertices each is
900,000 evaluations of a twenty-two-octave height field per frame to produce 30,000 answers. The
flora bands were **30 ms of a 50 ms frame**, and scaling the render target from 5.7 to 0.7
megapixels — an 8× cut in pixels — moved that frame by **5 ms**. `ResolutionScaler` would have
walked all the way down its rung ladder and reported that it had run out of room, which is exactly
the failure shape already recorded in `packages/core/src/resolution-scaler.ts`'s own docblock for a
different cause. Moving the evaluation to one point per instance took the worst landed frame from
**50 ms to 13 ms** at unchanged 5.7 megapixels.

### 3. "Not there" is not a position

The reference makes the point that no transform can express it: whether an instance exists at all is
a rejection, decided by a mask, a habitat rule and a hash. So the mechanism has to carry a rejection
convention — the reference writes `grow <= 0` into the placement texture and every consumer's first
act is to push the vertex behind the far plane. That convention is part of the seam, not an
implementation detail, because a game that invents its own gets a scatter that culls nothing.

### 4. It is mechanism, and it owns nothing about the look

Where a prop stands, whether it exists, and which way it faces come out of the game's own rule.
Geometry, material, colour, animation and LOD stay the game's. The framework supplies the pass, the
storage layout, the fetch, and the rejection — plumbing every game repeats and no game should write.
Rule 1(a), with 1(b) not triggered.

## What ships

### `packages/core/src/scatter-placement.ts`, exported from `@threenative/core`

- **`ScatterPlacement3D`** — takes a count, a per-instance TSL function
  `(index, seed, params) => IPlacementResult`, and the number of output channels it needs. Runs it
  once per instance into storage buffers each frame, or on an explicit `invalidate()` for a static
  scatter. Compute dispatch on WebGPU; the reference's MRT-float-texture form is the WebGL fallback
  shape, not the primary one.
- **`IPlacementResult`** — `{ present: boolean-ish, position, normal, scale, seed, extra: vec4[] }`.
  `present` is the rejection channel and the framework, not the game, is responsible for turning a
  rejected instance into a culled vertex.
- **`placementFetch(placement)`** — the preamble a game's material composes into its own vertex
  node: fetch this instance's record by index, discard if rejected, hand back the fields. A band
  split across several variant meshes shares one placement buffer and each instance carries the slot
  it was given, so a rock scatter with eight carved variants is still one evaluation per rock.
- **Budgeting.** The dispatch is attributed to the `FrameBudget` `render` phase under its own name,
  so PRD-342's ablation can weigh it, and a scatter that costs more than it saves is visible rather
  than assumed.
- **Reporting.** `TN_SCATTER_PLACEMENT` naming instance count, accepted count, buffer bytes, and
  dispatch time. Accepted-versus-total is the number an agent needs: a mask that rejects everything
  renders an empty field and a perfectly green playtest.

### What it explicitly keeps out of the pass

Anything that genuinely varies per vertex — the bend of a blade in wind, the shape of a stone, the
sway of a canopy. The reference is clear that the win comes from moving *only* the per-instance work
and leaving per-vertex work alone.

## What does not ship

- No height field, no habitat rules, no biome masks, no LOD policy. Those are the game's rule and
  the game's look.
- No placement of physics colliders. `@threenative/physics` is a separate package for a reason.
- No CPU fallback that silently runs the rule per vertex. If the platform cannot run the pass, the
  constructor throws — fail closed.

## Acceptance criteria

1. **The saving is real and is vertex-stage.** A playtest scenario scatters 30,000 instances of a
   30-vertex mesh under a deliberately expensive per-instance rule, and asserts `render` p50 with
   the placement pass against the same scene with the rule inlined per vertex.
   *Red-green:* inline the rule into the vertex node; the assertion must fail with both frame times
   printed. Then, with the pass in place, drop the resolution one rung and assert the frame time
   moves by less than the pixel ratio would predict — the proof that the cost was never fill.
2. **A rejected instance draws nothing.** A scenario whose rule rejects half the instances asserts
   the drawn triangle count is half, not the full count with degenerate triangles at the origin.
   *Red-green:* remove the `present <= 0` early-out from `placementFetch`; the triangle-count
   assertion goes red. (Note the meter: on WebGPU a batched draw reports per sub-draw — see the
   repo's own `BatchedMesh` finding — so assert triangles, not draw calls.)
3. **Malformed input throws.** A rule returning no `present` channel, a count of zero, and a fetch
   against a placement that was never run each throw at construction or call, with a named error.
   *Red-green:* the spec asserts each throw; softening any one to a warning fails it.
4. **It runs on native.** `--target desktop` and `--target android` playtests of the same scenario
   report the same accepted count and a frame time within the device lane's band. A native contract
   test covers the dispatch and the buffer readback with no display.
5. **`pnpm tsx scripts/count-loc.ts` scores it.** The kill switch applies: the framework version has
   to be smaller than the plain-Three.js version across at least three call sites, counted as
   repetitions and not once.

## Out of scope

Impostors, GPU-driven culling of the placed instances, and the terrain field itself.
