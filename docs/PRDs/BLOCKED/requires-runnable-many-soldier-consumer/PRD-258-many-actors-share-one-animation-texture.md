---
prd_contract: v1
---

# PRD-258 — Many actors share one animation texture

**Status: BLOCKED AT PHASE 0, 2026-08-30. No product code shipped.**
Repository `/home/joao/projects/threenative/threenative-engine`, remote
`https://github.com/ThreeNativeHQ/threenative.git`, branch `main`, baseline HEAD
`e8754ab24e8e227ab472690a3d8d7b6d2cd53550`. Binding charter:
[`docs/architecture/CHARTER.md`](../../../architecture/CHARTER.md). Parent batch:
feature-mining.

**Priority:** P3 — Its own blocked-on says Phase 0 may close it DECLINED with nothing built.
**Blocking evidence:** the required real many-soldier consumer is not reproducibly runnable from
its committed source. A detached `sandbox/fps-framework` at `e2652889` requests
`public/raw-assets.manifest.json`, but that commit contains only `public/assets.manifest.json`.
Against exact engine tarballs built from `68b32a65`, the browser receives the Vite HTML fallback,
reports `Unexpected token '<'`, creates zero canvases, and never installs the playtest bridge. Three
repair attempts stopped before assertions, as required by the repository's three-fix rule. Phase 0
therefore cannot measure or decline the candidate. The runnable-consumer repair and all browser,
desktop, Android and iOS performance rows remain **UNVERIFIED**.

**Outcome if Phase 0 survives:** the existing measured many-skinned-soldier subject bakes one or
more clip's bone matrices into a shared GPU animation texture at build time, then renders many
independently timed actors through upstream Three/WebGPU instanced skinning. The game still owns the
actor list, gameplay state, clip choice, speed, skeleton, material, LOD, transforms and look.

**Complexity:** +2 build-time animation bake, +2 render-projection / WebGPU skinning integration,
+2 native/WebGPU parity and performance gates, +1 real consumer gate, +1 asset-manifest data contract
= **8 → HIGH mode. Mandatory automated checkpoint after every phase.**

---

## 0. Decision first — consumer-gated, and allowed to decline

This PRD exists because the next credible character-performance question is not an animation state
machine, ragdoll, IK, or neural controller. It is the mechanical cost of drawing many actors that
share one rig and clip set.

**Phase 0 can close this PRD as DECLINED, with nothing built.** It proceeds only when both are true:

1. the existing many-skinned-soldier subject shows current skinned-animation cost of **at least
   2 ms/frame**, measured on the real soldier content and attributable to repeated skeleton update,
   skinning or draw submission rather than the soldiers' material/shadow look; and
2. a repeated consumer is named clearly enough that the work is not a benchmark ornament.

If the run is below 2 ms/frame, or if the only reason to build is that the upstream example is neat,
this file is marked DECLINED and no source file changes. A decline is a complete outcome.

If flat-material or shadow-off controls show that the ≥2 ms belongs to the soldiers' look rather than
repeated animation/skinning mechanics, Phase 0 declines this PRD. That result belongs in game render
source or a separately proven material mechanism; it is not a pretext to build GPU skinning.

---

## 1. What was read

**ThreeNative files read at `e8754ab2`:**

| File | Relevant fact |
| --- | --- |
| `AGENTS.md` | Mechanism may live in `packages/core/src/` only when the game owns every appearance parameter; native proof is required for unportable helpers. |
| `docs/PRDs/AGENTS.md` | Performance records for runtime/core consolidate into `docs/verification/runtime-perf-state.md`; red controls must name the mutation that fails. |
| `docs/architecture/CHARTER.md` | The framework owns portable plumbing and platform seams, never the look, never a new renderer, IR, editor, preset system, ECS, or bespoke vocabulary. |
| `docs/PRDs/feature-mining/README.md` | Feature-mining PRDs carry a borrow map, exact refusal scope, and do not edit the batch README as part of filing. |
| `docs/PRDs/done/PRD-039-animation-state-machine.md` | State machines, blends, one-shots and root-motion policy stay game-owned unless measured rigged-asset evidence reopens them. |
| `docs/PRDs/done/PRD-144-ragdoll.md` | Ragdolls were withdrawn by the kill switch; do not smuggle death physics into this work. |
| `docs/PRDs/done/PRD-228-the-pixel-budget-is-the-engines.md` | Pixel budget / resolution scale is engine-owned mechanism, but Bayview's look remains game-owned and platform claims require device evidence. |
| `docs/PRDs/BLOCKED/requires-portable-native-residency-consumer/PRD-253-content-residency-and-screen-space-hlod.md` | Residency/LOD owns content arrival and measured byte budgets; this PRD must not invent a second LOD or residency scheduler. |
| `packages/core/src/animation.ts` | `AnimationPlayer` already owns clip playback, fades, once clips, stride sync and reports; this PRD must not replace it with a graph. |
| `packages/core/src/projection-plan.ts` | Skinned meshes currently go to the exact lane (`isSkinnedMesh` reason), and `LOD` subtrees are mirrored as exact containers. |
| `packages/core/src/projection-apply.ts` | Exact-lane `SkinnedMesh` stand-ins copy the game's `skeleton`, bind matrices, geometry, material, morph data and LOD levels by reference. |
| `docs/verification/runtime-perf-state.md` | Bayview's current device performance is pixel/material/draw heavy, and 60 Hz acceptance is not satisfied merely by high-refresh numbers. |
| `docs/PRDs/performance/PRD-186-fps-sandbox-lifts.md` | The fps sandbox has real soldier consumers and already measured several soldier costs; this PRD must reuse that style of proof. |

**Pinned source repositories read-only:**

| Source | Commit | Licence | What matters here |
| --- | --- | --- | --- |
| `/tmp/threenative-feature-mining-11-15/three.js` | `444f238c63b594fbaf1d5adde301fa7e10c29a83` | MIT | Primary reference: `examples/webgpu_skinning_instancing.html` and `examples/webgpu_skinning_instancing_individual.html`. |
| `/tmp/threenative-feature-mining-11-15/threejs-gpu-skinning` | `09f184c23bc85022da6ad51b38dea4dfc0c85cb8` | ISC (`package.json`) | Historical bake-to-texture shape; its WebGL material patcher is explicitly refused. |
| `/tmp/threenative-feature-mining-6-10/ai4anim-webgpu` | `b539455f849f284a1e814eb11ab649eb594319dc` | CC BY-NC 4.0 | Research only. Its actor buffer discipline informs risk, but no source, vocabulary, or code is absorbed. |

---

## 2. Problem

Today a crowd of rigged actors reaches ThreeNative as many ordinary skinned meshes, each with its own
skeleton updates and exact-lane rendering. That is correct and expressive, but the repeated case has a
specific mechanical waste: the same rig and clip are evaluated many times when the only per-actor
inputs are time, transform and game-owned variation.

The admissible engine mechanism is small in concept:

- bake `AnimationClip` bone matrices for a known skeleton into one shared GPU texture or storage
  backing at asset-build time;
- each actor supplies an instance matrix and a clip-time cursor;
- Three/WebGPU samples the shared bone data while drawing an instanced skinned mesh; and
- gameplay and visuals remain outside the package.

The engine must **not** infer state, author movement, choose clips, choose skins, or decide how many
actors exist. The game says: "these N actors use this already-baked rig/clip set, at these times and
matrices." The package answers: "here is the mechanical draw path when the measured gate says it is
worth having."

---

## 3. Non-goals and hard refusals

These refusals are part of the product contract, not implementation taste.

- **No neural motion matching.** `ai4anim-webgpu` is CC BY-NC 4.0 and research only. No model runtime,
  trajectory predictor, contact planner, autopilot, or learned-controller vocabulary enters this repo.
- **No `AnimationTree`, state machine or graph.** PRD-039 remains closed. The game owns state → clip
  mapping and can keep using `AnimationPlayer` for hero/unique characters.
- **No ragdoll or physical bones.** PRD-144 remains withdrawn. This PRD does not hand animation to
  physics or build a death system.
- **No VAT for arbitrary vertex simulations.** Only skeletal bone matrices for an existing skeleton
  and clips are in scope. Cloth, morph-heavy effects, destruction and arbitrary vertex cache playback
  are separate problems.
- **No new renderer and no Three.js fork.** Use catalog Three/WebGPU behaviour; do not replace the
  renderer or add a visibility-buffer / meshlet path.
- **No WebGL shader patching.** `threejs-gpu-skinning/src/GPUSkinnedMeshMaterialPatcher.ts` is a
  do-not-borrow file. WebGL `onBeforeCompile` and material patch strings are out.
- **No NC source absorption.** `ai4anim-webgpu` informs only high-level risk notes.
- **No proprietary public vocabulary.** Prefer Three.js words (`SkinnedMesh`, `InstancedMesh`,
  `AnimationClip`, `Skeleton`, `boneTexture`) and existing ThreeNative asset-manifest terms.
- **No look ownership.** Material, texture, colour, shadow policy, scale variation, body proportions,
  LOD choice and camera framing are game-authored or existing Three objects.

---

## 4. Proposed shape

### Build-time half — `@threenative/assets`

Add an optional animation-bake step to the existing asset compiler. It accepts a real glTF/GLB with
one skeleton and one or more clips, samples each clip at a declared bake FPS, and writes:

- a shared floating-point bone-matrix texture or storage payload;
- manifest metadata mapping `clipName → frameOffset, frameCount, duration, fps`;
- `boneCount`, bind matrices, inverse bind matrices and skeleton identity hash;
- byte counts for CPU and GPU residency; and
- a report row saying exactly what was baked or why it refused.

Use the existing build-time `@threenative/assets` mechanism. Do not create a package unless Phase 0
finds a dependency that must be isolated; the expected answer is **no new package**.

### Runtime half — `@threenative/core`

Add a small runtime mechanism that turns one baked animated rig plus a caller-supplied actor buffer
into ordinary Three/WebGPU instanced skinned draws. The public surface should be no larger than:

```ts
export interface IInstancedSkinnedActor {
  readonly matrix: Matrix4;
  readonly clip: string;
  readonly time: number;
  readonly speed?: number;
  readonly visible?: boolean;
}

export interface IInstancedSkinnedReport {
  readonly enabled: boolean;
  readonly actors: number;
  readonly skinnedDraws: number;
  readonly exactSkinnedFallbacks: number;
  readonly animationTextureBytes: number;
  readonly uploadBytesThisFrame: number;
  readonly reason?: string;
}
```

Exact names may change during implementation if Three.js already has better names at the catalog
version, but the surface may not grow into a manager that owns gameplay. The runtime consumes the
game's geometry and material by reference, like the current projection mirror does. It may update a
per-instance time/index buffer; it may not mutate clip choice or actor state.

### Integration with projection and LOD

The projection already treats `SkinnedMesh` as exact and copies skeleton/material state faithfully.
This PRD adds a separate eligible lane only for the proven crowd case: same geometry, same material,
same skeleton identity, baked clips available, no unsupported morph/skin layout, and a caller-declared
actor set. Anything outside that lane keeps the existing exact path.

PRD-253 owns content residency and screen-space HLOD. This PRD consumes whatever actor meshes are
resident; it does not generate LODs or stream content. If a game supplies LOD levels for a crowd, the
game or PRD-253 chooses the resident level; this mechanism only draws the level it is handed.

---

## 5. Ownership

| Concern | Owner |
| --- | --- |
| Sampling clip bone matrices into a shared GPU animation payload | `@threenative/assets` build pass |
| Uploading and binding the shared animation payload | `@threenative/core` runtime mechanism |
| Actor matrices, visibility, clip name, time, speed, spawn/despawn and gameplay state | game code |
| Skeleton and clip authoring | game's source asset |
| Materials, textures, colours, shadows, tone mapping, body proportions and all look decisions | game `src/render/` / asset authoring |
| LOD selection and content residency | game-authored `THREE.LOD` and/or PRD-253 mechanism |
| Unique hero animation and bespoke blend logic | game code, optionally using existing `AnimationPlayer` |
| Native/WebGPU platform proof and diagnostics | engine gates and `docs/verification/runtime-perf-state.md` |

---

## 6. Phase 0 — isolate the real cost or decline

**Phase 0 writes measurements and a verdict before product code.** It uses the existing measured
many-skinned-soldier subject from the fps sandbox / PRD-186 lineage. If that subject is unavailable,
Phase 0 first records why and stops; a synthetic box rig is not a substitute.

**Measurements required, same camera path and actor count in every arm:**

1. current exact-skinned baseline: frame p50/p95, render p50/p95, skinned-update section if available,
   draw calls, triangles, skeleton count, actor count, animation-update ms, material/shadow pass costs;
2. hide soldiers but keep level/material cost, to isolate non-character work;
3. freeze animation but keep soldier meshes visible, to isolate animation update from skinning/draw;
4. flat-material and shadow-off diagnostics, pre-registered before the run, to reject material/look
   cost as evidence for this mechanism;
5. browser WebGPU with named adapter and native desktop if available; Android/iOS rows must read
   `UNVERIFIED` unless actually executed.

**Proceed only if:** repeated skeleton update, skinning or draw-submission mechanics attributable to
the exact skinned soldiers cost ≥2 ms/frame and there is a named repeated consumer. Otherwise mark
this PRD `DECLINED` and build nothing.

**Phase 0 commands:**

```sh
git status --short
pnpm --filter @threenative/playtest build
node packages/playtest/dist/runner/cli.js <many-soldiers>.playtest.json \
  --url http://127.0.0.1:5173 \
  --server-command "<sandbox dev command> --host 127.0.0.1" \
  --browser-recipe webgpu
node packages/playtest/dist/runner/cli.js perf --file <run-log>
pnpm tsx scripts/count-loc.ts
```

Record runtime/core performance findings in `docs/verification/runtime-perf-state.md`, per the PRD
AGENTS exception. Any separate per-run artifact must be referenced from that single state record.

---

## 7. Integration ledger

Every `→impl` cell must become a real non-test `file:line` before completion.

| # | New thing | Live caller | Replaces | Old path removed? | Negative control |
| --- | --- | --- | --- | --- | --- |
| 1 | Animation-bake manifest fields | `packages/assets/src/compile.ts:→impl` | ad-hoc runtime clip sampling per crowd | n/a | corrupt skeleton hash → load throws |
| 2 | Shared animation texture/storage payload | `packages/assets/src/passes/animation-texture.ts:→impl` | per-actor bone texture/matrices for identical clips | n/a | emit wrong frame count → visual/time assertion red |
| 3 | Instanced skinned runtime lane | `packages/core/src/projection-apply.ts:→impl` or named new module | exact lane for eligible repeated soldiers | no; exact remains fallback | disable lane → draw-count/perf gate red |
| 4 | Actor time/index upload buffer | real soldier scene `:→impl` | N independent mixer/skeleton updates for shared clips | yes, in the crowd consumer only | pin every time to zero → independent-timing gate red |
| 5 | Diagnostics report | `Registry.snapshot():→impl` | opaque performance claim | n/a | report constants → numbers fail to move with actor count |
| 6 | Native/WebGPU proof | `packages/runtime-native/conformance/registry.json:→impl` if native lane executes | web-only claim | n/a | native fallback forced → parity/perf row red or UNVERIFIED |

**Reachability:** game creates or loads the soldier crowd → asset manifest identifies baked clips →
caller supplies actor matrices and clip times → runtime lane groups compatible skinned meshes →
WebGPU draws instanced actors using shared bone data → diagnostics report actors, draws, bytes and
fallback reasons.

---

## 8. Acceptance criteria

- [ ] Phase 0 either declines with the measured reason or names a repeated soldier consumer and an
      isolated ≥2 ms/frame skeleton-update, skinning or draw-submission cost.
- [ ] The chosen consumer renders independently timed actors from one baked animation payload; two
      actors at different `time` values visibly and observably differ while sharing geometry,
      material, skeleton and clip texture.
- [ ] The game can change material, texture, colour, shadow settings, actor transforms, clip choice,
      speed and LOD without editing package code.
- [ ] Unique/unsupported skinned meshes continue through the existing exact lane and still animate.
- [ ] The animation bake refuses skeleton/clip mismatches, missing skin attributes, unsupported morph
      combinations, stale source hashes and non-float-capable WebGPU targets fail-closed.
- [ ] Browser WebGPU evidence names the adapter. Native desktop evidence is separate if executed;
      Android and iOS rows are honest `UNVERIFIED` unless run on those lanes.
- [ ] `docs/verification/runtime-perf-state.md` records baseline vs instanced results, with the same
      actor count, camera path, materials, shadows, resolution scale and PRD-228 display settings.
- [ ] Integration ledger has zero `→impl` cells and every new export has a non-test live caller.
- [ ] All negative controls below were observed red before the final green.

---

## 9. Negative controls

| Gate | Control | Expected red | Command |
| --- | --- | --- | --- |
| Bake identity | Change one source skeleton bone name after bake | `TN_ANIMATION_TEXTURE_STALE_SKELETON` or equivalent | `pnpm --filter @threenative/assets test -- animation-texture` |
| Independent time | Force all instance frame indices to 0 | two actors expected in different poses match incorrectly | `pnpm --filter @threenative/core test -- instanced-skinning` |
| Fallback safety | Remove baked manifest fields | scene uses exact skinned lane and reports fallback reason | soldier playtest |
| Look ownership | Swap material in game source only | instanced crowd draws with swapped material, no package edit | soldier playtest + screenshot/visual assertion |
| Performance proof | Disable instanced lane | draw count or measured skinned cost returns to Phase 0 baseline | `node packages/playtest/dist/runner/cli.js perf --file <run-log>` |
| Platform honesty | Run without named WebGPU adapter | performance evidence rejected, not filed as green | browser WebGPU playtest |

---

## 10. Borrow map

| Borrowed | From | Licence | Take | Do not take |
| --- | --- | --- | --- | --- |
| Upstream supported WebGPU instanced-skinning shape | `three.js/examples/webgpu_skinning_instancing.html` | MIT | ordinary Three/WebGPU `isInstancedMesh`, instance matrices, shared model/clip idea | demo lights, materials, colours, camera, post, layout |
| Per-instance pose computation and shared bone matrix storage | `three.js/examples/webgpu_skinning_instancing_individual.html` | MIT | storage-buffer organization, per-instance offsets, one compute before render | its body-shape/proportion demo, material choices, scene UI |
| Bake clip frames into one bone texture | `threejs-gpu-skinning/src/GPUSkeleton.ts` | ISC | sample clip frames, pack bone matrices into a texture | `GPUSkinnedMeshMaterialPatcher`, WebGL shader strings, `document` debug hooks |
| Instance-local animation time/frame | `threejs-gpu-skinning/src/InstancedSkinnedMesh.ts` and `CrowdManager.ts` | ISC | each instance has its own time/frame cursor | old Three r133 API, FBX-specific loader flow, random colours, material patcher |
| Non-allocating per-actor matrix write discipline | `ai4anim-webgpu/src/runtime/actor.ts` | CC BY-NC 4.0 | research note: actor state writes into shared arrays without bone scene traversal | source code, model, neural runtime, API names |
| Sequence sampling risk | `ai4anim-webgpu/src/runtime/sequence.ts` | CC BY-NC 4.0 | research note: interpolation/time cursors need preallocated scratch | source code or motion-matching semantics |

---

## 11. Rollback and kill conditions

**Rollback:** the build pass is optional and additive. Removing the runtime lane returns eligible
crowds to exact skinned meshes. Removing manifest bake fields makes the consumer report exact fallback
rather than failing a game that still owns ordinary skinned meshes.

**Kill conditions after Phase 0:**

- repeated skeleton-update, skinning and draw-submission cost is under 2 ms/frame, or the measured
  cost is actually material/shadow look;
- implementation requires a WebGL shader patch, new renderer, Three.js fork, or NC source;
- implementation chooses or constrains material/look/LOD/gameplay state;
- exact fallback breaks a unique skinned character or `AnimationPlayer` use;
- native cannot run the same source and the PRD tries to claim platform support anyway;
- LOC comparison says the game-owned plain Three path is smaller for the repeated consumer.

## 12. Validation command for the blocked Phase 0 record

```sh
git diff --check
pnpm check:docs
pnpm typecheck && pnpm lint && pnpm test
```

The runtime playtest must remain failed closed until the configured manifest exists in the committed
consumer; do not convert that missing observation into a green skip.
