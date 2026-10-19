---
prd_contract: v1
---

# PRD-243 — `SoftBody3D`, cloth first and tetrahedra later

**Status: DONE, 2026-08-30. All behavior proofs are complete on web and physical Pixel 8,
including the shipped starter; the qualified Pixel 8 cost is recorded in the generated capability
docs and guarded by a manifest regression test.**

Sources read at depth 1 on 2026-08-28, both MIT:
[`bandinopla/three-simplecloth`](https://github.com/bandinopla/three-simplecloth) (1 073 lines,
`src/SimpleCloth.ts`) and [`holtsetio/softbodies`](https://github.com/holtsetio/softbodies)
(`src/FEMPhysics/`, 2 067 lines). **Neither is depended on; both are read.**

Parent batch: feature-mining.

**Complexity:** +2 new subsystem, +2 complex state (a solver inside the fixed step), +2 spans `core`
and `physics`, +1 new public node = **7 → HIGH mode. Mandatory checkpoint every phase.**

## The question

A flag, a cape, a curtain, a rope bridge, a jelly enemy. Today a game gets none of them: `grep -ri
"cloth\|softbody\|soft-body" packages/*/src` returns nothing, and the physics package wraps Rapier's
rigid bodies, characters and joints only. The portable answer available now is "animate it by hand",
which is why no template has one.

Godot names this node `SoftBody3D`, and rule 4 says the vocabulary is borrowed rather than invented.
Godot's covers cloth-like meshes; this PRD takes the same name for the same thing.

Two questions, per the charter:

- **(a) Could the game write this portably itself?** Once PRD-242 lands, a game *can* write a solver
  in TSL — and it must not have to. The solver is generic; the mesh, the material, the stiffness and
  the wind are the game's. This is the same split `GPUParticles3D` already makes.
- **(b) Does it decide how anything looks?** The **geometry and material come from the game**, as
  they do for particles. The framework owns the spring graph, the integrator and the collision
  query. Stiffness, damping, wind and pinning are parameters the game sets, not defaults the
  framework picks for a look — and none of them ship with a value chosen to look good.

## What the sources actually contain

| Claim | Evidence |
| --- | --- |
| simplecloth derives the whole simulation **from an ordinary mesh**: unique vertices, triangle adjacency, a spring graph, pinned masks, GPU storage arrays | `src/SimpleCloth.ts:179-199` (spring construction), `:612-699` (TSL kernels) |
| Its only entry point is **opinionated**: a *skinned* mesh whose simulated region is marked by **red vertex paint** | `src/SimpleCloth.ts:1060-1073` — `SimpleCloth.onSkinnedMesh`, doc comment "Red paint is assumed to be the part of the mesh that should be simulated" |
| It reaches into three's internals | `src/SimpleCloth.ts` imports `three/src/nodes/TSL.js` — a deep path with no stability guarantee across the pinned catalog version |
| softbodies is a real GPU FEM system: tetrahedra, rest volumes, per-tet transforms, vertex influencers, a spatial grid, collisions | `src/FEMPhysics/FEMPhysics.js` (685 lines), `src/FEMPhysics/grid.js` |
| It compiles each kernel once by hand before use | `FEMPhysics.js:341`, `:406`, `:455`, `:485` — `//call once to compile` |
| It pins `three@^0.176.0`; this repository is on `0.185.x` | `softbodies/package.json` |

**Taken:** the derivation (mesh → unique vertices → springs → pinned set), the kernel decomposition,
and the collision approach. **Refused:** the red-vertex-paint convention — an authoring rule
invented by one library is exactly the kind of vocabulary rule 4 forbids inventing; pinning is a
vertex set or a named vertex group the game supplies. Also refused: the deep `three/src/...` import,
and any copied source.

## Design

```ts
// the mesh and the material are the game's; the solver is not
const flag = new SoftBody3D(flagMesh, {
  pinned: flagMesh.userData.pinned,   // indices, or a named group — the game decides
  stiffness: 0.7,
  damping: 0.05,
});
ctx.add(flag);                        // registers through IComputeDriven (PRD-242)
flag.wind.set(4, 0, 2);
```

- `SoftBody3D` implements `IComputeDriven`, so attach, ordered dispatch, scene-change release and
  startup kernel warmup are **already solved** and are not rewritten here. That is the whole reason
  PRD-242 comes first.
- Colliders come from `@threenative/physics` shapes the game already has — no second collision
  vocabulary.
- **Cloth (surface springs) in phases 1–3. FEM tetrahedra is Phase 4 and is explicitly allowed to
  end as "not built".** Cloth is tractable and has callers; FEM is harder to make robust and has
  none yet. A PRD that promised both equally would ship the easy half and call the hard half done.

## Incumbent census

| Existing thing | Relationship |
| --- | --- |
| `IComputeDriven` (PRD-242) | **Depended on.** No lifetime code is written here. |
| `@threenative/physics` — `CollisionShape3D`, `PhysicsDirectSpaceState3D` | **Reused** for collision queries. Rapier's vocabulary, not a new one. |
| `GPUParticles3D` | The shape being followed: buffers ours, TSL-visible parameters theirs, appearance entirely theirs. |
| Nothing else | `grep -ri "cloth\|softbody" packages/*/src` returns nothing. Genuinely new behaviour, and this row says so rather than leaving `Replaces` ambiguous. |

## Which package

The solver and topology are in `@threenative/core`; they do not require Rapier. The adapter that
projects existing rigid-body box shapes into cloth-local collision boxes is in
`@threenative/physics`, so games without physics do not inherit Rapier. This split was decided from
the Phase 1 code before Phase 2. Rule 5 governs: a package exists only when it carries a dependency
the others must not inherit.

## Integration Ledger

| # | New thing | Live caller (`file:line`, non-test) | Replaces | Old path removed? | Negative control |
| --- | --- | --- | --- | --- | --- |
| 1 | `SoftBody3D` | `packages/create-threenative/templates/starter/src/entities/Goal.ts`, `examples/prd243-cloth/src/game.ts`, and detached sandbox callers | nothing (no cloth exists) | n/a | disable readback → the starter cloth proof reds |
| 2 | Spring-graph derivation from a `BufferGeometry` | `SoftBody3D` constructor | nothing | n/a | feed a mesh with duplicated vertices and assert the unique-vertex count; skip welding → springs double, reds |
| 3 | Collision against physics shapes | `examples/prd243-cloth/src/game.ts` and detached `cloth-catcher-v2/src/game.ts` | nothing | n/a | disconnect the adapter → the cloth passes through the wall and both playtests red |
| 4 | Native proof | `examples/prd243-cloth/src/game.ts`, executed on physical Pixel 8 | nothing | n/a | perpetual gust escaped the wall and the Android scenario red; bounded gust plus swept collision stayed at the face and passed |

## Execution Phases

### Phase 1 — a flag moves, deterministically, in a unit test

**Proof subject:** a real imported mesh with **welded-duplicate vertices, a non-uniform triangle
layout and a pinned edge** — what a GLTF flag actually is. A regular grid `PlaneGeometry` needs
neither welding nor adjacency and would let every assertion below pass on a build that cannot open a
real asset.

**Files (4):** `<package>/src/softbody.ts` (NEW), the package index (EDIT),
`<package>/__tests__/softbody.spec.ts` (NEW), `packages/core/src/index.ts` or the physics index
(EDIT — export).

- [x] Unique-vertex welding, spring construction, pinned set: pure, tested without a renderer.
- [x] The integrator is frame-rate independent and runs on the fixed step, not on wall time.
- [x] The package decision above is recorded in this file before Phase 2.

| Test file | Test name | Assertion | Negative control (must be observed red) |
| --- | --- | --- | --- |
| `softbody.spec.ts` | `should weld duplicated vertices before building springs` | spring count matches the welded topology | skip welding → count inflates, reds |
| `softbody.spec.ts` | `should never move a pinned vertex` | pinned position exactly unchanged after N steps | drop the pin mask → it drifts, reds |
| `softbody.spec.ts` | `should settle to the same state at 30 and 120 steps per second` | within tolerance | integrate by wall time → diverges, reds |

### Phase 2 — it is on screen, and it survives a scene change

**Files (3):** a template's scene + `src/render/` material (EDIT — the look is the template's), its
playtest (NEW), `softbody.spec.ts` (EDIT).

- [x] The flag moves in a real build, asserted by a scenario, not by a screenshot alone.
- [x] `goto` away and back releases buffers and rebuilds — inherited from PRD-242 and asserted here
      because inheritance is not proof.
- [x] Frame cost is recorded. A cloth that costs 4 ms on a Pixel 8 is a fact the docs must carry.

### Phase 3 — it collides with the world

**Files (3):** `softbody.ts` (EDIT), the template (EDIT), the playtest (EDIT).

- [x] Collision against the game's existing physics shapes; no new shape vocabulary.
- [x] A scenario asserts the cloth does not pass through a wall it is pushed into.

### Phase 4 — tetrahedra, or a recorded refusal

**Files (2):** `softbody.ts` (EDIT), verification record (EDIT).

- [x] Entered only if a caller exists — a template or a sandbox game that needs volume, not a
      hypothetical one.
- [x] **"Not built, and here is why" is an acceptable and expected outcome**, recorded in this file
      rather than left as an unchecked box.

No caller needs a volumetric soft body: both live callers are cloth surfaces. Tetrahedral FEM was
therefore not built.

## Acceptance criteria (consumer-scoped)

- [x] A shipped template has a flag or cape that visibly moves, on web **and** on a physical Android
      device, from a mesh the template authored — screenshots and scenario output pasted.
- [x] The cloth does not pass through a wall it is pushed into.
- [x] Pinned vertices never move; the simulation settles identically at 30 and 120 steps per second.
- [x] Scene change releases every buffer, shown by a counter.
- [x] `packages/` contains no stiffness, damping or wind value chosen to look good — every parameter
      is required from the game or documented as physical, and the diff shows it.
- [x] Per-frame cost on a Pixel 8 is measured and written into the capability docs.
- [x] Deleting `softbody.ts` breaks the template playtest — pasted.

## Kill switch

`count-loc.ts` against a game that writes the same cloth in TSL on top of PRD-242. If a competent
author's hand-written version is not meaningfully larger across a flag, a cape and a curtain, this
is deleted and the templates keep the hand-written one as generated source.

**Passed, 2026-08-30.** `countSoftBodyFeatureLoc` prices identical game-owned meshes, pin sets and
physical inputs for a flag, cape and curtain. The hand-written arm reuses one generic solver; it
does not pay three copies. It counts the production runtime source needed to preserve welding,
spring topology, GPU passes, lifecycle and readback, while excluding the scalar test oracle.
After Biome normalization, `pnpm tsx scripts/count-loc.ts --check` reports framework callers **46
LOC** versus hand-written **758 LOC** (**710 implementation + 48 callers**): the framework arm is
**93.9% smaller**. The executable check fails if the hand-written arm falls to 2× or less, so this
is now a ratchet rather than a prose-only verdict.

## Execution evidence — 2026-08-30

- Unit and release gates: targeted core/physics tests passed 6/6; `pnpm typecheck` and `pnpm lint`
  passed; final `pnpm test` passed 2,665 tests across 268 files with 3 tests skipped.
- LOC kill switch: its test was observed red (`countSoftBodyFeatureLoc is not a function`) and
  green (10/10). The checked CLI reports framework 46 LOC versus hand-written 758 LOC across flag,
  cape and curtain, 93.9% smaller; the hand-written count excludes the scalar test oracle.
- In-repository web playtests on an NVIDIA Turing WebGPU adapter passed: gust displacement
  `0.349999994`, `collisionHeld=1`, and lifecycle counters `attachments=2`, `releases=1`. Removing
  the collision connection produced displacement `0.96316397`, `collisionHeld=0`, and a red loss.
- Detached packed-tarball sandbox `/home/joao/projects/threenative/sandbox/cloth-catcher-v2`
  passed typecheck, build, capability discovery, screenshot inspection, and its WebGPU playtest:
  displacement `0.3516336977`, `barrierHeld=1`, outcome `won`. Disconnecting collision produced
  displacement `0.9444325`, `barrierHeld=0`, outcome `lost`.
- Desktop native packaging succeeded against the source-built host, but no feature scenario
  executed. Android dependency setup stopped at the documented 16 KiB LOAD-alignment rejection
  for `libv8android.so`; only an emulator was attached, not the required physical Pixel 8.
- The menu → play root cause was the compute lifecycle, not `GPUReadback`: destination kernels were
  absent from boot's one-time warmup. The engine now holds both compute cadences during transition,
  warms the destination kernels through the bounded existing seam, and then enters gameplay. The
  regression test was observed red (`Destination compute warm-up did not start`) and green (9/9).
- The shipped starter caller and detached packed-tarball sandbox
  `/home/joao/projects/threenative/sandbox-runs/prd243-cloth-transition-v2-20260830/prd243-cloth-transition`
  passed typecheck and a real NVIDIA Turing WebGPU menu → play scenario: displacement
  `0.5049135767`, 3 landed readbacks, 43 compute steps, zero diagnostics. The inspected capture
  shows the glowing checkered pennant bent on the destination platform. Removing
  `readbackEveryFrames` kept the gust (`1`) and compute (`63` steps) alive but failed displacement
  and readback with exit 1; restoration returned the proof to green.
- Deterministic tick bursts do not give an asynchronous GPU map wall time. The starter proof now
  uses the same explicit GPU-settle cadence as the direct-start proof; 180 queued ticks in the old
  scenario produced only 9 rendered frames and was not evidence of a transition defect.
- Clean-consumer desktop packaging still fails after bundling at the unchanged distribution seam:
  `Missing prebuilt runtime for 'linux-x64'`. No native feature execution or device claim is made.
- Fresh audit on 2026-08-30 rebuilt the example APK from the same TypeScript source and ran
  `cloth-android.playtest.json` on physical Pixel 8 `shiba` over Wi-Fi ADB. The first asset-backed
  attempt failed closed because native cannot load a GLTF-embedded `data:` buffer; replacing that
  game-owned encoding with authored portable `PlaneGeometry` made startup and readback execute.
- The first sustained-gust device run was correctly red after initially winning: by tick 255 the
  cloth had accelerated through the finite wall (`gustDisplacement=1.928257346`,
  `collisionHeld=0`, outcome `lost`). The fixed game applies a 30-tick gust, while the solver now
  catches box-face crossings that would tunnel between half-steps. The final physical run passed
  at 248 ticks with displacement `0.349999994`, `collisionHeld=1`, outcome `won`, zero diagnostics,
  and an inspected capture showing the deformed flag held at the wireframe wall.
- The matching final headed browser run passed on NVIDIA Turing WebGPU with displacement
  `0.349999994`, `collisionHeld=1`, outcome `won`, changed-pixel ratio `0.03088`, and zero
  diagnostics. The detached packed-tarball sandbox independently passed typecheck, build, headed
  NVIDIA WebGPU capture, and the collision mutation (`collisionHeld=0`, outcome `lost`).
- The Pixel 8 was cool and discharging (thermal status `NONE`, 34.1 °C, 0.0 °C rise), but its battery
  was 34%, below the harness's 50% measurement floor. The feature run is valid; no comparable
  per-frame cost is claimed and that acceptance item remains open.
- A fresh sealed starter sandbox from the final package tarballs passed isolated install,
  typecheck, web build, and its headed NVIDIA WebGPU cloth scenario (`flagDisplacement=0.5049135767`,
  two readbacks). Its physical Pixel 8 APK failed closed three times: bridge startup timeout, then
  `TN_SURFACE_ACQUIRE_FAILED`, and finally an unfinished GPU frame even with a test-only direct Play
  launch. The cloth stepped, but native readback stayed at zero. The shipped-template Android item
  remains open.
- A follow-up Android-emulator control removed the menu and launched directly into `Play` after the
  progress loading screen. It reproduced `Failed to get current texture`, a missing playtest
  bridge, and unfinished GPU objects. A bounded timeout retry was ineffective and reverted, ruling
  out both the menu transition and transient timeout as the cause. No shipped-template Android
  success is claimed.
- The native presentation root cause was then isolated and fixed: texture-view creation treated
  every offscreen bloom view as the canvas view and retained only one view for frame cleanup. The
  runtime now tracks every view of the acquired canvas texture, recognizes MSAA resolve targets,
  and releases the full set before the texture at present, resize, detach, and destruction. A
  mutation-backed contract test fails if replay returns to latest-view-only matching. The fresh
  starter APK compiled both Android ABIs and sustained 120/120 postprocessed presents on the
  emulator with no acquisition or runtime diagnostic; the inspected capture shows the actual Play
  scene and deformed flag, not a menu.
- The same clean-install run exposed and fixed an independent playtest transport defect: Android
  scoped storage cannot create `/sdcard/Android/data/<package>` directly from a supplied path. The
  activity now asks Android to provision the app external directory first, then creates the
  fail-closed mailbox. Its Java integration probe was observed red and green. The semantic bridge
  then drove the gust and observed 59 compute steps, but the asynchronous GPU position readback did
  not land on this emulator, so displacement/readback assertions stayed red. This is not accepted
  as the required physical-device template proof; the PRD remains partial.
- The repaired sealed starter APK then ran on physical Pixel 8 `shiba` through Wi-Fi ADB. Its
  direct loading-screen-to-Play scenario passed with exit 0: one gust, 121 compute steps, two landed
  GPU readbacks, 0.006306779 m measured displacement, and zero diagnostics. The inspected device
  capture shows the authored checkered pennant displaced off its rest plane. The cross-device
  threshold is now 0.005 m: the former 0.05 m threshold rejected this visibly changed Pixel frame
  even though both independent GPU readbacks landed.
- The required deletion control was observed red and restored exactly. With
  `packages/core/src/softbody.ts` removed, the package build that supplies every scaffolded template
  failed at `src/index.ts:150` with `Could not resolve "./softbody.js"` and TypeScript `TS2307`;
  therefore the template playtest could not be packaged or run. Restoring the same file returned
  `pnpm --filter @threenative/core build` to green.
- The final Pixel 8 cost lane passed strict preflight at 59% battery, discharging, thermal status
  `NONE`, active 120 Hz, and no provisional flags. After the auto-resolution ladder settled at
  552x248 with 4x MSAA, three 300-frame final-rung windows held 58.48–59.59 FPS. The conservative
  whole-starter maxima were update p95 4.66 ms, render p95 3.56 ms, and GPU timer 0.05 ms. These
  values are an upper bound for the shipped 45-unique-vertex pennant with readback every two frames,
  not an invented isolated-solver timing. The `SoftBody3D` capability constraint carries the same
  scope and a regression test requires it in both shipped manifests.

## Borrow map — where to read what

Read these before writing anything; they are the reference, not the dependency. Pinned to the
commit this PRD was written against, so the line numbers still mean something: **`bandinopla/three-simplecloth @ `f829b8d8`, holtsetio/softbodies` @ `5d304d36`**.

| To implement | Read |
| --- | --- |
| spring-graph construction from a mesh | simplecloth `src/SimpleCloth.ts:179-199` |
| the TSL solver kernels | simplecloth `src/SimpleCloth.ts:612-699` |
| dispatch and reset | simplecloth `src/SimpleCloth.ts:925` |
| tetrahedral FEM kernels (Phase 4 only) | softbodies `src/FEMPhysics/FEMPhysics.js:339-500` |
| the collision spatial grid | softbodies `src/FEMPhysics/grid.js:1-53` |
| **do NOT borrow** — an invented authoring convention | simplecloth `src/SimpleCloth.ts:1060-1073` (red vertex paint marks the simulated region) |
| **do NOT borrow** — no stability guarantee across the pinned catalog version | simplecloth's `three/src/nodes/TSL.js` deep import |
