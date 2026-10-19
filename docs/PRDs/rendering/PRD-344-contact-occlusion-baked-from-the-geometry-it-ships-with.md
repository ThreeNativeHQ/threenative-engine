---
prd_contract: v1
---

# PRD-344 — contact occlusion baked from the geometry it ships with

**Status:** PROPOSED — filed 2026-09-03, measured at `43d03e6a`. Batch:
[docs/PRDs/AAA-visuals](aaa-visuals-notes.md). Source studied:
[TheLongSilence](https://github.com/achimala/TheLongSilence) `src/gfx/greeble.js` — `occupancy()` at
:1576, `bakeSurface()` at :1644, `place()` at :1739, `weld()` at :2019.

**Priority:** P2 — Proposed baked occlusion: crease-versus-plate bake, calibration, continuous detail.
**Goal: a procedurally-assembled object arrives with contact shadow in its creases and wear on its
exposed edges, without a lightmap, a UV set, an authoring step, or a per-frame cost.** This is the
difference between "a pile of boxes" and "a machine", and it is the cheapest AAA cue in the batch.

**Complexity:** a load-time bake writing one vertex attribute, plus the transform-baking and merge
conventions that make it meaningful = **MEDIUM**.

## The problem, measured at `43d03e6a`

### 1. Screen-space AO cannot see a crease it is not looking at, and is off on a phone

`render/chain.ts` offers `ambientOcclusion` and `ssgi`, both screen-space. At the low tier those
stages are the first thing a `quality.ts` turns off, so the exact devices with the least lighting
budget get the least occlusion. And screen-space AO at any tier is a half-resolution estimate over a
depth buffer — it will never resolve the millimetre-scale contact between a bracket and the panel it
is bolted to, which is the contact a viewer reads as *assembly*.

A load-time bake is complementary, not competing: it is free at runtime, it is tier-independent, and
it captures exactly the scale screen space cannot.

### 2. The framework advertises contact occlusion and offers a ray query instead

`packages/core/src/index.ts:156` carries `@situation build a contact-occlusion or visibility query
over loaded meshes` on `GPUSceneBVH`. That is a runtime ray query inside a TSL kernel, with an
explicit CPU SAH build and per-ray traversal cost paid by the game every frame it asks. It is the
right tool for a dynamic query and the wrong tool for "shade this bolt's shadow the same way
forever". An agent searching the capability manifest for contact occlusion finds the expensive one
and no cheap one.

### 3. Two conventions have to ship with it or the bake means nothing

The reference makes both explicit and both are the framework's to own:

- **Bake transforms into geometry, then merge by material.** If each part keeps its own transform,
  every part's procedural detail — panel lines, wear, noise — restarts in that part's local space
  and the seams show at every boundary. Baking the transform in makes `position` the *assembled
  object's* space, so detail runs continuously across parts, and merging per material then collapses
  a hundred parts into a handful of draws. The reference's number: a hundred pieces cost six draws.
- **Calibrate the whole set at once.** "Flat plate" has to mean the same thing on every geometry in
  the object, or the bake shades one part relative to itself and another relative to itself and the
  object comes out patchwork.

### 4. It owns no look

The bake writes two scalars per vertex — how enclosed this point is, and how exposed its edge is.
What a material *does* with them — darken, add dust, bleach paint, add rust, nothing at all — is
entirely the game's, in the game's own material. Mechanism under rule 1(a), 1(b) untriggered.

## What ships

### `packages/core/src/baked-occlusion.ts`, exported from `@threenative/core`

- **`bakeContactOcclusion(geometries, options)`** — takes the set of geometries that make up one
  assembled object, and writes a `float2` vertex attribute (`enclosure`, `edgeExposure`) onto each,
  calibrated across the set. Runs once, at load or at build time.
- **Two implementations behind one call, chosen by a stated rule.** A voxel occupancy grid
  (rasterise every triangle at better than one sample per voxel, then sample two shells around each
  vertex — the near shell finds a lip, the far one finds a pocket) is the default: it is
  dependency-free, deterministic, and the reference's numbers put a few thousand square metres at
  tens of thousands of samples, not millions. Where the game already holds a `GPUSceneBVH` over the
  same meshes, the bake uses it instead — same output attribute, better accuracy, no second
  structure. The rule for which one ran is reported, never inferred.
- **De-duplication by position.** A merged, de-indexed object carries each corner three or four
  times and the answer is identical every time; the reference caches per distinct position, and so
  does this.
- **`bakeTransforms(geometry, transform)` and `mergeByMaterial(parts)`** — the two conventions above,
  as named exports, because the bake is only meaningful on geometry that went through them. They are
  useful on their own: `mergeByMaterial` is the draw-call collapse every procedural builder here
  currently open-codes.
- **Budget and report.** `TN_BAKED_OCCLUSION` naming vertex count, distinct positions, grid or BVH,
  elapsed milliseconds and the calibration range. A bake that took 400 ms belongs in the startup
  budget, and `startup-readiness.ts` must see it rather than have it land as an unattributed stall.

### `src/render/materials.ts` in the templates, as generated source

One commented example of consuming the attribute — a darkening term and an edge-wear term — with the
note that the numbers are the game's. This is where the look lives.

## What does not ship

- No lightmap, no UV unwrap, no second UV set.
- No directional or bent-normal AO. Two scalars, v1.
- No automatic application. A game that bakes and never reads the attribute gets exactly its old
  image, and the report says the attribute exists — which is the honest failure mode.
- No default darkening curve anywhere in `packages/`.

## Acceptance criteria

1. **A crease is darker than a plate.** A unit spec bakes an L-shaped two-box assembly and asserts
   the vertices at the inner corner carry a materially higher `enclosure` than vertices at the
   centre of an open face, and that an outer edge carries a higher `edgeExposure` than either.
   *Red-green:* collapse the two sample shells to one radius; the pocket-versus-lip discrimination
   fails and the spec goes red.
2. **The set is calibrated together, not part by part.** The same assembly baked as one set and as
   two independent sets produces different attributes, and a spec asserts the one-set path.
   *Red-green:* calibrate per geometry; the spec goes red.
3. **Detail is continuous across a part boundary.** A playtest scenario renders two abutting parts
   with a position-driven procedural material, and `assert.tone` (PRD-341) over a crop centred on
   the boundary bounds the local contrast.
   *Red-green:* skip `bakeTransforms` and keep the per-part transform; the seam appears and the tone
   assertion goes red.
4. **The bake is attributed.** `TN_BAKED_OCCLUSION` prints elapsed ms, and a startup-readiness
   assertion bounds it, so a bake that grows into a two-second hitch is a red gate.
   *Red-green:* bake a deliberately over-dense grid; the startup assertion fails naming the ms.
5. **Malformed input throws.** An empty geometry list, a geometry with no position attribute, and a
   cell size of zero each throw with a named error.
6. **It runs on native.** The bake is pure CPU maths over typed arrays, so a `--target desktop`
   playtest asserting the same attribute statistics as the browser run is the parity evidence.
7. **`pnpm tsx scripts/count-loc.ts` scores `mergeByMaterial`.** Counted across every procedural
   builder in the templates that currently open-codes it, not once.

## Out of scope

Runtime re-baking for objects that change shape, and any wear, dust or paint law — those decide how
things look and belong in `src/render/`.
