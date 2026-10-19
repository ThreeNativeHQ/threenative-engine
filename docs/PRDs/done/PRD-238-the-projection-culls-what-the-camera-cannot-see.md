---
prd_contract: v1
---

# PRD-238 — The projection culls what the camera cannot see

**Status: DONE, 2026-08-29 — WebGPU/browser evidence; native execution remains `UNVERIFIED`.**
The batched culling arm removed 75% of scene sub-draws and moved steady `render.p50` from 1.60 ms
to 1.10 ms. The losing instanced compaction arm was removed and no Phase 4 spatial index was
added. Consumer evidence, including source/projected raycast and render parity, is recorded in
[docs/verification/runtime-perf-state.md](../../verification/runtime-perf-state.md).

Source of the borrowed technique:
[`agargaro/instanced-mesh`](https://github.com/agargaro/instanced-mesh) (`@three.ez/instanced-mesh`),
MIT, cloned at depth 1 on 2026-08-28. **The library itself is refused as a dependency** — see below.
What is mined is one function of 25 lines and the idea behind it.

Parent batch: feature-mining.

**Complexity:** +2 complex state (a per-frame visibility set inside a hot path that already exists
to be fast), +2 the change is a measurement before it is a feature, +1 touches ≤5 files,
+1 multi-package (core + an example harness) = **6 → MEDIUM mode.**

## The question

`packages/core/src/projection-apply.ts:54-62` states a decision in full, and it is the decision this
PRD exists to price:

> Per-instance frustum culling and depth sorting are both off.
> They are CPU work proportional to object count, and object-count-proportional CPU work is the
> entire cost this class exists to remove — on the profile that motivated it, interpreted
> JavaScript was the frame and the GPU was idle. A batch draws whole and lets the GPU discard what
> is off screen.

That reasoning is sound **for linear culling**, which is what three.js does when you ask an
`InstancedMesh` or a `BatchedMesh` to cull per object: a loop over every instance, every frame, in
interpreted JavaScript. The premise this PRD tests is the hidden one: **that linear is the only
option.** It is not, and the consequence of the current setting is that a game with a 200 m view
distance and a 2 km world submits the whole 2 km every frame — vertex work, and on mobile,
bandwidth, for geometry that was never going to be seen.

The honest possible outcomes are three, and this PRD is written so that any of them is a result:

1. Culling wins → it ships, measured.
2. Culling is flat → **the existing comment is upgraded from a reasoned assumption to a measured
   fact**, with the numbers beside it, and nothing else changes.
3. Culling loses → same as 2, plus the reason.

## What the source actually contains

| Claim | Evidence |
| --- | --- |
| Its BVH culling walks the tree and touches only nodes that survive the frustum, writing surviving indices into an index buffer and setting `count` — it is **not** proportional to instance count | `src/core/feature/FrustumCulling.ts:172-196` (25 lines, the whole idea) |
| It keeps a linear path too, and chooses between them | `src/core/feature/FrustumCulling.ts:58-77`, `:198` |
| The spatial index is its own dynamic BVH over instances, not a geometry BVH | `src/core/InstancedMeshBVH.ts` (322 lines), dependency `bvh.js` |
| **It is bound to `WebGLRenderer`** | `src/core/utils/SquareDataTexture.ts:171` `bindToProgram(renderer: WebGLRenderer, gl: WebGL2RenderingContext, …)`; `src/core/utils/PropertiesOverride.ts:34` `patchProperties(obj, renderer: WebGLRenderer, …)`; zero occurrences of "WebGPU" in `src/` or `README.md` |
| Its per-instance reordering needs a shader chunk and a custom instance-index attribute | `src/shaders/ShaderChunk.ts`, `src/core/utils/GLInstancedBufferAttribute.ts` |

**Therefore: the dependency is refused.** The renderer here is `WebGPURenderer`, and half of what
makes that library fast is a WebGL program patch. Taking it would be taking a WebGL library into a
WebGPU engine and calling the result portable.

**What is taken is the refutation**: per-instance culling is only object-count-proportional if you
do it linearly.

## The mechanism actually available here, which is smaller than the mined one

The projection has two lanes (`projection-apply.ts`):

| Lane | Object | Current setting | What three.js already offers |
| --- | --- | --- | --- |
| instanced | `InstancedMesh` | `frustumCulled = false` (`:621`) | Nothing per-instance. Culling would require compacting visible matrices into slots `0…k-1` and re-uploading the instance matrix buffer each frame. |
| batched | `BatchedMesh` | `perObjectFrustumCulled = false`, `sortObjects = false` (`:695-697`) | **Both, implemented upstream.** `BatchedMesh` culls and sorts per sub-draw itself. |

So the cheapest real experiment in this repository is **one line**: flip
`PER_OBJECT_FRUSTUM_CULLED` for the batched lane and measure. That is Phase 1, and it needs no
mined code at all. The mined BVH only becomes relevant if Phase 1 shows the win is real and the
linear cost is what caps it.

## Incumbent census

| Existing thing | Relationship |
| --- | --- |
| `SceneRenderProjection` — `packages/core/src/renderProjection.ts` | The owner of this behaviour. Nothing new is introduced beside it. |
| `PER_OBJECT_FRUSTUM_CULLED` / `SORT_BATCH_OBJECTS` — `projection-apply.ts:60-61` | **Replaced** by a measured setting, not by a game-facing option. |
| `three-mesh-bvh` (already a core dependency) | Candidate spatial index for Phase 3, if a BVH is needed at all. **No new dependency is added by this PRD** — `bvh.js` is not introduced. |
| `examples/engine-load-test` | The measurement subject. Already exists, already the load harness. |
| `packages/core/__tests__/projection-hot-path.spec.ts` | The allocation guard this change must not break. |

## Integration Ledger

| # | Changed thing | Live caller (`file:line`, non-test) | Replaces | Old path removed? | Negative control |
| --- | --- | --- | --- | --- | --- |
| 1 | Batched-lane culling setting | `packages/core/src/projection-apply.ts:695` | `PER_OBJECT_FRUSTUM_CULLED = false` | yes, one constant | force the camera to face away from every batch → drawn sub-draw count must fall; if it does not, the flag is not reaching the renderer |
| 2 | Off-screen A/B rung in the load harness | `examples/engine-load-test/src/main.ts` | nothing | n/a | run the rung with culling off → the recorded delta is the measurement's own control |
| 3 | Instanced-lane compaction (**only if Phase 1 wins**) | `packages/core/src/projection-apply.ts` reconcile path | full-buffer submission | yes | disable compaction → instance draw count returns to the uncompacted number |
| 4 | Measured verdict written beside the constant | `projection-apply.ts:54-62` comment | today's unmeasured reasoning | yes, the prose is replaced | the comment cites a verification record that exists |

## Execution Phases

### Phase 1 — price the one-line version on the real subject

**Proof subject:** `examples/engine-load-test` at a rung whose objects do **not** all fit the
frustum — a wide world with the camera inside it. A load test where everything is on screen
measures nothing about culling and would pass while proving the opposite of what is claimed.

**Files (3):** `examples/engine-load-test/src/main.ts` (EDIT — add the off-screen rung),
`packages/core/src/projection-apply.ts` (EDIT — the constant),
`docs/verification/runtime-perf-state.md` (EDIT — per the batch exception, performance findings
consolidate there rather than opening a new file).

- [ ] Add a rung where ~75% of batched objects are outside the frustum. Record the fraction; a rung
      whose off-screen share is not stated is not a measurement.
- [ ] Paired arms on one display lane, culling ON and OFF, three runs each, frames 226–899 only —
      whole-run averages are banned by the recorded method.
- [ ] Report `render.p50` and drawn sub-draw count. **Desktop reads `render.p50`, never fps**; FPS
      verdicts belong to the device lane.
- [ ] Stop rule: if drawn sub-draws do not fall with the flag on, the flag is not reaching the
      renderer — fix that before reading any timing.

| Test file | Test name | Assertion | Negative control |
| --- | --- | --- | --- |
| `packages/core/__tests__/renderProjection.spec.ts` | `should submit fewer batched sub-draws when most objects are behind the camera` | drawn count < total | point the camera at everything → counts equal, test reds |
| `packages/core/__tests__/projection-hot-path.spec.ts` | `should still allocate nothing per frame with culling enabled` | zero steady-state allocation | allocate a temp `Frustum` per frame → reds |

**Revert check:** set the constant back to `false` → the new sub-draw test fails.

### Phase 2 — the verdict is written down either way

**Files (2):** `packages/core/src/projection-apply.ts` (EDIT — the comment at `:54-62` now cites
measurements), `docs/verification/runtime-perf-state.md` (EDIT).

- [ ] The comment states what was measured, on what rung, with what off-screen fraction.
- [ ] **If the result is flat or negative, this PRD is finished here** and moves to `done/` with
      phases 3 and 4 marked "not needed, and why". A closed question with a number beside it is a
      result; leaving it open so the PRD looks bigger is not.

### Phase 3 — the instanced lane, only if Phase 1 won

**Files (3):** `projection-apply.ts` (EDIT — compaction of visible instance matrices),
`renderProjection.spec.ts` (EDIT), verification record (EDIT).

- [ ] Visible instances compact into slots `0…k-1`; `mesh.count = k`.
- [ ] The upload cost is measured, not assumed — compaction trades CPU writes and a buffer upload
      for vertex work, and on a small batch it loses. A per-batch size floor below which compaction
      is skipped is chosen **from the measurement**, and the floor is stated in the code.
- [ ] Correctness first: a compacted batch must raycast, animate and reconcile identically. The
      projection's whole design premise is that the game cannot tell it is there.

### Phase 4 — a spatial index, only if linear culling is the cap

**Files (2):** `projection-apply.ts` or a new `projection-cull.ts` (NEW/EDIT), tests (EDIT).

- [ ] Only entered if Phase 3 shows the linear per-instance scan dominating. Uses `three-mesh-bvh`,
      already a dependency; `bvh.js` is not introduced.
- [ ] The mined shape is `FrustumCulling.ts:172-196`: traverse, collect survivors, set count.

## Acceptance criteria (consumer-scoped)

- [ ] On the off-screen rung of `examples/engine-load-test`, the frame submits measurably fewer
      sub-draws with culling on, and `render.p50` moves by a stated amount in a stated direction —
      pasted from the run, on one display lane, three paired runs.
- [ ] A game whose world is larger than its view distance renders identically with culling on: same
      pixels, same raycast results, same reconciliation. Proven by the visual gate, not by argument.
- [ ] The `projection-apply.ts` comment names a measurement instead of a prediction.
- [ ] `pnpm test` and the projection allocation guard stay green; the frame still allocates nothing.
- [ ] If the answer is "the original decision was right", that sentence appears in the code with the
      numbers that justify it, and this PRD is closed as a success.

## Kill switch

This PRD adds no public surface, so `count-loc.ts` does not apply. Its kill switch is the
measurement itself: a change to the projection that does not move a meter is reverted, not kept
because it is theoretically better.

## Borrow map — where to read what

Read these before writing anything; they are the reference, not the dependency. Pinned to the
commit this PRD was written against, so the line numbers still mean something: **`agargaro/instanced-mesh` @ `78f5a94e`**.

| To implement | Read |
| --- | --- |
| the whole idea, 25 lines — BVH traversal writing survivor indices | `src/core/feature/FrustumCulling.ts:172-196` |
| the linear fallback it is measured against | `src/core/feature/FrustumCulling.ts:198-234` |
| how it chooses between the two | `src/core/feature/FrustumCulling.ts:58-77` |
| the dynamic instance BVH (Phase 4 only) | `src/core/InstancedMeshBVH.ts:1-322` |
| **do NOT borrow** — WebGL-bound, and this engine is WebGPU | `src/core/utils/SquareDataTexture.ts:171`, `src/core/utils/PropertiesOverride.ts:34`, `src/core/utils/GLInstancedBufferAttribute.ts`, `src/shaders/ShaderChunk.ts` |
