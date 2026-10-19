---
prd_contract: v1
---

# PRD-242 — GPU simulation has one lifetime, not one per game

**Status: DONE, 2026-08-29.** Implementation and one permitted repair round complete; the
framework owns only the compute lifecycle mechanism, and the two-pass simulation, buffers,
appearance and conformance scene are game-owned example source. Evidence:
[docs/verification/PRD-242.md](../../verification/PRD-242.md) and
[docs/verification/prd-242-startup-continuation.md](../../verification/prd-242-startup-continuation.md)
— unit, `examples/prd242-compute-lifetime` playtest, four abyss-framework scenarios and native
desktop conformance (300 frames, `exitCode: 0`). Android and iOS are UNVERIFIED.

Sources read at depth 1 on 2026-08-28, all MIT:
[`jure/webgiya`](https://github.com/jure/webgiya),
[`owenyuwono/poseidon`](https://github.com/owenyuwono/poseidon),
[`holtsetio/softbodies`](https://github.com/holtsetio/softbodies),
[`bandinopla/three-simplecloth`](https://github.com/bandinopla/three-simplecloth),
[`bandinopla/threejs-fluid-simulation`](https://github.com/bandinopla/threejs-fluid-simulation).
**Nothing is depended on and nothing is copied.** What is mined is the shape all five converge on.

Parent batch: feature-mining. **This PRD is the enabler for
[243](./PRD-243-softbody3d-cloth-first.md) and [244](./PRD-244-the-scenes-bvh-reaches-the-gpu.md);
neither is worth starting before it lands.**

**Complexity:** +2 lifetime state across scene changes and the frame loop, +2 it changes a hot path
and the startup contract, +1 touches ≤5 files, +1 public interface = **6 → MEDIUM mode.**

## The question

`GPUParticles3D` is the charter's named example of mechanism-without-look, and it works. What is
not general is everything **around** it. At HEAD, the compute lifetime in `packages/core/src/game.ts`
is hardcoded to that one class:

| Concern | Where | Bound to |
| --- | --- | --- |
| attach a renderer when the object enters the scene | `game.ts:708-713` — `if (object instanceof GPUParticles3D)` | one class |
| the per-frame dispatch | `game.ts:805-810` | one class |
| release on scene change | `game.ts:353-359` `clearScene(scene, particles)`, called at `:536` and `:1085` | one class |
| the registry | `game.ts:424` — `#particles = new Set<GPUParticles3D>()` | one class |

So a game that wants **any other** GPU simulation — cloth, a fluid field, a flow map, a heightfield,
a boid solver — gets none of it. It writes its own attach, its own per-frame ordering, its own
disposal, and it gets the scene-change case wrong, because the scene-change case is the one nobody
tests. And there is a fifth concern it cannot write at all:

**Compute kernels are not warmed at startup.** `packages/core/src/warmup.ts` contains zero
occurrences of `compute`. `ctx.startup.whenReady()` — the thing a loading screen waits on, which
exists precisely so the first visible frame is not the frame that compiles everything — knows about
draw work and not about compute work. A game's cloth therefore compiles its kernels *after* the
framework has reported the world ready, inside a frame, in front of the player.

Two questions, per the charter:

- **(a) Could the game write this portably itself?** The dispatch, yes — `ctx.renderer.compute(node)`
  is already exposed (`renderer.ts:104`), already guarded to the WebGPU renderer (`:267-270`), and
  already proven on native (conformance `73-storage-buffer-smoke` and `74-compute-smoke`, both
  `implemented`). The **lifetime** is a different matter: scene-change release and startup warmup are
  framework-owned seams a game cannot reach into. This is plumbing every game repeats and no game
  should write.
- **(b) Does it decide how anything looks?** No. It runs TSL the game wrote, in an order the game
  declared, and owns none of it.

## What the sources actually contain

The same four steps, five times, in five different shapes:

| Repo | Buffers | One-time compile warm | Per-frame dispatch | Release |
| --- | --- | --- | --- | --- |
| poseidon | `OceanCascade.js` | `await renderer.computeAsync(c.kInitial)` — `Ocean.js:113-114` | `Ocean.js:122` `evolve(t, dt)` → `renderer.compute(group)` at `:131-135` | ad hoc |
| softbodies | `FEMPhysics.js` | `await this.renderer.computeAsync(this.kernels.solveElemPass); //call once to compile` — `:341`, and again at `:406`, `:455`, `:485` | per-kernel `.compute(count)` | ad hoc |
| three-simplecloth | `SimpleCloth.ts` storage arrays | implicit first dispatch | `renderer.compute(...)` — `:925` | ad hoc |
| threejs-fluid-simulation | ping-pong targets | — | `renderer.compute(...)` — `FluidMaterialGPU.ts:84`, `update(delta, mesh)` at `:792` | ad hoc |
| webgiya | `surfelPool.ts`, `surfelHashGrid.ts` | — | an ordered pass list per frame | ad hoc |

**The load-bearing citation is softbodies' comment.** `//call once to compile`, written four times,
is a hand-rolled shader warmup — the exact concern `warmUpScene` and `ctx.startup` already own for
draw work in this repository. Five independent authors each rebuilt it because no framework offered
it. That is the definition of plumbing every game repeats.

## Design

Extract the contract `GPUParticles3D` already satisfies, and make `ctx.add` check for the contract
instead of the class.

```ts
export interface IComputeDriven {
  /** Kernels to compile before the world is shown. Read once, at attach. */
  readonly warmupNodes: readonly unknown[];
  attachRenderer(renderer: IRendererLike): void;
  /** Dispatched once per fixed step, in scene-add order. */
  process(renderer: IRendererLike): void;
  detach(): void;
  readonly released: boolean;
}
```

- `GPUParticles3D` **implements it** rather than being special-cased. One implementation, not two.
- `ctx.add(object)` registers anything satisfying the contract. Nothing else changes for a game that
  adds a plain `Mesh`.
- Ordering is scene-add order, stated in the doc, because a fluid that must run before the cloth
  that samples it needs a rule it can rely on — and an unstated order is a rule that changes under
  the game without warning.
- `warmupNodes` are compiled inside the existing startup window, so `ctx.startup.whenReady()` keeps
  its promise for compute as it already does for draws.

### The one open decision

The interface name. `IComputeDriven` describes the mechanism; Godot has no node for this, so rule 4
gives no borrowed word, and Three.js calls the thing `compute`. **Recommendation:
`IComputeDriven`, decided before Phase 1**, since it becomes a published type.

## Incumbent census

| Existing thing | Relationship |
| --- | --- |
| `GPUParticles3D` — `packages/core/src/particles.ts` | **Becomes the first implementer.** Its behaviour must not change by one dispatch; the existing particle tests are the proof. |
| `game.ts:708-713`, `:805-810`, `:353-359`, `:424` | **Replaced** by the contract check in the same commit. Two registries would be a rejection. |
| `warmUpScene` / `prewarm` — `warmup.ts`, `renderer.ts:51` | **Extended**, not duplicated. |
| `IRendererLike.compute` — `renderer.ts:104`, `:267-270` | Unchanged. Already the seam; already native-proven. |
| conformance `73-storage-buffer-smoke`, `74-compute-smoke` | The evidence that this substrate exists on native. A new case proves the *lifetime*, not the substrate. |

## Integration Ledger

| # | New thing | Live caller (`file:line`, non-test) | Replaces | Old path removed? | Negative control |
| --- | --- | --- | --- | --- | --- |
| 1 | `IComputeDriven` | `packages/core/src/game.ts:708` `ctx.add` | `instanceof GPUParticles3D` | **yes, deleted in Phase 1** | make `GPUParticles3D` stop satisfying the contract → the particle tests red |
| 2 | Generalised registry + frame dispatch | `game.ts:424`, `:805-810` | the `Set<GPUParticles3D>` | yes | add a second implementer and remove it from the registry → its `process` never runs, test reds |
| 3 | Scene-change release for any implementer | `game.ts:353-359`, called `:536`, `:1085` | particle-only `clearScene` | yes | `goto` with a live implementer and assert `released` — false without the change |
| 4 | Compute warmup in the startup window | `packages/core/src/warmup.ts` | hand-rolled `computeAsync` warmups in game code | n/a in-repo | assert the kernel compiled before `whenReady()` resolves; remove the warmup → it compiles later, test reds |
| 5 | Native proof | `packages/runtime-native/conformance/registry.json` new case | nothing | n/a | run with the registry bypassed → the simulation never advances on native |

## Execution Phases

### Phase 1 — the contract, with `GPUParticles3D` as its first implementer

**Files (5):** `packages/core/src/compute-driven.ts` (NEW — the interface and the registry),
`packages/core/src/particles.ts` (EDIT — implement it), `packages/core/src/game.ts` (EDIT — the four
call sites), `packages/core/src/index.ts` (EDIT — export the type),
`packages/core/__tests__/compute-driven.spec.ts` (NEW).

- [ ] Every `instanceof GPUParticles3D` in `game.ts` is **gone**, not supplemented.
- [ ] A test-local implementer that is not a particle system attaches, ticks and releases.
- [ ] Dispatch order is scene-add order, asserted with three implementers.

| Test file | Test name | Assertion | Negative control (must be observed red) |
| --- | --- | --- | --- |
| `compute-driven.spec.ts` | `should dispatch a non-particle implementer once per fixed step` | one call per step | keep the `instanceof` check → zero calls, reds |
| `compute-driven.spec.ts` | `should dispatch implementers in scene-add order` | recorded order matches | iterate an unordered collection → order flaps, reds |
| `compute-driven.spec.ts` | `should release every implementer on a scene change` | `released` true after `goto` | leave `clearScene` particle-typed → false, reds |
| `particles.spec.ts` (pre-existing) | unchanged | unchanged | this is the regression guard: particles must behave identically |

**Revert check:** restore the `instanceof` check → the non-particle dispatch test fails, and it is a
test that could not have passed before this phase.

### Phase 2 — compute is warm before the world is shown

**Files (3):** `packages/core/src/warmup.ts` (EDIT), `packages/core/src/game.ts` (EDIT — feed
`warmupNodes` into the startup window), `packages/core/__tests__/prewarm.spec.ts` (EDIT).

- [ ] `warmupNodes` are compiled inside the existing startup window, before `startup.phase` reaches
      `ready`.
- [ ] The warmup is bounded and never able to hang a launch, matching the rule the existing startup
      block already follows (`game.ts:961-975`).
- [ ] A game that registers no implementer sees a byte-identical startup.

| Test file | Test name | Assertion | Negative control |
| --- | --- | --- | --- |
| `prewarm.spec.ts` | `should compile compute kernels before startup reports ready` | compile recorded before `whenReady()` resolves | skip `warmupNodes` → compiles after, reds |
| `prewarm.spec.ts` | `should still resolve when a kernel fails to compile` | resolves, error reported | let it throw → launch hangs, reds |

### Phase 3 — a real second implementer, in a game, on native

**Files (4):** an example under `examples/` (EDIT/NEW — one non-particle compute object a game
authored), its playtest (NEW), `packages/runtime-native/conformance/registry.json` (EDIT), the
verification record (NEW).

**Proof subject:** a compute object with **at least two ordered passes and a ping-pong buffer** —
the shape cloth and fluids actually have. A single-pass toy would pass every criterion above and
prove nothing about ordering or buffer lifetime.

- [ ] The example advances state on the GPU across frames and shows it on screen.
- [ ] `goto` away and back releases and rebuilds without a leaked buffer.
- [ ] The same scene runs under the native conformance lane, and the result names the target.

## Acceptance criteria (consumer-scoped)

- [ ] A game adds a compute-driven object that is **not** `GPUParticles3D`, and it attaches, runs
      every fixed step in a declared order, survives a scene change, and releases — with no
      framework code naming its class.
- [ ] The first visible frame of a game with compute work does not compile that work: shown by the
      startup window, not by argument.
- [ ] `GPUParticles3D` behaves identically, proven by the pre-existing particle tests and a template
      playtest that was not edited.
- [ ] The same example runs on desktop native through the conformance lane, and the record names the
      target rather than implying it.
- [ ] `grep -n "instanceof GPUParticles3D" packages/core/src/game.ts` returns nothing — pasted.
- [ ] `pnpm budgets` passes with the new export documented (`@situation`, `@example`).

## Kill switch

`count-loc.ts` against a game that hand-rolls attach, ordered dispatch, scene-change release and
kernel warmup for two simulations. If the framework version is not smaller across those sites, it is
deleted — and PRDs 243 and 244 are withdrawn with it, because they are built on this.
