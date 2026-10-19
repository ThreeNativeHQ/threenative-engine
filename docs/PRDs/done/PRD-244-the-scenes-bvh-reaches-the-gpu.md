---
prd_contract: v1
---

# PRD-244 — The scene's BVH reaches the GPU

**Status: DONE, 2026-08-29.** `GPUSceneBVH` ships and is reached through
[PRD-242](./PRD-242-gpu-simulation-has-one-lifetime.md)'s `IComputeDriven` lifetime. Evidence:
[docs/verification/PRD-244.md](../../verification/PRD-244.md) — 8 unit tests over the packed
`bvh.nodes` buffer, the `prd140-picking` playtest, `pnpm native:build`, and desktop conformance
`76-gpu-scene-bvh` (pixel mismatch 0.000126953125). Android and iOS are UNVERIFIED.

Source of the borrowed technique: [`jure/webgiya`](https://github.com/jure/webgiya), MIT, cloned at
depth 1 on 2026-08-28 — specifically `src/sceneBvh.ts`, which shows how to pack a scene into storage
buffers a TSL kernel can trace. **Its global-illumination system is deliberately not absorbed** — see
"What is refused".

Parent batch: feature-mining.

**Complexity:** +2 new subsystem, +2 buffer lifetime tied to a mutable scene, +1 touches ≤5 files,
+1 new public surface = **6 → MEDIUM mode.**

## The question

`three-mesh-bvh` is already a direct dependency of `@threenative/core`, pinned at **0.9.14** in
`pnpm-workspace.yaml`, and `ScenePicker` traces it on the **CPU** (`packages/core/src/picking.ts:11`,
`:222`). That same installed package also ships a WebGPU path this repository has never touched:

```
node_modules/.pnpm/three-mesh-bvh@0.9.14_three@0.185.1/…/package.json
  exports: { ".", "./worker", "./webgpu", "./src/*" }
  src/webgpu/: BVHComputeData.js, bvh_ray_functions.wgsl.js, distance_functions.wgsl.js, tsl/…
```

So the engine ships a GPU ray-tracing substrate, already at the pinned version, and no game can
reach it. Everything that wants rays in a shader — ambient occlusion, contact shadows, GI, a
visibility check for a thousand agents, audio occlusion, a laser that samples the world instead of
querying it per frame — is currently a CPU round trip through `ctx.raycast`, one ray at a time.

Two questions, per the charter:

- **(a) Could the game write this portably itself?** No. Packing a scene's geometry, index and
  material data into storage buffers, keeping them alive across a scene change, and rebuilding when
  the world changes is framework plumbing. The tracing *kernel* is upstream's; the residency is not.
- **(b) Does it decide how anything looks?** No — **and this is exactly the line that keeps webgiya's
  GI out.** This PRD ships data and a query, not an image. What a game does with a traced ray —
  bounce it, occlude with it, colour with it — is the game's, in `src/render/`.

## What is refused, and why

`webgiya` is a surfel GI engine: `surfelPool.ts`, `surfelHashGrid.ts`, `surfelIntegratePass.ts`,
`surfelGIResolvePass.ts`, `surfelAgePass.ts`, `gbuffer.ts`, `lighting.ts`. **Global illumination is
lighting, and lighting is on the charter's list of things a screenshot shows** — it ships as
generated source in `templates/*/src/render/`, at any size, and never as package code. Absorbing GI
into a package would hand the framework the single loudest look decision in a renderer.

What survives that line is the layer underneath: the scene, in buffers, traceable. Which is the part
webgiya itself had to build before it could start.

One more fact from the clone, and it changes a risk into a non-risk: webgiya **vendors**
three-mesh-bvh (`import { MeshBVH, SAH } from './external/three-mesh-bvh/src'`, with the package
import commented out on the line below) because it pins `three-mesh-bvh@^0.9.2`, which predates the
published `./webgpu` export. **This repository is already on 0.9.14, where that export exists.** No
vendoring, no fork, no patch.

## Design

```ts
const bvh = new GPUSceneBVH(ctx.scene, { include: (o) => o.userData.traceable === true });
ctx.add(bvh);                       // IComputeDriven: residency, rebuild and release are PRD-242's

// the game writes the kernel; the framework hands it the buffers
const occlusion = Fn(() => bvhRayHit(bvh.nodes, bvh.positions, bvh.indices, origin, dir));
```

- The buffers are exposed as TSL storage nodes, named and documented, matching what
  `three-mesh-bvh/webgpu` expects. The framework does not wrap the tracing functions — re-exporting
  upstream's WGSL under new names would be inventing vocabulary for no gain.
- **Static-by-default, explicitly rebuilt.** A BVH over a scene that changes every frame is a
  rebuild every frame, which is a trap this must not set silently: the default covers the static
  world, and `rebuild()` is a call the game makes with a cost the docs state.
- Selection is a predicate the game supplies. A game does not want its particles in the trace set.

## Incumbent census

| Existing thing | Relationship |
| --- | --- |
| `ScenePicker` — `picking.ts:52`, `MeshBVH` at `:222` | **Untouched, and deliberately separate.** CPU picking answers one ray now; this answers thousands inside a shader. Sharing a built tree between them is a Phase 3 optimisation, not a Phase 1 requirement. |
| `three-mesh-bvh` 0.9.14, `pnpm-workspace.yaml:8` | **Already installed.** No new dependency, no version bump, no vendoring. |
| `IComputeDriven` (PRD-242) | Depended on for residency and release. |
| conformance `73-storage-buffer-smoke`, `74-compute-smoke` | The proof that storage buffers and compute run on native. This PRD adds the case that a *traced* result does. |

## Integration Ledger

| # | New thing | Live caller (`file:line`, non-test) | Replaces | Old path removed? | Negative control |
| --- | --- | --- | --- | --- | --- |
| 1 | `GPUSceneBVH` | an example scene that traces it | nothing | n/a | remove it → the example's occlusion assertion reds |
| 2 | Storage-buffer packing of positions, indices, normals | `GPUSceneBVH` build | nothing | n/a | corrupt one index → the traced hit distance changes; assert it, so silence is impossible |
| 3 | `rebuild()` + release through `IComputeDriven` | `ctx.add`, `clearScene` | nothing | n/a | `goto` and assert buffers released; skip release → count grows, reds |
| 4 | Native proof | conformance case | nothing | n/a | run on native with the trace stubbed → the readback is uniform, case reds |

## Execution Phases

### Phase 1 — a traced ray agrees with a CPU raycast

**Proof subject:** a real GLTF scene with **multiple meshes, an index buffer, transformed instances
and a non-trivial material split** — the thing a game actually loads. A single box would validate
the plumbing and none of the packing, which is where this kind of work fails.

**Files (4):** `packages/core/src/gpu-scene-bvh.ts` (NEW), `packages/core/src/index.ts` (EDIT),
`packages/core/__tests__/gpu-scene-bvh.spec.ts` (NEW), an example (EDIT).

- [ ] Build from the scene, pack into storage buffers, expose them as documented TSL nodes.
- [ ] **The gate is a differential**: for N sampled rays, the GPU hit distance matches
      `ScenePicker`'s CPU hit within tolerance. Two independent implementations, not one compared
      against itself — and the test logs the resolved identity of each side so a self-comparison is
      visible rather than silently green.
- [ ] Mismatch fails loudly with the ray and both distances printed.

| Test file | Test name | Assertion | Negative control (must be observed red) |
| --- | --- | --- | --- |
| `gpu-scene-bvh.spec.ts` | `should return the same hit distance as ScenePicker for sampled rays` | within tolerance, N ≥ 64 | offset one packed vertex by 0.5 → mismatch, reds |
| `gpu-scene-bvh.spec.ts` | `should exclude objects the predicate rejects` | excluded mesh never hit | ignore the predicate → hit, reds |
| `gpu-scene-bvh.spec.ts` | `should report both sides as distinct implementations` | logged CPU and GPU identities differ | point both at the CPU path → identical, reds |

**Revert check:** delete the packing step → the differential test fails, and it is a test nothing at
HEAD could have passed.

### Phase 2 — a game uses it for something visible

**Files (3):** an example or template (EDIT — a TSL kernel that traces, in `src/render/` because what
it draws is look), its playtest (NEW), verification record (NEW).

- [ ] One visible consumer — contact occlusion under props is the smallest honest one.
- [ ] The scenario asserts a **rendered difference**, not that a buffer exists.
- [ ] Build cost and per-frame cost recorded for the scene size used.

### Phase 3 — it runs on native, and the tree is built once

**Files (3):** `packages/runtime-native/conformance/registry.json` (EDIT),
`gpu-scene-bvh.ts` (EDIT — share the built tree with `ScenePicker` if the shapes allow),
verification record (EDIT).

- [ ] The conformance case traces on desktop native and reports the target it ran on.
- [ ] If `ScenePicker` and `GPUSceneBVH` can share one built tree, they do — two trees over the same
      geometry is the duplicate-implementation smell in memory form. If they cannot, the reason is
      written down here.

## Acceptance criteria (consumer-scoped)

- [ ] A game traces thousands of rays inside a TSL kernel against its own loaded scene, and the
      result matches `ctx.raycast` for sampled rays — pasted, with both implementations named.
- [ ] A visible rendered effect in an example changes when the BVH is removed, and the playtest
      catches it.
- [ ] The same scene traces on desktop native through the conformance lane, naming the target.
- [ ] Scene change releases every buffer; a `goto` loop does not grow memory.
- [ ] No GI, no surfels, no lighting decision entered `packages/` — grep pasted.
- [ ] No new dependency and no version bump: `pnpm-workspace.yaml` still reads
      `three-mesh-bvh: 0.9.14`, and nothing is vendored.
- [ ] Build cost and per-frame cost are in the capability docs, so an agent choosing this knows what
      it buys.

## Kill switch

If the only consumer this ever finds is one example, it is deleted. A GPU BVH with no game using it
is a research artifact, and the manifest would be advertising a capability nobody reached for.

## Borrow map — where to read what

Read these before writing anything; they are the reference, not the dependency. Pinned to the
commit this PRD was written against, so the line numbers still mean something: **`jure/webgiya` @ `0cd7f968`**.

| To implement | Read |
| --- | --- |
| the entire technique: scene → storage buffers a TSL kernel can trace | `src/sceneBvh.ts:1-212` |
| vertex packing into the buffer layout | `src/vertexPacked.ts:1-85` |
| per-material data as an array texture (only if materials are traced) | `src/diffuseArray.ts:1-132` |
| the tracing functions themselves — **use the installed package, not webgiya's vendored copy** | `three-mesh-bvh@0.9.14/src/webgpu/`: `BVHComputeData.js`, `bvh_ray_functions.wgsl.js`, `tsl/fns.js` |
| **do NOT borrow** — it vendors an older BVH because it pins `^0.9.2` | `src/external/three-mesh-bvh/`, and `src/sceneBvh.ts:3-4` |
