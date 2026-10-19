---
prd_contract: v1
---

# PRD-377 — One source model gets the right detail by default

## TL;DR

A developer authors one GLB and loads it through ThreeNative's normal asset path. ThreeNative generates useful lower-detail geometry during the existing asset compile/cook, then selects detail automatically from projected geometric error. No hand-authored LOD files, special loader, or game-owned update loop is required. **Automatic LOD is on by default for eligible assets; `threenative.config.ts` is its source of truth and provides a complete opt-out.**

This is not a greenfield LOD renderer. The repository already has default-on virtual geometry for sufficiently dense primitives. Extend and reconcile that machinery, adding a conservative discrete-LOD path where it supplies missing value. Exactly one system owns detail selection for a primitive. Preserve the original source, the full-detail fallback, materials, object identity, and gameplay semantics.

**Status:** PARTIAL — Phase 0 traced; Phase 1 config/eligibility/generation/artifact and Phase 2 engine-owned runtime landed and tested; Phase 3 browser WebGPU and Linux native consumer evidence plus both dense-asset triangle-reduction gates pass on hardware (8,192 → 369 web / 368 native far-route triangles, RTX 2080). Windows/macOS/Android/iOS qualification, frame-time/quality/byte gates, default-on (Phase 4) and the remaining Closure Gates are NOT started. No Closure Gate is claimed complete. The opt-in join far rung (§4.4) is now selected at runtime by the one selection authority: the authored primitives are hidden and the joined proxy is shown as one unit, reversibly, with picking kept on the authored nodes. Shadow/reflection passes still share the main selection (no dedicated coarser shadow rung), and no GPU/browser run exercises the joined selection yet.
**Priority:** P1 — Open: zero-config LOD front door through dev and build, with tested precedence.
**Date:** 2026-09-11.
**Scope:** Asset compilation, configuration, ordinary model loading, and existing render integration.
**Complexity:** HIGH — default-on lossy processing crosses build, runtime, and platform boundaries.

## Closure Gates

Every box below requires evidence from the implementation revision. Merging this PRD completes none of them.

- [ ] **Zero-configuration front door:** an ordinary created project with one eligible GLB and no LOD settings generates and renders lower detail through normal `tn dev` / `tn build` and normal model loading. No custom game loop, private import, or manually prepared LOD input is involved.
- [ ] **Config actually controls execution:** omission, global off, presets, partial settings, and per-asset overrides are typed, validated, serialized, and consumed by both compiler and runtime. Existing explicit opt-outs remain effective.
- [ ] **One owner, not two optimizers:** authored LOD, `TN_virtual_geometry`, explicit legacy simplification, and new discrete LOD have tested precedence. No primitive is automatically simplified or selected twice.
- [ ] **Quality and correctness:** approved eligible fixtures pass structural checks and rendered comparisons at switch boundaries; excluded fixtures retain their baseline rendering and gameplay behavior. Error estimates are never represented as universal perceptual guarantees.
- [ ] **Measured value:** a representative dense static asset achieves at least 50% fewer submitted triangles on the declared far-camera route without unacceptable image or frame-time regression. Record actual draws, CPU/GPU time, startup cost, and storage/residency overhead—not triangles alone.
- [ ] **Lifecycle and failure safety:** deterministic cache behavior, invalidation, hot reload, instancing, multi-view/shadow behavior, resource ownership, and corrupt/missing metadata have positive and negative tests through real entry points.
- [ ] **Portable release evidence:** browser WebGPU and owned native desktop run the same consumer; each mobile target enabled by default has its own render/correctness evidence. Unmeasured hardware or software-renderer timing is not counted as mobile performance proof.
- [ ] **Discoverable and reversible:** configuration reference, generated-project guidance, capability discovery, and diagnostics explain the effective behavior. Disabling AutoLOD removes its generation and runtime work without disabling unrelated asset optimizations.

## 1. Problem and repository grounding

The desired authoring contract is **one source model, automatic useful detail, optional central configuration**. `THREE.LOD` selects supplied objects; it does not generate simplified versions. Lower triangle count also does not inherently lower draw count, texture cost, download size, or total frame time.

The repository is further along than that starting point:

| Existing surface | What this PRD must respect |
| --- | --- |
| [PRD-098](../done/PRD-098-lod-and-instancing.md) | The earlier discrete LOD/instancing proposal was **declined**, not implemented, after its contemporary workload census found no triangle-bound scene. This PRD reopens the one-source/default-on authoring requirement, not its unmeasured performance claims. |
| [Virtual-geometry batch](../done/nanite-like/README.md) | Documents default-on cluster baking above 65,536 triangles per primitive, `assets.models.virtual`, `TN_virtual_geometry`, `ClusteredMesh`, `ClusteredBatch`, and engine-driven selection. It also records a historical native draw-count regression and unverified mobile coverage. Those are historical evidence, not a fresh benchmark of today's revision. |
| [`model.ts`](../../../packages/assets/src/passes/model.ts) | Already imports glTF Transform and `MeshoptSimplifier`, exposes opt-in single-ratio `simplify`, and defaults `virtual` baking on when that option is absent. Single-ratio simplification is not an automatically selected LOD chain. |
| [Default-on cook](../done/PRD-349-the-cook-is-on-by-default.md) | Existing commands, source preservation, caching, and cook opt-outs are the integration point. Direct GLB processing must not acquire a Blender dependency. |
| [Compression quality floor](./PRD-351-compression-never-looks-worse-than-a-floor.md) | Reuse applicable comparison/reporting instruments; independently account for geometry approximation and texture/quantization changes. Do not claim that satisfying a geometric-error target satisfies every material's visual requirements. |
| [Starter configuration](../../../packages/create-threenative/templates/starter/threenative.config.ts) | Uses the existing exported `ThreeNativeConfig` from `@threenative/playtest`. Extend that surface; do not introduce a second `defineConfig`, speculative `loadGLB` API, or a separate optimization configuration file. |

Before implementation, trace the current config-to-compile-to-loader-to-render chain. Record actual call sites and current virtual-geometry behavior on the target revision. Reuse working components; repair a missing connection instead of replacing an incumbent with a parallel mechanism.

## 2. Outcomes and non-goals

**Required:** default-on eligible processing, safe discrete representations for assets not already owned by another LOD mechanism, central configuration, screen-space selection, deterministic cooked artifacts, conservative fallback, and measured web/native delivery.

**Not required for v1:** a new cluster renderer, GPU-driven selection, streaming, impostors, automatic material atlasing, material-count reduction, cross-fades, bone/animation LOD, deforming-mesh simplification, or independently coarser shadow meshes. Existing virtual geometry remains supported; these exclusions are not instructions to remove it.

Do not turn this into a general instancing or HLOD project. Preserve existing batching and instancing, and report any trade-off. A result that saves triangles but regresses total frame time is not a demonstrated optimization.

## 3. Configuration contract

### 3.1 One author-facing policy

Add **`assets.lod`** to `threenative.config.ts`, using the existing config type, validation, and build/runtime handoff. This is a **proposed extension**, not a claim that the following fields exist today. The block below is an excerpt to merge into an otherwise unchanged project config:

```ts
assets: {
  lod: {
    enabled: true,
    preset: 'balanced',
    generation: {
      maxLevels: 4,
      minTriangles: 128,
      minTrianglesScope: 'asset',
      minSaving: 0.2,
      errorTargets: [0.002, 0.006, 0.02, 0.06],
    },
    runtime: {
      maxPixelError: 1,
      hysteresis: 0.15,
    },
    overrides: {
      'models/hero.glb': false,
      'models/castle.glb': { preset: 'quality' },
    },
  },
}
```

`assets.lod: false` and `assets.lod: { enabled: false }` are equivalent global kill switches for **ThreeNative-managed automatic** LOD, including implicit virtual-geometry activation. They do not disable an explicitly game-authored `THREE.LOD` or mutate source files. Omitting `assets.lod`, or writing `{}`, resolves to enabled/balanced once the implementation passes its release gates. No setting in a starter file is required to activate the feature.

Keep overrides in this same config. V1 accepts exact canonical project-relative source asset keys, using `/` separators and the existing asset resolver; no glob precedence or per-load generation settings. A runtime URL such as `/models/hero.glb` must resolve back to its registered source key rather than be matched as a different asset. Unknown override keys are diagnosed during asset discovery. The example keys represent source identifiers, not a new URL convention.

### 3.2 Defaults, merge rules, and validation

| Setting | Initial contract |
| --- | --- |
| `preset` | `quality`, `balanced`, or `aggressive`; default `balanced`. |
| `generation.maxLevels` | Default 4 **including LOD0**, integer 1–8; applies to discrete LOD, not the existing cluster DAG's depth. `1` emits no derived discrete levels. |
| `generation.minTriangles` | Default **128** (was 5,000 — see §4.3), a cheap pre-filter only, measured against `generation.minTrianglesScope`; positive integer. It avoids clearly-pointless work; the measured benefit rule in §4.3 is the gate, so eligibility may still cause a skip. |
| `generation.minTrianglesScope` | `"primitive"` or `"asset"`, default `"asset"`. `"asset"` measures the whole source model's triangle total, so a model split into many small primitives still clears the pre-filter on its total; `"primitive"` keeps the old per-primitive meaning. |
| `generation.minSaving` | Fraction in `[0, 1)`, default `0.2`. A derived level must save at least this much of its predecessor's triangles to be kept. This is the primary gate: an inability to reach it is a normal skip with reason `insufficient-reduction`. |
| `generation.errorTargets` | 1–16 strictly increasing positive finite geometric-error targets in normalized mesh-extent units, default `[0.002, 0.006, 0.02, 0.06]`. Each is simplified from LOD0 independently. |
| `runtime.maxPixelError` | Positive finite projected geometric-error budget in actual raster pixels. Initial preset defaults: quality 0.5, balanced 1.0, aggressive 2.0. These are policy starting points, not measured guarantees, and an explicit value overrides the preset at project or asset level. |
| `runtime.hysteresis` | Default 0.15, finite value in `[0, 0.5)`; stabilizes coarsening without postponing required refinement. |

Resolve the effective preset from asset override, then project, then default. Expand its defaults once; overlay explicit project fields, then explicit asset fields. Overrides are partial, not replacements for whole nested objects. A global `false` is absolute and cannot be re-enabled by a per-asset override; an asset `false` always disables automatic work for that asset. Validate the resolved policy before any bake. Unknown fields, non-finite numbers, invalid enums, and out-of-range values name their config path and fail instead of silently falling back.

V1 presets primarily set the screen-error budget; generation defaults above are shared. Every generation knob above is reachable both project-wide and per asset through `overrides`; no threshold the document names may remain a constant a game cannot move. Do not expose arbitrary percentage ladders or invent hidden, unmeasured preset differences. Explicit numeric settings win over preset defaults. Generation and runtime settings have separate cache fingerprints: changing only pixel budget/hysteresis refreshes runtime metadata/config, not geometry generation; changing any generation knob (including scope, saving rule or error targets) is part of the generation fingerprint and invalidates the baked geometry.

### 3.3 Existing settings and cook boundaries

Translate legacy settings into the same effective policy, rather than running old and new paths independently. Preserve explicit `assets.models.virtual: 'none'`: with no new explicit LOD policy for that asset, it must not quietly become default-on discrete LOD. Preserve explicit legacy single-ratio `simplify`; such assets skip additional automatic generation with an `explicit-legacy-simplify` reason. An explicit new declaration conflicting with a legacy declaration must produce a migration diagnostic, not silently choose a winner. The implementation must document and test the exact existing config shapes, including projects that use a model list instead of model-pass options.

Existing all-cook and per-mode cook opt-outs retain their meaning: no hidden generation outside the disabled cook/compile path. Already cooked LOD artifacts can still be rendered when runtime LOD is enabled; uncooked files use full detail and report that no generated representation is available. `assets.lod: false` additionally prevents automatic LOD activation even when such metadata is present. Do not disable compression, textures, or unrelated cook passes as a side effect of this setting.

## 4. Eligibility and generation

### 4.1 Conservative eligibility

Start with static, indexed triangle primitives with finite positions, valid indices and bounds, supported opaque materials, and supported immutable attributes. Lossless indexing is permitted for suitable non-indexed input. Rigid node transforms are supported; skinning and vertex deformation are not.

Skip—with a stable reason code—small/unprofitable meshes; skinned, morph-target, or dynamically deformed geometry; alpha-blended/masked or transmission-sensitive materials; displacement or custom vertex behavior without a validated contract; lines/points; unsupported attributes/topology; and explicitly authored LOD. Runtime material/geometry replacement that invalidates eligibility must restore the baseline or require an explicit opt-out; do not silently keep applying stale error metadata.

Preserve UV seams, hard-normal discontinuities, tangent/normal-map behavior, vertex colors, material boundaries, and lightmap UVs. Multi-primitive assets keep their node structure and materials. Where independent simplification can open a shared boundary, lock that boundary or decline the affected unit. No merging of different materials, surfaces, or animated nodes merely to reach a triangle target.

An inability to reduce safely/usefully is a normal skip, not a mandate to force a ratio. Passing structural checks and a simplifier error threshold is necessary, but not proof that an arbitrary material looks unchanged from every view.

### 4.2 A single owner per primitive

Use this decision order: explicit opt-out or authored ownership; existing supported virtual-geometry representation; eligible new discrete generation; otherwise baseline geometry. Never wrap `ClusteredMesh` in an additional automatic discrete LOD controller or process an already cooked chain as fresh source.

For newly cooked dense inputs, compare the incumbent clustered strategy against discrete/full-detail on representative browser and native workloads before changing the existing routing policy. Keep that choice deterministic and recorded in metadata. Do not build two payload families by default or dynamically switch algorithms every frame. An unqualified strategy retains the tested baseline and an explicit diagnostic on that target; missing mobile evidence does not become a silent “supported” claim.

### 4.3 Error-driven, bounded offline work

Use the already available meshoptimizer/glTF Transform integration, not a new simplifier dependency. Derive each discrete level from the same LOD0 reference, or conservatively accumulate and validate error if using a successive chain. Store actual achieved counts and actual error relative to that reference. Preserve an unsimplified LOD0 relative to the existing non-AutoLOD cook result; never overwrite the authored GLB.

Choose versioned increasing geometric-error targets (configurable through `generation.errorTargets`) and stop when simplification stalls, quality checks fail, or the level/storage budget is reached. Do not force `100% / 50% / 20% / 5%`. **The primary gate is measured benefit**: reject a derived level saving less than `generation.minSaving` (default 20%) of its predecessor's triangles, and treat an inability to reach it as a normal skip with reason `insufficient-reduction`, never a mandate to force a ratio. `generation.minTriangles` is only a cheap pre-filter — default **128**, measured against the whole asset (`generation.minTrianglesScope: 'asset'`) — that avoids the simplifier's fixed per-primitive cost on units too small for any reduction to matter. `maxLevels` is a ceiling, not a promise to create redundant geometry. Drop rejected levels and maintain monotonic usable error/count ordering, including an explicitly handled zero-error level.

**The 5,000-triangle per-primitive default was wrong and is gone.** It was measured against a real shipped game (Midway): its three US carriers are 347,497 triangles each but spread over 280–301 meshes (about 1,150–2,700 triangles per primitive), and its aircraft are 10–15k triangles over ~22 meshes (~600 per primitive). Every primitive fell under the floor, so the feature generated **zero** levels, zero derived bytes — it was inert on the one asset that needed it. An absolute per-primitive count measures how the artist split the mesh, not whether simplification would pay. The corrected contract makes the measured saving rule the gate and reduces the floor to a cheap pre-filter whose default scope is the whole asset; a model whose primitives are each small but whose total is large is now exactly the case the pre-filter admits and the saving rule decides, primitive by primitive. The defaults are deliberately project-agnostic: measured with no Midway-specific value, name or special case anywhere in the engine.

### 4.4 The per-primitive limit, and the opt-in join far rung

An asset whose cost is **draw count** rather than triangle density is not helped by the per-primitive
path. Midway's carrier is ~300 small primitives; the discrete path simplifies each of them
independently and the 300-node/300-primitive structure — the draw calls and per-mesh CPU cost — is
untouched. One measured recovery frame put a 48 px carrier at **147 draws** and a 30 px aircraft at
**92**. Collapsing those primitives by material is the change that makes a draw-bound asset cheaper.

This was originally **out of scope here**: §2 excludes HLOD, instancing and material-count reduction,
and the earlier note correctly recorded that a join-by-material path interacts with object identity,
boundaries and authored LOD. The repository owner has since authorised an **explicitly opt-in
extension** for exactly the consumer the feature was built to serve, on the stated condition that it
changes nothing by default and is declared honestly rather than smuggled in.

Built as **`assets.lod.generation.join`**, default **`false`**, reachable globally and per asset
through the same `overrides` map as every other generation knob:

- **What it does.** When enabled, the eligible primitives of every **sibling mesh under one shared
  container** are grouped by material *and* attribute layout and merged into one primitive per group
  (the already-installed `gltf-transform` `join`), so the far rung draws once per material group
  instead of once per authored primitive. This is what makes it useful on a real asset: the measured
  Midway hulls ship **one primitive per mesh** (`akagi` 146/146, `hornet` 94/94, `pt59` 40/40), so a
  within-mesh-only join collapsed nothing. Each sibling's transform relative to the container is
  baked into its merged vertices, so a carrier's 146 draws become the handful of its material
  groups. Joined geometry is reduced by the existing discrete chain when one is configured, so
  `join` plus `errorTargets` gives a far rung with both fewer draws and fewer triangles.
- **Bounded by construction.** A group never mixes materials — `join` itself refuses incompatible
  groups, and the caller is offered no switch to cross that boundary. Skinned, morph-target and
  animated **members** are left authored (a site that loses enough of them collapses nothing), a
  mesh instanced by more than one node is refused because its local transform is not single-valued,
  and a nested mesh node is skipped so a primitive belongs to exactly one site. The container's own
  animation is allowed: the rung is baked in container space and rides rigidly with it. Node
  identity, per-node visibility and picking are untouched; the authored primitives remain LOD0 and
  the joined rung is an additional, scene-unreferenced far mesh.
- **Default off, proved.** With no option, or with `join: false`, the cook is byte-identical to
  today; `join` is part of the generation cache fingerprint so a stale bake cannot be served.
- **Reported honestly.** The artifact metadata and the cook report name the far mesh, how many
  primitives it collapsed and into how many draws, and record the exact `mesh#primitive` sources it
  joined. A requested join that collapsed nothing says so rather than implying a collapse.

Runtime selection of the joined rung is **now wired**, still inside the one selection authority
(`packages/core/src/model-lod.ts`), so a cook that wrote no `join` is byte-identical to before. The
rung's absolute error is recorded in the artifact and appended as the coarsest step of the same
discrete chain, so `selectLodLevel` picks it only when its projected error fits
`runtime.maxPixelError`, with the same `hysteresis`. Selecting it is a draw-topology change, not a
geometry pointer swap: the authored primitives are hidden and a proxy built from the detached far
mesh is added under their shared container as one unit. The authored meshes are never removed or
replaced, so node identity, transforms, render order and authored per-node visibility are restored
byte-for-byte on the way back. Picking stays on the authored primitives: the framework picker
skips the proxy (`isLodJoinProxy`), and the authored meshes remain raycastable because a ray test
does not honour `visible`. The runtime re-checks what it is about to hide — every source present,
all members sharing one container, none skinned or morphed, and none targeted by an animation
channel **strictly below that container** — and refuses the rung with `TN_DISCRETE_LOD_JOIN_INVALID`
otherwise rather than half-joining.

Joining siblings bakes their relative transforms into the rung, so the honest ceiling is a model
whose sub-meshes move independently at runtime. Animation, a skin and a morph target are detected at
bake and at load; **script movement is detected at runtime**: every source member's authored local
transform relative to the container is snapshotted at load, and a member that no longer matches is
refused with `TN_DISCRETE_LOD_JOIN_INVALID` before any proxy is shown. The blind spot is a clone
created after load: it is baselined on its first far selection, so an individual clone member a
script moves before that first selection is not seen — which is why the whole feature stays opt-in.
The selection fact and the draw collapse are named once per activation in
`TN_DISCRETE_LOD_JOINED`. What is **not** wired: a dedicated coarser shadow rung (shadow and
reflection passes share the main selection, the same conservative shared choice the discrete path
already made), and the join proxy uses the loaded far mesh's own materials, so a per-node material
override made after load is not reflected in the joined draw.

Report normalized simplifier error and the scale used to convert it to local-space absolute error. Attribute-weighted error must not be mislabeled as a pure position bound. Include downstream quantization effects in the reported budget or measure against the decoded baseline; do not lose units between the baker and runtime.

Generation runs only in the existing build/import/dev-cook environment, with bounded concurrency, memory, attempts, and output size. Reuse its worker scheduling, instrumentation, and cancellation. Independent assets may cook in parallel; dependent passes and level publication remain ordered. No simplifier/WASM compilation or progressive decimation is added to the player's first frame or render loop.

## 5. Artifact and loading contract

The default discrete output is **one cooked GLB**, not several independently authored or duplicated model files. Keep LOD0 as its ordinary scene representation. Store derived mesh/index references and a versioned optional LOD extension alongside it; reuse existing extension registration/validation patterns. A generic glTF reader ignoring the extension must render only LOD0, not every level simultaneously. ThreeNative's loader must explicitly consume the metadata—custom glTF data does not magically become a `THREE.LOD`.

Share immutable attribute accessors, materials, images, and texture resources where valid. An index-only simplifier can reference existing vertices; methods that move vertices or reconstruct attributes cannot claim that sharing. Reorder/remap all affected buffers coherently. Preserve native-compatible vertex layouts. Validate both written and decoded artifacts, including references, bounds, index ranges, counts, and extension version.

Record at least source/content identity, generator/schema versions, generation fingerprint, per-primitive strategy and baseline mapping, local bounds, actual per-level counts/errors, shared-buffer ownership, and byte overhead. Runtime policy travels through the normal resolved project configuration; serialize only data, not executable config functions.

One authored GLB does **not** mean zero extra geometry, reduced download, or independently streamable levels. V1 can load the full cooked GLB. Report compressed file bytes, decoded CPU bytes, resident GPU bytes, and cook peak memory separately. Never copy textures per level or silently switch to runtime generation to meet a packaging target.

Cache keys include source/dependency bytes, effective generation policy, algorithm/toolchain version, and output schema. Builds are deterministic under the pinned toolchain; hot reload publishes a complete validated replacement atomically. Generated output is not rediscovered as input, and changing one source does not rebake unrelated assets.

## 6. Runtime selection and safety

Reuse the existing normal model-loading and pre-render integration. Register eligible renderables once and remove them on disposal. If `THREE.LOD` supplies object switching, disable its independent distance auto-update for managed objects. There is exactly one selection authority.

Select the cheapest available level satisfying the projected geometric-error estimate. Convert local error to world error using a conservative transform bound, including non-uniform scale and parent shear. Use the camera projection, zoom, actual render viewport, and conservative nearest relevant view-space depth—not distance to the object origin alone. Handle orthographic cameras separately. Near-plane intersection, invalid bounds/projection, or a camera inside relevant bounds selects full detail conservatively.

For a simple perspective illustration only:

```text
estimated pixel error ~= world-space error * viewport height
                         / (2 * conservative depth * tan(vertical FOV / 2))
```

The implementation must derive projection-correct behavior for supported camera modes; this illustration is not a rigorous all-views displacement bound. Account for viewport/render-resolution changes and avoid LOD/resolution controllers feeding oscillations into one another.

Refine immediately when the selected level exceeds budget. Coarsen only when the proposed cheaper level falls below `(1 - hysteresis) * budget`. This stabilizes thresholds without letting hysteresis authorize an indefinitely over-budget coarse level. Handle zero-error levels explicitly; do not require LOD0 at every close view when a derived representation is truly equivalent under the recorded metric.

Multiple cameras, stereo views, reflection captures, and shadows must not reuse a stale choice from another pass. Choose the finest detail required by all relevant views, or use a proven pass-local selection mechanism. V1 does **not** automatically request an even coarser shadow LOD: retain LOD0 for shadows or prove a conservative shared choice. Main-camera invisibility does not remove an off-screen shadow caster.

For the joined rung this is met without pass-local caching: the authority holds no per-pass level, and every call to `updateModelLods` recomputes from the camera it is handed, so a second pass cannot read a first pass's choice. The joined draw replaces the authored nodes for every pass at once — the same shared choice the discrete path makes — so a shadow or reflection camera does not get an independently coarser rung; that remains the open shadow question above, not a stale-reuse bug. Per-container state means two instances of the same joined model at different distances each join or refine on their own.

Keep entity/node identity, names, transforms, materials, event mappings, authored visibility, and render order intact. Physics, collision, navigation, and default precision picking continue using baseline/source semantics, not camera-dependent render geometry. Document raw Three.js face-index behavior; stable framework picking must not depend on the selected render LOD.

The joined rung keeps all of this by never touching the authored graph: it hides the authored primitives (`visible = false`), adds one proxy object under their shared container, and on revert removes the proxy and restores each primitive's captured `visible`. A framework pick skips the proxy (`isLodJoinProxy`), so it still answers with an authored node and its LOD0 surface; a stock three ray test also skips it, because the proxy's meshes carry a no-op `raycast`.

Instances sharing an asset may need different detail. Do not mutate a shared geometry/index so that one instance changes every other instance, and do not silently de-instance a large batch into hundreds of draws. Reuse safe existing batches; otherwise decline that optimization and report the reason. Preserve shared resource lifetimes: disposing one instance or geometry must not destroy a sibling's attributes. Test unload, reload, scene restart, and device-resource recreation where supported.

The ordinary frame performs no simplification, per-frame hierarchy discovery, new geometry allocation, synchronous GPU readback, or unnecessary buffer re-upload. Cache reusable state and upload only what the selected strategy actually changes. Assets without an eligible cooked representation, and explicitly disabled assets, install no automatic LOD controller; omitting configuration alone does not disable it.

## 7. Diagnostics and failures

Extend existing cook reports, asset diagnostics, and performance instruments rather than adding a parallel dashboard. Report effective config and its origin; selected strategy; generated/used levels; reasons for skipped or baseline-only assets; source versus submitted triangles and actual draws; bake/cache cost; file/residency overhead; and target qualification.

Distinguish expected skip, disabled policy, unsupported input, and tool/artifact failure. Invalid config, a failed compiler invariant, or a malformed newly generated artifact fails the build with the asset and stage named. Do not hide a broken compiler behind “ineligible.” Missing optional LOD data on a valid older/raw GLB may use LOD0 with diagnostics. Runtime recovery from malformed optional data may retain intact LOD0, but emits an actionable error and fails the corresponding validation test. Invalid baseline geometry remains the existing asset-load error, not a fake successful placeholder.

Useful stable reasons include `disabled`, `too-small`, `insufficient-reduction`, `authored-lod`, `virtual-owned`, `explicit-legacy-simplify`, `deforming`, `material-unsupported`, `boundary-unsafe`, `instance-policy-unsupported`, and `uncooked`. Diagnostic text and capability discovery must describe skipped/unqualified paths truthfully.

## 8. Implementation sequence and verification

Each phase extends the real caller chain and carries its own focused tests. Parallelize independent fixture, config, and documentation work after the metadata contract is settled; do not duplicate verification at every layer.

| Phase | Deliverable and proof |
| --- | --- |
| 0 — trace and baseline | Identify actual config/compile/load/render owners; inventory legacy opt-outs; reuse a real dense asset and the quarry where applicable. Record baseline image, triangles, draws, bytes, and CPU/GPU timing on declared targets. No new renderer before this audit. |
| 1 — config and artifact | Add typed/resolved policy, deterministic eligibility and offline generation, optional-extension round trip, source preservation, cache/invalidation, and resource metadata. Tests enter through the public compiler/config loader, not only a private simplifier helper. |
| 2 — ordinary runtime | Wire normal model loading and engine-owned selection; test camera/projection/scale changes, views/shadows, picking, instances, opt-out, and lifetime behavior on real decoded artifacts. |
| 3 — consumer qualification | Run an ordinary generated project through normal dev/build/loading paths on browser and native, capture visual comparisons around transitions, and measure frame-time and startup/storage impact. Enable each target only with its evidence. |
| 4 — default and discovery | Make omission resolve to enabled only after qualification; document migration and escape hatches through existing config/scaffold/discovery surfaces, then rerun the zero-config and off-path consumer proof. |

### Phase progress checklists

Keep these boxes current in the implementation PR. They remain open in this specification-only PR.

#### Phase 0 — trace and baseline

- [x] The current config-to-render caller chain and legacy settings are mapped. Evidence: the trace is
      the landed code itself — `packages/create-threenative/src/build.ts:312,458` calls
      `compileAssets({ config: config.assets })`, the `model` pass (`packages/assets/src/passes/model.ts`)
      bakes through glTF Transform, and `createAssetLoader` (`packages/core/src/assets.ts:547`) loads
      through `GLTFLoader` with the `VirtualGeometryPlugin` registered on `TN_virtual_geometry`. Legacy
      opt-outs inventoried: `assets.models.virtual: "none"` and `assets.models.simplify`.
- [ ] The representative corpus has reproducible baseline measurements.
      Blocked: requires a browser/GPU capture (capture lock held) and the owned native host; the
      counted Midway census (`/tmp/midway-60fps/report-X1.md`) is the only baseline available here.

#### Phase 1 — config and artifact

- [x] Public config validation and per-asset resolution pass the precedence and invalid-input tests.
      Evidence: validation in `packages/create-threenative/__tests__/lod-config.spec.ts` (25/25) and
      resolution in `packages/assets/__tests__/lod-generation.spec.ts` (32/32) — preset defaults,
      overlay precedence, absolute kill switch, legacy translation, split fingerprints, and every
      generation knob (`join`, `maxLevels`, `minTriangles`, `minTrianglesScope`, `minSaving`,
      `errorTargets`) honoured globally and per asset. `pnpm typecheck` (exit 0) and the package
      builds (exit 0) cover both packages. One resolver owns the decision — the compiler calls
      `resolveLodPolicy` where the asset is known; the config layer only validates.
- [x] The pre-filter is measured-benefit-driven, not an absolute per-primitive constant.
      Evidence: the default `minTriangles` moved 5,000 → 128 with `minTrianglesScope: 'asset'` after
      the Midway census (347,497-triangle carriers over ~300 primitives each), fixing a gate that
      generated zero levels on the asset that needed it; the measured saving rule
      (`minSaving`, default 0.2) is now the primary gate and an unreachable level reports
      `insufficient-reduction` instead of a forced ratio. Proven by the carrier, tiny-asset, scope,
      error-target and saving-rule tests in `lod-generation.spec.ts`.
- [x] The normal compiler applies tested eligibility and error-driven generation. Evidence:
      `packages/assets/__tests__/lod-generation.spec.ts`, 27/27 green;
      `modelPass` generates `TN_discrete_lod` via `packages/assets/src/lod/` (meshoptimizer, index-only,
      `LockBorder`), attached after the virtual bake and before quantize.
- [x] Cooked GLBs pass extension round-trip and baseline-preservation tests. Evidence: same spec —
      LOD0 arrays byte-equal to the non-AutoLOD cook; a generic reader sees only LOD0; schema/index
      revalidation on read.
- [x] The opt-in join far rung is generated, bounded and reported (the §4.4 extension). Evidence:
      `assets.lod.generation.join`, default `false`, global and per asset; a 300-primitive carrier
      collapses to one draw per material (3, not 300) with LOD0 still 300 primitives; absent or
      `false` is byte-identical; skinned/morph/animated refused; a per-asset override joins one asset
      only; the artifact metadata and the compiler manifest carry the draws, the collapsed primitive
      count and the `mesh#primitive` sources. Tests: `lod-generation.spec.ts` (36/36), join line in
      `report.spec.ts`, `lod-config.spec.ts` (25/25). §4.4 declares it an owner-authorised extension
      beyond §2's exclusion; runtime selection of the rung is not wired.
- [x] The join spans sibling meshes under one shared container, not just primitives inside one mesh.
      Evidence: `lod-generation.spec.ts` "joins sibling meshes under a shared parent into one draw per
      material" — 146 one-primitive meshes over 3 materials (the measured Midway shape, where the
      within-mesh join produced nothing) collapse to 3 draws / 146 primitives with each sibling's
      part-node transform baked into the merged vertices, LOD0 untouched; the artifact records the
      distinct source `meshes`. A multi-primitive mesh keeps its exact prior far mesh and draws, the
      animated sibling set is refused, and absent/`false` stays byte-identical. Runtime: the sibling
      container is the common ancestor, members are hidden wherever they sit in that subtree, and a
      member a script moves since load is refused (`model-lod-join.spec.ts`).
- [ ] Cache invalidation and atomic hot reload pass their integration tests.
      Partial: the generation fingerprint and pass cache key exclude runtime/preset, and a spec
      asserts a runtime-only edit neither rebakes nor changes the key. A cache hit now re-resolves
      and rewrites `lod.runtime` in the manifest (`withFreshLodRuntime`), proven by
      "refreshes the manifest runtime budget on a cache hit without rebaking" (payload `output` and
      `bytes` unchanged, runtime moved 1 -> 5 / 0.15 -> 0.3). Hot reload is not exercised here.

#### Phase 2 — ordinary runtime

- [x] Normal model loading reaches the single engine-owned LOD controller. Evidence:
      `packages/core/__tests__/model-lod-loader.spec.ts` (3/3) drives a hand-written cooked GLB
      through `createAssetLoader` — fetch, `extensionsUsed` detection, `GLTFLoader`, the reader,
      `widenQuantizedPositions`, then `attach` — and shows the far camera swapping a 64-triangle
      LOD0 to the 16-triangle level while the near camera keeps LOD0. The level shares the authored
      position attribute by reference.
- [x] Projection and hysteresis tests pass on decoded artifacts. Evidence:
      `packages/core/__tests__/model-lod.spec.ts` (17/17 — perspective/orthographic/zoom projection,
      conservative nearest depth, near-plane/inside-bounds full detail, immediate refinement,
      hysteresis-gated coarsening, zero-error level, multi-view and `finest` view),
      `model-lod-runtime.spec.ts` (5/5) and the loader-driven `model-lod-loader.spec.ts` (2/2).
- [ ] Multi-view and shadow correctness tests pass. `selectLodLevel` accepts several views and a
      `finest` view; the engine passes only the main camera and shadows have no dedicated test yet.
      The joined authority adds no pass-local cache — every `updateModelLods` call recomputes from
      the camera it is handed, and `model-lod-join.spec.ts` proves two cameras at different
      distances do not corrupt each other's choice — but shadow/reflection still share the main
      selection, so the shadow half remains open.
- [x] Precision-picking does not depend on the selected render LOD. Evidence:
      `packages/core/__tests__/picking.spec.ts` "picks the authored LOD0 surface while the camera
      draws a coarser level" — the BVH is built from LOD0 and the ray is run against LOD0 while the
      mesh is drawn at the coarse level. `model-lod-join.spec.ts` "keeps picking on the authored
      primitives while the joined rung is drawn" adds the joined case: the runtime proxy is skipped
      and the hit is an authored member.
- [x] The opt-in joined rung is selected at runtime inside the one authority. Evidence:
      `model-lod-join.spec.ts` (14/14) — a model with a joined rung selects it beyond the budget and
      its submitted triangles fall to the rung's, the switch is logged once as
      `TN_DISCRETE_LOD_JOINED` naming the primitive→draw collapse, reverting on a close camera
      restores authored visibility/render order/transform and removes the proxy, an
      animation-targeted or skinned/morphed mesh never joins, a clone behaves like its source, two
      instances at different distances choose independently, and a cook with no `join` is
      unchanged. A rung spanning sibling meshes selects and reverts the same way with picking kept on
      the authored members, and a part node moved after load is refused with
      `TN_DISCRETE_LOD_JOIN_INVALID`. The rung's absolute error is written by the cook and read back
      (asserted in `lod-generation.spec.ts`), and `picking.ts` skips the proxy.
- [x] Instance isolation and shared-resource lifetime tests pass. Evidence:
      `model-lod-runtime.spec.ts` "isolates two instances that share one base geometry" — each builds
      its own derived level, swapping one leaves the other and the shared base untouched, and
      disposing one instance's selected geometry leaves the sibling's shared `BufferAttribute` (array
      and identity) intact. Scope note: three has no buffer refcounting, so its `dispose()` deletes a
      shared attribute's GPU buffer and the sibling re-uploads it on the next frame; the CPU
      attribute is never destroyed, so this is a bounded transient re-upload, not a correctness break.
      A per-attribute refcount in `disposeModel` would remove the transient and is the remaining
      nicety, not a requirement of the stated contract.
- [x] Runtime policy reaches the controller from the manifest. Evidence:
      `model-lod-loader.spec.ts` serves a manifest whose entry resolves `maxPixelError: 0.1` and the
      same far camera that coarsens under the default 1-pixel budget keeps LOD0 — the loader read the
      asset's budget, not a framework constant.

#### Phase 3 — consumer qualification

- [x] Browser WebGPU consumer evidence establishes the default policy. Evidence: `examples/auto-lod`
      (an 8,192-triangle `assets/hull.glb`, `assets.lod: {}`, compiled through the same `watchAssets`
      dev seam a scaffolded project uses) on an RTX 2080. The runner reported adapter
      `turing / nvidia` and would have rejected a software adapter as non-evidence.
      `playtests/lod-near.playtest.json` selects LOD0
      (`sceneNodes` 8,192 triangles); `playtests/lod-far.playtest.json` submits 369 triangles with a
      non-blank capture. Both exit 0 under `--browser-recipe webgpu --headed` with no console or
      network errors. Reproduce with `DISPLAY` on the GPU's X server and
      `TN_PLAYTEST_HOST_DISPLAY=1`; the runner defaults to headless, which serves SwiftShader and is
      not evidence. Run locally with `pnpm --filter auto-lod playtest:web` (and `playtest:desktop`
      for the native lane); the package `test` script is the install-only `pnpm run build` proof,
      because the playtest needs a real adapter and cannot run in the CI package walk.
- [ ] Windows native consumer evidence establishes the default policy. NOT RUN; no host here.
- [ ] macOS native consumer evidence establishes the default policy. NOT RUN; no host here.
- [x] Linux native consumer evidence establishes the default policy. Evidence: the same example built
      for the owned host (`threenative build --target desktop`, embeddable desktop artifact) and run
      through the desktop playtest lane. `lod-near-desktop` drives the scene state from 368 to 8,192
      triangles (`changed`, `gte 8000`, `sceneNodes.minTriangles 8192`) and `lod-far-desktop` holds 368
      (`lte 4096`); both exit 0. The native lane carries the state channel and not the browser
      performance sampler, so the gate is the published triangle count rather than `performance`.
- [ ] Android's policy is backed by target evidence or explicitly remains baseline-only. NOT RUN;
      adb is on PATH, no emulator or device was started.
- [ ] iOS's policy is backed by target evidence or explicitly remains baseline-only. BLOCKED: `xcrun`
      is not on PATH (macOS only).
- [x] The dense-asset triangle-reduction gate passes on browser WebGPU. Evidence: 8,192 authored -> 369
      submitted on the far route (`lod-far`, exit 0), 95.5% fewer, above the 50% floor; the near route
      keeps LOD0 at 8,192. Frame meters were sampled (1,024 samples) but no regression allowance was
      asserted, so no frame-time claim is made here.
- [x] The dense-asset triangle-reduction gate passes on a native target. Evidence: Linux desktop,
      8,192 authored -> 368 submitted on the far route (`lod-far-desktop`, exit 0), 95.5% fewer.
- [ ] The frame-time regression gates pass on every default-enabled target. NOT RUN; a browser pass
      was measured but not bounded, and the native lane reports no performance samples.
- [ ] The rendered-quality gate passes on the declared corpus. NOT RUN. The two browser scenarios
      assert a non-blank capture and the far/near screenshots exist in `artifacts/playtest/`, but the
      declared corpus comparison at transitions was not performed.
- [ ] The new discrete-artifact byte budgets pass. NOT RUN as the declared 1.5x cap. The cook reports
      8,192 -> 368 triangles across 3 levels at 88,728 payload bytes, and the cooked file 150,188 ->
      59,116 bytes (-60.6%), against a non-AutoLOD baseline that was not measured.

#### Phase 4 — default and discovery

- [ ] Omitted configuration enables the qualified policy through the real front door. Open by
      design: omission bakes nothing until Phase 3 qualification passes; `assets.lod: {}` is the
      current opt-in that resolves to enabled/balanced.
- [x] The global off switch passes its end-to-end negative control. Evidence:
      `lod-generation.spec.ts` "bakes nothing and installs nothing when the global switch is off" —
      `assets.lod: false` and `{ enabled: false }` both ship a GLB whose `extensionsUsed` does not
      contain `TN_discrete_lod` and a manifest with `generated === 0`.
- [x] Existing config documentation and discovery expose the effective settings. Evidence:
      `IThreeNativeConfig.assets.lod` and `IThreeNativeLodConfig` JSDoc state the opt-in, the absolute
      kill switch and the override keys, and the generated capability reference documents
      `updateModelLods` with its `assets.lod` constraints/overrides (`pnpm capabilities:sync`).
- [ ] Generated-project guidance documents default behavior and migration. Template guidance lands
      with the default-on flip, after qualification, so it does not document a default that is not on.

### Minimum acceptance matrix

| Case | Observable assertion / negative control |
| --- | --- |
| Omitted config vs explicit off | Same authored source; eligible default produces and uses derived detail. Off produces no automatic payload or runtime controller. Forcing LOD0 removes the measured triangle benefit. |
| Presets and partial overrides | Resolved numeric settings have tested precedence; an asset opt-out remains off; unknown keys/invalid values fail by config path. A runtime-only edit does not invoke the simplifier. |
| Legacy and existing LOD | Explicit old opt-outs keep working; manual LOD and virtual-owned primitives have one owner; conflicting explicit policies diagnose rather than stack. |
| Eligible static textured asset | LOD0 matches the non-AutoLOD cooked reference; lower levels preserve UV/material/node semantics and reduce submitted work on the prescribed camera route. |
| Risky content corpus | Skin/morph/deformation, alpha mask/blend, lightmap/seam fixtures, tiny meshes, and unsupported topology either retain baseline or meet their explicitly qualified contract. No lost pieces or new boundary cracks. |
| Camera transitions | Perspective/orthographic zoom, actual pixel resize, scaled parents, near-plane/inside bounds, rapid camera motion, and boundary oscillation select valid levels with no stale view choice. |
| Multi-view and gameplay | Two views and shadow-only casters remain correct; collisions and framework picking return the same target before/after camera-driven switches. |
| Instances and lifecycle | Independent instances select correctly without draw explosion; repeated load/unload/reload returns tracked resources to baseline and never invalidates live siblings. |
| Cache and corruption | Repeat cook is identical and cached; source/generator changes invalidate; malformed extension/index/error data is detected; raw valid GLB still renders baseline. |
| Real front door | Remove the new compile or runtime connection and the relevant consumer assertion fails. New integration tests through real entry points are valid proof; no artificial requirement that a pre-existing test already cover this new behavior. |

Use a declared representative corpus and deterministic camera routes, including a real textured dense model, not just a generated sphere. For the dense benefit fixture, require at least 50% fewer far-route submitted triangles. Report median and p95 CPU/render/GPU measurements separately with hardware/backend, resolution, warmup, sample count, and variance. Predeclare a regression allowance of 5% for median/p95 total frame time on each representative route and the ineligible/disabled control; investigate measurement uncertainty instead of passing noisy numbers. No default-on strategy is approved on a target when its repeated measurements show a regression beyond that allowance.

Compare matched cameras and lighting at LOD0, each transition, close silhouettes, and the far route. Review per-object silhouette/UV/normal-map artifacts in addition to aggregate image metrics. Reuse an existing meaningful image-quality floor or establish and justify one before evaluating the candidate; do not tune it after observing failures. A one-pixel geometric budget is not automatically a one-pixel image difference.

Start with a 1.5x cap on decoded geometry bytes and cooked file bytes versus the non-AutoLOD result for **new discrete** artifacts; reject lower-value levels until within the cap or keep LOD0. Treat this as an explicit initial product budget, not a prediction; report unavoidable overhead, especially for tiny files. Existing clustered assets retain their own measured/storage contract and are not claimed to fit this discrete budget. Report cold bake, warm-cache, load-to-first-frame, and peak memory even where no speedup is expected.

Browser/native compatibility and mobile render correctness are separate from hardware performance qualification. CI/software rendering can prove functional behavior but cannot certify a physical phone's frame-time budget. Retain honest target-specific qualification until the necessary evidence exists.

## 9. Completion boundary and references

The implementation is complete only when the closure gates have revision-linked evidence and normal consumers get the intended behavior. Unprofitable or unsupported assets may correctly remain full detail; “skip everything” does not satisfy the positive eligible-asset gate. Do not mark this PRD done because a helper emits fewer indices or because the specification itself merged.

Primary technical references for implementation review:

- [Three.js LOD](https://threejs.org/docs/pages/LOD.html): supplied-level selection and auto-update behavior.
- [meshoptimizer JavaScript API](https://github.com/zeux/meshoptimizer/blob/master/js/README.md): simplification, error scale, indices, and buffer semantics; use the repository's pinned implementation when validating exact behavior.
- [glTF Transform simplify](https://gltf-transform.dev/modules/functions/functions/simplify): target ratios are constrained by error and topology; simplification alone does not wire a runtime LOD system.

This PR changes this PRD only. No runtime/config defaults, source assets, generated artifacts, package versions, workflow checks, or previous PRD statuses are changed by its merge.
