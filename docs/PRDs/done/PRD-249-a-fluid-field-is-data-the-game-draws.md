---
prd_contract: v1
---

# PRD-249 — A fluid field is data; what it looks like is the game's

**Status: DONE, 2026-08-29 — web and desktop-native evidence; Pixel 8 and mobile fit remain
`UNVERIFIED`.** `FluidField2D` is shipped with game-owned smoke and fire materials, and its
desktop cost is recorded at 128², 256² and 512². Evidence:
[docs/verification/prd-249-fluid-field-2026-08-29.md](../../verification/prd-249-fluid-field-2026-08-29.md).
It depends on [PRD-242](./PRD-242-gpu-simulation-has-one-lifetime.md).

Source: [`bandinopla/threejs-fluid-simulation`](https://github.com/bandinopla/threejs-fluid-simulation)
at `14ff3b0e`, MIT (Pavel Dobryakov's original WebGL shaders, ported to TSL). Cloned at depth 1 and
read on 2026-08-28. **Nothing copied.**

Parent batch: feature-mining.

**Complexity:** +2 new subsystem, +2 ping-pong state across frames inside a hot path, +1 ≤5 files
per phase, +1 public surface = **6 → MEDIUM mode.**

## The question

Smoke, fire, fog that moves, wind that bends grass, water that reacts to a boat, magical trails that
curl — all of them want the same thing underneath: an **advected velocity-and-dye field**. There is
none. `GPUParticles3D` simulates discrete particles; nothing simulates a field.

Two questions, per §11.1:

- **(1) Could the game write it portably itself?** After PRD-242, yes — these are TSL compute passes.
  §11.1 admits framework code *"once one game writes it more than twice"*, and this is the honest
  reason this PRD sits at the end of the batch: **it has zero in-repo callers today.** It is filed
  because the moment a second game writes an advected field by hand, the answer flips, and because
  the ping-pong lifetime is the part that is genuinely easy to get wrong.
- **(2) Does it decide how anything looks?** **Only if it is shipped the way upstream ships it** —
  see the split below.

## The split, and it is the whole insight

Upstream fuses the solver into a material: `FluidMaterialGPU extends MeshPhysicalNodeMaterial`
(`src/FluidMaterialGPU.ts:384`). That is exactly the shape that fails the live test — a game cannot
change how the fluid looks without editing the class that simulates it.

**Unfused, the mechanism and the appearance come apart cleanly**, because upstream already wrote
them as separate pass classes:

| Upstream | Where | Side |
| --- | --- | --- |
| `ComputeShader` base — wraps a TSL `Fn(pixelPos, uvPos, texelSize)` into a dispatch | `FluidMaterialGPU.ts:53` | **Framework** (or dissolved into PRD-242) |
| `SplatShader` — inject velocity and dye at a point | `:100`, `:109` | **Framework** |
| `CurlShader` | `:174`, `:177` | **Framework** |
| `VorticityShader` — confinement | `:193`, `:197` | **Framework** |
| `DivergenceShader` | `:220`, `:221` | **Framework** |
| `PressureShader` — Jacobi iterations | `:257`, `:258` | **Framework** |
| gradient subtraction, advection | `:278`, `:302` | **Framework** |
| Ping-pong pairs `velA` / `velB`, bound per pass | `:531-541` | **Framework** — the part hand-rolling gets wrong |
| Per-frame order: splat → curl → vorticity → divergence → pressure → subtract → advect | `:799-803` and the update path at `:792` | **Framework**, and it is fixed physics, not a preference |
| `MeshPhysicalNodeMaterial` subclassing, dye colour, `TrackedObject` visual coupling | `:326`, `:384` | **REFUSED — the game's** |

So the framework ships a **field with a sampler**, and the game draws it:

```ts
const field = new FluidField2D({ resolution: 256, viscosity: 0, pressureIterations: 20 });
ctx.add(field);                                  // IComputeDriven: ping-pong, order, release
field.splat(uv, velocity, amount);               // the game decides when and where

// src/render/smoke.ts — generated for you, edit or delete it freely
smokeMaterial.colorNode = myPalette(field.dye.sample(uv));
grassMaterial.positionNode = bend(field.velocity.sample(worldUv));
```

Nothing about colour, dye, palette, fade or material is in the package. `field.dye` is a number per
texel; a game that maps it to fire and a game that maps it to fog edit no framework code.

## Borrow map — where to read what, at `14ff3b0e`

An implementing agent should read these before writing anything. They are the reference, not the
dependency:

| To implement | Read |
| --- | --- |
| The dispatch wrapper | `src/FluidMaterialGPU.ts:53-92` |
| Splat (injection) | `src/FluidMaterialGPU.ts:100-172` |
| Curl and vorticity confinement | `src/FluidMaterialGPU.ts:174-219` |
| Divergence and the Jacobi pressure solve | `src/FluidMaterialGPU.ts:220-277` |
| Gradient subtraction and advection | `src/FluidMaterialGPU.ts:278-325` |
| Ping-pong binding | `src/FluidMaterialGPU.ts:531-541` |
| Per-frame pass order | `src/FluidMaterialGPU.ts:792-810` |
| **What NOT to borrow** | `src/FluidMaterialGPU.ts:326-470` (`TrackedObject`, the material subclass) and `src/FluidV3Material.ts` entirely — 1 097 lines of look |

## Incumbent census

| Existing thing | Relationship |
| --- | --- |
| `GPUParticles3D` | Discrete particles. A field is the continuous case and they do not overlap; a game may well drive one from the other. |
| `IComputeDriven` (PRD-242) | Depended on for ping-pong lifetime, ordered dispatch and release. |
| Nothing else | No field simulation exists. `Replaces` is empty. |

## Integration Ledger

| # | New thing | Live caller (`file:line`, non-test) | Replaces | Old path removed? | Negative control |
| --- | --- | --- | --- | --- | --- |
| 1 | `FluidField2D` implementing `IComputeDriven` | an example scene | nothing | n/a | remove it → the example's dye capture goes uniform |
| 2 | `splat()` | the example's input handler | nothing | n/a | splat with zero amount → the field stays uniform; a non-uniform field means the amount is ignored |
| 3 | `field.dye` / `field.velocity` samplers | the example's `src/render/` material | nothing | n/a | edit the palette in `src/render/` → appearance changes, no package edit. The charter test, executable |
| 4 | Native proof | conformance case | nothing | n/a | run with the solver stubbed → readback uniform, case reds |

## Execution Phases

### Phase 1 — the solver, checked against physics rather than against a screenshot

**Proof subject:** a divergent initial field with an obstacle, **not** a single splat into still
fluid. A single splat looks convincing while the pressure solve is wrong.

**Files (4):** `packages/core/src/fluid-field.ts` (NEW), `index.ts` (EDIT),
`__tests__/fluid-field.spec.ts` (NEW), an example (EDIT).

- [ ] Seven passes in the fixed order, ping-pong pairs owned by the field, dispatched through
      `IComputeDriven`.
- [ ] **Incompressibility is a number**: mean absolute divergence after the pressure solve falls
      below a stated threshold, and the threshold is in the docs.
- [ ] Determinism: same seed, same splats, same field.

| Test | Assertion | Negative control |
| --- | --- | --- |
| `should reduce mean divergence below threshold after the pressure solve` | measured value | set pressure iterations to 0 → above threshold, reds |
| `should conserve total dye under pure advection` | within tolerance | advect with the wrong sign → dye leaves the domain, reds |
| `should produce an identical field for identical inputs` | hash equality | seed from wall time → differs, reds |

### Phase 2 — a game draws it, and the drawing is the game's

**Files (3):** an example's `src/render/` material (NEW — the look), its playtest (NEW), capture
baseline.

- [ ] One visible consumer, driven by real input.
- [ ] The scenario asserts a **rendered difference** between splatted and un-splatted frames.
- [ ] Editing the palette in `src/render/` changes the appearance with no package edit — pasted diff.

### Phase 3 — cost, and native

**Files (3):** conformance case (EDIT), verification record (NEW), capability docs (EDIT).

- [ ] Per-frame cost at 128², 256² and 512², desktop lane, `render.p50`.
- [ ] A Pixel 8 number, because a 512² field with 20 Jacobi iterations is not a mobile budget and
      the docs must say so rather than letting an agent discover it.
- [ ] **If no resolution fits mobile, the docs say "desktop and web"**, and this PRD closes with that
      recorded rather than shipping a default that quietly costs the frame.

## Acceptance criteria (consumer-scoped)

- [ ] An example shows smoke or fire reacting to input, on web and native, drawn by a material the
      example owns.
- [ ] Two different `src/render/` materials over the **same** field produce two completely different
      looks, with no package file edited — both captures pasted. This is the charter test, run.
- [ ] Mean divergence after the solve is a measured number in the capability docs, not a claim.
- [ ] `packages/` contains no colour, no palette and no dye-fade constant — grep pasted.
- [ ] A game that never constructs `FluidField2D` is byte-identical to HEAD.
- [ ] Per-frame cost at three resolutions, including one Pixel 8 figure, is in the docs.

## Kill switch, and the honest recommendation

**This is the last PRD in the batch for a reason.** It has no in-repo caller, and §11.1's
more-than-twice clause is not yet satisfied. `count-loc.ts` measures it against a game writing the
seven passes on top of PRD-242 — which, unlike most items in this batch, is a genuinely reasonable
thing for a game to do. **Build it when a second game asks for a field, not before.**
