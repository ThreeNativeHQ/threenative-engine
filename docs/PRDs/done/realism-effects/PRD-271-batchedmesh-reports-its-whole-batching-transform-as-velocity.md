---
prd_contract: v1
---

# PRD-271 — a `BatchedMesh` reports its whole batching transform as velocity, every frame, standing still

**Status:** PROPOSED — filed 2026-08-30, measured at `1eeecf1e`. Depends on
PRD-266 for the chain
seam only; the defect and its fix are independent of it. **Supersedes the `BatchedMesh` half of
[PRD-269](../PRD-269-motion-vectors-or-the-temporal-filters-lie.md)** — see
[the batch README](./README.md) for why the rest of PRD-269 no longer has a problem to solve.
Batch: [docs/PRDs/realism-effects](./README.md).

**Goal: batched geometry that has not moved reports zero velocity.** Today it reports its entire
batching matrix as motion, so every temporal stage rejects its history everywhere, on every frame,
including a scene where nothing moves at all.

**Complexity:** one `positionPrevious` assignment in a TSL accessor, plus per-sub-draw previous
matrix storage and the frame ordering around it = **MEDIUM**. The maths is three lines; the
storage lifetime and the ordering are the work.

## The problem, measured at `1eeecf1e`

### 1. Upstream applies the batching matrix to the current position and not to the previous one

`three@0.185.1` computes motion vectors from two positions: `positionLocal` for this frame and
`positionPrevious` for the last one (`src/nodes/accessors/VelocityNode.js`, `setup()`). Every
accessor that displaces a vertex is responsible for displacing both.

Two of the three do:

- `src/nodes/accessors/Skinning.js:162` — `if ( builder.needsPreviousData() )` → assigns
  `positionPrevious` from a `_previousBoneMatricesData` WeakMap of the previous frame's
  `skeleton.boneMatrices`.
- `src/nodes/accessors/Instance.js:215` — same guard → `positionPrevious.assign(
  previousInstanceMatrixNode.mul( positionPrevious ).xyz )`.

`src/nodes/accessors/Batch.js` does not. The whole file is 108 lines, it imports `positionLocal`
and never `positionPrevious`, and line 92 reads:

```js
positionLocal.assign( batchingMatrix.mul( positionLocal ) );
```

with no previous-frame counterpart anywhere in the file.

### 2. The consequence is not "zero velocity" — it is a large wrong velocity

`positionPrevious` defaults to the raw geometry position (`src/nodes/accessors/Position.js:54`,
`positionGeometry.toVarying( 'positionPrevious' )`). So for a sub-draw of a `BatchedMesh`,
`VelocityNode` differences a current clip position that **has** the batching matrix applied against
a previous clip position that **does not**.

The reported velocity is therefore the sub-draw's entire batching transform projected to NDC — the
displacement from the origin of its packed geometry to wherever the batch placed it. That number is
large, it is present on a completely static scene, and it is the same every frame.

This is the failure mode that reads as correct in a review and wrong on screen: it is not a subtle
smear on a moving object, it is every batched object permanently failing the history test.
`TRAANode` treats it exactly that way — `maxVelocityLength` is 128 pixels and
`TRAANode.js:685` computes `motionFactor` as the history offset over that length, saturated. A
sub-draw placed further than 128 px from its packed origin in screen space pins `motionFactor` at
1 and discards its history entirely, forever.

### 3. This repository batches in core, so it is not a hypothetical

`packages/core/src/projection-apply.ts:685` constructs `BatchedMesh` directly — the material lane
packs differing geometries into one `BatchedMesh` per material
(`projection-apply.ts:230`, `:338`). Any scene that goes through that lane and turns on any
temporal stage gets the defect on all of its batched geometry.

The file's own docblock at `projection-apply.ts:587` already records that three's WebGPU backend
has no multi-draw path and walks a `BatchedMesh` issuing one `drawIndexed` per sub-draw. That is
the same granularity the fix needs: **per sub-draw, not per object.**

### 4. Neither reference source solves it either

`0beqz/realism-effects` — the repo this batch mines — does not handle batching or instancing at
all. `src/temporal-reproject/pass/VelocityDepthNormalPass.js` walks the scene with
`getVisibleChildren`, swaps in one `VelocityDepthNormalMaterial` per object, and stores exactly one
`prevVelocityMatrix` uniform per object (`unsetVelocityDepthNormalMaterialInScene`). Its
`src/temporal-reproject/material/VelocityDepthNormalMaterial.js` vertex body reads `position`
directly with no instancing or batching chunk. It solves the *skinned* case with a
`prevBoneTexture`, which upstream has since solved in TSL.

So there is no implementation to port from. This one is written here or it does not exist.

## What ships

A per-sub-draw previous-matrix path for `BatchedMesh`, mirroring what `Instance.js` already does
for `InstancedMesh`:

- **Previous per-sub-draw matrices**, stored beside the batch's current matrix texture and
  double-buffered, so a matrix written mid-frame cannot produce a velocity that disagrees with the
  colour pass. Copied from the batch's matrix storage at one defined point in the frame, the same
  point `Instance.js` copies at.
- **A `positionPrevious` assignment** in the batching setup path, guarded by
  `builder.needsPreviousData()` exactly as the skinning and instancing accessors are, indexing the
  previous matrix by the same batch id the current matrix uses.
- **Correct handling of a sub-draw whose id did not exist last frame** — a newly added or newly
  visible sub-draw has no previous matrix. It reports zero velocity and is marked as new, rather
  than differencing against an uninitialised matrix, which is how a spawn becomes a screen-wide
  streak.
- Whether this lands as a patch upstream, a `packages/core/src/render/` accessor that overrides the
  batching path, or a wrapper on the core batching lane is an implementation choice for the
  builder — **but the acceptance criteria are asserted against `packages/core`'s batching lane
  either way**, because that is what this repository ships. Upstreaming it to `mrdoob/three.js` is
  encouraged and does not discharge the criteria.

The framework owns this under charter rule 1(a): a game cannot portably write a previous-frame
matrix buffer for a batching path whose draw granularity is a renderer-backend detail. It decides
nothing about how anything looks.

## Acceptance criteria

1. **A static `BatchedMesh` reports zero velocity.** A fixture builds a `BatchedMesh` with three
   sub-draws at distinct non-origin transforms, renders two frames with velocity requested, and
   asserts the velocity buffer is zero within tolerance over all three sub-draws' screen
   footprints. *Mutation:* remove the `positionPrevious` assignment from the batching path and the
   spec fails with a non-zero velocity whose magnitude matches the sub-draw's NDC offset — the
   failing numbers are pasted in this PRD's red before the fix lands.

2. **Per-sub-draw motion is per-sub-draw.** With one sub-draw of a `BatchedMesh` moving and the
   rest static, velocity is non-zero only over the moving sub-draw. *Mutation:* index the previous
   matrix by object instead of by batch id and the spec fails by marking every sub-draw as moving.

3. **A sub-draw added this frame reports zero, not garbage.** A fixture adds a sub-draw at frame
   N and asserts its velocity is zero on the frame it appears, and correct on frame N+1.
   *Mutation:* difference against an unwritten previous matrix and the spec fails on frame N with a
   velocity of the sub-draw's full transform.

4. **The batched case is asserted against `packages/core`'s own batching lane, not a synthetic
   mesh.** A spec drives `projection-apply.ts`'s material lane to produce a `BatchedMesh` and
   asserts criterion 1 through it. *Mutation:* assert only against a hand-built `BatchedMesh` and
   the lane's own packing — negatively scaled matrices, per-material grouping — goes untested.

5. **Ghosting is measured, not judged by eye.** A playtest drives a camera across a batched,
   GI-lit scene with a temporal stage active and asserts the history-rejection fraction stays below
   a pinned threshold. *Mutation:* revert the fix and the assertion fails on the rejection
   fraction, with the before/after numbers pasted.

## Out of scope

Motion blur, which consumes the same buffer and is a look decision — if a template wants it, it
ships in `templates/*/src/render/` on top of this. Velocity for the atmosphere and ocean compute
paths, which have their own lifetimes. Skinned and instanced velocity, which
[the batch README](./README.md) shows upstream already handles — a regression guard for those two
is [PRD-272](./PRD-272-velocity-is-opt-in-and-nothing-reports-whether-it-was-on.md)'s job, not a
reimplementation here.

## Verification

`pnpm typecheck && pnpm lint && pnpm test`; the ghosting playtest with the before/after rejection
fraction pasted; `pnpm visuals:ab` on a template whose scene uses the batching lane. Native parity
follows [PRD-270](../../useful-defaults/PRD-270-no-lighting-node-ships-web-only.md) — a velocity path proven
only in the browser is a web-only feature and the charter calls that unfinished.
`pnpm tsx scripts/count-loc.ts` runs against this one: the defence against the kill switch is that
the per-sub-draw bookkeeping is not something a game can write portably at all, counted across
every call site rather than one.
