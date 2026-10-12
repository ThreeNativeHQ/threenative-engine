# ThreeNative UE5-Class Feature Checklists and Repository Reuse Map

**Version:** 2.0 — numbered feature checklists + repository reuse research  
**Research snapshot:** 2026-08-30  
**Audience:** ThreeNative renderer, runtime, tooling, asset-pipeline, QA, and platform engineers  
**Purpose:** Define the functional and production requirements that must be satisfied before any Unreal Engine 5–inspired subsystem can be called **Done** in ThreeNative, and identify the open-source repositories that can safely accelerate each requirement set.

> This document defines **outcome parity**, not source-code or implementation parity with Unreal Engine. ThreeNative should reproduce the developer-visible capability and production behavior that matters, using WebGPU, Three.js, native platform backends, Rapier, and purpose-built ThreeNative abstractions.

The Unreal feature names in this document are comparison labels. Public ThreeNative names should remain engine-specific—for example, `DynamicGI`, `VirtualGeometry`, `VirtualShadows`, and `TemporalUpscaler`—and should not imply binary compatibility with Unreal Engine.

## Navigation

**Core gates:** [Decision rule](#1-the-decision-rule) · [Capability tiers](#2-baseline-architecture-and-capability-tiers) · [Global Definition of Done](#3-global-definition-of-done) · [Benchmark manifest](#4-benchmark-manifest-required-for-every-stable-feature) · [Dependency map](#5-shared-dependency-map) · [Effort-impact matrix](#6-effort-impact-priority-matrix)

Feature definitions are physically ordered by the ranking below. Existing `F#` labels and requirement IDs remain stable so issue links and implementation references do not break.

| Rank | Stable ID | Feature definition | Impact | Effort | Priority score | Band |
|---:|---:|---|---:|---:|---:|---|
| 1 | F1 | [Post-processing](#f1) | 94/100 | 3/10 | 89.8 | A — Now |
| 2 | F2 | [Volumetrics / god rays](#f2) | 88/100 | 5/10 | 79.6 | A — Now |
| 3 | F12 | [Temporal upscaling / TSR-like](#f12) | 94/100 | 6–7/10 | 79.3 | A — Now |
| 4 | F14 | [Virtual Shadow Maps](#f14) | 96/100 | 7/10 | 79.2 | A — Now |
| 5 | F3 | [Niagara-like GPU VFX](#f3) | 90/100 | 6/10 | 78.0 | A — Now |
| 6 | F17 | [Virtualized geometry / Nanite-like](#f17) | 100/100 | 8–9/10 | 77.5 | B — Strategic |
| 7 | F13 | [Layered materials / Substrate-like](#f13) | 91/100 | 6–7/10 | 77.2 | B — Strategic |
| 8 | F16 | [Dynamic GI / Lumen-like](#f16) | 100/100 | 9–10/10 | 74.5 | B — Strategic |
| 9 | F5 | [PCG](#f5) | 80/100 | 5/10 | 74.0 | B — Strategic |
| 10 | F9 | [Motion Matching](#f9) | 84/100 | 6/10 | 73.8 | C — Next |
| 11 | F4 | [Water](#f4) | 75/100 | 4/10 | 73.5 | C — Next |
| 12 | F18 | [Many-light rendering / MegaLights-like](#f18) | 89/100 | 7–8/10 | 72.8 | C — Next |
| 13 | F8 | [World Partition / HLOD](#f8) | 79/100 | 6/10 | 70.3 | C — Next |
| 14 | F11 | [Control Rig / IK](#f11) | 77/100 | 6/10 | 68.9 | C — Next |
| 15 | F6 | [Mass / ECS crowds](#f6) | 68/100 | 4/10 | 68.6 | C — Next |
| 16 | F7 | [Sequencer](#f7) | 68/100 | 4/10 | 68.6 | C — Next |
| 17 | F15 | [Virtual Texturing](#f15) | 85/100 | 8/10 | 68.5 | C — Next |
| 18 | F10 | [Procedural audio](#f10) | 70/100 | 5/10 | 67.0 | D — Later / specialized |
| 19 | F19 | [Physics suite](#f19) | 82/100 | 9/10 as a suite | 63.4 | D — Later / specialized |
| 20 | F20 | [Path tracer](#f20) | 60/100 | 9–10/10 | 46.5 | D — Later / specialized |

**Closure and delivery:** [Cross-system closure](#cross-system-closure) · [Dependency-correct delivery order](#dependency-correct-delivery-order) · [Stable-release evidence template](#stable-release-evidence-template) · [Research sources](#research-sources-and-implementation-baselines)

---


## Repository-reuse decision framework

The repository crawl is intentionally conservative. Public source code is **not** automatically reusable source code.

| Label | Meaning for ThreeNative |
|---|---|
| **Adopt** | Consume a pinned package/library directly, with a narrow adapter and upstream-friendly patches. |
| **Fork** | Maintain a pinned ThreeNative fork because the implementation is unusually close but requires sustained changes. |
| **Port** | Copy or translate selected permissively licensed algorithms/shaders/tests into ThreeNative-owned architecture, preserving notices. |
| **Study** | Use architecture, papers, screenshots and behavior as references; avoid runtime dependency or wholesale copying. |
| **Blocked** | Do not copy source/assets because no usable license was found or terms are incompatible/restrictive. |

**License markers:** ✅ verified permissive at the inspected repository/package revision · ⚠️ conditional, copyleft, per-file or legal-review required · ⛔ no usable license or restrictive terms · 🧊 permissive but archived/frozen.

**Important:** This is engineering license triage, not legal advice. Before merge, pin the exact commit/package, inspect every copied file and bundled asset, review transitive dependencies and patents, preserve required notices, and record the decision in the project SBOM.

### Repository intake gate — applies to every feature

1. [ ] Pin the exact repository commit, package version and Three.js compatibility range.
2. [ ] Reproduce the upstream demo/tests from a clean checkout before modifying code.
3. [ ] Record the exact files, shaders, algorithms, assets and test data proposed for reuse.
4. [ ] Verify repository, per-file, asset, model/dataset and transitive dependency licenses.
5. [ ] Choose and document **Adopt**, **Fork**, **Port**, **Study** or **Blocked**; do not leave the relationship ambiguous.
6. [ ] Put third-party code behind a ThreeNative-owned interface so it can be replaced without breaking public APIs.
7. [ ] Port upstream tests and add ThreeNative conformance, lifecycle, device-loss and degraded-mode tests.
8. [ ] Benchmark the upstream implementation and the integrated implementation on the common benchmark manifest.
9. [ ] Add attribution, source offer/notice obligations where applicable, SBOM entries and a patch/divergence log.
10. [ ] Define an upstreaming and update policy, including who owns security fixes and Three.js/native-backend migrations.

### Recommended starting point by effort-impact rank

| Rank | Feature | Best initial candidates | Initial reuse posture |
|---:|---|---|---|
| 1 | [F1](#f1) — Cinematic post-processing stack | [Three.js](https://github.com/mrdoob/three.js) + [pmndrs/postprocessing](https://github.com/pmndrs/postprocessing) | Adopt as foundation / Adopt where compatible; port WebGPU gaps |
| 2 | [F2](#f2) — Volumetrics, fog, and god rays | [takram-design-engineering/three-geospatial](https://github.com/takram-design-engineering/three-geospatial) + [Ameobea/three-good-godrays](https://github.com/Ameobea/three-good-godrays) | Fork/port rendering modules / Port the light-shaft pass |
| 3 | [F12](#f12) — TSR-like temporal anti-aliasing and upscaling | [pmndrs/upscaler](https://github.com/pmndrs/upscaler) + [Three.js](https://github.com/mrdoob/three.js) | Fork/adopt behind `TemporalUpscaler` / Adopt as frame-input foundation |
| 4 | [F14](#f14) — Virtual Shadow Maps | [Sunset-Flock/Timberdoodle](https://github.com/Sunset-Flock/Timberdoodle) + [TheRealMJP/Shadows](https://github.com/TheRealMJP/Shadows) | Port sparse-page algorithms / Port/reference shadow quality |
| 5 | [F3](#f3) — Niagara-like GPU VFX and particles | [aiira-co/three-particles](https://github.com/aiira-co/three-particles) + [Alchemist0823/three.quarks](https://github.com/Alchemist0823/three.quarks) | Evaluate, then fork/adopt GPU runtime / Adopt/port authoring and asset model |
| 6 | [F17](#f17) — Nanite-like virtualized geometry | [Scthe/nanite-webgpu](https://github.com/Scthe/nanite-webgpu) + [zeux/meshoptimizer](https://github.com/zeux/meshoptimizer) | Fork/port the prototype core / Adopt offline/runtime utilities |
| 7 | [F13](#f13) — Substrate-like layered materials | [Three.js TSL and Node Materials](https://github.com/mrdoob/three.js) + [AcademySoftwareFoundation/MaterialX](https://github.com/AcademySoftwareFoundation/MaterialX) | Adopt as runtime/compiler base / Adopt schema/interchange; map a subset |
| 8 | [F16](#f16) — Lumen-like dynamic global illumination and reflections | [jure/webgiya](https://github.com/jure/webgiya) + [0beqz/realism-effects](https://github.com/0beqz/realism-effects) | Fork/port primary surfel-GI candidate / Port screen-space baseline |
| 9 | [F5](#f5) — Procedural Content Generation framework | [retejs/rete](https://github.com/retejs/rete) + [xyflow/xyflow](https://github.com/xyflow/xyflow) | Adopt graph/runtime infrastructure / Adopt authoring canvas |
| 10 | [F9](#f9) — Motion Matching | [orangeduck/Motion-Matching](https://github.com/orangeduck/Motion-Matching) + [Three.js animation system](https://github.com/mrdoob/three.js) | Port primary algorithm/reference implementation / Adopt playback foundation |
| 11 | [F4](#f4) — Water system | [reed-soul/SeedOcean](https://github.com/reed-soul/SeedOcean) + [owenyuwono/poseidon](https://github.com/owenyuwono/poseidon) | Fork/evaluate broad ocean stack / Fork/port TSL ocean kernels |
| 12 | [F18](#f18) — MegaLights-like many-light rendering | [Three.js clustered lighting](https://github.com/mrdoob/three.js) + [playcanvas/engine](https://github.com/playcanvas/engine) | Adopt as primary browser base / Port/reference production light clustering |
| 13 | [F8](#f8) — World Partition, streaming, and HLOD | [NASA-AMMOS/3DTilesRendererJS](https://github.com/NASA-AMMOS/3DTilesRendererJS) + [CesiumGS/cesium](https://github.com/CesiumGS/cesium) | Adopt/fork traversal and cache modules / Study/port mature streaming policy |
| 14 | [F11](#f11) — Control Rig and full-body IK | [Three.js CCDIKSolver/Skeleton](https://github.com/mrdoob/three.js) + [jsantell/THREE.IK](https://github.com/jsantell/THREE.IK) | Adopt core skeleton and CCD path / Port/adopt FABRIK and chain model |
| 15 | [F6](#f6) — Mass/ECS crowds and large-scale agents | [hmans/miniplex](https://github.com/hmans/miniplex) + [NateTheGreatt/bitECS](https://github.com/NateTheGreatt/bitECS) | Evaluate/adopt ergonomic ECS / Evaluate/adopt data-oriented core |
| 16 | [F7](#f7) — Sequencer and cinematic timeline | [Theatre.js core](https://github.com/theatre-js/theatre) + [Theatre.js Studio](https://github.com/theatre-js/theatre/tree/main/packages/studio) | Adopt/reference permissive core packages / Do not embed without explicit copyleft strategy |
| 17 | [F15](#f15) — Streaming and runtime virtual texturing | [shlomnissan/virtual-textures](https://github.com/shlomnissan/virtual-textures) + [BinomialLLC/basis_universal](https://github.com/BinomialLLC/basis_universal) | Port primary VT prototype / Adopt encoder/transcoder tooling |
| 18 | [F10](#f10) — MetaSounds-like procedural audio | [Tonejs/Tone.js](https://github.com/Tonejs/Tone.js) + [standardized-audio-context](https://github.com/chrisguttandin/standardized-audio-context) | Adopt browser DSP/scheduling layer / Adopt browser compatibility layer |
| 19 | [F19](#f19) — Chaos replacement: modular physics, destruction, cloth, and vehicles | [dimforge/rapier](https://github.com/dimforge/rapier) + [pmndrs/react-three-rapier](https://github.com/pmndrs/react-three-rapier) | Adopt as rigid-body foundation / Port React lifecycle/API patterns |
| 20 | [F20](#f20) — Path tracer and reference renderer | [gkjohnson/three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer) + [gkjohnson/three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) | Fork/adopt primary implementation / Adopt acceleration foundation |

---

## 1. The decision rule

A feature is **Done** only when all of the following are true:

1. Every applicable requirement in the **Global Definition of Done** is checked.
2. Every mandatory checkbox in that feature's section is checked.
3. Every promised capability tier and platform passes the feature's conformance suite.
4. The canonical demo is reproducible from a clean checkout and contains no private assets or manual setup.
5. Performance, memory, image quality, lifecycle, and degraded-mode evidence is attached to the release record.
6. Known exclusions are represented by explicit capability flags and documentation—not by silent failure.
7. The public API is marked `stable`; an attractive prototype, research branch, example, or editor-only effect is not sufficient.

### Maturity labels

| Label | Meaning |
|---|---|
| **Research** | Algorithm exploration. Breaking changes and curated-scene assumptions are expected. |
| **Experimental** | Publicly callable, but unsupported combinations and performance cliffs remain. |
| **Beta** | API mostly stable; broad test coverage exists; production risks are documented. |
| **Stable / Done** | All mandatory requirements and evidence gates in this document pass. |
| **Parity extension** | Additional UE-like depth that is useful but not necessary for the first Stable release. |

### Requirement language

- Every unqualified checkbox is a **MUST** for Done.
- `[PARITY]` checkboxes are excluded from the first Stable closure gate unless ThreeNative publicly promises them.
- “Supported” means tested, documented, and included in the platform matrix.
- “Fallback” means an intentional degraded path with a predictable visual/functional result—not disabling the feature without notice.

---

## 2. Baseline architecture and capability tiers

This specification assumes ThreeNative remains a React/TypeScript-facing 3D framework using Three.js as a major rendering substrate, with platform-specific implementation paths where needed. The current `@threenative/physics` package already demonstrates this direction by presenting one API over a Rapier WASM path and a native Rapier path.

Three.js' current `WebGPURenderer` can choose WebGPU and fall back to WebGL 2. Its newer post stack provides node composition, built-in MRT, and common scene attachments. Those are useful primitives, but they do not by themselves satisfy the feature-level Done definitions below.

### Capability tiers

| Tier | Minimum capability | Intended use |
|---|---|---|
| **TN-BASIC** | WebGL 2 or equivalent constrained backend; no compute assumption | Graceful fallback, simple scenes, compatibility mode |
| **TN-COMPUTE** | WebGPU render + compute, storage buffers/textures, MRT, indirect drawing where required | Primary browser and modern-device path |
| **TN-NATIVE** | Native GPU backend exposing the same ThreeNative feature contract | Android/iOS/desktop native targets declared by the project |
| **TN-RT** | Optional native acceleration structures and ray queries | Hardware-ray-traced enhancements; never assumed on standard WebGPU |

A feature may be Stable on only a subset of tiers, but the subset must be encoded in the public capability registry and documentation. For example, `VirtualGeometry` may require `TN-COMPUTE`; it must not appear enabled on `TN-BASIC` and then fail during play.

### Important WebGPU constraint

The current WebGPU specification provides programmable render and compute passes, explicit resources, buffers, textures, synchronization, validation, and device-loss handling. It does **not** standardize hardware ray-tracing acceleration structures or ray-query shaders. Therefore, browser implementations of Dynamic GI, many-light visibility, and the path tracer must use screen-space methods, probes, voxels/SDFs, or software BVHs unless a future WebGPU capability is detected. Native backends may add hardware RT behind the same contract.

---

## 3. Global Definition of Done

These requirements apply to **every** subsystem in this document. Feature teams should link to a single shared implementation rather than rebuilding these facilities per feature.

### 3.1 Public contract and lifecycle

- [ ] **GLOB-API-001** — Expose a documented, typed TypeScript API and a React-facing API; both paths must share the same runtime implementation and behavior.
- [ ] **GLOB-API-002** — Expose a machine-readable capability query returning support, active implementation, quality tier, limits, and fallback reason.
- [ ] **GLOB-API-003** — Define ownership for every GPU, audio, physics, worker, and streamed resource; React unmount and imperative `dispose()` must release the same resources.
- [ ] **GLOB-API-004** — Support repeated mount/unmount, scene replacement, hot reload, and renderer recreation without duplicate registrations, stale callbacks, or leaked resources.
- [ ] **GLOB-API-005** — Use versioned, serializable feature configuration with validation, defaults, and deterministic migration of older assets.
- [ ] **GLOB-API-006** — Reject invalid combinations with actionable diagnostics before frame execution whenever possible.
- [ ] **GLOB-API-007** — Make asynchronous creation, compilation, baking, and streaming cancellable; cancellation must leave no partially registered runtime object.
- [ ] **GLOB-API-008** — Document thread affinity and callback semantics for render, simulation, worker, audio, and React threads.
- [ ] **GLOB-API-009** — Provide stable object IDs and event ordering wherever a subsystem participates in serialization, picking, history, replication, or replay.
- [ ] **GLOB-API-010** — Keep experimental implementation details out of the stable public API, or isolate them behind explicitly experimental namespaces.

### 3.2 Shared renderer and runtime services

- [ ] **GLOB-RUN-001** — Integrate render work through a shared frame/render graph with declared reads, writes, dependencies, lifetimes, and queue/pass type.
- [ ] **GLOB-RUN-002** — Use a shared scene-data registry for transforms, previous transforms, bounds, material IDs, mobility, visibility layers, and feature masks.
- [ ] **GLOB-RUN-003** — Use a shared temporal-history service that owns allocation, ping-ponging, validity, resolution changes, camera cuts, teleport detection, and destruction.
- [ ] **GLOB-RUN-004** — Use a shared GPU resource and residency manager with byte budgets, priorities, reference counts, eviction policy, and pressure telemetry.
- [ ] **GLOB-RUN-005** — Use shared color-management conventions: linear-light working space, declared texture color spaces, HDR range, tone-mapping location, and output transform.
- [ ] **GLOB-RUN-006** — Use shared coordinate, handedness, scale, depth-range, camera-jitter, and world-origin conventions across rendering, physics, audio, animation, and tools.
- [ ] **GLOB-RUN-007** — Provide quality presets plus granular overrides; changing quality at runtime must not corrupt history or leak old resources.
- [ ] **GLOB-RUN-008** — Cache and prewarm shaders/pipelines for known variants; shipping samples must not exhibit avoidable first-use compilation stalls.
- [ ] **GLOB-RUN-009** — Handle resize, device-pixel-ratio change, dynamic-resolution change, camera replacement, and multi-camera rendering intentionally.
- [ ] **GLOB-RUN-010** — Handle GPU device loss and backend reinitialization according to the supported-platform policy; unrecoverable loss must surface a structured error.
- [ ] **GLOB-RUN-011** — Define behavior for transparent objects, alpha masking, double-sided materials, skinned meshes, morph targets, instancing, and vertex/node deformation wherever applicable.
- [ ] **GLOB-RUN-012** — Avoid unbounded per-frame CPU/GPU allocation; transient allocations must come from bounded pools or frame allocators.
- [ ] **GLOB-RUN-013** — Label GPU passes/resources and emit CPU/GPU timing scopes so captures are intelligible in browser and native GPU debuggers.
- [ ] **GLOB-RUN-014** — Keep runtime feature state independent of editor/devtools state; disabling diagnostics must remove their measurable shipping overhead.

### 3.3 Asset pipeline and compatibility

- [ ] **GLOB-ASSET-001** — Define canonical source and runtime asset formats, including version, endianness, compression, coordinate conversion, and integrity/hash metadata.
- [ ] **GLOB-ASSET-002** — Provide deterministic command-line build steps suitable for CI; identical inputs and tool versions must produce byte-identical or semantically hash-identical outputs.
- [ ] **GLOB-ASSET-003** — Cache build outputs by source hash, settings, tool version, and platform target; stale cache entries must be rejected safely.
- [ ] **GLOB-ASSET-004** — Validate imported assets and report unsupported features with object/material/clip-level context rather than silently dropping data.
- [ ] **GLOB-ASSET-005** — Support glTF 2.0 as an interchange path where relevant and document any ThreeNative-specific extension or sidecar schema.
- [ ] **GLOB-ASSET-006** — Use GPU-native texture compression/transcoding, such as KTX2/BasisU, on declared platforms; retain a documented fallback format.
- [ ] **GLOB-ASSET-007** — Package streamable data into independently addressable chunks with checksums and cancellation-safe loading.
- [ ] **GLOB-ASSET-008** — Keep runtime assets backward-compatible for the declared support window, with migration or rebuild instructions for breaking format changes.

### 3.4 Testing, performance, and release evidence

- [ ] **GLOB-QA-001** — Provide unit tests for pure algorithms and state transitions, integration tests for lifecycle and cross-system behavior, and end-to-end canonical scene tests.
- [ ] **GLOB-QA-002** — Provide visual-golden tests for every supported renderer tier, with documented perceptual and per-pixel tolerances and an approved-update workflow.
- [ ] **GLOB-QA-003** — Run GPU/WebGPU validation with zero unexpected errors, warnings, NaNs, out-of-bounds accesses, resource hazards, or uncaptured error events.
- [ ] **GLOB-QA-004** — Run a load/unload soak that returns CPU heap, GPU allocation, worker count, event listeners, and native handles to the documented steady-state envelope.
- [ ] **GLOB-QA-005** — Run a long-frame soak that detects history divergence, simulation drift, memory growth, timestamp wrap/overflow, and intermittent device failures.
- [ ] **GLOB-QA-006** — Publish a benchmark manifest containing scene hash, build hash, device/driver/browser/OS, resolution, quality settings, warm-up, sample duration, and camera path.
- [ ] **GLOB-QA-007** — Record median and p95 CPU frame time, GPU frame time, peak and steady memory, streaming bandwidth, compilation time, and feature-specific counters.
- [ ] **GLOB-QA-008** — Set explicit pass/fail budgets per supported reference device; 'fast enough on my machine' cannot close a requirement.
- [ ] **GLOB-QA-009** — Test minimum limits and resource-pressure behavior, not only high-end hardware; pool overflow and allocation failure must degrade safely.
- [ ] **GLOB-QA-010** — Test camera cuts, teleports, rapid resize, foreground/background transitions, orientation changes, and repeated quality toggles.
- [ ] **GLOB-QA-011** — Test missing/corrupt assets, cancelled loads, shader compilation failure, device loss, and unsupported capability paths.
- [ ] **GLOB-QA-012** — Maintain at least one adversarial scene designed to reveal the subsystem's known artifact classes, not only a flattering showcase.
- [ ] **GLOB-QA-013** — Attach before/after captures, profiler traces, benchmark output, known limitations, and the completed requirement IDs to the Stable release record.
- [ ] **GLOB-QA-014** — Pin or explicitly qualify the Three.js revision used by conformance tests; upgrading Three.js must rerun the affected feature suites.

### 3.5 Diagnostics, documentation, and operability

- [ ] **GLOB-OPS-001** — Provide an in-engine debug view or inspector for the subsystem's internal data, active tier, fallback, budgets, and failure state.
- [ ] **GLOB-OPS-002** — Expose structured counters that can be collected without parsing console text.
- [ ] **GLOB-OPS-003** — Provide one minimal example, one production-oriented example, and one stress/adversarial example.
- [ ] **GLOB-OPS-004** — Document setup, public API, supported combinations, platform matrix, quality controls, performance costs, failure modes, and troubleshooting.
- [ ] **GLOB-OPS-005** — Provide migration notes for public API or asset-format changes and keep examples synchronized with the current stable API.
- [ ] **GLOB-OPS-006** — Emit no recurring console noise during normal operation; warnings must be actionable, deduplicated, and identify the offending object or asset.
- [ ] **GLOB-OPS-007** — Provide a feature-disable switch that returns the engine to a valid baseline path for diagnosis and emergency rollback.
- [ ] **GLOB-OPS-008** — Assign a subsystem owner and a maintenance policy covering dependency updates, regression triage, and platform deprecation.

---

## 4. Benchmark manifest required for every Stable feature

Each feature's benchmark evidence must include this exact information:

```yaml
feature: DynamicGI
featureVersion: 1.0.0
engineCommit: <git-sha>
threeRevision: r185
assetBuildVersion: <version>
scene:
  id: <canonical-scene-id>
  hash: <content-hash>
cameraPath: <path-and-hash>
platformTier: TN-COMPUTE
device:
  model: <model>
  gpu: <gpu>
  driver: <driver>
  os: <version>
  browserOrRuntime: <version>
render:
  resolution: 2560x1440
  internalScale: 0.67
  qualityPreset: high
run:
  warmupFrames: 600
  measuredFrames: 3600
budgets:
  gpuMsP95: <approved-budget>
  cpuMsP95: <approved-budget>
  steadyGpuMemoryMiB: <approved-budget>
  peakGpuMemoryMiB: <approved-budget>
resultArtifacts:
  - profiler-trace
  - visual-capture
  - counters-json
  - validation-log
```

The concrete numbers belong to ThreeNative's product targets and reference devices. This document deliberately does not invent universal millisecond or memory budgets.

---

## 5. Shared dependency map

```text
Platform capability registry
        │
        ├── Render graph / pass scheduler
        │      ├── Scene attachments and scene-data buffers
        │      ├── Temporal history service
        │      ├── Dynamic resolution
        │      └── GPU profiling and debug labels
        │
        ├── Material compiler / TSL integration
        │      ├── Post processing
        │      ├── Virtual shadows
        │      ├── Dynamic GI / reflections
        │      ├── Many-light shading
        │      └── Path tracer material translation
        │
        ├── Asset build pipeline
        │      ├── KTX2 texture pipeline
        │      ├── Virtual texture tiling
        │      ├── Virtual geometry clustering
        │      ├── HLOD generation
        │      └── Motion database extraction
        │
        ├── Residency / streaming manager
        │      ├── World partition
        │      ├── Virtual textures
        │      ├── Virtual geometry
        │      └── Audio streaming
        │
        └── Simulation clock and scene identity
               ├── Mass/ECS
               ├── Physics suite
               ├── Niagara-like VFX
               ├── Sequencer
               ├── Motion matching / Control Rig
               └── MetaSounds-like audio
```

A subsystem should consume these shared services. A feature-specific private history manager, resource pool, asset cache, or capability system is a design defect unless a measured technical constraint requires it.

---

## 6. Effort-impact priority matrix

The feature definitions below are sorted by a **weighted effort-impact priority score**, not by Unreal's marketing prominence or by implementation dependency alone.

### Scoring model

- **Impact (0–100):** Expected contribution to ThreeNative's UE5-class outcome, combining visible quality, performance leverage, scene scale, developer leverage, and breadth of use.
- **Effort (1–10):** Relative end-to-end engineering cost to reach the full Stable/Done contract in this document—not the cost of producing a curated demo.
- **Implementation ease:** `(11 − effort midpoint) × 10`.
- **Priority score:** `70% × impact + 30% × implementation ease`.
- **Impact/effort:** A raw ROI ratio shown for transparency. It is **not** the primary sort key because pure division over-rewards narrow quick wins and can bury engine-defining systems such as VirtualGeometry and DynamicGI.

The score is a planning heuristic. Dependencies still override literal rank during execution; see [Dependency-correct delivery order](#dependency-correct-delivery-order).

| Rank | Stable ID | System | Impact | Effort | Impact / effort | Priority score | Feasibility | Three.js starting point | Dominant closure dependency |
|---:|---:|---|---:|---:|---:|---:|---:|---|---|
| 1 | F1 | [Post-processing](#f1) | 94/100 | 3/10 | 31.3 | 89.8 | 99/100 | Strong primitives | Shared render graph and scene attachments |
| 2 | F2 | [Volumetrics / god rays](#f2) | 88/100 | 5/10 | 17.6 | 79.6 | 97/100 | Partial primitives | Froxel pipeline, temporal history, shadow sampling |
| 3 | F12 | [Temporal upscaling / TSR-like](#f12) | 94/100 | 6–7/10 | 14.5 | 79.3 | 92/100 | MRT, velocity, TRAA primitives | Complete motion vectors and robust temporal resolve |
| 4 | F14 | [Virtual Shadow Maps](#f14) | 96/100 | 7/10 | 13.7 | 79.2 | 90/100 | Conventional shadow primitives | Virtual paging, invalidation and cache |
| 5 | F3 | [Niagara-like GPU VFX](#f3) | 90/100 | 6/10 | 15.0 | 78.0 | 96/100 | Compute/render primitives | GPU simulation framework and authoring schema |
| 6 | F17 | [Virtualized geometry / Nanite-like](#f17) | 100/100 | 8–9/10 | 11.8 | 77.5 | 80–85/100 | Compute, batching and indirect primitives | Cluster hierarchy, GPU traversal and streaming |
| 7 | F13 | [Layered materials / Substrate-like](#f13) | 91/100 | 6–7/10 | 14.0 | 77.2 | 92/100 | Strong TSL/PBR primitives | Layered BSDF compiler and pass consistency |
| 8 | F16 | [Dynamic GI / Lumen-like](#f16) | 100/100 | 9–10/10 | 10.5 | 74.5 | 82/100 | SSGI/SSR/probe primitives | World-space radiance representation and denoising |
| 9 | F5 | [PCG](#f5) | 80/100 | 5/10 | 16.0 | 74.0 | 100/100 | General geometry/compute primitives | Graph runtime, deterministic data model, world integration |
| 10 | F9 | [Motion Matching](#f9) | 84/100 | 6/10 | 14.0 | 73.8 | 95/100 | Animation primitives only | Offline feature database and runtime search |
| 11 | F4 | [Water](#f4) | 75/100 | 4/10 | 18.8 | 73.5 | 96/100 | Example-level primitives | Water-body model, mesh LOD, shading and queries |
| 12 | F18 | [Many-light rendering / MegaLights-like](#f18) | 89/100 | 7–8/10 | 11.9 | 72.8 | 75/100 | Forward+ clustered lighting | Scalable visibility/shadows and temporal sampling |
| 13 | F8 | [World Partition / HLOD](#f8) | 79/100 | 6/10 | 13.2 | 70.3 | 96/100 | LOD/loading primitives | Cell packaging, streaming budget, HLOD builder |
| 14 | F11 | [Control Rig / IK](#f11) | 77/100 | 6/10 | 12.8 | 68.9 | 94/100 | Skeleton and CCD IK primitives | Rig graph, solver suite, animation integration |
| 15 | F6 | [Mass / ECS crowds](#f6) | 68/100 | 4/10 | 17.0 | 68.6 | 100/100 | Instancing/batching primitives | Data-oriented runtime and representation LOD |
| 16 | F7 | [Sequencer](#f7) | 68/100 | 4/10 | 17.0 | 68.6 | 100/100 | Animation primitives | Deterministic timeline/evaluation model |
| 17 | F15 | [Virtual Texturing](#f15) | 85/100 | 8/10 | 10.6 | 68.5 | 88/100 | Low-level texture primitives | Offline tiler, feedback, residency and IO |
| 18 | F10 | [Procedural audio](#f10) | 70/100 | 5/10 | 14.0 | 67.0 | 98/100 | Web Audio and positional wrappers | Real-time graph runtime and native parity |
| 19 | F19 | [Physics suite](#f19) | 82/100 | 9/10 as a suite | 9.1 | 63.4 | 85/100 by modules | Rapier covers rigid-body core | Explicit module scope and cross-backend conformance |
| 20 | F20 | [Path tracer](#f20) | 60/100 | 9–10/10 | 6.3 | 46.5 | 55–70/100 | General compute/texture primitives | Software BVH or optional native RT and material parity |

### Priority bands

| Band | Meaning |
|---|---|
| **A — Now** | Highest combined return. Build production foundations and close these early. |
| **B — Strategic** | High-impact bets. Start architecture/R&D early even when full closure comes later. |
| **C — Next** | Strong value, usually dependent on shared runtime, world, or animation foundations. |
| **D — Later / specialized** | Valuable but narrower, expensive as a complete suite, or better used first as an internal validation tool. |

### Reading the ranking correctly

- `VirtualGeometry` and `DynamicGI` rank below several cheaper systems, but they remain long-lead strategic projects and should receive early prototypes after shared foundations exist.
- `VirtualTexturing` ranks lower on standalone ROI, yet a minimum residency/streaming layer may be pulled forward because `VirtualGeometry`, `WorldPartition`, and large-world materials depend on it.
- `PathTracer` ranks last as a full customer-facing renderer, but a **minimal correctness harness** should begin much earlier to validate materials and lighting.
- `PhysicsSuite` is expensive only when treated as one UE-Chaos-sized program. Rapier rigid bodies are already the base; destruction, cloth, and vehicles should ship as separately gated modules.

---

# Feature Definitions of Done

<a id="f1"></a>

## F1. Cinematic post-processing stack

**ThreeNative working name:** `PostProcessing`  

**Effort-impact priority:** **#1 of 20** · **Impact:** 94/100 · **Effort:** 3/10 · **Impact/effort:** 31.3 · **Priority score:** 89.8/100 · **Band:** A — Now  

**Done means:** A camera or volume can compose a predictable HDR image pipeline with production-quality exposure, tone mapping, grading, anti-aliasing, lens effects, and custom passes, with correct temporal behavior and no hidden renderer forks.

**Three.js starting point:** Three.js already provides `RenderPipeline`, node-composed effects, built-in MRT, depth, velocity, normal and emissive attachments, tone mapping, LUT paths, TRAA, bloom, DOF and SSR building blocks. ThreeNative still needs an opinionated contract, volume/camera blending, lifecycle, complete effect coverage, presets, diagnostics and conformance.

**Critical dependencies:** `GLOB-RUN-001`, `GLOB-RUN-003`, `GLOB-RUN-005`, `GLOB-RUN-007`, `TSR`, `Substrate`

### Functional Definition-of-Done checklist

#### Public API and composition

1. [ ] **POST-001** — Expose a `PostProcessing`/`PostProcessVolume` API usable declaratively from React and imperatively from runtime code.
2. [ ] **POST-002** — Represent the chain as an ordered/dependency-aware graph whose passes declare inputs, outputs, resolution, format, history, and color-space expectations.
3. [ ] **POST-003** — Allow built-in and user-authored TSL/WGSL-compatible passes without requiring a private fork of the renderer.
4. [ ] **POST-004** — Support global settings, camera-local settings, bounded 3D volumes, blend radius, blend weight, priority, and deterministic overlap resolution.
5. [ ] **POST-005** — Provide versioned presets such as `mobile`, `balanced`, `cinematic`, and `custom`, while allowing every effect to be overridden.
6. [ ] **POST-006** — Expose an explicit policy for offscreen render targets, reflection cameras, minimaps, portals, WebXR, screenshots, and video capture.

#### HDR, exposure, and color pipeline

7. [ ] **POST-007** — Render scene-referred lighting into a documented HDR intermediate format and apply the display/output transform exactly once.
8. [ ] **POST-008** — Implement manual exposure and histogram- or luminance-driven automatic exposure with min/max range, adaptation-up/down speeds, compensation, and metering masks.
9. [ ] **POST-009** — Implement local exposure or an equivalent local-contrast stage with halo/clipping controls and a quality-scalable path.
10. [ ] **POST-010** — Implement at least one documented filmic tone mapper and preserve an escape hatch for custom output transforms.
11. [ ] **POST-011** — Implement color grading controls for white balance, global/shadow/midtone/highlight lift-gamma-gain or equivalent, saturation, contrast, gamma, gain, offset, and 3D LUTs.
12. [ ] **POST-012** — Respect texture/output color-space metadata and verify SDR output; document and test HDR-display output separately if promised.

#### Required visual effects

13. [ ] **POST-013** — Implement thresholded, physically sensible bloom with controllable intensity, scatter/radius, tint, and resolution scaling.
14. [ ] **POST-014** — Implement depth of field with focus distance, focal region or aperture/circle-of-confusion controls, foreground/background handling, and stable edges.
15. [ ] **POST-015** — Implement camera/object motion blur using motion vectors, shutter control, sample/quality tiers, and camera-cut suppression.
16. [ ] **POST-016** — Implement vignette, film grain, sharpen, chromatic aberration, and lens distortion with zero-cost or negligible-cost disabled paths.
17. [ ] **POST-017** — Integrate the selected spatial/temporal anti-aliasing or upscaling stage at the correct point in the color pipeline.
18. [ ] **POST-018** — Support user-defined post materials/effects with depth, normals, velocity, material/object masks, and previous-frame inputs when declared.
19. [ ] **POST-019** — Support selective application through stable object/layer/stencil IDs without ID reuse corrupting temporal effects.

#### Runtime behavior and integration

20. [ ] **POST-020** — Reallocate and invalidate resolution-dependent resources correctly on resize, DPR, internal render-scale, sample-count, and format changes.
21. [ ] **POST-021** — Reset or reproject temporal histories correctly on camera cuts, teleports, projection changes, origin rebasing, pause/resume, and effect topology changes.
22. [ ] **POST-022** — Keep UI/HTML overlays and non-jittered HUD rendering outside temporal jitter and unwanted lens effects unless explicitly opted in.
23. [ ] **POST-023** — Define and test premultiplied-alpha/canvas-alpha behavior, including capture to transparent render targets.
24. [ ] **POST-024** — Fuse compatible passes or reuse intermediates where possible, while preserving debuggable logical pass boundaries.
25. [ ] **POST-025** — Make disabled effects release or avoid allocating their exclusive persistent resources.

#### Diagnostics

26. [ ] **POST-026** — Provide debug views for every scene attachment, exposure histogram/current exposure, pre-tonemap HDR, post-tonemap output, effect masks, motion vectors, and temporal validity.
27. [ ] **POST-027** — Expose per-effect CPU/GPU timings, transient/persistent bytes, render resolution, shader variant, and history reset counters.
28. [ ] **POST-028** — Allow capture of any logical pass output to an image without changing the rendered result.

### Candidate repositories and code-reuse plan

**Recommended blend:** Keep Three.js `RenderPipeline`/TSL as the runtime base; selectively port mature effects and composition behavior from pmndrs, while owning the ThreeNative volume, camera, lifecycle and quality contract.

| Candidate | Reuse score | Recommended action | License status | Likely requirement coverage | What to borrow | Gaps and caveats |
|---|---:|---|---|---|---|---|
| [Three.js](https://github.com/mrdoob/three.js) | **98** | Adopt as foundation | ✅ MIT | Renderer, TSL, WebGPU compute, MRT, temporal inputs, batching and core scene integration | Use upstream APIs and examples; contribute missing primitives upstream instead of creating a permanent renderer fork. | ThreeNative still needs stable cross-backend contracts, lifecycle, quality policy and production tests. |
| [pmndrs/postprocessing](https://github.com/pmndrs/postprocessing) | **92** | Adopt where compatible; port WebGPU gaps | ✅ Zlib | Effect composition, bloom, DOF, SSAO-style effects, LUTs, pass lifecycle and resource reuse | Effect graph concepts, effect implementations, blend modes, selection masks, tests and documentation structure. | Historically centered on `EffectComposer`/WebGL; verify each effect against the Three.js r185 WebGPU path before depending on it. |
| [pmndrs/react-postprocessing](https://github.com/pmndrs/react-postprocessing) | **84** | Port API/lifecycle patterns | ✅ MIT | Declarative React composition, selection, context ownership and component lifecycle | Component API, provider boundaries, effect ordering and React cleanup patterns. | React Three Fiber-specific; do not make R3F a runtime dependency of ThreeNative. |
| [0beqz/realism-effects](https://github.com/0beqz/realism-effects) | **80** | Port selected algorithms | ✅ MIT | SSGI, SSR, GTAO, TRAA, temporal denoising and motion-vector usage | Temporal accumulation, ray-march, denoiser and debug patterns useful to post, GI and reflections. | Built against older Three.js assumptions; re-derive against r185 TSL/WebGPU rather than copying integration code blindly. |

> **Reuse-score meaning:** engineering fit for this ThreeNative feature—not GitHub popularity. It weighs useful requirement coverage, proximity to Three.js/WebGPU/TypeScript, maturity, maintainability and license safety. A high score does not replace benchmark or legal review.

### Open-source integration checklist

1. [ ] Pin a Three.js r185-compatible baseline and reproduce the selected pmndrs/realism-effects demos before extracting code.
2. [ ] Define one backend-neutral ThreeNative pass interface before importing any third-party pass classes.
3. [ ] Map each borrowed effect to the HDR/color-space stage where it runs; prove that tone mapping and output conversion occur exactly once.
4. [ ] Port effects one at a time with golden images, resize/camera-cut/history tests and isolated GPU timing.
5. [ ] Keep React wrappers separate from the imperative render-graph implementation.
6. [ ] Record every copied shader/function and retain upstream notices in the Third-Party Software manifest.

### Required completion evidence

1. [ ] **POST-EVID-001** — Golden scenes cover indoor/outdoor exposure transition, extreme highlights, emissive bloom, thin geometry, alpha-masked foliage, fast motion, camera cuts, DOF edges, UI composition, and overlapping volumes.
2. [ ] **POST-EVID-002** — An adversarial temporal sequence shows no persistent ghosting, stale exposure, uninitialized history, or full-frame flash after cuts and resize.
3. [ ] **POST-EVID-003** — The benchmark records each effect alone and the shipping preset as a whole, including transient and persistent memory.
4. [ ] **POST-EVID-004** — A custom third-party pass example proves the extension API without modifying ThreeNative or Three.js internals.
5. [ ] **POST-EVID-005** — Screenshots from every promised platform/tier pass the approved visual-difference thresholds.

### This is **not Done** when

- Only one hard-coded composer chain or showcase scene works.
- The effect stack produces double tone mapping, incorrect gamma, or order-dependent color-space bugs.
- Camera cuts, resize, or dynamic-resolution changes leave stale histories or flashes.
- Volumes cannot blend deterministically or are editor-only.
- Individual effects exist but there is no stable composition, diagnostics, or lifecycle contract.

### Parity extensions — valuable, but not required for the first Stable release

1. [ ] **[PARITY] POST-P001** — HDR10/scRGB output calibration and metadata on supported native displays.
2. [ ] **[PARITY] POST-P002** — Cinematic lens simulation including anamorphic bloom, diaphragm blades, lens dirt, and calibrated camera profiles.
3. [ ] **[PARITY] POST-P003** — Automatic pass scheduling across async compute where the native backend can prove a benefit.

### Primary research references

- [Epic — Post Process Effects](https://dev.epicgames.com/documentation/en-us/unreal-engine/post-process-effects-in-unreal-engine)
- [Three.js — WebGPU post-processing](https://threejs.org/manual/en/webgpu-postprocessing.html)
- [Three.js — WebGPURenderer](https://threejs.org/docs/pages/WebGPURenderer.html)

<a id="f2"></a>

## F2. Volumetrics, fog, and god rays

**ThreeNative working name:** `Volumetrics`  

**Effort-impact priority:** **#2 of 20** · **Impact:** 88/100 · **Effort:** 5/10 · **Impact/effort:** 17.6 · **Priority score:** 79.6/100 · **Band:** A — Now  

**Done means:** Participating media is lit, shadowed, temporally stable, composited with the scene, scalable across hardware, and authorable as both global atmosphere and local volumes.

**Three.js starting point:** Three.js supplies fog primitives, 3D/storage textures, compute, shadow maps, lights, depth and post-processing hooks. It does not provide a unified froxel volumetric-lighting system, local media composition, temporal resolve, or production diagnostics.

**Critical dependencies:** `GLOB-RUN-001`, `GLOB-RUN-003`, `VirtualShadows`, `DynamicGI`, `PostProcessing`

### Functional Definition-of-Done checklist

#### Authoring and media model

1. [ ] **VOL-001** — Expose a global height-fog component with density, height falloff, start distance, max opacity/distance, color/albedo, extinction, emission, and anisotropy/phase controls.
2. [ ] **VOL-002** — Expose bounded local fog volumes with box, sphere, capsule and extensible signed-distance/custom-density shapes.
3. [ ] **VOL-003** — Support overlapping local volumes with deterministic density/emission composition, priorities, masks, and smooth boundary falloff.
4. [ ] **VOL-004** — Support procedural 3D noise, scrolling/turbulence, density textures, and user-authored TSL density functions with bounded evaluation cost.
5. [ ] **VOL-005** — Distinguish physically meaningful coefficients from art-direction multipliers and document units/ranges.
6. [ ] **VOL-006** — Allow per-light volumetric contribution and volumetric-shadow toggles without cloning light objects.

#### Volumetric rendering

7. [ ] **VOL-007** — Implement a camera-aligned froxel grid, equivalent clustered volume, or demonstrably equivalent technique with configurable XY/Z resolution and depth distribution.
8. [ ] **VOL-008** — Inject density, extinction, albedo and emission into the volume and integrate transmittance and in-scattered radiance along the view ray.
9. [ ] **VOL-009** — Illuminate media from directional, point, spot, and supported area lights with physically consistent attenuation.
10. [ ] **VOL-010** — Sample the active shadow solution so occluders produce volumetric shadows and recognizable light shafts.
11. [ ] **VOL-011** — Include sky/ambient lighting and, where enabled, an approximate Dynamic GI contribution without double counting.
12. [ ] **VOL-012** — Support emissive media and VFX injection hooks for fire, explosions, smoke, and clouds.
13. [ ] **VOL-013** — Apply temporal jitter/reprojection and spatial filtering that suppress noise without unacceptable trails around moving lights, occluders, or camera motion.
14. [ ] **VOL-014** — Composite media correctly against opaque depth, sky/background, transparent surfaces, particles, and water; document any unavoidable ordering restrictions.
15. [ ] **VOL-015** — Prevent light leakage through thin occluders using a documented depth/shadow strategy and quality controls.
16. [ ] **VOL-016** — Render at reduced resolution or reduced froxel density as configured, with stable reconstruction and no visible grid discontinuities.

#### Scalability and fallbacks

17. [ ] **VOL-017** — Provide quality controls for froxel dimensions, ray steps, shadow samples, light count, temporal weight, max distance, and local-volume complexity.
18. [ ] **VOL-018** — Provide a TN-BASIC fallback using analytic height fog and local screen-space fog volumes that preserves scene readability.
19. [ ] **VOL-019** — Cull volumes and lights by bounds and influence; inactive or fully occluded volumes must not consume full-grid work.
20. [ ] **VOL-020** — Handle camera-inside-volume, near-plane intersection, very large worlds, origin shifts, and fast teleports without precision failure or stale media.
21. [ ] **VOL-021** — Reset or reinitialize history on camera cuts, projection changes, quality-grid changes, and device restoration.

#### Diagnostics

22. [ ] **VOL-022** — Visualize froxel slices, integrated transmittance, in-scattering, density contributors, light contributors, shadow term, and temporal history weight.
23. [ ] **VOL-023** — Expose froxel dimensions, injected volume/light counts, culled counts, GPU time per stage, bytes, and history resets.
24. [ ] **VOL-024** — Identify the volume or light responsible for budget overflow, unsupported density code, or a fallback path.

### Candidate repositories and code-reuse plan

**Recommended blend:** Build a unified ThreeNative participating-media system, combining Three.js/TSL primitives with the best permissive atmosphere, cloud and light-shaft implementations rather than adopting a single monolithic library.

| Candidate | Reuse score | Recommended action | License status | Likely requirement coverage | What to borrow | Gaps and caveats |
|---|---:|---|---|---|---|---|
| [takram-design-engineering/three-geospatial](https://github.com/takram-design-engineering/three-geospatial) | **94** | Fork/port rendering modules | ✅ MIT | Physically based atmosphere, aerial perspective, clouds, geospatial depth and temporal rendering | Atmospheric scattering model, cloud ray marching, LUT generation, temporal reprojection and diagnostics. | Geospatial product architecture is broader than ThreeNative needs; extract rendering modules behind a generic world-coordinate contract. |
| [Ameobea/three-good-godrays](https://github.com/Ameobea/three-good-godrays) | **89** | Port the light-shaft pass | ✅ Permissive custom license | Screen-space volumetric light shafts with occlusion and temporal-quality ideas | Occlusion sampling, radial accumulation, compositing and tuning controls. | God rays alone are not volumetric fog; integrate as one consumer of the shared media/shadow model. |
| [joshbrew/webgpu_realtime_clouds](https://github.com/joshbrew/webgpu_realtime_clouds) | **83** | Port compute/ray-march kernels | ✅ MIT | WebGPU real-time clouds, noise volumes and temporal accumulation | WGSL cloud sampling, weather/noise construction, reprojection and performance controls. | Prototype maturity; validate precision, resource bounds, mobile behavior and integration with scene depth/shadows. |
| [Three.js](https://github.com/mrdoob/three.js) | **88** | Adopt as foundation | ✅ MIT | Fog, 3D textures, TSL, storage textures, compute, depth/shadow access and render-pipeline integration | Use native nodes/resources and upstream missing low-level hooks where possible. | No unified UE-style volumetric fog/froxel system exists; ThreeNative must provide it. |
| [Ameobea/three-volumetric-pass](https://github.com/Ameobea/three-volumetric-pass) | **35** | Blocked; study behavior only | ⛔ No usable repository license found | Volumetric ray-march pass and light integration concepts | Observe API shape and visual behavior only. | Do not copy source or shaders unless the project is relicensed or explicit permission is obtained. |

> **Reuse-score meaning:** engineering fit for this ThreeNative feature—not GitHub popularity. It weighs useful requirement coverage, proximity to Three.js/WebGPU/TypeScript, maturity, maintainability and license safety. A high score does not replace benchmark or legal review.

### Open-source integration checklist

1. [ ] Reproduce atmosphere, cloud and god-ray candidates in the same cathedral, outdoor-sun and moving-light benchmark scenes.
2. [ ] Define the common media representation—density, extinction, albedo, emission, anisotropy and world bounds—before porting shaders.
3. [ ] Unify depth, shadow and light inputs so clouds, fog and shafts do not maintain incompatible private pipelines.
4. [ ] Port temporal reprojection with explicit camera-cut, resize, teleport and dynamic-resolution invalidation.
5. [ ] Provide half/quarter-resolution and non-volumetric fallback tiers before calling the borrowed path production-ready.
6. [ ] Exclude all source from no-license repositories from commits, patches and generated shader bundles.

### Required completion evidence

1. [ ] **VOL-EVID-001** — Canonical scenes include a sunlit cathedral, dense indoor spotlights, night fog with many local lights, moving occluders, animated smoke, camera-inside-volume, water intersection, and transparent particles.
2. [ ] **VOL-EVID-002** — A camera-cut and rapid-motion sequence shows no persistent light trails, black frames, density popping, or exposed froxel slices.
3. [ ] **VOL-EVID-003** — The low-end fallback and TN-COMPUTE implementation preserve the same public scene configuration and fail only by documented quality differences.
4. [ ] **VOL-EVID-004** — Benchmark evidence separates injection, lighting, integration, filtering, and composition costs.
5. [ ] **VOL-EVID-005** — Volumetric shadow alignment is tested against the opaque shadow result across directional and local lights.

### This is **not Done** when

- God rays are a 2D radial blur unrelated to scene depth or occlusion.
- Only one directional light or one global fog layer works.
- Moving lights/objects leave long trails or camera cuts flash old fog.
- Transparent objects and water ignore or incorrectly double-apply fog.
- The implementation has no low-tier path, debug slices, or measurable budgets.

### Parity extensions — valuable, but not required for the first Stable release

1. [ ] **[PARITY] VOL-P001** — Physically based multi-scattering atmosphere and volumetric clouds sharing the volume/light infrastructure.
2. [ ] **[PARITY] VOL-P002** — Per-volume material graphs with heterogeneous multiple scattering.
3. [ ] **[PARITY] VOL-P003** — Native async-compute scheduling and foveated volumetric quality for XR.

### Primary research references

- [Epic — Volumetric Fog](https://dev.epicgames.com/documentation/en-us/unreal-engine/volumetric-fog-in-unreal-engine)
- [Epic — Local Fog Volumes](https://dev.epicgames.com/documentation/en-us/unreal-engine/local-fog-volumes-in-unreal-engine)
- [Epic — Light Shafts](https://dev.epicgames.com/documentation/en-us/unreal-engine/light-shafts-in-unreal-engine)
- [WebGPU — 3D textures and compute foundation](https://gpuweb.github.io/gpuweb/)

<a id="f12"></a>

## F12. TSR-like temporal anti-aliasing and upscaling

**ThreeNative working name:** `TemporalUpscaler`  

**Effort-impact priority:** **#3 of 20** · **Impact:** 94/100 · **Effort:** 6–7/10 · **Impact/effort:** 14.5 · **Priority score:** 79.3/100 · **Band:** A — Now  

**Done means:** A lower-resolution jittered frame is reconstructed into a stable higher-resolution output using complete motion/depth/exposure information, with controlled disocclusion, transparency, reactive content, camera cuts and dynamic-resolution changes.

**Three.js starting point:** Three.js' WebGPU post stack provides MRT, depth, velocity and TRAA building blocks. ThreeNative must close motion-vector coverage, reactive/composition masks, reconstruction, anti-ghosting, disocclusion, dynamic-resolution, history control, quality modes and image-quality validation.

**Critical dependencies:** `GLOB-RUN-003`, `GLOB-RUN-005`, `PostProcessing`, `Substrate`, `VFX`

### Functional Definition-of-Done checklist

#### Inputs and frame contract

1. [ ] **TSR-001** — Accept internal render resolution, output resolution, viewport, jitter, current/previous view-projection, exposure and frame timing through one explicit frame contract.
2. [ ] **TSR-002** — Generate a well-distributed subpixel jitter sequence, apply it only to jittered scene rendering, and expose the non-jittered camera to gameplay/UI/picking.
3. [ ] **TSR-003** — Produce linear HDR color, depth and motion vectors at documented precisions and coordinate conventions.
4. [ ] **TSR-004** — Generate valid motion vectors for rigid meshes, camera motion, instances/batches, skinned meshes, morph targets and transform animation.
5. [ ] **TSR-005** — Define and test motion-vector support/fallback for vertex/TSL deformation, particles, ribbons, water, foliage/wind and Virtual Geometry.
6. [ ] **TSR-006** — Provide reactive and composition/transparency masks—or equivalent confidence metadata—for rapidly changing, translucent, emissive, refractive and post-composited content.
7. [ ] **TSR-007** — Track exposure/pre-exposure so history comparison is stable across automatic-exposure changes.

#### Reprojection and reconstruction

8. [ ] **TSR-008** — Reproject history using motion and depth with consistent velocity conventions and precision at screen edges and large motion.
9. [ ] **TSR-009** — Detect newly revealed/disoccluded pixels using depth, motion divergence and neighborhood information.
10. [ ] **TSR-010** — Reject or reduce stale history for disocclusion, animated shading, invalid velocity, transparency and reactive content.
11. [ ] **TSR-011** — Rectify/clamp history against current-frame neighborhoods in a luminance/chroma space that suppresses ghosting without excessive blur.
12. [ ] **TSR-012** — Reconstruct output-resolution detail from current samples and valid history with a documented spatial filter.
13. [ ] **TSR-013** — Stabilize subpixel edges, specular highlights, alpha-masked foliage and repeating textures without turning motion into persistent smears.
14. [ ] **TSR-014** — Provide configurable final sharpening that does not reintroduce ringing, aliasing or HDR overshoot.
15. [ ] **TSR-015** — Handle history lock/confidence and low-frequency flicker/shading changes rather than blindly accumulating every pixel.

#### Temporal lifecycle and composition

16. [ ] **TSR-016** — Reset/reseed history on camera cuts, teleports, projection discontinuities, renderer/device recreation and incompatible pipeline changes.
17. [ ] **TSR-017** — Resample or safely invalidate history when internal/output resolution or dynamic-resolution scale changes.
18. [ ] **TSR-018** — Handle pause, single-step, slow motion, long frame gaps and background/resume without amplifying stale data.
19. [ ] **TSR-019** — Render UI/text and other designated crisp layers after temporal upscaling, or provide a documented composition path.
20. [ ] **TSR-020** — Define ordering with motion blur, DOF, bloom, tone mapping, distortion, film grain and screenshot/capture supersampling.
21. [ ] **TSR-021** — Support multiple cameras/render targets without sharing or overwriting unrelated histories.

#### Quality tiers, fallback, and diagnostics

22. [ ] **TSR-022** — Provide quality modes controlling history resolution, filter radius, sample count, rejection quality, masks, sharpen and internal scale range.
23. [ ] **TSR-023** — Provide spatial-upscale/TAA/FXAA or native-resolution fallback when temporal inputs/capabilities are unavailable.
24. [ ] **TSR-024** — Visualize motion vectors, current color/depth, reprojected history, disocclusion, rejection/confidence, reactive/composition masks, lock status and final sharpen.
25. [ ] **TSR-025** — Expose input/output resolution, internal scale, valid-history ratio, rejection classes, reset reasons, GPU time per stage and persistent bytes.
26. [ ] **TSR-026** — Detect NaN/Inf velocities, impossible motion magnitudes, uninitialized history and missing required masks in validation builds.

### Candidate repositories and code-reuse plan

**Recommended blend:** Use `pmndrs/upscaler` as the primary WebGPU implementation candidate, fed by Three.js motion/depth/MRT data. Treat FidelityFX and archived renderers as algorithm references, not mandatory runtime dependencies.

| Candidate | Reuse score | Recommended action | License status | Likely requirement coverage | What to borrow | Gaps and caveats |
|---|---:|---|---|---|---|---|
| [pmndrs/upscaler](https://github.com/pmndrs/upscaler) | **97** | Fork/adopt behind `TemporalUpscaler` | ✅ MIT | Temporal upscaling, depth/velocity reprojection, jitter, reactive masks, history and sharpening | WGSL compute stages, bindings, history management, RCAS-like sharpening, examples and quality controls. | Young implementation; pin a commit, add conformance tests and avoid exposing its internal resource layout publicly. |
| [Three.js](https://github.com/mrdoob/three.js) | **95** | Adopt as frame-input foundation | ✅ MIT | MRT velocity/depth, TRAA primitives, jitter, render scale, TSL and WebGPU compute | Use upstream motion vectors and renderer lifecycle rather than rebuilding frame inputs. | Three.js does not itself provide polished TSR-class reconstruction and reactive-mask policy. |
| [AMD FidelityFX SDK](https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK) | **83** | Port/reference selected algorithms | ⚠️ Verify license and third-party notices per pinned file | FSR reconstruction, sharpening, masks, exposure and validation concepts | Study sample ordering, mask semantics, disocclusion logic and test scenes; port only explicitly compatible files. | Large native SDK with mixed third-party material; perform file-level license review and translate HLSL to WGSL/TSL. |
| [0beqz/realism-effects](https://github.com/0beqz/realism-effects) | **75** | Port temporal utilities | ✅ MIT | TRAA, velocity reprojection, history filtering and denoising | History tests, motion-vector consumers and edge/disocclusion heuristics. | Older Three.js integration; use algorithms, not its renderer wiring. |
| [EmbarkStudios/kajiya](https://github.com/EmbarkStudios/kajiya) | **65** | Study only | 🧊 Apache-2.0/MIT; archived | Temporal reconstruction, jitter, denoising and modern render-graph organization | Use as an architecture and shader-quality reference. | Different Rust/Vulkan renderer and archived; unsuitable as a dependency. |

> **Reuse-score meaning:** engineering fit for this ThreeNative feature—not GitHub popularity. It weighs useful requirement coverage, proximity to Three.js/WebGPU/TypeScript, maturity, maintainability and license safety. A high score does not replace benchmark or legal review.

### Open-source integration checklist

1. [ ] Pin and reproduce `pmndrs/upscaler` with the exact Three.js revision used by ThreeNative.
2. [ ] Create a formal frame-input contract for jittered/non-jittered matrices, motion vectors, depth, exposure, transparency and reactive masks.
3. [ ] Add reactive-mask providers for particles, emissive animation, transparency, water and UI before judging image quality.
4. [ ] Build camera-cut, teleport, skinned-motion, disocclusion, thin-geometry and dynamic-resolution regression sequences.
5. [ ] Benchmark native resolution, spatial upscale and temporal upscale at matched output quality and record frame-time/memory deltas.
6. [ ] Keep sharpening, history format and reconstruction kernels replaceable behind a versioned public API.

### Required completion evidence

1. [ ] **TSR-EVID-001** — The image-quality suite covers static fine detail, slow pan, fast pan, rotation, camera translation, disocclusion, thin wires, foliage, specular crawl, animated emissives, particles, water, transparency, skinning and vertex deformation.
2. [ ] **TSR-EVID-002** — Automated captures compare native-resolution reference, spatial upscale, Three.js TRAA baseline and the TemporalUpscaler using approved perceptual/temporal metrics.
3. [ ] **TSR-EVID-003** — Camera cuts, teleport, resize and dynamic-resolution sweeps produce no old-frame flash, black border, resolution mismatch or persistent ghost.
4. [ ] **TSR-EVID-004** — Motion-vector conformance renders analytic known motion and validates direction/magnitude for every promised geometry path.
5. [ ] **TSR-EVID-005** — Benchmark evidence records reconstruction quality and cost across at least three internal scale factors and each promised tier.

### This is **not Done** when

- It is only TAA at native resolution or FSR1-style spatial scaling.
- Static screenshots look sharp but motion/disocclusion ghosts materially.
- Skinned, instanced, particle, water or deformed geometry lacks an explicit velocity policy.
- Camera cuts and resolution changes rely on users manually clearing buffers.
- There is no debug view for rejection, masks and history validity.

### Parity extensions — valuable, but not required for the first Stable release

1. [ ] **[PARITY] TSR-P001** — History resurrection from multiple past frames for recurring occlusion patterns.
2. [ ] **[PARITY] TSR-P002** — Optical-flow or learned reconstruction behind an optional capability tier.
3. [ ] **[PARITY] TSR-P003** — Foveated and variable-rate temporal reconstruction for XR/native backends.

### Primary research references

- [Epic — Temporal Super Resolution](https://dev.epicgames.com/documentation/en-us/unreal-engine/temporal-super-resolution-in-unreal-engine)
- [Three.js — WebGPU post-processing/MRT/velocity](https://threejs.org/manual/en/webgpu-postprocessing.html)
- [Three.js — TRAA node source](https://github.com/mrdoob/three.js/tree/dev/examples/jsm/tsl/display)

<a id="f14"></a>

## F14. Virtual Shadow Maps

**ThreeNative working name:** `VirtualShadows`  

**Effort-impact priority:** **#4 of 20** · **Impact:** 96/100 · **Effort:** 7/10 · **Impact/effort:** 13.7 · **Priority score:** 79.2/100 · **Band:** A — Now  

**Done means:** Directional and local dynamic lights use a unified, demand-paged high-resolution shadow system with cache residency, precise invalidation, scalable soft shadows, deterministic overflow behavior and deep diagnostics.

**Three.js starting point:** Three.js provides conventional shadow maps, light/shadow types, render targets, compute/storage resources and indirect rendering. The virtual address space, page table/pool, demand marking, clipmaps/mips, cache, invalidation, page rendering and visualization are new engine work.

**Critical dependencies:** `GLOB-RUN-001`, `GLOB-RUN-002`, `GLOB-RUN-004`, `VirtualGeometry`, `Volumetrics`, `LayeredMaterials`

### Functional Definition-of-Done checklist

#### Virtual address space and page management

1. [ ] **VSM-001** — Define virtual shadow-map dimensions, page dimensions, page-table encoding, physical page format and per-light virtual layout.
2. [ ] **VSM-002** — Allocate a bounded physical page pool and provide deterministic free-list/eviction behavior under pressure.
3. [ ] **VSM-003** — Mark required pages from visible receiver pixels/depth plus declared coarse consumers such as volumetrics and forward transparency.
4. [ ] **VSM-004** — Deduplicate page requests and update page tables without mandatory full-frame CPU readback.
5. [ ] **VSM-005** — Handle missing pages with a conservative fallback and never sample uninitialized physical memory.
6. [ ] **VSM-006** — Detect and report virtual/physical pool overflow; degrade resolution, evict by policy or fall back without corrupting unrelated lights.
7. [ ] **VSM-007** — Support stable residency across frames and avoid page thrash under smooth camera motion.

#### Directional and local light layouts

8. [ ] **VSM-008** — Implement camera-centered directional-light clipmaps or an equivalent multi-scale virtual projection covering the declared world distance.
9. [ ] **VSM-009** — Choose clipmap level from receiver footprint and provide configurable resolution bias and stable transitions.
10. [ ] **VSM-010** — Implement spot-light virtual maps with screen-footprint-driven mip/LOD selection.
11. [ ] **VSM-011** — Implement point-light omnidirectional layout—cubemap or equivalent—with face/mip selection and seam handling.
12. [ ] **VSM-012** — Support the declared rect/area-light shadow approximation and expose source size/angle controls to filtering.
13. [ ] **VSM-013** — Keep light movement, range/cone/source-size changes and shadow enable/disable synchronized with virtual-map lifetime.

#### Rendering, cache, and invalidation

14. [ ] **VSM-014** — Render only new or invalidated physical pages and batch page rendering to minimize CPU draw submission.
15. [ ] **VSM-015** — Cache valid pages across frames and precisely invalidate overlaps from moved/added/removed casters and moved lights.
16. [ ] **VSM-016** — Track caster bounds tightly and include skinned, morphing and vertex-deformed geometry according to the declared invalidation policy.
17. [ ] **VSM-017** — Separate static and dynamic cached contributions, or provide equivalent behavior that avoids redrawing expensive static geometry for small dynamic changes.
18. [ ] **VSM-018** — Render conventional, instanced/batched and Virtual Geometry casters through compatible page paths.
19. [ ] **VSM-019** — Support opaque and alpha-masked casters; define transparent/translucent shadow policy and lower-tier fallback.
20. [ ] **VSM-020** — Avoid self-shadow acne, peter-panning and precision loss with documented bias/normal-bias/slope strategies suitable for high-resolution pages.

#### Filtering and consumers

21. [ ] **VSM-021** — Provide stable hard shadows and scalable soft/contact-hardening shadows based on directional source angle and local source size.
22. [ ] **VSM-022** — Filter across physical-page boundaries without visible seams and avoid sampling nonresident neighbors unsafely.
23. [ ] **VSM-023** — Expose low-resolution/coarse shadow data for volumetrics, transparency and other arbitrary-position consumers.
24. [ ] **VSM-024** — Use one public shadow configuration/fallback contract for ordinary and Virtual Geometry objects rather than separate incompatible light APIs.
25. [ ] **VSM-025** — Integrate with dynamic resolution, multi-camera rendering and camera cuts without sharing invalid page demand incorrectly.

#### Diagnostics and control

26. [ ] **VSM-026** — Visualize final mask, virtual page address, physical page, clipmap/mip, residency, cache state, invalidations, caster bounds, overdraw and filtering sample count.
27. [ ] **VSM-027** — Expose requested/allocated/cached/new/invalidated/evicted/overflow pages, pool bytes, page render count, caster counts and timings.
28. [ ] **VSM-028** — Identify invalidation cause by light/object/material and allow cache disabling or light isolation for diagnosis.
29. [ ] **VSM-029** — Provide quality controls for pool size, resolution bias, clipmap range, page size if supported, soft-shadow samples and coarse pages.

### Candidate repositories and code-reuse plan

**Recommended blend:** Build Virtual Shadows in-house on Three.js/TSL, porting sparse-page architecture from Timberdoodle and filtering/stabilization from MJP. Use larger engines only as design references.

| Candidate | Reuse score | Recommended action | License status | Likely requirement coverage | What to borrow | Gaps and caveats |
|---|---:|---|---|---|---|---|
| [Sunset-Flock/Timberdoodle](https://github.com/Sunset-Flock/Timberdoodle) | **92** | Port sparse-page algorithms | ✅ Apache-2.0 | Virtual shadow page tables, physical-page allocation, residency and GPU-driven rendering concepts | Page metadata/layout, allocator, feedback/marking, cache invalidation and debug visualization ideas. | Rust/wgpu renderer architecture differs from Three.js; port algorithms and tests rather than importing the engine. |
| [TheRealMJP/Shadows](https://github.com/TheRealMJP/Shadows) | **86** | Port/reference shadow quality | ✅ MIT | Cascades, stabilization, filtering, biasing and shadow quality analysis | Projection fitting, filter kernels, receiver-plane/depth bias and benchmark scenes. | Not a sparse virtual-shadow implementation; combine with the page system rather than treating it as one. |
| [Three.js](https://github.com/mrdoob/three.js) | **83** | Adopt rendering primitives | ✅ MIT | Shadow passes, TSL shadow filters, texture comparison/gather, light integration and materials | Extend upstream hooks for page-backed shadow sampling and custom shadow render lists. | Conventional maps only; paging, residency, dirty tracking and cache policy are ThreeNative work. |
| [Themaister/Granite](https://github.com/Themaister/Granite) | **72** | Study/port utility patterns | ✅ MIT | Render graph, resource lifetime, synchronization and cache architecture | Transient resource planning, dependency tracking and GPU-driven scheduling patterns. | Large Vulkan engine; no direct Three.js integration. |
| [ConfettiFX/The-Forge](https://github.com/ConfettiFX/The-Forge) | **69** | Study native backend patterns | ✅ Apache-2.0 | Cross-platform GPU abstractions, shadow samples and resource management | Use for native backend parity and platform-specific performance lessons. | Too large and architecturally distant to vendor for this feature. |
| [octoon/UnityVSM](https://github.com/octoon/UnityVSM) | **30** | Blocked; study behavior only | ⛔ No usable repository license found | Unity virtual-shadow implementation concepts | Observe debug views and high-level algorithm choices only. | Do not copy source/shaders without explicit permission or a compatible license. |

> **Reuse-score meaning:** engineering fit for this ThreeNative feature—not GitHub popularity. It weighs useful requirement coverage, proximity to Three.js/WebGPU/TypeScript, maturity, maintainability and license safety. A high score does not replace benchmark or legal review.

### Open-source integration checklist

1. [ ] Prototype the page table, physical-page allocator and feedback loop independently of the current shadow renderer.
2. [ ] Port the allocator/invalidation ideas into ThreeNative-owned data structures with bounded queues and deterministic overflow behavior.
3. [ ] Adapt MJP filtering, bias and cascade validation tests to page-backed shadow samples.
4. [ ] Prove directional and local-light layouts, cache invalidation and coarse fallback before optimizing page rendering.
5. [ ] Integrate the sampler through TSL/material hooks without maintaining a permanent private Three.js material fork.
6. [ ] Demonstrate that page selection and submission are GPU-driven or bounded—not a CPU loop over visible pages.

### Required completion evidence

1. [ ] **VSM-EVID-001** — Canonical scenes include detailed sun shadows across large distance, many local lights, alpha foliage, skinned characters, vertex-deformed foliage, moving lights, static architecture and camera cuts.
2. [ ] **VSM-EVID-002** — A static-camera test proves page reuse; a single moving object invalidates only bounded affected pages under the declared policy.
3. [ ] **VSM-EVID-003** — Pool-overflow and constrained-memory tests degrade predictably with no corrupted page-table sampling.
4. [ ] **VSM-EVID-004** — Clipmap/mip transition routes show no persistent seams, large popping, stale shadows or missing contact detail.
5. [ ] **VSM-EVID-005** — Benchmarks separate page marking/allocation, page rendering, cache invalidation and projection/filtering.

### This is **not Done** when

- A high-resolution atlas or cascaded shadow map is called virtual without demand paging.
- All pages redraw every frame or any moving object invalidates the whole world.
- Pool overflow produces corruption or silent missing shadows.
- Virtual Geometry, alpha masking, animation, volumetrics or local lights bypass the unified system.
- There is no page/cache/invalidation visualization.

### Parity extensions — valuable, but not required for the first Stable release

1. [ ] **[PARITY] VSM-P001** — GPU-driven page rasterization with visibility-buffer/material bin integration.
2. [ ] **[PARITY] VSM-P002** — Advanced stochastic soft shadows and denoising comparable to high-sample area-light results.
3. [ ] **[PARITY] VSM-P003** — Persistent cross-camera page sharing with provably correct demand and invalidation.

### Primary research references

- [Epic — Virtual Shadow Maps](https://dev.epicgames.com/documentation/en-us/unreal-engine/virtual-shadow-maps-in-unreal-engine)
- [Three.js — PointLightShadow and shadow infrastructure](https://threejs.org/docs/pages/PointLightShadow.html)
- [WebGPU specification](https://gpuweb.github.io/gpuweb/)

<a id="f3"></a>

## F3. Niagara-like GPU VFX and particles

**ThreeNative working name:** `VFX`  

**Effort-impact priority:** **#5 of 20** · **Impact:** 90/100 · **Effort:** 6/10 · **Impact/effort:** 15.0 · **Priority score:** 78.0/100 · **Band:** A — Now  

**Done means:** Developers can define reusable systems made of emitters and modules, simulate them on CPU or GPU, render multiple output types, exchange data with the scene, scale by budget, and diagnose behavior without writing a one-off particle loop.

**Three.js starting point:** Three.js demonstrates WebGPU compute particles, storage buffers, sprites, meshes, linked particles, rain, snow and fluid-particle experiments. The missing product is the system/emitter/module model, data interfaces, serialization, events, lifecycle, scalability, and tooling.

**Critical dependencies:** `GLOB-RUN-001`, `GLOB-RUN-002`, `GLOB-RUN-004`, `PostProcessing`, `Substrate`, `PhysicsSuite`

### Functional Definition-of-Done checklist

#### System, emitter, and module model

1. [ ] **VFX-001** — Define versioned `VFXSystem`, `Emitter`, `Module`, `ParameterStore`, and `Renderer` assets with stable IDs and deterministic execution order.
2. [ ] **VFX-002** — Provide explicit system, emitter-spawn, emitter-update, particle-spawn, particle-update, event, and render phases.
3. [ ] **VFX-003** — Provide typed particle attributes and user/system/emitter parameters with defaults, namespaces, validation, and compile-time or build-time layout generation.
4. [ ] **VFX-004** — Allow modules to be composed, reordered, enabled, parameterized, inherited, and reused without copying shader source.
5. [ ] **VFX-005** — Provide a documented extension API for custom CPU modules, TSL/WGSL GPU modules, renderer modules, and scene data interfaces.
6. [ ] **VFX-006** — Serialize systems to a diffable format and include migrations for module/attribute schema changes.

#### Simulation

7. [ ] **VFX-007** — Support rate, burst, event-driven, distance-traveled, and externally commanded spawning with deterministic seed control.
8. [ ] **VFX-008** — Support lifetime, age, position, velocity, acceleration, orientation, angular velocity, scale, color, custom attributes, and normalized-age curves.
9. [ ] **VFX-009** — Provide gravity, drag, curl/vector noise, vortices, attractors, kill volumes, vector fields, and curve/gradient sampling modules.
10. [ ] **VFX-010** — Support CPU simulation for small/event-heavy systems and GPU compute simulation for high-count systems under one authoring contract.
11. [ ] **VFX-011** — Compact alive particles and generate draw/dispatch counts on GPU without mandatory CPU readback on the GPU path.
12. [ ] **VFX-012** — Support fixed-step or bounded-substep simulation and define pause, time dilation, rewind/seek, and large-delta behavior.
13. [ ] **VFX-013** — Implement collisions against scene depth and at least one off-screen-capable representation such as SDFs, simplified colliders, or the physics scene.
14. [ ] **VFX-014** — Support collision events, death events, spawn-from-event/subemitters, and bounded event buffers with overflow diagnostics.
15. [ ] **VFX-015** — Provide data interfaces for transforms, skeletal sockets/bones, textures, curves, audio parameters, physics fields, and user buffers where supported.

#### Rendering

16. [ ] **VFX-016** — Provide sprite/billboard, mesh, ribbon/trail, and point/line renderers with documented backend support.
17. [ ] **VFX-017** — Support additive, alpha, premultiplied, masked and opaque rendering, soft-particle depth fading, flipbooks, and per-particle material inputs.
18. [ ] **VFX-018** — Support correct sorting modes or order-independent/depth-binned alternatives with explicit cost and fallback behavior.
19. [ ] **VFX-019** — Generate conservative bounds on CPU/GPU, cull systems/emitters, and allow fixed bounds for effects whose GPU bounds are not read back.
20. [ ] **VFX-020** — Integrate motion vectors, shadows, post-processing masks, volumetric injection, lighting, and Dynamic GI emission according to an explicit renderer support matrix.
21. [ ] **VFX-021** — Support per-system LOD/scalability rules for spawn rate, particle budget, simulation rate, renderer substitution, distance, visibility, and platform tier.

#### Lifecycle, tooling, and safety

22. [ ] **VFX-022** — Pool particle buffers and system instances; stop/restart/destroy must not retain live particles, events, or GPU resources.
23. [ ] **VFX-023** — Enforce declared particle/event/buffer limits and degrade by deterministic dropping, LOD, or pause rather than memory growth.
24. [ ] **VFX-024** — Provide live inspection of attributes, spawn counts, alive/dead counts, bounds, event traffic, selected-particle traces, and module timings.
25. [ ] **VFX-025** — Provide authoring-time compile/validation errors that map shader/runtime failures back to the responsible module and pin/parameter.
26. [ ] **VFX-026** — Support system warm-up/pre-roll and shader/pipeline prewarming to avoid visible first-use stalls.

### Candidate repositories and code-reuse plan

**Recommended blend:** Run a bake-off: likely use `three-particles` for the WebGPU runtime and `three.quarks` for its mature effect schema/editor concepts, while keeping the serialized ThreeNative VFX asset independent from either library.

| Candidate | Reuse score | Recommended action | License status | Likely requirement coverage | What to borrow | Gaps and caveats |
|---|---:|---|---|---|---|---|
| [aiira-co/three-particles](https://github.com/aiira-co/three-particles) | **95** | Evaluate, then fork/adopt GPU runtime | ✅ MIT | TSL compute simulation, indirect rendering, ribbons, curves, soft particles, depth collision and provider graph | GPU particle buffers, emission/update kernels, renderer variants, ribbon history, curve/gradient representation and VFX registry. | Newer project; validate scale, device loss, determinism, memory bounds, API stability and non-demo workloads. |
| [Alchemist0823/three.quarks](https://github.com/Alchemist0823/three.quarks) | **93** | Adopt/port authoring and asset model | ✅ MIT | Emitters, behaviors, render modes, batching, JSON loading, Unity import, React wrappers and visual editor | Serializable effect schema, module vocabulary, editor UX, batching model and plugin system. | Primary mature path is not yet fully WebGPU compute; avoid coupling the ThreeNative runtime to its CPU simulation. |
| [creativelifeform/three-nebula](https://github.com/creativelifeform/three-nebula) | **79** | Port stable abstractions selectively | ✅ MIT | Emitter/initializer/behavior architecture and long-lived Three.js particle API | Naming, composition model, pooling and established behavior semantics. | CPU/WebGL heritage and older architecture; use as a compatibility/reference layer, not the high-end runtime. |
| [Three.js](https://github.com/mrdoob/three.js) | **91** | Adopt GPU foundation | ✅ MIT | TSL compute, storage buffers, indirect draws, depth access, node materials and official GPU VFX examples | Use upstream compute/buffer/material facilities and examples as conformance seeds. | No Niagara-like effect asset, module graph, budgeting or editor contract. |

> **Reuse-score meaning:** engineering fit for this ThreeNative feature—not GitHub popularity. It weighs useful requirement coverage, proximity to Three.js/WebGPU/TypeScript, maturity, maintainability and license safety. A high score does not replace benchmark or legal review.

### Open-source integration checklist

1. [ ] Benchmark `three-particles` and `three.quarks` with identical smoke, sparks, ribbon and mesh-particle effects at target counts.
2. [ ] Define a versioned ThreeNative VFX asset schema before choosing the runtime implementation.
3. [ ] Build importers/adapters from Quarks JSON and any selected upstream schema into the ThreeNative asset.
4. [ ] Keep spawn, simulation and render modules pluggable so CPU fallback and native compute can share effect assets.
5. [ ] Port deterministic seeds, bounded allocation, overflow policy, camera-cut handling and device-loss restoration tests.
6. [ ] Verify every editor/runtime dependency separately; do not require the editor package in shipped applications.

### Required completion evidence

1. [ ] **VFX-EVID-001** — Examples cover fire/smoke, rain, snow, sparks with collision, a mesh-particle swarm, ribbons, a subemitter explosion, and an effect attached to an animated skeleton.
2. [ ] **VFX-EVID-002** — The stress scene reaches the declared particle target while reporting stable memory and no CPU readback dependency on the GPU path.
3. [ ] **VFX-EVID-003** — Seeded CPU simulations replay identically; GPU simulations meet documented tolerance and reset identically from their initial state.
4. [ ] **VFX-EVID-004** — Overflow tests prove bounded behavior for particles, events, lights, sorting, and collision queries.
5. [ ] **VFX-EVID-005** — A custom module and custom data-interface example build outside the ThreeNative core package.

### This is **not Done** when

- The engine merely wraps `Points` or ships several unrelated effect classes.
- High-count simulation reads particle state back to the CPU every frame.
- Effects cannot be serialized, parameterized, pooled, or debugged.
- Only sprites work; mesh/ribbon output and events are absent.
- Particle counts, event queues, sorting, or buffers can grow without a hard budget.

### Parity extensions — valuable, but not required for the first Stable release

1. [ ] **[PARITY] VFX-P001** — Grid-based 2D/3D gas, smoke, fire and shallow-water simulation integrated into the same authoring model.
2. [ ] **[PARITY] VFX-P002** — Visual graph editor with live node preview and stack inheritance UI.
3. [ ] **[PARITY] VFX-P003** — Deterministic GPU event replay across different GPU vendors.

### Primary research references

- [Epic — Niagara overview](https://dev.epicgames.com/documentation/en-us/unreal-engine/overview-of-niagara-effects-for-unreal-engine)
- [Epic — Niagara Fluids](https://dev.epicgames.com/documentation/en-us/unreal-engine/niagara-fluids-in-unreal-engine)
- [Three.js — WebGPU compute particles](https://threejs.org/examples/webgpu_compute_particles.html)
- [Three.js — linked-particle VFX](https://threejs.org/examples/webgpu_tsl_vfx_linkedparticles.html)

<a id="f17"></a>

## F17. Nanite-like virtualized geometry

**ThreeNative working name:** `VirtualGeometry`  

**Effort-impact priority:** **#6 of 20** · **Impact:** 100/100 · **Effort:** 8–9/10 · **Impact/effort:** 11.8 · **Priority score:** 77.5/100 · **Band:** B — Strategic  

**Done means:** High-detail static geometry is preprocessed into a hierarchical cluster representation, selected and culled on GPU by projected error, submitted indirectly, streamed under a memory budget, and rendered consistently into all required passes with documented fallbacks.

**Three.js starting point:** Three.js provides storage/compute resources, `BatchedMesh`, indirect draw buffers and the conventional raster pipeline. Meshoptimizer supplies mature MIT-licensed meshlet, bounds, simplification, clustered LOD and compression building blocks. ThreeNative must still own the runtime asset, hierarchy, traversal, HZB occlusion, submission, residency, materials, pass integration and diagnostics.

**Critical dependencies:** `GLOB-ASSET-001`, `GLOB-RUN-001`, `GLOB-RUN-002`, `GLOB-RUN-004`, `LayeredMaterials`, `VirtualShadows`, `WorldPartition`, `VirtualTexturing`

### Functional Definition-of-Done checklist

#### Offline geometry build

1. [ ] **VGEO-001** — Accept validated indexed static meshes and preserve submesh/material assignments, UVs, normals/tangents, colors and required custom attributes.
2. [ ] **VGEO-002** — Optimize/weld source topology according to explicit seam/border/material rules before clustering.
3. [ ] **VGEO-003** — Partition triangles into bounded meshlets/clusters with compact vertex and micro-index references.
4. [ ] **VGEO-004** — Compute per-cluster bounds, normal cones or equivalent backface-culling data, material range and geometric error.
5. [ ] **VGEO-005** — Build a multi-level cluster hierarchy or DAG whose parent approximations cover child geometry.
6. [ ] **VGEO-006** — Preserve crack-free boundaries or provide a proven stitching/skirt/morph strategy across independently selected neighboring clusters.
7. [ ] **VGEO-007** — Use screen/projected-error-compatible simplification metrics and preserve locked borders, silhouettes and material seams according to settings.
8. [ ] **VGEO-008** — Quantize/compress cluster geometry and metadata with documented precision/error and independently decodable streaming pages.
9. [ ] **VGEO-009** — Package hierarchy roots and coarse fallback geometry separately from fine pages so an asset remains renderable before full residency.
10. [ ] **VGEO-010** — Produce deterministic, versioned build output, validation reports and cache keys from source/settings/tool/platform hashes.
11. [ ] **VGEO-011** — Reject or route unsupported topology/material/deformation to a conventional mesh/LOD path with object-level diagnostics.

#### GPU visibility and LOD selection

12. [ ] **VGEO-012** — Traverse cluster hierarchy on GPU or in another demonstrably scalable GPU-driven form without per-cluster CPU draw submission.
13. [ ] **VGEO-013** — Select clusters by projected geometric error using viewport resolution, projection and configurable quality bias.
14. [ ] **VGEO-014** — Perform cluster frustum, distance/error, backface/cone and instance visibility culling.
15. [ ] **VGEO-015** — Build/use a hierarchical Z buffer or equivalent occlusion representation and cull clusters/instances conservatively.
16. [ ] **VGEO-016** — Handle previous-frame occlusion uncertainty, camera cuts, newly visible geometry and fast motion without permanent false occlusion.
17. [ ] **VGEO-017** — Compact visible clusters and generate indirect draw arguments or an equivalent bounded GPU submission stream.
18. [ ] **VGEO-018** — Enforce visible-cluster/command-buffer limits and recover through coarser LOD or segmented submission instead of overflow corruption.
19. [ ] **VGEO-019** — Support multiple views/cameras intentionally and prevent one view's selection buffers from corrupting another.

#### Rendering and material integration

20. [ ] **VGEO-020** — Render selected clusters with correct vertex attributes, transforms, negative-scale/winding policy and material IDs.
21. [ ] **VGEO-021** — Support many instances of one virtual-geometry asset without duplicating geometry pages.
22. [ ] **VGEO-022** — Integrate with Layered Materials and define whether shading uses standard draws, material bins, visibility buffer or a hybrid.
23. [ ] **VGEO-023** — Render compatible depth/prepass, beauty, object ID/picking, motion-vector, Virtual Shadow and Dynamic GI scene-representation variants.
24. [ ] **VGEO-024** — Generate correct current/previous transforms and motion vectors for moving instances.
25. [ ] **VGEO-025** — Support opaque and alpha-masked materials according to the declared matrix; route translucency/additive surfaces to a conventional path.
26. [ ] **VGEO-026** — Define support/fallback for skinned meshes, morph targets, vertex displacement, two-sided foliage, decals and runtime topology changes.
27. [ ] **VGEO-027** — Maintain stable picking/selection metadata from cluster triangle back to source asset/submesh/object where promised.

#### Streaming and residency

28. [ ] **VGEO-028** — Request missing pages from selected hierarchy traversal without blocking the frame.
29. [ ] **VGEO-029** — Prioritize roots, visible error reduction, camera motion, shadow/GI consumers, cell importance and starvation age.
30. [ ] **VGEO-030** — Maintain a bounded geometry-page cache with refcounts, in-flight state, cancellation, eviction and device-loss restoration.
31. [ ] **VGEO-031** — Render the best resident ancestor while fine pages load; never produce a geometry hole from a missing page.
32. [ ] **VGEO-032** — Prefetch likely child/neighbor pages and avoid oscillating residency near LOD thresholds.
33. [ ] **VGEO-033** — Share page packaging/scheduling conventions with World Partition and the common residency manager.
34. [ ] **VGEO-034** — Invalidate affected shadow/GI caches when finer geometry residency materially changes their required representation.

#### Diagnostics and validation

35. [ ] **VGEO-035** — Visualize cluster boundaries, hierarchy/LOD level, geometric error, frustum/cone/occlusion reason, overdraw, resident/missing pages, instance IDs and fallback objects.
36. [ ] **VGEO-036** — Expose source/rendered triangles, clusters tested/visible, hierarchy nodes visited, occlusion results, indirect commands, requested/resident/evicted pages, cache bytes and per-stage GPU time.
37. [ ] **VGEO-037** — Provide offline reports for simplification error, cluster fill, compression ratio, hierarchy depth, page locality, material fragmentation and unsupported features.
38. [ ] **VGEO-038** — Detect cracks, invalid bounds/cones, hierarchy coverage errors, out-of-range indices, page checksum failures and indirect-buffer overflow in validation builds.

### Candidate repositories and code-reuse plan

**Recommended blend:** Adopt meshoptimizer for the offline pipeline, port the core hierarchy/culling ideas from `nanite-webgpu`, use Three.js indirect rendering, and borrow streaming/cache concepts from 3D Tiles. ThreeNative must own the asset format and runtime.

| Candidate | Reuse score | Recommended action | License status | Likely requirement coverage | What to borrow | Gaps and caveats |
|---|---:|---|---|---|---|---|
| [Scthe/nanite-webgpu](https://github.com/Scthe/nanite-webgpu) | **97** | Fork/port the prototype core | ✅ MIT | Meshlet hierarchy, LOD selection, culling, quantization, software rasterization and debug tooling | Offline hierarchy construction, cluster data layout, compute traversal, impostor/LOD logic and validation views. | Research prototype; missing production streaming, broad material/pass integration, robust queues and platform abstraction. |
| [zeux/meshoptimizer](https://github.com/zeux/meshoptimizer) | **99** | Adopt offline/runtime utilities | ✅ MIT | Meshlets, simplification, clustered LOD, vertex/index compression, bounds and optimization | Use directly in the asset builder and decode path; retain upstream tests and attribution. | Does not provide a scene renderer, residency manager or Nanite traversal by itself. |
| [gkjohnson/three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) | **92** | Adopt for acceleration and validation | ✅ MIT | BVH construction, ray queries, refit, GPU/WebGPU experiments, picking and geometry validation | Use for picking/fallback queries, offline validation, GI/path-tracing integration and possibly software visibility. | BVH is complementary to meshlet hierarchy; do not conflate the two structures. |
| [NASA-AMMOS/3DTilesRendererJS](https://github.com/NASA-AMMOS/3DTilesRendererJS) | **84** | Port/adopt residency concepts | ✅ Apache-2.0 | Hierarchical traversal, screen-space error, request scheduling, cache, cancellation and plugins | Use streaming state machine, request priority, fallback-to-ancestor behavior and diagnostics. | 3D Tiles semantics differ from meshlet pages; adapt the scheduler rather than exposing tiles as virtual geometry. |
| [seanhlewis/three-meshlet](https://github.com/seanhlewis/three-meshlet) | **45** | Blocked for copying; study API/demo | ⛔ Package references a missing repository license | Three.js meshlet generation and Nanite-style demo | Observe public API shape and test scenarios only until relicensed. | No license file was present despite package metadata saying to consult one; public source is not permission to copy. |
| [EmbarkStudios/kajiya](https://github.com/EmbarkStudios/kajiya) | **67** | Study only | 🧊 Apache-2.0/MIT; archived | GPU-driven rendering, visibility, resource management and modern frame architecture | Use as a design reference for work queues, indirect execution and diagnostics. | Archived and non-Three renderer; avoid dependency or wholesale port. |

> **Reuse-score meaning:** engineering fit for this ThreeNative feature—not GitHub popularity. It weighs useful requirement coverage, proximity to Three.js/WebGPU/TypeScript, maturity, maintainability and license safety. A high score does not replace benchmark or legal review.

### Open-source integration checklist

1. [ ] Integrate meshoptimizer into a deterministic asset build that emits clusters, hierarchy, error metrics, compressed pages and validation reports.
2. [ ] Reproduce `nanite-webgpu` traversal/culling independently, then port it to ThreeNative-owned buffers and TSL/WGSL kernels.
3. [ ] Prove compute-generated indirect submission with no per-cluster CPU draw loop.
4. [ ] Design page IDs, ancestor fallback, request priority, cancellation and eviction before adding network/disk streaming.
5. [ ] Integrate depth, motion, shadow, picking and GI passes before claiming beauty rendering is representative.
6. [ ] Keep conventional mesh fallback for unsupported deformation, translucency and capability tiers.
7. [ ] Do not copy from `three-meshlet` until a compatible license is present and pinned.

### Required completion evidence

1. [ ] **VGEO-EVID-001** — Canonical assets include scanned/photogrammetry geometry, modular architecture with seams, many materials, dense repeated props, thin features and large continuous surfaces.
2. [ ] **VGEO-EVID-002** — Scripted near-to-far and grazing-angle camera paths show no cracks, missing clusters, unstable LOD thrash or permanent occlusion holes.
3. [ ] **VGEO-EVID-003** — A residency-constrained and network-latency simulation proves coarse-ancestor fallback and bounded memory.
4. [ ] **VGEO-EVID-004** — All required passes—beauty, depth, shadow, motion, picking and GI representation—are visually/functionally compared with the conventional source mesh.
5. [ ] **VGEO-EVID-005** — GPU-driven evidence demonstrates no per-cluster CPU draw loop and records traversal, culling, submission and raster costs.
6. [ ] **VGEO-EVID-006** — Offline build determinism, corruption handling and incremental cache behavior pass in CI.

### This is **not Done** when

- The feature is only automatic discrete LOD generation.
- Clusters are built but selected or submitted one-by-one from CPU.
- Occlusion, streaming, indirect limits or missing-page behavior are absent.
- Beauty rendering works while shadows, velocity, picking or GI fall back incorrectly.
- Unsupported deforming/translucent geometry silently disappears instead of using conventional fallback.

### Parity extensions — valuable, but not required for the first Stable release

1. [ ] **[PARITY] VGEO-P001** — Skinned/deformable virtual geometry with bounded cluster deformation and acceleration updates.
2. [ ] **[PARITY] VGEO-P002** — Visibility-buffer shading and material binning optimized for very high material/cluster counts.
3. [ ] **[PARITY] VGEO-P003** — Native mesh-shader path while preserving compute+indirect behavior on WebGPU.

### Primary research references

- [Epic — Nanite Virtualized Geometry](https://dev.epicgames.com/documentation/en-us/unreal-engine/nanite-virtualized-geometry-in-unreal-engine)
- [Three.js — IndirectStorageBufferAttribute](https://threejs.org/docs/pages/IndirectStorageBufferAttribute.html)
- [Three.js — BufferGeometry indirect drawing](https://threejs.org/docs/pages/BufferGeometry.html)
- [meshoptimizer — meshlets, clustered LOD and compression](https://github.com/zeux/meshoptimizer)

<a id="f13"></a>

## F13. Substrate-like layered materials

**ThreeNative working name:** `LayeredMaterials`  

**Effort-impact priority:** **#7 of 20** · **Impact:** 91/100 · **Effort:** 6–7/10 · **Impact/effort:** 14.0 · **Priority score:** 77.2/100 · **Band:** B — Strategic  

**Done means:** Artists and code can compose physically meaningful material lobes through horizontal mixing and vertical layering; the compiler preserves energy behavior, simplifies by platform tier, and emits consistent results for every render pass.

**Three.js starting point:** Three.js TSL and `MeshPhysicalNodeMaterial` already expose programmable node shading and lobes such as clearcoat, sheen, anisotropy, iridescence, transmission and dispersion. ThreeNative must add a first-class layered-BSDF model, compiler rules, asset instances/functions, pass parity, simplification and material diagnostics.

**Critical dependencies:** `GLOB-RUN-001`, `GLOB-RUN-005`, `PostProcessing`, `VirtualShadows`, `DynamicGI`, `PathTracer`

### Functional Definition-of-Done checklist

#### Material graph and asset model

1. [ ] **MAT-001** — Define versioned material graph, material function and material instance assets with typed pins, stable IDs, parameters, defaults and migrations.
2. [ ] **MAT-002** — Represent surface response as composable BSDF/lobe closures rather than only final color/roughness scalar overrides.
3. [ ] **MAT-003** — Support horizontal mixing by physical coverage/weight and vertical layering with top/bottom media semantics.
4. [ ] **MAT-004** — Support per-layer normals, tangent frame, roughness, thickness, absorption/transmittance and optional displacement inputs.
5. [ ] **MAT-005** — Validate graph types, illegal cycles, incompatible domains/blend modes, undefined derivatives and unsupported tier combinations before runtime.
6. [ ] **MAT-006** — Support reusable functions/subgraphs, parameter collections and instance overrides without recompiling unrelated material topology.
7. [ ] **MAT-007** — Provide a TypeScript/TSL builder and a serializable graph representation; a visual editor may consume the same model.

#### Required material capabilities

8. [ ] **MAT-008** — Implement dielectric diffuse/specular and conductor/metal response with physically documented index-of-refraction/F0 mapping.
9. [ ] **MAT-009** — Implement clearcoat, sheen/fuzz, anisotropy, iridescence/thin-film and emissive lobes.
10. [ ] **MAT-010** — Implement thin and volumetric transmission/refraction with thickness, absorption and dispersion policy.
11. [ ] **MAT-011** — Implement subsurface scattering or a documented scalable approximation for skin/wax-like materials.
12. [ ] **MAT-012** — Support unlit, opaque, alpha-masked, transparent/premultiplied and additive domains with explicit lobe restrictions.
13. [ ] **MAT-013** — Support normal, bump/parallax or displacement inputs with correct tangent/derivative behavior and explicit Virtual Geometry compatibility.
14. [ ] **MAT-014** — Support texture sampling, UV transforms/sets, triplanar/world projections, vertex data, object/world/camera data and time/animation inputs.
15. [ ] **MAT-015** — Support decals/material layers or an equivalent mechanism for localized surface modification.

#### Physical correctness and compiler

16. [ ] **MAT-016** — Conserve energy across lobes/layers within documented approximations and prevent arbitrary mixes from exceeding plausible reflected/transmitted energy.
17. [ ] **MAT-017** — Compile/optimize constant branches, unused lobes, repeated expressions and compatible layer operations.
18. [ ] **MAT-018** — Generate stable shader/pipeline keys and cache variants; parameter-only changes must not cause topology recompilation.
19. [ ] **MAT-019** — Estimate material complexity before shipping and simplify/collapse lobes by quality tier according to explicit rules.
20. [ ] **MAT-020** — Produce defined fallback materials for unsupported graphs without rendering black, pink, NaN or silently wrong output.
21. [ ] **MAT-021** — Preserve physically equivalent results as closely as practical across WebGPU and native shader backends.

#### Pass and system integration

22. [ ] **MAT-022** — Emit consistent variants for beauty/depth, alpha mask, shadow, motion vectors, object ID/picking, reflection/GI capture and path tracing.
23. [ ] **MAT-023** — Expose the parameters/closures required by Dynamic GI, reflections, Virtual Shadows, volumetrics and many-light evaluation without reimplementing material logic in each subsystem.
24. [ ] **MAT-024** — Generate previous-frame deformation inputs where the graph modifies position and the geometry path promises motion vectors.
25. [ ] **MAT-025** — Import glTF PBR materials and supported extensions into equivalent graphs/instances, retaining unsupported metadata for diagnostics.
26. [ ] **MAT-026** — Bake or approximate a layered material into conventional textures/materials for lower tiers and export workflows.
27. [ ] **MAT-027** — Handle hot reload and graph edits with atomic pipeline replacement and no frame using mismatched resource layouts.

#### Diagnostics and validation

28. [ ] **MAT-028** — Visualize individual lobes/layers, normals, roughness, metalness/F0, thickness, transmission, energy sum, complexity and active simplifications.
29. [ ] **MAT-029** — Expose compile time, pipeline count, shader size, texture/sampler count, instruction/estimated cost, render-pass variants and cache hits.
30. [ ] **MAT-030** — Provide standard material validation scenes including furnace tests, white rooms, calibrated lights, reference spheres and transmission slabs.

### Candidate repositories and code-reuse plan

**Recommended blend:** Use Three.js TSL as the executable material layer, MaterialX as the graph/interchange vocabulary, and permissive production renderers as BRDF/compiler references. ThreeNative owns the supported subset and stable material asset.

| Candidate | Reuse score | Recommended action | License status | Likely requirement coverage | What to borrow | Gaps and caveats |
|---|---:|---|---|---|---|---|
| [Three.js TSL and Node Materials](https://github.com/mrdoob/three.js) | **99** | Adopt as runtime/compiler base | ✅ MIT | Node graph generation, physical node materials, clearcoat, sheen, iridescence, transmission, anisotropy and backend compilation | Build the ThreeNative layer/BSDF compiler on TSL nodes and upstream generally useful hooks. | TSL is a shader language/toolkit, not a complete Substrate-style material asset or layering policy. |
| [AcademySoftwareFoundation/MaterialX](https://github.com/AcademySoftwareFoundation/MaterialX) | **95** | Adopt schema/interchange; map a subset | ✅ Apache-2.0 | Typed material graphs, standard nodes, BSDF vocabulary, serialization and interchange | Use node definitions, type rules, graph validation and document format; translate supported nodes to TSL. | Full MaterialX is larger than a real-time mobile/WebGPU subset; unsupported nodes need explicit diagnostics or baking. |
| [google/filament](https://github.com/google/filament) | **89** | Port/reference BRDF and quality policy | ✅ Apache-2.0 | Production PBR, material compiler, mobile quality tiers, IBL, clear coat, anisotropy, sheen and color pipeline | Use equations, validation scenes, compiler concepts and platform tradeoffs. | C++ engine and its own shading language; port selected math/tests, not the renderer. |
| [BabylonJS/Babylon.js](https://github.com/BabylonJS/Babylon.js) | **84** | Study/port node-material and PBR patterns | ✅ Apache-2.0 | Node Material Editor, graph serialization, broad PBR features and WebGPU production behavior | Borrow editor UX, graph migrations, variant handling and real-time fallback strategies. | Different engine/runtime; avoid introducing a second renderer abstraction. |
| [THREE-CustomShaderMaterial](https://github.com/FarazzShaikh/THREE-CustomShaderMaterial) | **80** | Adopt/port extension seams | ✅ MIT | Extending stock Three materials while preserving lighting, shadows and standard passes | Use its public customization model and tests as inspiration for safe custom material hooks. | GLSL/WebGL-oriented; TSL-native integration still needs a new implementation. |
| [pmndrs/lamina](https://github.com/pmndrs/lamina) | **56** | Study declarative layer API only | 🧊 MIT; archived | Declarative material layers and React-friendly composition | Borrow naming/API ergonomics for simple artistic layers. | Archived and not a physically general BSDF layering system. |

> **Reuse-score meaning:** engineering fit for this ThreeNative feature—not GitHub popularity. It weighs useful requirement coverage, proximity to Three.js/WebGPU/TypeScript, maturity, maintainability and license safety. A high score does not replace benchmark or legal review.

### Open-source integration checklist

1. [ ] Define and version the supported MaterialX/ThreeNative node and BSDF subset before building an editor.
2. [ ] Implement graph validation, cycle detection, type conversion and deterministic serialization independently from UI code.
3. [ ] Compile the same material asset to TSL/WebGPU and every promised native backend through one semantic intermediate representation.
4. [ ] Create furnace, energy-conservation, IBL, transmission, layering and tangent-space tests against Filament/PBRT references.
5. [ ] Provide explicit bake/fallback/error behavior for unsupported nodes and quality tiers.
6. [ ] Preserve a controlled custom-node extension seam without letting user shaders bypass depth, shadow, velocity or path-tracer contracts.

### Required completion evidence

1. [ ] **MAT-EVID-001** — Canonical materials include coated paint, dusty varnished wood, car paint, skin/wax, cloth, brushed metal, glass/liquid, thin film and layered damaged surfaces.
2. [ ] **MAT-EVID-002** — Furnace/energy tests show no unexplained energy gain/loss beyond documented approximations.
3. [ ] **MAT-EVID-003** — Beauty, shadow, velocity, GI/reflection and path-tracer/raster comparison captures agree on masking, normals, emission and deformation.
4. [ ] **MAT-EVID-004** — Tier simplification tests prove predictable fallback rather than shader failure or random lobe loss.
5. [ ] **MAT-EVID-005** — A third-party material function/lobe package proves the extension, serialization and compiler diagnostics contract.

### This is **not Done** when

- It is only a renamed `MeshPhysicalNodeMaterial` with no layer semantics.
- Material behavior differs between beauty, shadow, velocity and GI passes.
- Arbitrary layer mixes create uncontrolled energy gain or NaNs.
- Every parameter change recompiles shaders or creates unbounded variants.
- Unsupported mobile/basic-tier materials silently render incorrectly.

### Parity extensions — valuable, but not required for the first Stable release

1. [ ] **[PARITY] MAT-P001** — Measured material inputs and fitting tools for captured BRDF data.
2. [ ] **[PARITY] MAT-P002** — Spectral rendering or wavelength-aware thin-film/dispersion on selected native paths.
3. [ ] **[PARITY] MAT-P003** — Visual graph editor with material-layer debugging and live cost visualization.

### Primary research references

- [Epic — Substrate materials](https://dev.epicgames.com/documentation/en-us/unreal-engine/overview-of-substrate-materials-in-unreal-engine)
- [Three.js — MeshPhysicalNodeMaterial](https://threejs.org/docs/pages/MeshPhysicalNodeMaterial.html)
- [Three.js — TSL](https://threejs.org/docs/pages/TSL.html)
- [Khronos — glTF 2.0](https://registry.khronos.org/glTF/)

<a id="f16"></a>

## F16. Lumen-like dynamic global illumination and reflections

**ThreeNative working name:** `DynamicGI`  

**Effort-impact priority:** **#8 of 20** · **Impact:** 100/100 · **Effort:** 9–10/10 · **Impact/effort:** 10.5 · **Priority score:** 74.5/100 · **Band:** B — Strategic  

**Done means:** Fully dynamic lights, sky and emissive surfaces produce temporally stable indirect diffuse lighting and rough-to-glossy reflections, including meaningful off-screen contribution and dynamic scene updates, with a software WebGPU path and optional native hardware-RT enhancement.

**Three.js starting point:** Three.js provides SSGI, SSR, light probes, MRT/depth/normals/velocity, TSL, compute and storage resources. These cover screen-space and plumbing pieces, but not a world-space scene/radiance representation, off-screen visibility, cache updates, multi-bounce approximation, unified reflections, large-world streaming or production diagnostics.

**Critical dependencies:** `GLOB-RUN-001`, `GLOB-RUN-002`, `GLOB-RUN-003`, `GLOB-RUN-004`, `LayeredMaterials`, `VirtualShadows`, `WorldPartition`, `PathTracer`

### Functional Definition-of-Done checklist

#### Feature contract and scene representation

1. [ ] **GI-001** — Expose one `DynamicGI` configuration covering diffuse GI and reflections, with independent enable/quality controls and a queryable active implementation.
2. [ ] **GI-002** — Maintain a world-space representation capable of answering off-screen visibility/radiance using probes, surfels, voxels, SDFs, software BVH, surface cache, or a documented hybrid.
3. [ ] **GI-003** — Represent static and dynamic geometry, material albedo/emission/roughness, lights, sky and bounds at the fidelity required by each quality tier.
4. [ ] **GI-004** — Support opaque and alpha-masked geometry; define explicit support/fallback for skinned, morphing, instanced, Virtual Geometry, vertex-deformed and transparent objects.
5. [ ] **GI-005** — Update or invalidate only affected scene/radiance regions when lights, geometry, materials, emission, world cells or quality settings change.
6. [ ] **GI-006** — Partition/clipmap the representation for large worlds and integrate residency with World Partition and the shared resource manager.
7. [ ] **GI-007** — Avoid requiring a complete CPU copy or rebuild of all scene geometry every frame.

#### Diffuse global illumination

8. [ ] **GI-008** — Inject direct-light, sky and emissive radiance into the world-space representation with physically consistent units relative to direct shading.
9. [ ] **GI-009** — Trace/reconstruct first-bounce indirect diffuse lighting using screen-space information first where useful and world-space fallback for off-screen/missed rays.
10. [ ] **GI-010** — Provide at least an approximate multi-bounce response so enclosed scenes do not lose all secondary color propagation.
11. [ ] **GI-011** — Produce indirect sky occlusion/shadowing in interiors and contact regions rather than adding a uniform ambient term.
12. [ ] **GI-012** — Respond to moving lights and emissive surfaces within the documented latency without full cache restart.
13. [ ] **GI-013** — Respond to opening/closing doors, moving occluders, spawned/despawned objects and streamed cells without persistent leaks or black voids.
14. [ ] **GI-014** — Support a controllable update budget and prioritization by camera proximity, visibility, lighting change and cache staleness.
15. [ ] **GI-015** — Define behavior for tiny/bright emissives, thin geometry, backfaces and two-sided foliage so known leak/noise cases are bounded.

#### Reflections

16. [ ] **GI-016** — Provide reflections across the supported roughness range, selecting among screen traces, world-space traces/cache, probes/environment and optional native RT.
17. [ ] **GI-017** — Blend fallback paths without obvious screen-edge holes, black behind-camera regions or double energy.
18. [ ] **GI-018** — Support rough-reflection convolution/importance sampling and temporal reconstruction appropriate to the active representation.
19. [ ] **GI-019** — Reflect dynamic lights, emissive surfaces and moving geometry according to the documented path and latency.
20. [ ] **GI-020** — Respect material normals, roughness, metal/dielectric response, transmission policy and layered-material output.
21. [ ] **GI-021** — Define mirror-like planar/glossy limitations and integrate a planar or native-RT escape hatch where the general path cannot meet quality.

#### Sampling, reconstruction, and composition

22. [ ] **GI-022** — Use temporal reprojection with motion/depth/material validation and reset correctly on cuts, teleports, origin shifts, scale changes and scene-representation resets.
23. [ ] **GI-023** — Apply spatial/temporal denoising that preserves contact detail and moving edges while avoiding persistent trails and boiling.
24. [ ] **GI-024** — Clamp fireflies/outliers without crushing legitimate high-dynamic-range emissive transport.
25. [ ] **GI-025** — Compose direct lighting, indirect diffuse, specular/reflections, ambient occlusion, emissive and precomputed/probe fallback without double counting.
26. [ ] **GI-026** — Feed supported translucency and volumetrics with a documented lower-frequency/quality indirect-lighting approximation.
27. [ ] **GI-027** — Support dynamic resolution and reduced GI resolution with stable reconstruction.
28. [ ] **GI-028** — Offer TN-BASIC fallback through light probes/environment, baked data or SSAO/SSGI as declared, preserving the public scene contract.

#### Backend strategy and diagnostics

29. [ ] **GI-029** — Ship a standard-WebGPU path that does not depend on hardware ray-query APIs.
30. [ ] **GI-030** — Allow an optional TN-RT implementation to replace visibility/intersection stages without changing authored scene/material APIs.
31. [ ] **GI-031** — Visualize screen traces, fallback traces, hit/miss distance, world representation, probes/surfels/voxels, radiance cache, update regions, diffuse result, reflection result, history confidence and denoiser inputs.
32. [ ] **GI-032** — Expose rays/samples, screen-hit rate, fallback-hit rate, cache occupancy/age, update work, invalidations, representation bytes and GPU time by stage.
33. [ ] **GI-033** — Identify unsupported geometry/material paths and the exact fallback used for each selected object.
34. [ ] **GI-034** — Provide freeze-cache, disable-screen-trace, disable-world-trace, single-bounce and reference-quality debug switches.

### Candidate repositories and code-reuse plan

**Recommended blend:** Use Three.js screen-space/temporal primitives for the first layer, then port Webgiya’s compute-driven surfel pipeline as the principal off-screen GI candidate. Share `three-mesh-bvh` with path tracing and use a path tracer as the correctness oracle.

| Candidate | Reuse score | Recommended action | License status | Likely requirement coverage | What to borrow | Gaps and caveats |
|---|---:|---|---|---|---|---|
| [jure/webgiya](https://github.com/jure/webgiya) | **98** | Fork/port primary surfel-GI candidate | ✅ MIT | Three.js/WebGPU surfel pool, spatial hash, BVH rays, temporal irradiance, radial-depth visibility and resolve | Port pass sequence, data layouts, surfel allocation/aging, hash-grid build, integration, visibility and debug views. | Research project; needs dynamic-scene robustness, production budgets, materials/lights coverage, fallbacks and API stabilization. |
| [0beqz/realism-effects](https://github.com/0beqz/realism-effects) | **86** | Port screen-space baseline | ✅ MIT | SSGI, SSR, GTAO, temporal denoising and motion-vector infrastructure | Use for GI v1, hybrid fallback, ray marching and reconstruction tests. | Screen-space only cannot satisfy meaningful off-screen lighting or reflection requirements. |
| [gkjohnson/three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) | **95** | Adopt shared software acceleration | ✅ MIT | Scene/mesh BVHs, ray queries, refit and GPU-compatible data paths | Use for browser software rays, dynamic updates, path tracer, GI and reflection visibility. | Scene-scale dynamic acceleration and instancing policy still require ThreeNative integration. |
| [gkjohnson/three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer) | **84** | Adopt as reference/oracle and share code | ✅ MIT | Material/light transport, BVH packing, environment sampling and converged references | Reuse compatible scene packing and generate ground-truth images for GI/reflection tests. | Interactive path tracing is not the shipping GI algorithm; keep frame architectures separate. |
| [EmbarkStudios/kajiya](https://github.com/EmbarkStudios/kajiya) | **69** | Study temporal GI architecture | 🧊 Apache-2.0/MIT; archived | Irradiance cache, temporal sampling, denoising and modern GI frame organization | Use as an algorithm/reference source after reading associated technical material. | Archived, native/Vulkan and architecturally distant. |
| [BabylonJS/Babylon.js](https://github.com/BabylonJS/Babylon.js) | **75** | Study/port WebGPU GI approaches | ✅ Apache-2.0 | Reflective shadow maps, voxel/IBL/SSR-related production integrations and WebGPU resource handling | Borrow quality tiers, debug UX, scene update policy and compatibility lessons. | Avoid copying engine-bound orchestration; verify exact submodule maturity. |

> **Reuse-score meaning:** engineering fit for this ThreeNative feature—not GitHub popularity. It weighs useful requirement coverage, proximity to Three.js/WebGPU/TypeScript, maturity, maintainability and license safety. A high score does not replace benchmark or legal review.

### Open-source integration checklist

1. [ ] Reproduce Webgiya at a pinned commit and capture quality/performance before modifying its algorithms.
2. [ ] Extract scene-BVH, surfel-pool, hash-grid, integration and resolve stages behind ThreeNative render-graph interfaces.
3. [ ] Define dynamic geometry, skinned geometry, material/emissive and light invalidation policy before scaling scene size.
4. [ ] Combine screen-space near-field detail with world-space surfel/probe contribution using explicit confidence and fallback rules.
5. [ ] Port temporal denoising with camera-cut, teleport, disocclusion and moving-light validation.
6. [ ] Generate path-traced references for light leaks, occlusion, emissive lighting, glossy response and off-screen contributors.
7. [ ] Keep browser software-ray and optional native hardware-RT implementations behind the same public capability contract.

### Required completion evidence

1. [ ] **GI-EVID-001** — Canonical scenes include window-lit interiors, opening doors, moving sun/local lights, emissive signs, colored rooms, thin walls, foliage, moving characters, reflective corridors, rough metals and off-screen reflectors.
2. [ ] **GI-EVID-002** — Path-traced reference captures quantify diffuse and reflection error for static checkpoints at each shipping quality tier.
3. [ ] **GI-EVID-003** — Temporal videos—not only stills—cover camera motion, dynamic objects/lights, disocclusion, emissive animation, cuts and world-cell streaming.
4. [ ] **GI-EVID-004** — An off-screen test proves lighting/reflections do not collapse when the contributing object/light leaves the camera view.
5. [ ] **GI-EVID-005** — Leak/noise adversarial scenes cover thin walls, stacked geometry, tiny bright emitters, large empty spaces, enclosed rooms and fast changes.
6. [ ] **GI-EVID-006** — Benchmarks separate scene update, trace, radiance/cache update, diffuse resolve, reflection resolve and denoising, plus representation memory.

### This is **not Done** when

- The feature is only SSAO, SSGI or SSR and loses all contribution outside the current screen.
- Dynamic geometry/light changes require rebaking or rebuilding the whole world.
- Diffuse GI exists but reflections are a separate incompatible system with visible holes.
- Temporal denoising produces persistent trails, boiling, or cut-history flashes in canonical motion tests.
- No path-traced reference, off-screen test, cache visualization or fallback matrix exists.

### Parity extensions — valuable, but not required for the first Stable release

1. [ ] **[PARITY] GI-P001** — Hardware ray-traced hit lighting and acceleration-structure updates on TN-RT platforms.
2. [ ] **[PARITY] GI-P002** — Higher-fidelity translucency, hair and volumetric global illumination.
3. [ ] **[PARITY] GI-P003** — Radiance-field/neural cache implementations behind the same contract.

### Primary research references

- [Epic — Lumen GI and Reflections](https://dev.epicgames.com/documentation/en-us/unreal-engine/lumen-global-illumination-and-reflections-in-unreal-engine)
- [Three.js — SSGI example](https://threejs.org/examples/webgpu_postprocessing_ssgi.html)
- [Three.js — WebGPU post-processing/MRT](https://threejs.org/manual/en/webgpu-postprocessing.html)
- [WebGPU specification](https://gpuweb.github.io/gpuweb/)

<a id="f5"></a>

## F5. Procedural Content Generation framework

**ThreeNative working name:** `PCG`  

**Effort-impact priority:** **#9 of 20** · **Impact:** 80/100 · **Effort:** 5/10 · **Impact/effort:** 16.0 · **Priority score:** 74.0/100 · **Band:** B — Strategic  

**Done means:** A deterministic, inspectable dataflow graph can transform spatial data and metadata into reproducible world content at build time or runtime, with incremental execution, world streaming integration and extensible nodes.

**Three.js starting point:** Three.js supplies geometry, splines, instancing, noise and compute primitives, but no canonical PCG graph, spatial data model, cache/invalidation model, provenance, runtime scheduler, or world-partition bridge.

**Critical dependencies:** `GLOB-ASSET-001`, `GLOB-ASSET-002`, `Mass`, `WorldPartition`, `VirtualGeometry`

### Functional Definition-of-Done checklist

#### Graph and data model

1. [ ] **PCG-001** — Define a versioned directed graph asset with typed pins, nodes, edges, graph inputs/outputs, validation, stable IDs, and deterministic execution order.
2. [ ] **PCG-002** — Define core spatial data types for points, surfaces, meshes, splines, volumes, landscapes/height fields, bounds, collections, and attribute sets.
3. [ ] **PCG-003** — Represent points with transform, bounds/extents, density/weight, seed, color and arbitrary typed metadata.
4. [ ] **PCG-004** — Support graph parameters, overrides, subgraphs, reusable functions/templates, loops/iteration with hard bounds, and conditional execution.
5. [ ] **PCG-005** — Guarantee deterministic seeded output for a pinned engine/tool version, independent of worker scheduling.
6. [ ] **PCG-006** — Track data provenance from output instances back to graph, node, input element and seed.

#### Required node library

7. [ ] **PCG-007** — Provide samplers for surfaces, volumes, splines, grids, textures/masks and existing scene geometry.
8. [ ] **PCG-008** — Provide filters for bounds, density, distance, slope, height, tags, attributes, collision/overlap and custom predicates.
9. [ ] **PCG-009** — Provide transforms for projection, remap, jitter, orient-to-normal/flow, scale/rotation variation, clustering and attribute math.
10. [ ] **PCG-010** — Provide point operations for scatter, prune, relax, merge, difference, union, intersection, partition and deterministic selection.
11. [ ] **PCG-011** — Provide spawn/output nodes for instanced geometry, virtual geometry, regular objects/entities, decals, lights, VFX, spline meshes and custom resources.
12. [ ] **PCG-012** — Provide weighted asset selection, rules by metadata/biome, exclusion zones, minimum spacing, collision policy and per-output tags.
13. [ ] **PCG-013** — Provide a documented custom-node SDK for TypeScript/worker nodes and optional GPU nodes with serialization and validation.

#### Execution, caching, and runtime generation

14. [ ] **PCG-014** — Compile graphs into an execution plan that separates pure/cacheable work, main-thread scene mutation, workers and optional GPU work.
15. [ ] **PCG-015** — Cache node outputs by graph/node/input/settings/tool hashes and invalidate only affected downstream work.
16. [ ] **PCG-016** — Support partial/incremental recomputation when a source spline, volume, parameter, asset, or cell changes.
17. [ ] **PCG-017** — Support offline bake, unbake/rebuild, runtime generation, and hybrid prebuilt-plus-runtime graphs under one asset model.
18. [ ] **PCG-018** — Run expensive graphs asynchronously with time/work budgets, cancellation, progress, priorities and no partially visible output on failure.
19. [ ] **PCG-019** — Partition graph execution and generated output by World Partition cell with stable seeds across load order and neighboring-cell seams.
20. [ ] **PCG-020** — Batch generated rendering, collision and entities rather than creating a React component/object per point.
21. [ ] **PCG-021** — Persist generated-state identity where gameplay needs save/load or removal without serializing the entire generated world.
22. [ ] **PCG-022** — Provide explicit regeneration policy when source assets or graph versions differ from saved/baked data.

#### Authoring and diagnostics

23. [ ] **PCG-023** — Provide a graph authoring path—visual editor, structured JSON/TS builder, or both—that supports inspectable connections and version control.
24. [ ] **PCG-024** — Preview any node's spatial output, points, bounds, attributes, density, seed and rejected elements in the scene.
25. [ ] **PCG-025** — Expose node timing, cache hit/miss, element counts, memory, worker/GPU utilization, generated draw/entity counts and cell ownership.
26. [ ] **PCG-026** — Surface cycles, type mismatches, unbounded expansion, missing assets and nondeterministic custom-node declarations before shipping builds.

### Candidate repositories and code-reuse plan

**Recommended blend:** Assemble PCG from mature graph/editor and procedural primitives: Rete for typed execution concepts, XYFlow for authoring UI, FastNoiseLite for deterministic noise and BVH/CSG libraries for spatial geometry. ThreeNative owns deterministic evaluation, caching, baking and runtime integration.

| Candidate | Reuse score | Recommended action | License status | Likely requirement coverage | What to borrow | Gaps and caveats |
|---|---:|---|---|---|---|---|
| [retejs/rete](https://github.com/retejs/rete) | **91** | Adopt graph/runtime infrastructure | ✅ MIT | Typed node graph, sockets, dataflow/control flow, plugins, serialization and processing | Use graph model, validation, plugin architecture and execution patterns. | Generic editor/runtime; PCG determinism, spatial data types, caching and asset semantics are ThreeNative-specific. |
| [xyflow/xyflow](https://github.com/xyflow/xyflow) | **89** | Adopt authoring canvas | ✅ MIT | Node editor interactions, selection, grouping, minimap, viewport and React UI | Use for the PCG editor surface while storing data in the engine-owned graph format. | UI only; do not make the visual component tree the authoritative execution graph. |
| [Auburn/FastNoiseLite](https://github.com/Auburn/FastNoiseLite) | **97** | Adopt procedural noise library | ✅ MIT | Deterministic cross-language value/Perlin/simplex/cellular/domain-warp noise | Use shared algorithms/seeds across JS/WASM/native backends and add conformance vectors. | Noise is one node family, not a PCG framework. |
| [gkjohnson/three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) | **93** | Adopt spatial-query layer | ✅ MIT | Surface queries, ray casts, shapecasts, nearest-point and acceleration | Use for scatter-on-surface, collision rejection, projection, visibility and bounds operations. | Dynamic world partition and distributed spatial indices still need engine integration. |
| [gkjohnson/three-bvh-csg](https://github.com/gkjohnson/three-bvh-csg) | **82** | Adopt/port geometry operators | ✅ MIT | Fast Boolean/CSG operations over Three.js geometry | Use for optional PCG Boolean/cutting nodes and offline generation. | Potentially expensive and topology-sensitive; keep out of hot runtime paths unless budgeted. |
| [BabylonJS/Babylon.js](https://github.com/BabylonJS/Babylon.js) | **73** | Study node-geometry architecture | ✅ Apache-2.0 | Node Geometry editor/runtime, graph migration and procedural geometry UX | Borrow node taxonomy, previews, serialization/versioning and authoring ergonomics. | Different engine; no direct dependency recommended. |

> **Reuse-score meaning:** engineering fit for this ThreeNative feature—not GitHub popularity. It weighs useful requirement coverage, proximity to Three.js/WebGPU/TypeScript, maturity, maintainability and license safety. A high score does not replace benchmark or legal review.

### Open-source integration checklist

1. [ ] Separate the authoritative PCG graph schema/executor from the XYFlow/Rete editor representation.
2. [ ] Define stable spatial data types, units, coordinate spaces, seeds and deterministic iteration order.
3. [ ] Add FastNoiseLite conformance vectors across JavaScript, WASM and native implementations.
4. [ ] Wrap BVH/CSG operations as budgeted nodes with cancellation, bounds and deterministic output hashes.
5. [ ] Implement dirty-region propagation, incremental cache keys and asset dependency tracking before adding a large node library.
6. [ ] Test offline bake, editor preview and runtime generation from the same graph asset and seed.

### Required completion evidence

1. [ ] **PCG-EVID-001** — Examples generate a forest/biome, road-side placement from splines, modular structure, and runtime cell-local decoration using reusable subgraphs.
2. [ ] **PCG-EVID-002** — The same graph/seed produces matching canonical output hashes across supported platforms and different worker counts.
3. [ ] **PCG-EVID-003** — Editing one local source proves bounded downstream invalidation rather than a full-world rebuild.
4. [ ] **PCG-EVID-004** — World Partition load-order and seam tests produce identical border output with no duplicate or missing instances.
5. [ ] **PCG-EVID-005** — Stress evidence records graph execution, output count, batching, memory, cancellation and cache behavior.

### This is **not Done** when

- Procedural generation is a collection of helper functions with no serializable graph/data model.
- Results change with worker timing or World Partition cell load order.
- Any edit rebuilds the entire world.
- Generated output creates one React/Three object per point at scale.
- There is no provenance/debug preview, build cache, or runtime cancellation.

### Parity extensions — valuable, but not required for the first Stable release

1. [ ] **[PARITY] PCG-P001** — GPU-resident graph execution for large point sets with indirect rendering output.
2. [ ] **[PARITY] PCG-P002** — Grammar, constraint-solving and wave-function-collapse node libraries.
3. [ ] **[PARITY] PCG-P003** — Collaborative visual graph editor with node diff/merge support.

### Primary research references

- [Epic — PCG overview](https://dev.epicgames.com/documentation/en-us/unreal-engine/procedural-content-generation-overview)
- [Epic — PCG framework](https://dev.epicgames.com/documentation/en-us/unreal-engine/procedural-content-generation-framework-in-unreal-engine)
- [Three.js — InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html)
- [Three.js — BatchedMesh](https://threejs.org/docs/pages/BatchedMesh.html)

<a id="f9"></a>

## F9. Motion Matching

**ThreeNative working name:** `MotionMatching`  

**Effort-impact priority:** **#10 of 20** · **Impact:** 84/100 · **Effort:** 6/10 · **Impact/effort:** 14.0 · **Priority score:** 73.8/100 · **Band:** C — Next  

**Done means:** A runtime query built from desired trajectory and current pose selects high-quality poses from a preprocessed animation database, blends them without visible discontinuity, preserves contacts/root motion, and can be inspected and tuned.

**Three.js starting point:** Three.js supplies skeletal clips, mixers, keyframes and interpolation. The feature database, extraction schema, search/index, costs, transition logic, inertialization, trajectory integration, contacts, retargeting and diagnostics must be built.

**Critical dependencies:** `GLOB-ASSET-002`, `Sequencer`, `ControlRig`, `Mass`

### Functional Definition-of-Done checklist

#### Animation ingest and database build

1. [ ] **MM-001** — Validate skeleton compatibility, sample rate, root-motion conventions, clip metadata and required joints when importing source animations.
2. [ ] **MM-002** — Define versioned feature schemas containing pose features, trajectory features, contact/phase data, tags and cost weights.
3. [ ] **MM-003** — Extract configurable joint positions, velocities, rotations and angular velocities in a documented local/root/facing space.
4. [ ] **MM-004** — Extract past/future trajectory positions, facing directions and optionally velocity/curvature at configurable time horizons.
5. [ ] **MM-005** — Extract foot/hand contacts, gait/phase, locomotion speed, slope or authored semantic metadata where requested.
6. [ ] **MM-006** — Normalize feature dimensions and weights so incompatible units do not dominate search accidentally.
7. [ ] **MM-007** — Build deterministic pose databases with source clip/frame provenance and cache them by animation/schema/tool hashes.
8. [ ] **MM-008** — Provide exact/brute-force search for correctness and at least one accelerated index such as PCA plus KD-tree/VP-tree/clustered search for scale.
9. [ ] **MM-009** — Measure and report index recall/quality against exact search on the canonical databases.

#### Runtime query, search, and selection

10. [ ] **MM-010** — Build runtime queries from current evaluated pose, controller/player desired trajectory, movement state and active tags.
11. [ ] **MM-011** — Compute a decomposable cost with pose, trajectory, contacts, continuity, transition and authored bias terms.
12. [ ] **MM-012** — Support required/excluded tags, database partitions, clip ranges, cooldowns and transition eligibility.
13. [ ] **MM-013** — Avoid rapid pose thrashing with continuation bias, minimum switch intervals, hysteresis or an equivalent documented policy.
14. [ ] **MM-014** — Throttle search and reuse results by quality tier without breaking animation time or input responsiveness.
15. [ ] **MM-015** — Support switching databases/schemas and fallback clips when no valid candidate exists.
16. [ ] **MM-016** — Make selection deterministic for a given database, query and configuration, including tie-breaking.

#### Playback quality and integration

17. [ ] **MM-017** — Blend selected poses using inertialization or an equivalent velocity-aware transition that suppresses pops.
18. [ ] **MM-018** — Handle root motion, in-place animation and controller-driven motion with an explicit policy and no double application.
19. [ ] **MM-019** — Preserve planted contacts using contact-aware costs plus IK/warping integration; expose foot-lock failures for diagnosis.
20. [ ] **MM-020** — Support play-rate/stride or distance matching so locomotion speed changes do not force visible sliding.
21. [ ] **MM-021** — Handle turns, starts, stops, pivots, jumps/falls/landings and uneven terrain according to the declared database scope.
22. [ ] **MM-022** — Feed Control Rig/IK after pose selection and integrate with Sequencer override/blending rules.
23. [ ] **MM-023** — Provide a scalable crowd path that shares databases and avoids a full expensive search every frame per distant agent.

#### Authoring and diagnostics

24. [ ] **MM-024** — Visualize the current query trajectory, sampled joints, selected pose, candidate poses and source clip frame.
25. [ ] **MM-025** — Expose total and per-channel candidate costs, selected/continuing cost, search time, candidates visited, index recall mode and switch reason.
26. [ ] **MM-026** — Provide offline tools to inspect database coverage, outlier poses, sparse trajectory regions, contact labels and duplicate data.
27. [ ] **MM-027** — Allow live weight/tag tuning and save validated schema changes without corrupting existing database assets.

### Candidate repositories and code-reuse plan

**Recommended blend:** Port OrangeDuck’s matcher/database design, but build a ThreeNative-owned database format and use only properly licensed animation clips. Reuse Three.js playback and three-vrm retargeting.

| Candidate | Reuse score | Recommended action | License status | Likely requirement coverage | What to borrow | Gaps and caveats |
|---|---:|---|---|---|---|---|
| [orangeduck/Motion-Matching](https://github.com/orangeduck/Motion-Matching) | **98** | Port primary algorithm/reference implementation | ✅ MIT code; dataset has separate restrictions | Feature extraction, database construction, search, inertialization, trajectory control and runtime matching | Port matcher math, preprocessing, normalization, search structures, debug tooling and test methodology. | Do not redistribute the example motion dataset without satisfying its separate terms; create/license a ThreeNative test dataset. |
| [Three.js animation system](https://github.com/mrdoob/three.js) | **93** | Adopt playback foundation | ✅ MIT | Animation clips, mixers, tracks, skeletons, morphs, blending and glTF integration | Use for clip playback/output pose and extend only missing low-level pose access. | No matching database, trajectory query, inertialization or authoring pipeline. |
| [pixiv/three-vrm](https://github.com/pixiv/three-vrm) | **89** | Adopt retargeting/humanoid utilities | ✅ MIT | Humanoid bone mapping, normalized rigs, constraints, spring bones and VRM loading | Use retargeting/normalization patterns and runtime humanoid abstraction. | VRM-specific conventions must remain optional; generic skeletons still need support. |
| [google/motive](https://github.com/google/motive) | **77** | Study/port low-level animation math | ✅ Apache-2.0 | Animation blending, compact curves and runtime evaluation | Use as reference for efficient interpolation, blending and memory layout. | C++ library and not a motion matcher. |
| [Nekuzaky/kinema-motion-matching](https://github.com/Nekuzaky/kinema-motion-matching) | **30** | Blocked; study behavior only | ⛔ No usable repository license found | Unity motion-matching workflow and visual behavior | Observe authoring and debugging concepts only. | Do not copy code/assets without explicit compatible licensing. |

> **Reuse-score meaning:** engineering fit for this ThreeNative feature—not GitHub popularity. It weighs useful requirement coverage, proximity to Three.js/WebGPU/TypeScript, maturity, maintainability and license safety. A high score does not replace benchmark or legal review.

### Open-source integration checklist

1. [ ] Pin OrangeDuck’s code and separately inventory every dataset/model asset license.
2. [ ] Create a small redistributable ThreeNative motion dataset that covers locomotion, turns, stops, jumps and uneven speed.
3. [ ] Define the database file format, feature schema, normalization data and versioning independently from the reference code.
4. [ ] Integrate search output with Three.js pose blending, root motion and inertialization without frame allocations.
5. [ ] Validate retargeting on multiple skeleton proportions using three-vrm only as an optional humanoid adapter.
6. [ ] Benchmark query latency, memory, transition quality and determinism at target database sizes.

### Required completion evidence

1. [ ] **MM-EVID-001** — Canonical locomotion scenarios include idle/start/stop, speed changes, strafing, sharp turns, pivots, slopes, stairs/uneven ground and interrupted transitions.
2. [ ] **MM-EVID-002** — Golden selection tests assert chosen source frames and decomposed costs for fixed queries and database versions.
3. [ ] **MM-EVID-003** — Accelerated search meets the approved recall/quality tolerance relative to exact search.
4. [ ] **MM-EVID-004** — Contact metrics quantify foot sliding, penetration and lock discontinuity rather than relying only on subjective video.
5. [ ] **MM-EVID-005** — Crowd and single-character benchmarks record build size/time, query p50/p95, memory, search rate and animation cost.

### This is **not Done** when

- The runtime simply chooses clips from speed/direction thresholds.
- There is no offline pose database, exact-reference search or cost decomposition.
- Pose choice is good in a demo but cannot be reproduced or diagnosed.
- Contacts/root motion visibly slide and there is no measurable acceptance criterion.
- Every crowd agent performs an unrestricted full search every frame.

### Parity extensions — valuable, but not required for the first Stable release

1. [ ] **[PARITY] MM-P001** — Learned embeddings or neural motion matching with deterministic fallback.
2. [ ] **[PARITY] MM-P002** — Motion/pose warping to arbitrary traversal targets and environment constraints.
3. [ ] **[PARITY] MM-P003** — Automatic database coverage recommendations and clip synthesis hooks.

### Primary research references

- [Epic — Motion Matching](https://dev.epicgames.com/documentation/en-us/unreal-engine/motion-matching-in-unreal-engine)
- [Three.js — Animation system](https://threejs.org/manual/en/animation-system.html)
- [Three.js — AnimationMixer](https://threejs.org/docs/pages/AnimationMixer.html)

<a id="f4"></a>

## F4. Water system

**ThreeNative working name:** `Water`  

**Effort-impact priority:** **#11 of 20** · **Impact:** 75/100 · **Effort:** 4/10 · **Impact/effort:** 18.8 · **Priority score:** 73.5/100 · **Band:** C — Next  

**Done means:** Oceans, lakes and rivers share a continuous scalable surface, physically coherent shading, underwater rendering, runtime water queries and physics interaction, instead of being unrelated demo shaders.

**Three.js starting point:** Three.js has water examples/material primitives, reflection/refraction tools, compute, geometry LOD and scene depth. ThreeNative must supply water-body semantics, continuous meshing, optical model, river flow, interaction, queries, buoyancy, streaming and diagnostics.

**Critical dependencies:** `GLOB-RUN-001`, `PostProcessing`, `DynamicGI`, `VirtualShadows`, `WorldPartition`, `PhysicsSuite`

### Functional Definition-of-Done checklist

#### Water-body model and authoring

1. [ ] **WATER-001** — Expose ocean, lake and spline-defined river body types through one versioned API and serializable asset model.
2. [ ] **WATER-002** — Support body elevation, depth, shoreline/boundary shape, priority, exclusion volumes, material profile, wave profile, flow profile, and collision/query settings.
3. [ ] **WATER-003** — Blend connected bodies without visible gaps or double surfaces and define deterministic overlap/priority behavior.
4. [ ] **WATER-004** — Provide spline controls for river width, depth, bank shape, velocity, direction, falloff, and transitions into lakes/oceans.
5. [ ] **WATER-005** — Support bounded custom water zones and multiple disconnected elevations in one world.

#### Surface geometry and LOD

6. [ ] **WATER-006** — Generate a camera-centered or world-partitioned tiled/quadtree surface whose resolution follows screen-space error and wave frequency.
7. [ ] **WATER-007** — Maintain crack-free transitions between LOD levels and between water bodies.
8. [ ] **WATER-008** — Cull tiles outside body boundaries, view, distance, and occlusion constraints; very large oceans must not create world-sized geometry.
9. [ ] **WATER-009** — Handle world-origin shifts, large coordinates, camera crossing the surface, and rapid teleports without gaps or precision explosions.
10. [ ] **WATER-010** — Support displacement from analytic waves and sampled height fields with normals/velocity consistent with the query API.

#### Optics and lighting

11. [ ] **WATER-011** — Implement Fresnel reflection, refraction, roughness, normal detail, absorption, scattering, depth coloration, specular response, and controllable opacity.
12. [ ] **WATER-012** — Use a reflection hierarchy with explicit selection/fallback among screen-space, planar, probe/environment, Dynamic GI reflection, and optional native RT.
13. [ ] **WATER-013** — Avoid screen-edge holes and behind-camera omissions by blending to an off-screen-capable reflection fallback.
14. [ ] **WATER-014** — Implement shoreline and wave-crest foam driven by depth, slope, flow, intersection, or authored masks.
15. [ ] **WATER-015** — Receive direct light and shadows and participate in exposure, fog/volumetrics, tone mapping, and supported reflection/GI paths.
16. [ ] **WATER-016** — Implement underwater post processing with waterline detection, absorption/scattering, distortion, fog, caustic approximation or documented omission, and audio/physics state hooks.
17. [ ] **WATER-017** — Prevent double refraction/fog and define composition behavior for transparent objects, particles and volumetric effects above and below water.

#### Simulation, queries, and physics

18. [ ] **WATER-018** — Expose batched runtime queries for water presence, surface height, depth, normal, velocity/flow, body ID, and temperature/custom metadata.
19. [ ] **WATER-019** — Make query results agree with rendered displacement within the documented tolerance and latency.
20. [ ] **WATER-020** — Provide buoyancy forces/torques for sampled points or hull approximations and integrate with the ThreeNative/Rapier fixed-step clock.
21. [ ] **WATER-021** — Support wakes, ripples, splashes and impact events through a bounded interaction field or VFX bridge.
22. [ ] **WATER-022** — Provide flow sampling suitable for particles, floating debris, swimming, and gameplay without requiring GPU readback per object.
23. [ ] **WATER-023** — Define collision, navmesh, character-controller and camera behavior at water boundaries.

#### Scalability and diagnostics

24. [ ] **WATER-024** — Expose quality controls for mesh density, wave bands, reflection path/resolution, refraction resolution, underwater quality, interaction resolution, and max query count.
25. [ ] **WATER-025** — Provide debug views for body boundaries, tile/LOD levels, depth, flow, displacement, query samples, reflection source, foam and buoyancy forces.
26. [ ] **WATER-026** — Expose tile counts, draw/dispatch counts, reflection cost, query count/latency, interaction occupancy, and memory.

### Candidate repositories and code-reuse plan

**Recommended blend:** Compose the system: use SeedOcean/Poseidon as WebGPU FFT candidates, older FFT implementations as validation references, and interactive water/fluid projects for local waves, caustics and physics. ThreeNative owns water bodies, LOD, queries and integration.

| Candidate | Reuse score | Recommended action | License status | Likely requirement coverage | What to borrow | Gaps and caveats |
|---|---:|---|---|---|---|---|
| [reed-soul/SeedOcean](https://github.com/reed-soul/SeedOcean) | **95** | Fork/evaluate broad ocean stack | ✅ MIT | WebGPU ocean rendering/simulation and modern large-water implementation | Port spectrum generation, FFT stages, displacement/normal output, rendering and debug controls. | Young project; validate code completeness, device limits, shoreline/body abstractions and production lifecycle. |
| [owenyuwono/poseidon](https://github.com/owenyuwono/poseidon) | **93** | Fork/port TSL ocean kernels | ✅ MIT | Three.js/TSL WebGPU FFT ocean with JONSWAP/TMA-style spectra | Use TSL compute implementation, spectral setup, displacement/normal maps and integration patterns. | Prototype scope; does not supply rivers, lakes, buoyancy, shoreline or complete water-body tooling. |
| [jbouny/fft-ocean](https://github.com/jbouny/fft-ocean) | **81** | Port/reference FFT correctness | ✅ MIT | Established FFT ocean pipeline and spectral wave implementation | Use equations, passes and comparison scenes to validate newer compute ports. | Older WebGL implementation and API; not a direct modern dependency. |
| [jeantimex/threejs-water](https://github.com/jeantimex/threejs-water) | **86** | Port local-wave and caustic modules | ✅ MIT | Interactive waves, caustics, refraction/reflection and object-water interaction | Use local height-field updates, caustic generation, collision interaction and visual tests. | Single-pool/demo assumptions; integrate selectively into a scalable body model. |
| [jeantimex/fluid](https://github.com/jeantimex/fluid) | **83** | Port optional fluid kernels | ✅ MIT | WebGPU fluid/SPH or grid simulation experiments | Use compute kernels and debug examples for local fluid effects or parity extensions. | General fluid simulation is not required for ocean/water Stable; isolate cost and API. |
| [Three.js water examples/primitives](https://github.com/mrdoob/three.js) | **89** | Adopt base materials/examples | ✅ MIT | Water meshes, reflections/refractions, flow maps, textures and scene integration | Use upstream loaders/material nodes and compatibility fallback. | No unified ocean/river/lake/physics/LOD system. |

> **Reuse-score meaning:** engineering fit for this ThreeNative feature—not GitHub popularity. It weighs useful requirement coverage, proximity to Three.js/WebGPU/TypeScript, maturity, maintainability and license safety. A high score does not replace benchmark or legal review.

### Open-source integration checklist

1. [ ] Run SeedOcean and Poseidon with identical spectra/resolutions and compare displacement, stability, GPU time and memory.
2. [ ] Choose one canonical spectrum/FFT data contract that can be implemented by TSL/WGSL and native compute backends.
3. [ ] Separate far-ocean simulation from local interactive ripples and fluid effects.
4. [ ] Build water-body, shoreline, LOD and query APIs before exposing implementation-specific textures.
5. [ ] Validate optics, underwater transition, caustics, shadows, GI/reflections and temporal upscaling together.
6. [ ] Connect deterministic height/normal/velocity queries to Rapier buoyancy without GPU readback in the hot path.

### Required completion evidence

1. [ ] **WATER-EVID-001** — Canonical scenes include open ocean, nested lake, winding river joining a lake, waterfall/rapid handoff policy, shoreline, boat buoyancy, underwater camera, moving objects, and fog.
2. [ ] **WATER-EVID-002** — A continuous fly/teleport path shows no cracks, tile holes, reflection discontinuities, stale interaction maps, or waterline flashes.
3. [ ] **WATER-EVID-003** — Automated query tests compare rendered/simulated heights, normals and flow over time within declared tolerances.
4. [ ] **WATER-EVID-004** — Buoyancy tests cover stable floating, partially submerged objects, high speed, sleeping/waking bodies, and body transitions.
5. [ ] **WATER-EVID-005** — The benchmark separates base surface, reflections/refraction, waves, interaction, underwater, and query costs.

### This is **not Done** when

- A single plane shader is presented as the water system.
- Rendered waves and physics/query heights disagree materially.
- Only an ocean works; rivers, lakes, overlaps, and transitions are absent.
- Screen-space reflections disappear with no fallback.
- Underwater, buoyancy, streaming, and debug behavior are missing.

### Parity extensions — valuable, but not required for the first Stable release

1. [ ] **[PARITY] WATER-P001** — FFT ocean spectrum with cascaded wave bands and weather transitions.
2. [ ] **[PARITY] WATER-P002** — Fluid coupling, breaking waves, shoreline erosion, and gameplay-scale shallow-water simulation.
3. [ ] **[PARITY] WATER-P003** — Authoring tools for automatic river carving and terrain/water-body conformance.

### Primary research references

- [Epic — Water Body Actors](https://dev.epicgames.com/documentation/en-us/unreal-engine/water-body-actors-in-unreal-engine)
- [Epic — Water Mesh](https://dev.epicgames.com/documentation/en-us/unreal-engine/water-meshing-system-and-surface-rendering-in-unreal-engine)
- [Three.js — WebGPU water example](https://threejs.org/examples/webgpu_water.html)

<a id="f18"></a>

## F18. MegaLights-like many-light rendering

**ThreeNative working name:** `ManyLights`  

**Effort-impact priority:** **#12 of 20** · **Impact:** 89/100 · **Effort:** 7–8/10 · **Impact/effort:** 11.9 · **Priority score:** 72.8/100 · **Band:** C — Next  

**Done means:** Scenes can contain a product-defined high count of dynamic local/area lights with shadows while per-pixel work remains bounded through clustering and/or stochastic sampling, with stable visibility, temporal reconstruction, fallbacks and transparent performance evidence.

**Three.js starting point:** Three.js now provides Forward+ `ClusteredLighting` for many point lights, with configurable light and per-cluster capacities. ThreeNative must extend this into multiple light shapes, scalable shadow visibility, importance/sampling policy, temporal stability, material/volumetric integration and robust overflow behavior.

**Critical dependencies:** `GLOB-RUN-001`, `GLOB-RUN-002`, `VirtualShadows`, `LayeredMaterials`, `Volumetrics`, `DynamicGI`

### Functional Definition-of-Done checklist

#### Light model and authoring

1. [ ] **ML-001** — Support the declared point, spot, directional and rect/disk/area-light shapes with physically documented intensity/power, range, attenuation and source size.
2. [ ] **ML-002** — Support light layers/channels, groups, priorities, shadow enable/quality, volumetric contribution and GI contribution.
3. [ ] **ML-003** — Support IES profiles, projected textures/cookies and light functions through an atlas/cache or equivalent bounded mechanism.
4. [ ] **ML-004** — Allow dynamic creation, deletion, movement, animation and parameter changes without shader recompilation per light-count change.
5. [ ] **ML-005** — Define a hard maximum, per-cluster/list maximum, shadow budget and overflow policy for every platform tier.

#### Candidate generation and bounded shading

6. [ ] **ML-006** — Partition the view into 3D clusters/tiles or an equivalent structure and assign only intersecting candidate lights.
7. [ ] **ML-007** — Cull lights by bounds, view, layer, range and negligible contribution before expensive visibility/shading.
8. [ ] **ML-008** — Keep candidate generation GPU-driven or otherwise bounded so light movement does not create per-object/per-light CPU combinatorics.
9. [ ] **ML-009** — Handle per-cluster overflow through deterministic top-contribution selection, secondary lists, stochastic sampling or quality degradation—not memory corruption.
10. [ ] **ML-010** — When exact evaluation exceeds the tier budget, importance-sample a bounded number of lights with a documented estimator and energy behavior.
11. [ ] **ML-011** — If stochastic sampling is used, reuse samples temporally and optionally spatially while validating visibility/material changes.
12. [ ] **ML-012** — Avoid systematic bias where small bright, large dim, nearby, shadowed or off-center area lights are never selected.

#### Visibility, shadows, and reconstruction

13. [ ] **ML-013** — Resolve selected-light visibility through Virtual Shadows, SDF/software-BVH visibility, screen-space tests, optional TN-RT rays or a documented hybrid.
14. [ ] **ML-014** — Support area-source soft shadows at the quality promised for each light shape.
15. [ ] **ML-015** — Bound and prioritize shadow updates separately from unshadowed light evaluation.
16. [ ] **ML-016** — Denoise/reconstruct stochastic direct light with motion/depth/normal/material validation and camera-cut reset.
17. [ ] **ML-017** — Respond to moving lights and occluders within the documented latency without long-lived light ghosts.
18. [ ] **ML-018** — Provide a conservative fallback when a selected light's shadow page/visibility data is unavailable.
19. [ ] **ML-019** — Avoid double counting direct light with Dynamic GI and preserve energy behavior through Layered Materials.

#### Scene integration and scalability

20. [ ] **ML-020** — Support opaque and alpha-masked geometry; define transparent, particle, hair, water and decal lighting policy.
21. [ ] **ML-021** — Feed Volumetrics with bounded/coarse light and shadow data instead of evaluating every light in every froxel.
22. [ ] **ML-022** — Integrate with instanced/batched and Virtual Geometry without per-instance light lists on CPU.
23. [ ] **ML-023** — Provide quality controls for cluster dimensions, light limits, samples/pixel, temporal/spatial reuse, shadow quality and max affected distance.
24. [ ] **ML-024** — Fall back to Three.js ClusteredLighting or a bounded conventional-light path on tiers lacking the advanced visibility/sampling route.
25. [ ] **ML-025** — Support dynamic resolution, multiple cameras and origin shifts with independent cluster/history state.

#### Diagnostics

26. [ ] **ML-026** — Visualize clusters, candidate counts, overflow, selected lights, sample probability/weight, visibility source, shadow availability, temporal age/confidence and per-light contribution.
27. [ ] **ML-027** — Expose total/visible/candidate/selected/shadowed light counts, overflow clusters, rays/shadow samples, cache hits, rejection, GPU time and memory.
28. [ ] **ML-028** — Allow isolation by light, cluster, visibility method and shadow method, plus freeze-random/freeze-history modes.
29. [ ] **ML-029** — Identify lights dropped by budget and the reason/contribution score used.

### Candidate repositories and code-reuse plan

**Recommended blend:** Start from Three.js clustered lighting, borrow production atlas/culling lessons from PlayCanvas and Filament, and keep ReSTIR/native hardware-ray visibility as an optional backend enhancement—not a browser prerequisite.

| Candidate | Reuse score | Recommended action | License status | Likely requirement coverage | What to borrow | Gaps and caveats |
|---|---:|---|---|---|---|---|
| [Three.js clustered lighting](https://github.com/mrdoob/three.js) | **98** | Adopt as primary browser base | ✅ MIT | Forward+ clustered light assignment, TSL integration, WebGPU buffers and physical lights | Extend the upstream clustered path with budgets, atlas metadata, diagnostics and ThreeNative policy. | Does not provide stochastic visibility/ReSTIR or a complete thousands-of-shadowed-lights solution. |
| [playcanvas/engine](https://github.com/playcanvas/engine) | **92** | Port/reference production light clustering | ✅ MIT | Clustered lighting, shadow/cookie atlases, area-light/LTC patterns and production WebGL/WebGPU behavior | Borrow cluster construction, atlas allocation, light prioritization, overflow policy and diagnostics. | Different engine; port isolated algorithms and tests rather than importing the renderer. |
| [google/filament](https://github.com/google/filament) | **87** | Study/port froxel and mobile-lighting ideas | ✅ Apache-2.0 | Froxel/clustered lighting, physically based light units, IBL and mobile quality policy | Use math, culling layouts, quality tiers and performance validation. | Native C++ engine; no direct runtime dependency. |
| [alipbcs/ZetaRay](https://github.com/alipbcs/ZetaRay) | **76** | Study/port for optional native RT tier | ✅ MIT | Real-time ray tracing, ReSTIR-style sampling and denoising concepts | Use reservoir, temporal/spatial reuse and native ray-visibility ideas where TN-RT is available. | Not a WebGPU/Three.js path and assumes hardware RT; do not make it a browser baseline. |
| [toji/webgpu-clustered-shading](https://github.com/toji/webgpu-clustered-shading) | **35** | Blocked; study demo only | ⛔ No usable repository license found | WebGPU clustered shading demo | Observe buffer layouts and benchmark presentation only. | Do not copy source without explicit compatible licensing. |
| [NVIDIA RTXDI](https://github.com/NVIDIAGameWorks/RTXDI) | **45** | Legal-review/study only | ⚠️ NVIDIA RTX SDK license | Reservoir-based direct illumination, light sampling and hardware-ray visibility | Use technical papers and public algorithm concepts; consider isolated native integration only after review. | License and hardware/API assumptions are unsuitable for the permissive cross-platform core. |

> **Reuse-score meaning:** engineering fit for this ThreeNative feature—not GitHub popularity. It weighs useful requirement coverage, proximity to Three.js/WebGPU/TypeScript, maturity, maintainability and license safety. A high score does not replace benchmark or legal review.

### Open-source integration checklist

1. [ ] Benchmark the current Three.js clustered path first; record where light assignment, shading or shadow visibility becomes the bottleneck.
2. [ ] Port PlayCanvas-style atlas allocation and overflow/prioritization behind ThreeNative-owned light metadata.
3. [ ] Define deterministic light importance, cluster overflow and quality degradation policy.
4. [ ] Integrate Virtual Shadows or another bounded visibility strategy before advertising high shadowed-light counts.
5. [ ] Stress static, moving, overlapping, tiny and large lights at 100, 1,000 and 10,000-light scene scales.
6. [ ] Keep any ReSTIR/hardware-RT implementation in an optional TN-RT module with equivalent public semantics and explicit fallback.

### Required completion evidence

1. [ ] **ML-EVID-001** — Canonical scenes include a dense neon city/interior, many moving lights, overlapping depth layers, tiny bright lights, large soft area lights, cookies/IES, volumetric fog and moving occluders.
2. [ ] **ML-EVID-002** — Reference renders compare exact all-light evaluation for smaller scenes against the bounded/stochastic implementation for energy and selection bias.
3. [ ] **ML-EVID-003** — Temporal videos demonstrate stable direct light during camera/light/occluder motion and immediate history reset on cuts.
4. [ ] **ML-EVID-004** — Overflow tests exceed total and per-cluster capacities and prove deterministic, visible diagnostics and graceful degradation.
5. [ ] **ML-EVID-005** — Benchmarks scale light count, shadowed-light count, depth complexity and sample budget independently on every promised tier.

### This is **not Done** when

- The feature is only Three.js `ClusteredLighting` renamed without scalable shadow visibility.
- A headline light count ignores shadows, materials, depth complexity, resolution or frame budget.
- Per-cluster overflow silently drops arbitrary lights.
- Stochastic lighting visibly flickers/ghosts and has no exact-reference validation.
- Volumetrics, transparency, Virtual Geometry or Dynamic GI double count/bypass the many-light path.

### Parity extensions — valuable, but not required for the first Stable release

1. [ ] **[PARITY] ML-P001** — Native hardware-ray-traced visibility with ReSTIR-style spatiotemporal resampling.
2. [ ] **[PARITY] ML-P002** — Unified analytic, emissive mesh and environment-light sampling.
3. [ ] **[PARITY] ML-P003** — Perceptual/adaptive light budgets driven by gaze or foveation.

### Primary research references

- [Epic — MegaLights](https://dev.epicgames.com/documentation/en-us/unreal-engine/megalights-in-unreal-engine)
- [Three.js — ClusteredLighting](https://threejs.org/docs/pages/ClusteredLighting.html)
- [Three.js — DynamicLighting](https://threejs.org/docs/pages/DynamicLighting.html)
- [WebGPU specification](https://gpuweb.github.io/gpuweb/)

<a id="f8"></a>

## F8. World Partition, streaming, and HLOD

**ThreeNative working name:** `WorldPartition`  

**Effort-impact priority:** **#13 of 20** · **Impact:** 79/100 · **Effort:** 6/10 · **Impact/effort:** 13.2 · **Priority score:** 70.3/100 · **Band:** C — Next  

**Done means:** A large world is packaged into independently streamable cells, loaded by explicit streaming sources under memory and latency budgets, and represented by HLODs when detailed cells are absent, without gameplay identity loss or visible holes.

**Three.js starting point:** Three.js offers loaders, LOD, batching and external 3D Tiles ecosystems, but no authoritative world-cell model, packaging pipeline, streaming scheduler, data layers, persistent-state handoff, HLOD generation, or integrated diagnostics.

**Critical dependencies:** `GLOB-ASSET-001`, `GLOB-RUN-004`, `PCG`, `Mass`, `VirtualGeometry`, `VirtualTexturing`, `PhysicsSuite`

### Functional Definition-of-Done checklist

#### World and cell model

1. [ ] **WORLD-001** — Define a versioned spatial partition scheme—grid, quadtree, octree or hybrid—with deterministic cell IDs and world bounds.
2. [ ] **WORLD-002** — Assign streamable objects, entities, assets and generated data to cells while supporting always-loaded/global objects.
3. [ ] **WORLD-003** — Support named data layers/scenarios that independently control inclusion, activation, loading and build output.
4. [ ] **WORLD-004** — Represent inter-cell dependencies explicitly and detect cycles, missing dependencies and objects that illegally span cells.
5. [ ] **WORLD-005** — Define ownership and persistence for gameplay state when a cell unloads and reloads.
6. [ ] **WORLD-006** — Implement a large-world precision strategy such as camera-relative rendering and/or origin rebasing, shared with physics, audio, particles and temporal systems.

#### Streaming runtime

7. [ ] **WORLD-007** — Support one or more streaming sources with shape, position, direction, velocity, target range, priority and layer filters.
8. [ ] **WORLD-008** — Select cells using load/activate/unload radii or equivalent hysteresis so small camera movement does not thrash residency.
9. [ ] **WORLD-009** — Load, decode, create GPU resources, activate gameplay, deactivate and unload through explicit asynchronous stages.
10. [ ] **WORLD-010** — Prioritize visible/soon-visible cells using distance, camera velocity, portals/teleports, gameplay importance and dependency criticality.
11. [ ] **WORLD-011** — Support cancellation, reprioritization and fast travel; obsolete loads must not block newly critical cells.
12. [ ] **WORLD-012** — Enforce CPU, GPU and IO budgets with deterministic eviction and protected working sets.
13. [ ] **WORLD-013** — Expose readiness barriers for gameplay/cinematics and a nonblocking fallback when a requested area is not ready.
14. [ ] **WORLD-014** — Keep physics, nav, audio, VFX, PCG, Mass entities, lighting and render resources synchronized with cell activation state.
15. [ ] **WORLD-015** — Prewarm required shaders/pipelines and avoid first-entry compilation spikes for known cell content.
16. [ ] **WORLD-016** — Package cells into independently addressable chunks with hashes, dependency manifests and range/cache-friendly layout.

#### HLOD build and runtime

17. [ ] **WORLD-017** — Build one or more HLOD levels from cell/object groups using merge, instancing, simplification, impostor or Virtual Geometry strategies.
18. [ ] **WORLD-018** — Generate proxy materials/textures that preserve major albedo, normal, roughness, emissive, opacity and lighting behavior within declared tolerances.
19. [ ] **WORLD-019** — Preserve object exclusion rules, shadows, collision/query policy, selection/picking metadata and visibility/data-layer membership.
20. [ ] **WORLD-020** — Display HLOD proxies while source cells are absent and transition to/from detailed content without gaps, double rendering or severe popping.
21. [ ] **WORLD-021** — Build HLODs incrementally and cache outputs by source asset/settings/tool hashes.
22. [ ] **WORLD-022** — Validate proxy bounds and screen-space error so incorrect bounds cannot unload visible detail or explode culling cost.

#### Diagnostics and operations

23. [ ] **WORLD-023** — Visualize grid/cell bounds, streaming sources, requested/loading/active/evicting states, priorities, data layers and HLOD levels.
24. [ ] **WORLD-024** — Expose resident/pending cell counts, stage latency, bytes by resource class, IO throughput, cancellations, evictions, HLOD draw savings and missed deadlines.
25. [ ] **WORLD-025** — Record a streaming trace that explains why each cell loaded/unloaded and which dependency or budget delayed it.
26. [ ] **WORLD-026** — Provide build reports for cell size distribution, dependency fan-out, always-loaded content, duplicate assets and HLOD effectiveness.

### Candidate repositories and code-reuse plan

**Recommended blend:** Use 3DTilesRendererJS as the closest reusable traversal/cache core, loaders.gl for workers/formats and Cesium as the production reference. Adapt these to game-world cells and build ThreeNative-specific HLOD, persistence and replication semantics.

| Candidate | Reuse score | Recommended action | License status | Likely requirement coverage | What to borrow | Gaps and caveats |
|---|---:|---|---|---|---|---|
| [NASA-AMMOS/3DTilesRendererJS](https://github.com/NASA-AMMOS/3DTilesRendererJS) | **98** | Adopt/fork traversal and cache modules | ✅ Apache-2.0 | Hierarchical LOD traversal, screen-space error, request scheduling, cache, cancellation, plugins and Three.js integration | Use runtime traversal, loading queues, fallback-to-parent, cache and debug tooling as the streaming foundation. | 3D Tiles metadata/coordinate assumptions differ from game cells; wrap rather than expose the format as the world model. |
| [CesiumGS/cesium](https://github.com/CesiumGS/cesium) | **89** | Study/port mature streaming policy | ✅ Apache-2.0 | Planet-scale tile selection, request prioritization, cache pressure, occlusion and failure handling | Borrow scheduling heuristics, screen-space error, traversal diagnostics and resilience patterns. | Very large geospatial engine; not a sensible dependency for ThreeNative game-world streaming. |
| [visgl/loaders.gl](https://github.com/visgl/loaders.gl) | **92** | Adopt selected loaders/worker infrastructure | ✅ MIT with Apache-2.0/third-party notices | Binary loaders, workers, streaming parsers, 3D Tiles, glTF and transferable data | Use worker pool, loader interfaces and format modules that pass dependency/license review. | Select packages carefully; retain third-party notices and avoid pulling the entire monorepo. |
| [ebeaufay/threedtiles](https://github.com/ebeaufay/threedtiles) | **81** | Port supplemental tile techniques | ✅ MIT | Three.js 3D Tiles traversal, occlusion and instancing ideas | Use as a second implementation for comparison and selected refinements. | Smaller ecosystem; prefer 3DTilesRendererJS as the primary maintained base. |
| [gkjohnson/three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) | **86** | Adopt spatial-query support | ✅ MIT | Bounds, ray/shapecasts and spatial validation for cell/HLOD building | Use in offline HLOD grouping, visibility validation, collision/nav generation and editor selection. | Not a streaming scheduler. |
| [isaac-mason/recast-navigation-js](https://github.com/isaac-mason/recast-navigation-js) | **85** | Adopt streamed-navigation companion | ✅ MIT | Recast/Detour navmesh generation, tiled navmeshes and crowd integration | Use for per-cell/tile nav assets and load/unload hooks. | Navigation lifecycle must be synchronized with world cells and agents. |

> **Reuse-score meaning:** engineering fit for this ThreeNative feature—not GitHub popularity. It weighs useful requirement coverage, proximity to Three.js/WebGPU/TypeScript, maturity, maintainability and license safety. A high score does not replace benchmark or legal review.

### Open-source integration checklist

1. [ ] Prototype cell traversal and cache pressure using 3DTilesRendererJS before designing a custom scheduler.
2. [ ] Define the ThreeNative world-cell manifest, dependency bundle and stable object identity independently from 3D Tiles.
3. [ ] Adopt only the loaders.gl packages required and generate an SBOM/notice bundle for them.
4. [ ] Implement HLOD construction, proxy materials/collision and deterministic bake as an offline ThreeNative tool.
5. [ ] Integrate save state, networking, physics, navigation, audio, PCG and Virtual Geometry residency through explicit cell hooks.
6. [ ] Test bandwidth/latency, cancellation, corruption, memory pressure, teleport and origin-rebase failure scenarios.

### Required completion evidence

1. [ ] **WORLD-EVID-001** — A large canonical world runs a deterministic camera/player route, fast travel, reverse route and data-layer switch while recording streaming and memory.
2. [ ] **WORLD-EVID-002** — No route frame exposes an unintentional world hole, missing collision, duplicate actor/entity, stale light/audio source or HLOD/detail overlap.
3. [ ] **WORLD-EVID-003** — A constrained-memory run proves budget-respecting eviction and recovery instead of unbounded allocation.
4. [ ] **WORLD-EVID-004** — Origin-shift tests cover rendering, physics, particles, audio, motion vectors, temporal histories and water.
5. [ ] **WORLD-EVID-005** — Incremental build tests prove a local edit rebuilds only affected cells/HLODs and their true dependents.

### This is **not Done** when

- The system is distance-based `LOD` or manual loader calls without cell ownership and budgets.
- Fast travel waits behind obsolete requests or shows uncontrolled holes.
- Cell unload destroys persistent gameplay identity or leaves physics/audio behind.
- HLODs are hand-authored and not generated, cached, validated and transitioned by the system.
- There is no explainable streaming trace or hard memory policy.

### Parity extensions — valuable, but not required for the first Stable release

1. [ ] **[PARITY] WORLD-P001** — Server-authoritative replication-aware streaming and per-client relevance.
2. [ ] **[PARITY] WORLD-P002** — Portal/room visibility and semantic streaming volumes combined with distance sources.
3. [ ] **[PARITY] WORLD-P003** — Remote CDN patching and live cell-version migration.

### Primary research references

- [Epic — World Partition](https://dev.epicgames.com/documentation/en-us/unreal-engine/world-partition-in-unreal-engine)
- [Epic — HLOD](https://dev.epicgames.com/documentation/unreal-engine/world-partition---hierarchical-level-of-detail-in-unreal-engine)
- [Khronos — glTF](https://registry.khronos.org/glTF/)

<a id="f11"></a>

## F11. Control Rig and full-body IK

**ThreeNative working name:** `ControlRig`  

**Effort-impact priority:** **#14 of 20** · **Impact:** 77/100 · **Effort:** 6/10 · **Impact/effort:** 12.8 · **Priority score:** 68.9/100 · **Band:** C — Next  

**Done means:** A serializable rig graph can procedurally control skeletons and scene transforms using a production solver suite, spaces, constraints and controls, and can blend predictably with animation, Motion Matching and Sequencer.

**Three.js starting point:** Three.js supplies skeleton/skinning infrastructure and an add-on CCD IK solver with joint limits and helpers. It lacks a rig asset/graph, control hierarchy, execution phases, full solver suite, retargeting, animation layering, authoring workflow and production diagnostics.

**Critical dependencies:** `GLOB-RUN-002`, `MotionMatching`, `Sequencer`, `PhysicsSuite`

### Functional Definition-of-Done checklist

#### Rig asset and hierarchy

1. [ ] **RIG-001** — Define a versioned rig asset containing bones, controls, nulls/spaces, curves/parameters, metadata, hierarchy, initial pose and stable IDs.
2. [ ] **RIG-002** — Map a rig asset to compatible skeletons with explicit validation for bone names, hierarchy, orientation, scale, bind pose and missing optional bones.
3. [ ] **RIG-003** — Support parent/space switching and maintain-offset behavior without discontinuities.
4. [ ] **RIG-004** — Expose typed controls for transform, position, rotation, scale, float, integer, boolean, vector and enum values.
5. [ ] **RIG-005** — Provide control shapes/gizmos, selection, visibility, color, limits and local/world/parent-space manipulation in devtools.
6. [ ] **RIG-006** — Serialize authored values and rig topology separately from transient evaluated state.

#### Graph and execution model

7. [ ] **RIG-007** — Define deterministic forward-solve, backward-solve and construction/setup phases, or equivalent phases with documented data flow.
8. [ ] **RIG-008** — Provide graph nodes for transforms, hierarchy traversal, math, curves, remapping, conditions, collections, pose cache and custom functions.
9. [ ] **RIG-009** — Detect illegal cycles, ambiguous writes, missing controls/bones and unsupported custom nodes before runtime.
10. [ ] **RIG-010** — Support reusable rig functions/subgraphs and versioned custom nodes without copying graph fragments.
11. [ ] **RIG-011** — Allow execution at configurable update rates and skip unchanged/culled rigs while preserving state correctness.
12. [ ] **RIG-012** — Define thread/worker eligibility and isolate main-thread-only scene mutation from pure rig evaluation.

#### Mandatory solver and constraint suite

13. [ ] **RIG-013** — Implement FK and direct bone/control manipulation.
14. [ ] **RIG-014** — Implement two-bone IK with pole vector, stretch, limits and blend weight.
15. [ ] **RIG-015** — Implement CCD and FABRIK chain solvers with iteration/error limits and joint constraints.
16. [ ] **RIG-016** — Implement a full-body IK solver or equivalent multi-effector whole-body solve with root behavior, per-bone stiffness, preferred angles and limits.
17. [ ] **RIG-017** — Implement aim/look-at, parent, position, rotation, scale, distance and multi-parent constraints.
18. [ ] **RIG-018** — Support per-bone rotation/translation limits, preferred angles, stretch/compression and solver weights.
19. [ ] **RIG-019** — Support pose caches and partial-chain solving so multiple solvers can compose without unintentionally resetting prior results.
20. [ ] **RIG-020** — Provide common procedural modules for foot placement/locking, hand targets, look-at, spine alignment and ground-normal adaptation.

#### Animation, retargeting, and runtime integration

21. [ ] **RIG-021** — Blend rig output before/after clip animation and Motion Matching according to explicit layer/order and per-bone masks.
22. [ ] **RIG-022** — Support additive and absolute rig layers with runtime blend weights and safe enable/disable transitions.
23. [ ] **RIG-023** — Provide retarget chains, root/scale policy, reference poses and per-chain settings for declared skeleton families.
24. [ ] **RIG-024** — Integrate controls and rig parameters as Sequencer tracks with deterministic seek/scrub evaluation.
25. [ ] **RIG-025** — Consume physics traces/ground contacts and optionally drive or follow ragdoll bodies without feedback instability.
26. [ ] **RIG-026** — Generate correct current/previous skinned poses for motion vectors, shadows, bounds and picking.

#### Diagnostics and performance

27. [ ] **RIG-027** — Visualize controls, spaces, bone axes, constraints, effectors, targets, pole vectors, limits, iteration progress and final error.
28. [ ] **RIG-028** — Expose per-rig/node/solver timings, iteration counts, errors, skipped evaluations and memory.
29. [ ] **RIG-029** — Provide a pose-diff inspector comparing source animation, each rig layer and final output.
30. [ ] **RIG-030** — Report singularities, unreachable targets, scale/shear issues, NaNs and nonconvergent solves with rig/node context.

### Candidate repositories and code-reuse plan

**Recommended blend:** Compose a solver suite from Three.js skeleton/CCD, permissive FABRIK projects and three-vrm retargeting, while keeping rig graphs, spaces, controls, constraints and execution order native to ThreeNative.

| Candidate | Reuse score | Recommended action | License status | Likely requirement coverage | What to borrow | Gaps and caveats |
|---|---:|---|---|---|---|---|
| [Three.js CCDIKSolver/Skeleton](https://github.com/mrdoob/three.js) | **93** | Adopt core skeleton and CCD path | ✅ MIT | Skeleton/skinning, clips, bone transforms, CCD IK and debug helpers | Use as the core pose representation and baseline solver. | No full Control Rig graph, full-body solver, rich constraints or authoring framework. |
| [jsantell/THREE.IK](https://github.com/jsantell/THREE.IK) | **89** | Port/adopt FABRIK and chain model | ✅ MIT | FABRIK, chains, joints, constraints and Three.js integration | Borrow solver math, chain composition, constraints and examples. | Older package; modernize types, allocations and skeleton integration. |
| [lo-th/fullik](https://github.com/lo-th/fullik) | **81** | Port/reference alternate FABRIK | ✅ MIT | Full-body/multichain FABRIK concepts and constraints | Use as a second correctness/reference implementation and for edge-case tests. | Older codebase and API; do not expose it directly. |
| [pixiv/three-vrm](https://github.com/pixiv/three-vrm) | **92** | Adopt optional humanoid/retarget layer | ✅ MIT | Humanoid normalization, retargeting, constraints and spring bones | Use humanoid mapping and retarget behavior behind generic ThreeNative interfaces. | VRM semantics are optional; arbitrary rigs and non-humanoids remain required. |
| [google/motive](https://github.com/google/motive) | **77** | Study efficient evaluation/blending | ✅ Apache-2.0 | Compact animation data, blending and runtime curve evaluation | Borrow performance/data-layout ideas for graph evaluation. | C++ runtime, not a rig graph or IK package. |
| [retejs/rete](https://github.com/retejs/rete) | **75** | Adopt for editor graph only | ✅ MIT | Node graph UI/runtime infrastructure | Use for authoring controls, solver nodes and graph validation if consistent with PCG/material tooling. | Do not use generic graph execution in the per-frame pose hot path without compiling it. |

> **Reuse-score meaning:** engineering fit for this ThreeNative feature—not GitHub popularity. It weighs useful requirement coverage, proximity to Three.js/WebGPU/TypeScript, maturity, maintainability and license safety. A high score does not replace benchmark or legal review.

### Open-source integration checklist

1. [ ] Normalize all solver inputs/outputs into one documented local/component/world-space pose contract.
2. [ ] Port CCD and FABRIK behind common chain/constraint interfaces and compare them on analytic rigs.
3. [ ] Compile the authored rig graph into a deterministic allocation-free evaluation plan.
4. [ ] Use three-vrm only through an optional humanoid adapter and test generic skeletons separately.
5. [ ] Add limits, pole vectors, aim, look-at, two-bone, full-body, foot placement and retargeting conformance scenes.
6. [ ] Profile per-character CPU time and allocations at crowd-scale character counts.

### Required completion evidence

1. [ ] **RIG-EVID-001** — Canonical rigs cover humanoid full-body IK, quadruped or multi-leg placement, mechanical constraints, look-at and hand interactions.
2. [ ] **RIG-EVID-002** — Golden pose tests validate each solver, limits, spaces and layer ordering against fixed inputs.
3. [ ] **RIG-EVID-003** — Sequencer seek, Motion Matching transitions and runtime enable/disable produce no one-frame bind-pose flash or motion-vector spike.
4. [ ] **RIG-EVID-004** — Retarget tests cover different limb proportions, root scale and missing optional bones with documented tolerances.
5. [ ] **RIG-EVID-005** — Crowd and hero-character benchmarks measure solver rate, culled/update-rate behavior and memory.

### This is **not Done** when

- Only CCD IK exists with no rig asset or graph.
- Rig results depend on incidental update order or previous editor interaction.
- Solvers cannot layer with animation/Motion Matching/Sequencer.
- Retargeting, limits, spaces or pose diagnostics are absent.
- Current and previous skinning poses diverge, causing rendering artifacts.

### Parity extensions — valuable, but not required for the first Stable release

1. [ ] **[PARITY] RIG-P001** — Physics-based secondary rig dynamics and direct mesh controls.
2. [ ] **[PARITY] RIG-P002** — Automatic rig generation/templates and high-level modular rig authoring.
3. [ ] **[PARITY] RIG-P003** — GPU batched rig evaluation for large crowds.

### Primary research references

- [Epic — Control Rig](https://dev.epicgames.com/documentation/en-us/unreal-engine/control-rig-in-unreal-engine)
- [Epic — Full-Body IK](https://dev.epicgames.com/documentation/en-us/unreal-engine/control-rig-full-body-ik-in-unreal-engine)
- [Three.js — CCDIKSolver](https://threejs.org/docs/pages/CCDIKSolver.html)

<a id="f6"></a>

## F6. Mass/ECS crowds and large-scale agents

**ThreeNative working name:** `Mass`  

**Effort-impact priority:** **#15 of 20** · **Impact:** 68/100 · **Effort:** 4/10 · **Impact/effort:** 17.0 · **Priority score:** 68.6/100 · **Band:** C — Next  

**Done means:** Tens of thousands of lightweight entities can be created, queried, updated, represented and culled through a data-oriented runtime whose workload scales by archetype and representation—not by React component or JavaScript object count.

**Three.js starting point:** Three.js provides `InstancedMesh`, `BatchedMesh`, storage buffers and compute, which cover efficient representation. It does not provide entity storage, queries, system scheduling, representation LOD, spawn policy, signals, persistence, movement or crowd behavior.

**Critical dependencies:** `GLOB-RUN-002`, `GLOB-RUN-006`, `WorldPartition`, `PCG`, `VirtualGeometry`, `PhysicsSuite`

### Functional Definition-of-Done checklist

#### Entity and component model

1. [ ] **MASS-001** — Define opaque entity IDs with generation/version protection so recycled indices cannot mutate stale entities.
2. [ ] **MASS-002** — Support typed components/fragments, zero-sized tags, shared components, archetypes and chunked contiguous storage.
3. [ ] **MASS-003** — Support required/optional/excluded component queries, changed filters, chunk iteration and stable query caching.
4. [ ] **MASS-004** — Avoid allocating a standalone JavaScript object, React component, closure or event listener per large-scale entity in hot paths.
5. [ ] **MASS-005** — Provide batched spawn/despawn, component add/remove, archetype migration and deferred structural changes through a command buffer.
6. [ ] **MASS-006** — Define entity ownership across world cells, gameplay systems, save state and rendering representations.
7. [ ] **MASS-007** — Provide deterministic or explicitly nondeterministic iteration modes and document ordering guarantees.

#### System scheduling and simulation

8. [ ] **MASS-008** — Define processors/systems with declared read/write component access, phase, frequency, dependencies and thread/backend eligibility.
9. [ ] **MASS-009** — Build a schedule that prevents data races and can execute independent chunk work in workers or compute where supported.
10. [ ] **MASS-010** — Support fixed-rate, variable-rate, lower-frequency and event/signal-driven systems under a shared simulation clock.
11. [ ] **MASS-011** — Bound per-frame structural changes, signals and work queues, with overflow/backpressure counters.
12. [ ] **MASS-012** — Support snapshots or serialization of selected components and stable restoration of entity references.
13. [ ] **MASS-013** — Expose hooks for rollback, prediction and replication filtering without requiring full networking in the core ECS.
14. [ ] **MASS-014** — Support scene/object bridge components for a small promoted subset without forcing every entity into the Three.js scene graph.

#### Crowd behavior and representation

15. [ ] **MASS-015** — Provide representation LOD states such as full gameplay object, simplified animated object, instanced/batched representation, impostor, and no visual representation.
16. [ ] **MASS-016** — Transition representation LOD without losing entity identity, gameplay state, animation phase or selection state.
17. [ ] **MASS-017** — Batch transforms, animation parameters and material variation to rendering buffers; updates must be dirty-range or GPU-generated at scale.
18. [ ] **MASS-018** — Provide spatial partition/query support for nearby agents, cells, frustum/distance visibility and streaming ownership.
19. [ ] **MASS-019** — Provide baseline movement, steering, separation, cohesion, target following and obstacle/nav integration hooks.
20. [ ] **MASS-020** — Integrate collision/avoidance with a scalable approximation and reserve full Rapier bodies for promoted entities or bounded subsets.
21. [ ] **MASS-021** — Support batched animation state or vertex-animation/instanced-skinned paths for the declared crowd representation tier.
22. [ ] **MASS-022** — Support spawn-data sources from PCG, authored zones, gameplay events and World Partition cells.

#### Diagnostics and safety

23. [ ] **MASS-023** — Inspect archetypes, component layouts, chunk occupancy, queries, processors, dependencies, entity state and representation LOD.
24. [ ] **MASS-024** — Expose entity/chunk/archetype counts, structural changes, processor timings, worker utilization, rendered-instance counts, promotions and memory by component.
25. [ ] **MASS-025** — Detect query invalidation bugs, stale IDs, structural mutation during iteration, write conflicts and leaked cell-owned entities.
26. [ ] **MASS-026** — Provide a deterministic capture/replay tool for a bounded set of entities and system inputs.

### Candidate repositories and code-reuse plan

**Recommended blend:** Choose the ECS core empirically: Miniplex favors ergonomic typed entities, while bitECS favors dense data-oriented scale. Pair the selected model with Recast/Detour crowds, Three.js batching/compute and Rapier promotion for near agents.

| Candidate | Reuse score | Recommended action | License status | Likely requirement coverage | What to borrow | Gaps and caveats |
|---|---:|---|---|---|---|---|
| [hmans/miniplex](https://github.com/hmans/miniplex) | **93** | Evaluate/adopt ergonomic ECS | ✅ MIT | Typed entities, queries, React/Three ecosystem ergonomics and simple composition | Use for gameplay-facing entity model if target-scale benchmarks pass. | Object-oriented component storage may be less efficient for very large homogeneous crowds; measure rather than assume. |
| [NateTheGreatt/bitECS](https://github.com/NateTheGreatt/bitECS) | **91** | Evaluate/adopt data-oriented core | ⚠️ MPL-2.0 file-level copyleft | Structure-of-arrays ECS, high entity counts, queries and cache-friendly simulation | Use for dense agent state or as the full ECS if API/maintenance tradeoffs fit. | MPL obligations apply to modified covered files; isolate/adopt unmodified package or complete legal review. |
| [isaac-mason/recast-navigation-js](https://github.com/isaac-mason/recast-navigation-js) | **95** | Adopt navigation/crowd layer | ✅ MIT | Recast/Detour navmesh, tiled navigation and crowd simulation | Use navmesh build/runtime, crowd steering and dynamic obstacle integration. | Behavior, representation LOD, networking and physics promotion remain ThreeNative work. |
| [donmccurdy/three-pathfinding](https://github.com/donmccurdy/three-pathfinding) | **79** | Adopt as lightweight fallback/tool | ✅ MIT | Three.js nav-zone creation and path queries | Use for simple projects, editor previews or fallback where full Recast is unnecessary. | Not intended for massive dynamic crowds or tiled world streaming. |
| [Three.js BatchedMesh/InstancedMesh/compute](https://github.com/mrdoob/three.js) | **91** | Adopt representation foundation | ✅ MIT | Instancing, batching, indirect draws, animation textures and WebGPU compute | Use for visual LOD tiers and GPU-driven transforms/animation. | No ECS, behavior scheduler, navigation or agent lifecycle. |
| [dimforge/rapier](https://github.com/dimforge/rapier) | **89** | Adopt promoted-agent physics | ✅ Apache-2.0 | Collision, character control, sensors and rigid-body interactions | Use for near/high-fidelity agents and promotion/demotion adapters. | Do not simulate every background crowd agent as a rigid body. |

> **Reuse-score meaning:** engineering fit for this ThreeNative feature—not GitHub popularity. It weighs useful requirement coverage, proximity to Three.js/WebGPU/TypeScript, maturity, maintainability and license safety. A high score does not replace benchmark or legal review.

### Open-source integration checklist

1. [ ] Benchmark Miniplex and bitECS with the actual component/query mix at 10k, 100k and target maximum agent counts.
2. [ ] Choose one authoritative entity identity/lifecycle model or define a narrow adapter—do not run two unsynchronized worlds.
3. [ ] Integrate Recast crowd state with streamed navmesh tiles and World Partition lifecycle.
4. [ ] Implement simulation, animation and rendering LOD plus deterministic promotion/demotion to Rapier/character actors.
5. [ ] Batch system scheduling with bounded work queues and no per-agent React component requirement.
6. [ ] Stress spawn/despawn, queries, path replanning, obstacle updates, networking and save/load under memory pressure.

### Required completion evidence

1. [ ] **MASS-EVID-001** — A canonical crowd scene reaches the product-declared entity target with stable frame time, bounded memory and no one-object-per-entity renderer path.
2. [ ] **MASS-EVID-002** — Representation LOD stress tests exercise repeated promotion/demotion, camera teleport and cell streaming without state loss or visual duplication.
3. [ ] **MASS-EVID-003** — Scheduling tests prove dependency ordering and race-free results across single-thread and worker-enabled execution.
4. [ ] **MASS-EVID-004** — Snapshot/restore and stale-ID tests prove entity identity safety.
5. [ ] **MASS-EVID-005** — Profiler evidence attributes CPU, worker, GPU and memory costs to processors, archetypes and representation tiers.

### This is **not Done** when

- Crowds are implemented as thousands of React components or Three.js objects.
- The project has instanced rendering but no data-oriented entity runtime.
- Systems mutate structure during iteration without a safe command model.
- Representation LOD loses identity or gameplay state.
- A benchmark quotes entity count without scene, behavior, rendering and frame-budget evidence.

### Parity extensions — valuable, but not required for the first Stable release

1. [ ] **[PARITY] MASS-P001** — GPU-resident agent simulation and culling with minimal CPU synchronization.
2. [ ] **[PARITY] MASS-P002** — Production networking/replication graph and rollback implementation.
3. [ ] **[PARITY] MASS-P003** — Hierarchical crowd navigation, lane systems and large-scale traffic simulation.

### Primary research references

- [Epic — Mass Entity](https://dev.epicgames.com/documentation/en-us/unreal-engine/overview-of-mass-entity-in-unreal-engine)
- [Epic — Mass Gameplay](https://dev.epicgames.com/documentation/en-us/unreal-engine/overview-of-mass-gameplay-in-unreal-engine)
- [Three.js — InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html)
- [Three.js — BatchedMesh](https://threejs.org/docs/pages/BatchedMesh.html)

<a id="f7"></a>

## F7. Sequencer and cinematic timeline

**ThreeNative working name:** `Sequencer`  

**Effort-impact priority:** **#16 of 20** · **Impact:** 68/100 · **Effort:** 4/10 · **Impact/effort:** 17.0 · **Priority score:** 68.6/100 · **Band:** C — Next  

**Done means:** Serializable timelines can deterministically animate and bind scene properties, cameras, skeletal animation, audio, VFX, materials, lights and events at runtime and during capture, with nested shots and predictable seek/scrub behavior.

**Three.js starting point:** Three.js supplies clips, mixers, keyframe tracks, property binding and interpolation. ThreeNative must add a multi-track timeline model, object bindings, evaluation rules, nested sequences, camera cuts, non-animation tracks, event semantics, authoring tools and capture integration.

**Critical dependencies:** `GLOB-RUN-002`, `PostProcessing`, `VFX`, `MetaAudio`, `ControlRig`, `MotionMatching`

### Functional Definition-of-Done checklist

#### Sequence data model

1. [ ] **SEQ-001** — Define versioned sequence assets with an explicit display rate, tick resolution/timebase, duration/range and stable element IDs.
2. [ ] **SEQ-002** — Represent tracks, rows, sections/clips, channels, keys, interpolation/tangents, easing, weights, blending and muted/solo state.
3. [ ] **SEQ-003** — Support object/property bindings by stable scene identity plus runtime rebinding/overrides for spawned or reused actors.
4. [ ] **SEQ-004** — Distinguish possessable existing objects from sequence-spawned objects and define ownership/destruction on stop, seek and sequence end.
5. [ ] **SEQ-005** — Support nested sequences, shot tracks, time transforms, offsets, loops, subsequence hierarchy and deterministic overlap resolution.
6. [ ] **SEQ-006** — Serialize to a diffable format with migrations and preserve unknown extension tracks when possible.

#### Playback and evaluation

7. [ ] **SEQ-007** — Support play, pause, stop, seek, scrub, reverse, loop, play rate, range playback, frame stepping and external-clock driving.
8. [ ] **SEQ-008** — Evaluate deterministically for a given time and binding state, independent of previous playback direction except where a track explicitly maintains state.
9. [ ] **SEQ-009** — Define pre-roll, post-roll, warm-up, evaluation range and completion behavior such as restore state, keep state or custom completion.
10. [ ] **SEQ-010** — Blend overlapping numeric, vector, quaternion, color and transform sections with documented absolute/additive/relative semantics.
11. [ ] **SEQ-011** — Handle camera cuts as first-class events that notify temporal rendering systems, audio listeners, input/camera controllers and capture.
12. [ ] **SEQ-012** — Define event-track semantics for forward play, reverse, seek, scrub, loops, skipped frames and reentrancy; events must not fire unpredictably during editor scrubbing.
13. [ ] **SEQ-013** — Support asynchronous asset readiness and pre-roll without drifting sequence time or producing partially initialized shots.
14. [ ] **SEQ-014** — Allow runtime creation, binding, parameterization and control of players without mutating the source sequence asset.

#### Mandatory track types

15. [ ] **SEQ-015** — Implement transform and generic typed property tracks.
16. [ ] **SEQ-016** — Implement camera-cut and camera-property tracks, including lens/focus values used by post processing.
17. [ ] **SEQ-017** — Implement skeletal animation tracks with clip offsets, rate, looping, root-motion policy and blending.
18. [ ] **SEQ-018** — Implement Control Rig tracks or an equivalent rig-parameter bridge.
19. [ ] **SEQ-019** — Implement audio tracks with sample-aware start/offset, fades, volume/pitch and listener/bus routing.
20. [ ] **SEQ-020** — Implement VFX activation, parameter and lifecycle tracks with deterministic pre-roll/warm-up.
21. [ ] **SEQ-021** — Implement material/uniform, light, visibility, post-process and event/function tracks.
22. [ ] **SEQ-022** — Provide an extension contract for custom track/channel evaluators with capability and serialization metadata.

#### Authoring, capture, and diagnostics

23. [ ] **SEQ-023** — Provide a minimum timeline authoring surface that can create/edit tracks, sections and keys, scrub time, select bindings, and perform undo/redo; a full Unreal-style editor is not required.
24. [ ] **SEQ-024** — Provide a TypeScript/JSON builder API suitable for code generation, source control and agent authoring.
25. [ ] **SEQ-025** — Integrate deterministic fixed-frame capture for images/video, including warm-up, temporal samples, output naming and failed-frame reporting.
26. [ ] **SEQ-026** — Visualize evaluation hierarchy, active sections, resolved values, binding targets, event firing, spawned objects and current camera.
27. [ ] **SEQ-027** — Expose evaluation time by track/type, active-player counts, async waits, dropped capture frames and temporal-history resets.

### Candidate repositories and code-reuse plan

**Recommended blend:** Own a deterministic ThreeNative sequence asset/evaluator. Borrow runtime/tween concepts from Theatre core and Tween.js, capture/evaluation ideas from Motion Canvas, and avoid embedding Theatre Studio unless an AGPL strategy is explicitly accepted.

| Candidate | Reuse score | Recommended action | License status | Likely requirement coverage | What to borrow | Gaps and caveats |
|---|---:|---|---|---|---|---|
| [Theatre.js core](https://github.com/theatre-js/theatre) | **90** | Adopt/reference permissive core packages | ✅ Apache-2.0 at repository/core level | Timeline objects, tracks, sheets, interpolation, sequencing and Three.js ecosystem integration | Borrow runtime data/evaluation concepts, curve UX and project serialization patterns. | Audit package-by-package; do not assume the Studio UI shares the core license. |
| [Theatre.js Studio](https://github.com/theatre-js/theatre/tree/main/packages/studio) | **48** | Do not embed without explicit copyleft strategy | ⚠️ AGPL-3.0 | Polished keyframe/timeline authoring UI | Use as UX inspiration or deploy under a consciously accepted AGPL architecture. | Embedding/modifying the Studio can trigger AGPL obligations; build a separate permissive ThreeNative editor by default. |
| [tweenjs/tween.js](https://github.com/tweenjs/tween.js) | **91** | Adopt interpolation/easing utility | ✅ MIT | Tween lifecycle, easing and interpolation | Use low-level easing/interpolants where Three.js tracks are insufficient. | Not a sequence asset, editor, event system or deterministic capture pipeline. |
| [motion-canvas/motion-canvas](https://github.com/motion-canvas/motion-canvas) | **85** | Port/reference evaluator and capture concepts | ✅ MIT | Generator-based timelines, deterministic frame evaluation, media/capture and authoring | Borrow fixed-frame evaluation, event composition, export/cancellation and debugging ideas. | 2D/animation framework; adapt concepts, not scene runtime. |
| [Three.js animation system](https://github.com/mrdoob/three.js) | **89** | Adopt clip/track foundation | ✅ MIT | Animation clips, keyframe tracks, interpolation, mixers and object-property binding | Use for animation tracks and object binding under the sequence evaluator. | No cinematic editor, nested sequence, camera cut, event or capture orchestration. |
| [retejs/rete / xyflow](https://github.com/xyflow/xyflow) | **76** | Adopt editor infrastructure selectively | ✅ MIT | Node/track-adjacent UI interactions, selection, grouping and viewport | Use shared editor primitives where they reduce duplicated tooling. | A node editor is not automatically a high-quality nonlinear timeline. |

> **Reuse-score meaning:** engineering fit for this ThreeNative feature—not GitHub popularity. It weighs useful requirement coverage, proximity to Three.js/WebGPU/TypeScript, maturity, maintainability and license safety. A high score does not replace benchmark or legal review.

### Open-source integration checklist

1. [ ] Define a versioned ThreeNative sequence schema and deterministic evaluator independently from any editor package.
2. [ ] Audit Theatre packages separately and explicitly exclude AGPL Studio code from the permissive core unless approved.
3. [ ] Implement fixed-time and fixed-frame evaluation before real-time playback controls.
4. [ ] Map animation, property, event, audio, camera-cut, spawn/visibility and subsequence tracks to stable bindings.
5. [ ] Integrate capture with Temporal Upscaling, motion blur, path tracing and audio offline rendering.
6. [ ] Add round-trip serialization, migration, undo/redo and headless CI evaluation tests.

### Required completion evidence

1. [ ] **SEQ-EVID-001** — A multi-shot canonical sequence uses nested shots, camera cuts, animation, Control Rig, audio, VFX, material/light/post tracks and events.
2. [ ] **SEQ-EVID-002** — Golden state snapshots at selected frame numbers match when reached by forward play, reverse play, direct seek and fresh evaluation.
3. [ ] **SEQ-EVID-003** — Loop/event tests prove no duplicate, missing or scrub-induced gameplay events under documented semantics.
4. [ ] **SEQ-EVID-004** — Fixed-frame capture produces the same frame count, timestamps and visual sequence on every declared platform tier.
5. [ ] **SEQ-EVID-005** — A custom track implemented outside the core proves the extension and serialization contract.

### This is **not Done** when

- The system is only an `AnimationMixer` wrapper.
- Results depend on how playback arrived at the current timestamp.
- Camera cuts do not reset temporal renderer histories.
- Audio/VFX/events drift or fire inconsistently after seek and loop.
- There is no serializable asset, binding model, nested sequence support or minimum authoring surface.

### Parity extensions — valuable, but not required for the first Stable release

1. [ ] **[PARITY] SEQ-P001** — Collaborative nonlinear editing, takes, editorial conform and EDL/AAF-style interchange.
2. [ ] **[PARITY] SEQ-P002** — Movie-render queue with distributed rendering, render layers and advanced temporal/spatial supersampling.
3. [ ] **[PARITY] SEQ-P003** — Live-control recording and automated key reduction.

### Primary research references

- [Epic — Sequencer](https://dev.epicgames.com/documentation/en-us/unreal-engine/sequencer-cinematic-editor-unreal-engine)
- [Three.js — AnimationClip](https://threejs.org/docs/pages/AnimationClip.html)
- [Three.js — KeyframeTrack](https://threejs.org/docs/pages/KeyframeTrack.html)

<a id="f15"></a>

## F15. Streaming and runtime virtual texturing

**ThreeNative working name:** `VirtualTexturing`  

**Effort-impact priority:** **#17 of 20** · **Impact:** 85/100 · **Effort:** 8/10 · **Impact/effort:** 10.6 · **Priority score:** 68.5/100 · **Band:** C — Next  

**Done means:** Materials can address textures larger than physical GPU memory through demand-loaded pages, while runtime virtual textures can cache/composite scene-authored surface data, both under explicit residency, IO and quality budgets.

**Three.js starting point:** Three.js provides textures, compressed KTX2 loading, storage textures, render targets and readback primitives. It does not provide offline tiling, page tables, GPU feedback, page scheduling, physical caches, runtime producers, residency or debugging.

**Critical dependencies:** `GLOB-ASSET-001`, `GLOB-RUN-004`, `WorldPartition`, `LayeredMaterials`

### Functional Definition-of-Done checklist

#### Offline build and runtime asset format

1. [ ] **VT-001** — Tile source images and mip chains into independently addressable pages with configurable page size and filter borders/gutters.
2. [ ] **VT-002** — Preserve color space, channel semantics, alpha, normal-map convention and coordinated material-layer alignment.
3. [ ] **VT-003** — Compress/transcode pages into GPU-supported formats per target tier using KTX2/BasisU or an equivalent documented path.
4. [ ] **VT-004** — Produce a versioned manifest containing virtual dimensions, mip hierarchy, page locations/sizes/checksums, channel groups and fallback tiles.
5. [ ] **VT-005** — Package pages for efficient range/chunk loading and cache outputs by source/settings/tool/platform hashes.
6. [ ] **VT-006** — Validate dimensions, mip completeness, border generation, compression compatibility and page integrity in CI.

#### Virtual addressing and feedback

7. [ ] **VT-007** — Implement virtual UV/mip addressing through a page table and bounded physical cache/atlas.
8. [ ] **VT-008** — Generate GPU feedback identifying required virtual pages and desired mip without stalling the render path.
9. [ ] **VT-009** — Compact/deduplicate feedback and transfer only bounded request data to the streaming scheduler.
10. [ ] **VT-010** — Provide conservative parent/fallback tiles so missing fine pages never sample uninitialized memory or flash arbitrary colors.
11. [ ] **VT-011** — Update page tables atomically relative to uploaded content and prevent references to overwritten/evicted pages.
12. [ ] **VT-012** — Support anisotropic/filter sampling across page and mip boundaries without visible seams from missing gutters or incorrect derivatives.
13. [ ] **VT-013** — Support synchronized multi-channel page groups for base color, normal, roughness/metalness, height and custom masks.

#### Streaming, residency, and budgets

14. [ ] **VT-014** — Prioritize requests by visible footprint, mip error, camera motion, material importance, cell priority and starvation age.
15. [ ] **VT-015** — Load/decode/transcode/upload asynchronously with cancellation and bounded staging memory.
16. [ ] **VT-016** — Enforce physical cache, pending request, IO bandwidth, decode and upload budgets with explicit eviction policy.
17. [ ] **VT-017** — Prefetch parent/neighbor pages and camera-predicted pages enough to reduce visible latency without defeating the budget.
18. [ ] **VT-018** — Handle fast camera motion, teleport, quality changes, device loss and World Partition transitions without stale page-table entries.
19. [ ] **VT-019** — Deduplicate page data across materials/assets when content identity and format allow it.
20. [ ] **VT-020** — Persist disk/network cache according to version/checksum policy and recover safely from corrupt or missing chunks.

#### Runtime virtual textures

21. [ ] **VT-021** — Provide a runtime virtual-texture asset/volume with declared bounds, resolution, layers/channels and producer list.
22. [ ] **VT-022** — Render or compute only dirty/requested runtime pages and invalidate them from producer transform/material/data changes.
23. [ ] **VT-023** — Support deterministic producer ordering/blending for terrain, decals, roads, footprints, landscape data and custom writers.
24. [ ] **VT-024** — Allow materials and gameplay/PCG consumers to sample runtime pages with the same missing-page and quality contract.
25. [ ] **VT-025** — Provide persistence/bake or clear-regenerate policy for runtime-generated data and cell unload/reload.
26. [ ] **VT-026** — Prevent feedback loops where a runtime texture samples itself unless an explicitly staged prior-frame path is used.

#### Integration and diagnostics

27. [ ] **VT-027** — Integrate with layered materials, terrain/water, decals, PCG, HLOD and Virtual Geometry without each system owning a separate incompatible cache.
28. [ ] **VT-028** — Visualize requested/resident/missing pages, mip selection, physical cache, page-table lookup, feedback density, producer ownership and eviction.
29. [ ] **VT-029** — Expose cache occupancy, hit/miss ratio, requested/loaded/evicted pages, IO/decode/upload throughput, latency, fallback sampling and bytes by channel.
30. [ ] **VT-030** — Provide quality controls for page size/build profile, mip bias, anisotropy, cache size, upload budget, prefetch and runtime-update budget.

### Candidate repositories and code-reuse plan

**Recommended blend:** Build the runtime in-house by porting the clear MIT virtual-texture prototype, and adopt KTX/Basis tooling for asset packaging/compression. Use Granite/The Forge only to inform residency and native sparse-resource backends.

| Candidate | Reuse score | Recommended action | License status | Likely requirement coverage | What to borrow | Gaps and caveats |
|---|---:|---|---|---|---|---|
| [shlomnissan/virtual-textures](https://github.com/shlomnissan/virtual-textures) | **97** | Port primary VT prototype | ✅ MIT | Page-table sampling, physical atlas, GPU feedback, CPU cache/eviction and page padding | Port the end-to-end minimal architecture and its visual residency diagnostics. | Clarity prototype, not production: add concurrency, prioritization, compression, budgets, cancellation and failure handling. |
| [BinomialLLC/basis_universal](https://github.com/BinomialLLC/basis_universal) | **95** | Adopt encoder/transcoder tooling | ✅ Apache-2.0 | Universal GPU texture compression and transcoding | Use in the offline page builder and runtime format negotiation. | Compression artifacts, per-page borders/mips and worker/native deployment need validation. |
| [KhronosGroup/KTX-Software](https://github.com/KhronosGroup/KTX-Software) | **92** | Adopt selected KTX2 tools/runtime files | ⚠️ Mostly Apache-2.0; verify SPDX per file | KTX/KTX2 packaging, Basis integration, validation and transcoding | Use container format, tooling and selected runtime modules after file-level review. | Repository includes multiple licenses and a non-open-source special-case file; pin and inventory exact shipped files. |
| [Themaister/Granite](https://github.com/Themaister/Granite) | **75** | Study residency/resource systems | ✅ MIT | Virtual/resource caching, render graph and native GPU synchronization | Borrow cache lifetime, upload and synchronization patterns. | Large native engine; not a direct WebGPU/Three dependency. |
| [ConfettiFX/The-Forge](https://github.com/ConfettiFX/The-Forge) | **72** | Study native sparse-resource backend | ✅ Apache-2.0 | Cross-platform texture streaming/sparse-resource samples and platform abstractions | Use to design optional native sparse-texture acceleration. | Browser path still needs atlas/page-table implementation. |
| [carloskiki/wgpu-virtual-texturing](https://github.com/carloskiki/wgpu-virtual-texturing) | **30** | Blocked; study demo only | ⛔ No usable repository license found | wgpu virtual-texturing prototype | Observe benchmark and architecture only. | Do not copy source without explicit compatible licensing. |

> **Reuse-score meaning:** engineering fit for this ThreeNative feature—not GitHub popularity. It weighs useful requirement coverage, proximity to Three.js/WebGPU/TypeScript, maturity, maintainability and license safety. A high score does not replace benchmark or legal review.

### Open-source integration checklist

1. [ ] Reproduce the minimal VT prototype and validate page requests/residency visually before optimizing it.
2. [ ] Define the virtual page file/container format, IDs, borders, mip tail and checksums as a ThreeNative asset contract.
3. [ ] Build deterministic KTX2/Basis page tooling and verify exact file/transitive licenses in the shipped toolchain.
4. [ ] Implement GPU feedback compaction, request priority, cancellation, upload budget, eviction and ancestor fallback.
5. [ ] Share residency accounting and IO scheduling with Virtual Geometry and World Partition without coupling their public assets.
6. [ ] Stress fast camera motion, anisotropy, seams, missing/corrupt pages, memory pressure and device loss.

### Required completion evidence

1. [ ] **VT-EVID-001** — Canonical scenes include huge terrain/material sets, rapid aerial-to-ground movement, repeated textures, normal-map seams, runtime roads/decals/footprints and cell streaming.
2. [ ] **VT-EVID-002** — Golden close-ups validate page borders, anisotropy, mip transitions, normal/material channel alignment and color space.
3. [ ] **VT-EVID-003** — Constrained cache/bandwidth tests prove deterministic fallback/eviction with no uninitialized sampling or stale table references.
4. [ ] **VT-EVID-004** — Fast teleport/device-reset tests recover valid fallback and progressively refine without corruption.
5. [ ] **VT-EVID-005** — Benchmarks separate feedback, CPU scheduling, IO, decode/transcode, upload, page-table update and runtime-page production.

### This is **not Done** when

- Large textures are only manually tiled or loaded as ordinary texture arrays.
- Feedback requires synchronous full-frame readback or stalls rendering.
- Fine-page misses flash black/checkerboard/uninitialized memory instead of valid parents.
- Normals/material channels load at mismatched pages and visibly disagree.
- Runtime producers redraw the entire virtual texture every frame.

### Parity extensions — valuable, but not required for the first Stable release

1. [ ] **[PARITY] VT-P001** — Fully GPU-resident request scheduling/direct storage paths where native platforms support them.
2. [ ] **[PARITY] VT-P002** — Sparse-residency textures exposed directly by native APIs behind the same contract.
3. [ ] **[PARITY] VT-P003** — Editable persistent virtual texture layers for world painting and user-generated content.

### Primary research references

- [Epic — Runtime Virtual Texturing](https://dev.epicgames.com/documentation/en-us/unreal-engine/runtime-virtual-texturing-in-unreal-engine)
- [Khronos — KTX 2.0 specification](https://registry.khronos.org/KTX/specs/2.0/ktxspec.v2.html)
- [Khronos — KHR_texture_basisu](https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_texture_basisu)
- [Three.js — KTX2Loader](https://threejs.org/docs/pages/KTX2Loader.html)

<a id="f10"></a>

## F10. MetaSounds-like procedural audio

**ThreeNative working name:** `MetaAudio`  

**Effort-impact priority:** **#18 of 20** · **Impact:** 70/100 · **Effort:** 5/10 · **Impact/effort:** 14.0 · **Priority score:** 67.0/100 · **Band:** D — Later / specialized  

**Done means:** A versioned, sample-accurate audio graph runs safely on the real-time audio thread, supports reusable DSP nodes and parameters, streams assets, manages voices, integrates spatial audio, and behaves consistently across web and native backends.

**Three.js starting point:** Three.js wraps Web Audio listeners and positional sources. Web Audio provides a routing graph and AudioWorklet for custom processing on the rendering thread. ThreeNative still needs a portable graph asset/compiler, DSP library, scheduling, voice/bus system, streaming, native implementation and diagnostics.

**Critical dependencies:** `GLOB-RUN-006`, `Sequencer`, `WorldPartition`

### Functional Definition-of-Done checklist

#### Graph, types, and compilation

1. [ ] **AUDIO-001** — Define versioned audio graph assets with typed audio/control/trigger inputs and outputs, stable node IDs, validation and migration.
2. [ ] **AUDIO-002** — Separate control-rate and audio-rate data and reject cycles unless they pass through an explicit delay/feedback node.
3. [ ] **AUDIO-003** — Compile graphs into a bounded runtime plan for AudioWorklet on web and the declared native audio callback backend.
4. [ ] **AUDIO-004** — Support subgraphs/functions, interfaces, presets/inheritance, graph parameters and reusable node packages.
5. [ ] **AUDIO-005** — Provide a custom-node SDK for portable DSP code or explicitly tiered web/native implementations with capability metadata.
6. [ ] **AUDIO-006** — Calculate and propagate channel layouts, sample rates, latency and tail time through the graph.

#### Sample-accurate runtime

7. [ ] **AUDIO-007** — Schedule triggers, starts, stops, parameter ramps and timeline events against the audio clock with sample-accurate or explicitly bounded accuracy.
8. [ ] **AUDIO-008** — Provide thread-safe control messages and parameter automation without blocking the render/audio thread.
9. [ ] **AUDIO-009** — Perform no unbounded allocation, garbage collection dependency, mutex wait, filesystem/network IO, logging or React callback on the audio render thread.
10. [ ] **AUDIO-010** — Handle underruns, processor errors, device changes, focus/background transitions, suspend/resume and graph teardown predictably.
11. [ ] **AUDIO-011** — Support hot reload by safe graph swap/crossfade or documented restart without a loud click, use-after-free or orphaned voice.
12. [ ] **AUDIO-012** — Keep transport/audio time synchronized with Sequencer and gameplay while defining behavior under pause and time dilation.

#### Mandatory node and mixing library

13. [ ] **AUDIO-013** — Provide sample/wave playback with looping, region/cue selection, start offset, playback rate/pitch policy, fades and completion events.
14. [ ] **AUDIO-014** — Provide oscillators/noise, envelopes, LFOs, math, comparisons, random/seeded-random, selectors and trigger logic.
15. [ ] **AUDIO-015** — Provide gain/pan, filters/EQ, delay, dynamics, waveshaping/distortion, convolution or algorithmic reverb, and analyzers/meters.
16. [ ] **AUDIO-016** — Provide mixers, buses, sends/returns, snapshots, ducking/side-chain hooks and master output control.
17. [ ] **AUDIO-017** — Support parameter modulation with smoothing and documented audio/control-rate behavior.
18. [ ] **AUDIO-018** — Support multichannel conversion/mixing and avoid channel-count surprises when connecting graphs.

#### Assets, voices, and spatial integration

19. [ ] **AUDIO-019** — Stream/decode long audio incrementally with buffering, cancellation, seek and underrun policy; short assets may be predecoded.
20. [ ] **AUDIO-020** — Manage voice limits, priorities, concurrency groups, stealing, virtualization and resume behavior under a hard budget.
21. [ ] **AUDIO-021** — Integrate 3D position, orientation, attenuation, directional cones, Doppler, listener changes and world-origin shifts.
22. [ ] **AUDIO-022** — Support occlusion/reverb-zone/environment inputs through bounded physics or authored queries rather than per-sample scene access.
23. [ ] **AUDIO-023** — Integrate cell streaming so unloaded sources stop/virtualize and resume according to explicit ownership rules.
24. [ ] **AUDIO-024** — Expose asset duration, cue markers, loudness metadata and optional seek tables produced by the build pipeline.

#### Diagnostics and offline operation

25. [ ] **AUDIO-025** — Visualize the compiled graph, active voices, buses, levels, parameters, triggers, buffers and node CPU cost.
26. [ ] **AUDIO-026** — Expose underruns, render quantum/callback time, voice steals, streamed bytes, decode time, buffer fill, graph swaps and peak/RMS levels.
27. [ ] **AUDIO-027** — Provide deterministic offline rendering for tests, waveform comparison, asset baking and non-real-time Sequencer export.
28. [ ] **AUDIO-028** — Provide clipping, NaN/denormal, unstable-feedback and excessive-gain diagnostics with offending graph/node context.

### Candidate repositories and code-reuse plan

**Recommended blend:** Use Tone.js and standardized-audio-context for the browser DSP/scheduling substrate, but keep the graph asset, compiler, voice budgeting and native backend contract in ThreeNative. Offer Faust only as an isolated optional plugin.

| Candidate | Reuse score | Recommended action | License status | Likely requirement coverage | What to borrow | Gaps and caveats |
|---|---:|---|---|---|---|---|
| [Tonejs/Tone.js](https://github.com/Tonejs/Tone.js) | **97** | Adopt browser DSP/scheduling layer | ✅ MIT | Transport, sample-accurate scheduling, synths, effects, signals, envelopes and routing | Use proven DSP nodes, scheduling and tests under a ThreeNative graph/voice abstraction. | Browser/Web Audio-centric and musically oriented; native backend and engine asset semantics remain required. |
| [standardized-audio-context](https://github.com/chrisguttandin/standardized-audio-context) | **91** | Adopt browser compatibility layer | ✅ MIT | Consistent Web Audio API behavior across browser differences | Use to reduce browser-specific scheduling/node inconsistencies. | Adds dependency weight; benchmark and use only where native Web Audio behavior is insufficient. |
| [Three.js Audio/PositionalAudio](https://github.com/mrdoob/three.js) | **87** | Adopt scene-listener/spatial bridge | ✅ MIT | Audio listener, source, analyser and positional audio tied to Object3D | Reuse scene transform integration and familiar API where compatible. | No procedural graph, compiler, sample-accurate event model or voice manager. |
| [grame-cncm/faustwasm](https://github.com/grame-cncm/faustwasm) | **77** | Optional isolated compiler/plugin | ⚠️ LGPL-3.0 | Faust DSP compilation to WebAssembly/Web Audio | Allow advanced user DSP nodes through a separately distributed/dynamically linked integration. | Do not merge LGPL implementation into the permissive core without legal review; native/mobile packaging needs design. |
| [retejs/rete](https://github.com/retejs/rete) | **81** | Adopt graph editor/runtime tooling | ✅ MIT | Typed node graph and editor/plugin architecture | Use for authoring UI and graph validation shared with PCG/rig tooling. | Compile the graph to an audio-thread plan; never execute generic JS graph traversal in the real-time callback. |

> **Reuse-score meaning:** engineering fit for this ThreeNative feature—not GitHub popularity. It weighs useful requirement coverage, proximity to Three.js/WebGPU/TypeScript, maturity, maintainability and license safety. A high score does not replace benchmark or legal review.

### Open-source integration checklist

1. [ ] Define a backend-neutral audio graph asset and compiler IR before wrapping Tone.js nodes.
2. [ ] Compile/control the graph through AudioWorklet or equivalent real-time-safe execution with no main-thread timing dependency.
3. [ ] Implement voice allocation, stealing, virtualization and streaming budgets at the ThreeNative layer.
4. [ ] Map scene transforms/occlusion/zones to browser and native spatial-audio backends through one contract.
5. [ ] Package FaustWasm only as an optional module with isolated licensing and a documented linking/distribution model.
6. [ ] Test sample-accurate events, seek/pause/resume, device changes, offline render and deterministic Sequencer export.

### Required completion evidence

1. [ ] **AUDIO-EVID-001** — Examples include procedural ambience, impact variation, engine/vehicle synthesis or layering, music bus transitions, spatial occlusion and a Sequencer-synchronized cue.
2. [ ] **AUDIO-EVID-002** — Offline golden waveforms verify graph logic, parameter ramps, trigger timing and deterministic random behavior.
3. [ ] **AUDIO-EVID-003** — Real-time stress tests prove no underruns at the declared voice/node target and show p95 callback utilization.
4. [ ] **AUDIO-EVID-004** — Web and native conformance tests compare timing, graph output and lifecycle within declared tolerances.
5. [ ] **AUDIO-EVID-005** — A custom external DSP node demonstrates packaging, validation, compilation and diagnostics.

### This is **not Done** when

- The system is only `Audio`/`PositionalAudio` playback or a main-thread Web Audio wrapper.
- Graph updates allocate or block in the real-time callback.
- Timing is frame-based and drifts from the audio clock.
- There is no bounded voice/concurrency policy or long-file streaming.
- Web and native paths share API names but produce undocumented timing/behavior differences.

### Parity extensions — valuable, but not required for the first Stable release

1. [ ] **[PARITY] AUDIO-P001** — Higher-order ambisonics, HRTF profile selection and room-acoustic simulation.
2. [ ] **[PARITY] AUDIO-P002** — Visual node editor with live waveform/spectrum preview and audition.
3. [ ] **[PARITY] AUDIO-P003** — Audio-rate WASM DSP plugin ABI with ahead-of-time validation on every platform.

### Primary research references

- [Epic — MetaSounds](https://dev.epicgames.com/documentation/en-us/unreal-engine/metasounds-the-next-generation-sound-sources-in-unreal-engine)
- [W3C — Web Audio API](https://www.w3.org/TR/webaudio-1.0/)
- [Three.js — PositionalAudio](https://threejs.org/docs/pages/PositionalAudio.html)

<a id="f19"></a>

## F19. Chaos replacement: modular physics, destruction, cloth, and vehicles

**ThreeNative working name:** `PhysicsSuite`  

**Effort-impact priority:** **#19 of 20** · **Impact:** 82/100 · **Effort:** 9/10 as a suite · **Impact/effort:** 9.1 · **Priority score:** 63.4/100 · **Band:** D — Later / specialized  

**Done means:** ThreeNative ships a clearly scoped, cross-platform physics suite: production rigid bodies and queries over Rapier, plus stable destruction, cloth and vehicle modules. Every module shares clocks, transforms, collision policy, budgets, serialization and diagnostics rather than claiming a monolithic Chaos clone.

**Three.js starting point:** The current `@threenative/physics` direction already wraps Rapier and exposes web/WASM and native paths. Rapier provides rigid bodies, colliders, joints, queries, sleeping and nonlinear CCD; the major work is semantic conformance between backend versions plus destruction, cloth, vehicles, rendering integration, tools and module-level acceptance.

**Critical dependencies:** `GLOB-RUN-002`, `GLOB-RUN-006`, `WorldPartition`, `Mass`, `VFX`, `Water`, `ControlRig`

### Functional Definition-of-Done checklist

#### Suite scope and common simulation contract

1. [ ] **PHYS-001** — Publish a capability/module matrix for `rigidBody`, `character`, `destruction`, `cloth`, `vehicle`, `rope`, `softBody`, and `fluid`; unsupported modules must not be implied by the suite name.
2. [ ] **PHYS-002** — Use one fixed-step clock, accumulator, interpolation/extrapolation policy, pause/time-scale behavior and maximum catch-up rule across modules.
3. [ ] **PHYS-003** — Define units, handedness, transform ownership, scale restrictions, center-of-mass conventions and world-origin shifting across rendering and physics.
4. [ ] **PHYS-004** — Provide stable handles/IDs, lifecycle, serialization hooks, collision layers/groups, materials and event ordering across web and native implementations.
5. [ ] **PHYS-005** — Pin backend versions or implement compatibility shims so the same public configuration has documented equivalent semantics across WASM and native Rapier.
6. [ ] **PHYS-006** — Run cross-backend conformance scenes and quantify any numerical/determinism differences rather than assuming version/API parity.
7. [ ] **PHYS-007** — Support worker/native-thread stepping and batched typed-array transform/event transfer without one bridge call per body.
8. [ ] **PHYS-008** — Define World Partition ownership, sleeping/unloaded behavior, migration between cells and persistent-state restoration.

#### Rigid-body and collision core

9. [ ] **PHYS-009** — Support dynamic, fixed and position/velocity-based kinematic bodies with mass, inertia, center of mass, gravity scale, damping, velocity, forces, impulses and locks.
10. [ ] **PHYS-010** — Support primitive, convex, compound and triangle/height-field colliders with scale/update restrictions documented per backend.
11. [ ] **PHYS-011** — Support friction, restitution, combine rules, density, sensors/triggers, active collision/event flags and collision groups.
12. [ ] **PHYS-012** — Support fixed, spherical, revolute, prismatic, rope/distance and generic joint capabilities promised by the public API, including motors and limits.
13. [ ] **PHYS-013** — Support sleeping/waking with explicit mutation behavior and diagnostics.
14. [ ] **PHYS-014** — Support continuous collision detection for fast bodies with quality/substep controls and tests for angular/translational tunneling.
15. [ ] **PHYS-015** — Expose batched ray, shape cast, point, overlap and nearest/scene queries with filtering and stable hit metadata.
16. [ ] **PHYS-016** — Expose contact/intersection/force events through bounded queues with deterministic draining and overflow reporting.
17. [ ] **PHYS-017** — Provide a robust character-controller profile with slopes, steps, grounding, moving platforms, depenetration, skin/offset and query hooks.
18. [ ] **PHYS-018** — Support snapshots or deterministic state serialization adequate for save/load and test replay on each declared backend.

#### Destruction module

19. [ ] **PHYS-019** — Provide an offline fracture asset with pieces, hierarchy/clusters, adjacency/bond graph, mass/collision proxies, render mapping and build validation.
20. [ ] **PHYS-020** — Support authored and procedural fracture patterns at the declared scope, with deterministic seeds and bounded piece counts.
21. [ ] **PHYS-021** — Represent bonds with strength/damage thresholds and allow impact, radial, directional, strain and gameplay-authored field damage.
22. [ ] **PHYS-022** — Break clusters incrementally, activate physical pieces and update collision without blocking full-asset rebuild on the game thread.
23. [ ] **PHYS-023** — Keep visible geometry, cluster hierarchy, collision proxies, shadows, GI representation and VFX/audio events synchronized with fracture state.
24. [ ] **PHYS-024** — Apply debris budgets, sleep, cull, merge/impostor and lifetime/pooling policies without deleting gameplay-critical pieces silently.
25. [ ] **PHYS-025** — Serialize or deterministically reconstruct fracture state and preserve state through world-cell unload/reload.
26. [ ] **PHYS-026** — Provide damage/bond/cluster/collision visualization and counters for active pieces, broken bonds, islands, contacts, memory and timings.

#### Cloth module

27. [ ] **PHYS-027** — Import/build a cloth asset with particles/vertices, structural/shear/bend constraints, pin/skin weights, material parameters and collision thickness.
28. [ ] **PHYS-028** — Use a stable position/constraint solver with configurable iterations/substeps, damping, gravity and compliance/stiffness.
29. [ ] **PHYS-029** — Support collisions with primitives/convex/character bodies and a declared mesh or signed-distance representation.
30. [ ] **PHYS-030** — Support self-collision or explicitly scope it out by cloth profile; a 'hero cloth' claim requires self-collision.
31. [ ] **PHYS-031** — Support wind/aerodynamic forces, attachment animation, teleport/reset, sleep and world-origin shifts.
32. [ ] **PHYS-032** — Skin/render simulated cloth with current/previous positions for motion vectors, bounds and shadows.
33. [ ] **PHYS-033** — Provide cloth LOD for simulation resolution, iterations, collision fidelity, update rate and disable/fallback.
34. [ ] **PHYS-034** — Visualize particles, constraints, strain, contacts, pins, normals and solver error; expose timings and memory.

#### Vehicle module

35. [ ] **PHYS-035** — Define a vehicle asset/config for chassis, wheel positions/radii/inertia, suspension, steering, brakes, drivetrain, differential and transmission.
36. [ ] **PHYS-036** — Support suspension ray/shape casts, spring/damper forces, wheel contact, normal load and surface material lookup.
37. [ ] **PHYS-037** — Implement a documented tire force/slip model with tunable longitudinal/lateral grip and combined-slip behavior.
38. [ ] **PHYS-038** — Implement engine/motor torque curve, gearing, clutch/automatic policy, braking, handbrake and reverse.
39. [ ] **PHYS-039** — Support stable inputs, assists/limits if promised, sleeping/reset, moving platforms and high-speed CCD policy.
40. [ ] **PHYS-040** — Expose telemetry for speed, RPM, gear, wheel contact, suspension travel, slip, forces and control state.
41. [ ] **PHYS-041** — Synchronize visual wheels/suspension, audio/VFX, camera and networking/prediction hooks with the physics state.
42. [ ] **PHYS-042** — Provide deterministic or tolerance-bounded handling tests on declared surfaces and backend tiers.

#### Integration, diagnostics, and release policy

43. [ ] **PHYS-043** — Provide one shared debug renderer for colliders, AABBs, contacts, joints, CCD, sleeping, queries, fields, cloth, destruction and vehicles.
44. [ ] **PHYS-044** — Expose broadphase/narrowphase/solver/query time, active/sleeping bodies, contacts, islands, CCD, events, bridge bytes/calls and module memory.
45. [ ] **PHYS-045** — Integrate Mass promotion/demotion, PCG-spawned collision, water buoyancy/flow, Control Rig/ragdoll handoff and VFX/audio events through explicit adapters.
46. [ ] **PHYS-046** — Bound all event, debris, query, cloth-particle and vehicle work queues and prove overflow behavior.
47. [ ] **PHYS-047** — Mark the overall `PhysicsSuite` Stable only when rigid body, destruction, cloth and vehicle profiles above are Stable; otherwise publish stable modules individually.

### Candidate repositories and code-reuse plan

**Recommended blend:** Retain Rapier as the rigid-body foundation. Add focused modules: V-HACD for asset decomposition, three-pinata/three-bvh-csg for fracture tooling, custom GPU cloth/fluid paths and optional native studies. Explicitly exclude NVIDIA Blast source under its current restrictive repository license.

| Candidate | Reuse score | Recommended action | License status | Likely requirement coverage | What to borrow | Gaps and caveats |
|---|---:|---|---|---|---|---|
| [dimforge/rapier](https://github.com/dimforge/rapier) | **99** | Adopt as rigid-body foundation | ✅ Apache-2.0 | Rigid bodies, colliders, joints, CCD, queries, character controllers, events and JS/native implementations | Use as the canonical physics semantics and keep cross-backend conformance tied to pinned Rapier versions. | Does not provide Chaos-equivalent fracture, cloth, fluids, hair/flesh or a full vehicle suite. |
| [pmndrs/react-three-rapier](https://github.com/pmndrs/react-three-rapier) | **89** | Port React lifecycle/API patterns | ✅ MIT | Declarative bodies/colliders/joints, event handling, interpolation, snapshots and Three ecosystem ergonomics | Borrow component lifecycle, context ownership, cleanup and user-facing API ideas. | R3F-specific and browser/WASM-focused; do not make it the underlying ThreeNative runtime. |
| [dgreenheck/three-pinata](https://github.com/dgreenheck/three-pinata) | **91** | Adopt/port runtime fracture and slicing | ✅ MIT | Real-time Three.js mesh fracturing and slicing | Use geometry cutting, fragment generation and examples as the start of the destruction module. | Fracture geometry alone is not a damage/bond/cluster/debris system; integrate with Rapier and offline preprocessing. |
| [gkjohnson/three-bvh-csg](https://github.com/gkjohnson/three-bvh-csg) | **87** | Adopt for cutting/Boolean tooling | ✅ MIT | Accelerated CSG/Boolean operations over Three.js geometry | Use for authoring cuts, fracture preprocessing and optional runtime slicing. | Topology/performance limits require budgets and robust fallback. |
| [kmammou/v-hacd](https://github.com/kmammou/v-hacd) | **94** | Adopt offline convex decomposition | ✅ BSD-3-Clause | Approximate convex decomposition for collision/fracture assets | Use in the asset pipeline with deterministic settings and cached outputs. | Native/WASM build and asset-processing time need operational tooling; retain notices. |
| [jrouwe/JoltPhysics](https://github.com/jrouwe/JoltPhysics) | **83** | Study/optional native module | ✅ MIT | Rigid bodies, vehicles, soft bodies and broad production physics features | Borrow vehicle/soft-body architecture and consider isolated native backends where justified. | Do not create incompatible semantics beside Rapier without an explicit module boundary and conformance story. |
| [aatishb/drape](https://github.com/aatishb/drape) | **69** | Study/port cloth constraints | ✅ MIT | Three.js cloth simulation, constraints and collision visualization | Use as an educational/reference baseline and test-scene seed. | Older CPU demo; production cloth needs GPU compute, self-collision, attachment, LOD and motion vectors. |
| [jeantimex/fluid](https://github.com/jeantimex/fluid) | **79** | Port optional GPU fluid kernels | ✅ MIT | WebGPU fluid simulation experiments | Use for parity-extension research and localized effects. | Keep separate from the Stable rigid/destruction/cloth/vehicle scope unless fully productized. |
| [NVIDIAGameWorks/Blast](https://github.com/NVIDIAGameWorks/Blast) | **0** | Blocked | ⛔ Restrictive NVIDIA repository license | Destruction/fracture SDK concepts | Use public technical concepts only; do not copy code or distribute binaries from this repository. | Repository license states use/reproduction/distribution requires a separate express NVIDIA agreement. |

> **Reuse-score meaning:** engineering fit for this ThreeNative feature—not GitHub popularity. It weighs useful requirement coverage, proximity to Three.js/WebGPU/TypeScript, maturity, maintainability and license safety. A high score does not replace benchmark or legal review.

### Open-source integration checklist

1. [ ] Keep the existing ThreeNative/Rapier semantics authoritative and pin matching WASM/native Rapier versions.
2. [ ] Port React Three Rapier ergonomics only at the component layer; maintain an imperative runtime with no React dependency.
3. [ ] Add V-HACD and fracture preprocessing to a deterministic cached asset pipeline.
4. [ ] Integrate three-pinata/CSG fragments with bond/cluster damage, Rapier body creation and strict debris budgets.
5. [ ] Prototype GPU cloth and fluid modules behind independent capability flags and fixed-step contracts.
6. [ ] Run cross-backend recordings for contacts, joints, CCD, character, destruction, cloth and vehicles within declared tolerances.
7. [ ] Exclude NVIDIA Blast source/binaries unless a separate signed license is reviewed and approved.

### Required completion evidence

1. [ ] **PHYS-EVID-001** — Rigid-body conformance covers stacks, friction/restitution, joints/motors, sensors/events, sleeping, CCD, character movement, queries, serialization and origin shifts on web and native.
2. [ ] **PHYS-EVID-002** — Cross-backend input recordings produce matching discrete outcomes and positions/velocities within declared tolerances; divergences are documented by feature/version.
3. [ ] **PHYS-EVID-003** — Destruction scenes cover impact/radial/field damage, clustered fracture, debris budgets, save/reload and World Partition.
4. [ ] **PHYS-EVID-004** — Cloth scenes cover character attachment, wind, collision, self-collision profile, teleport, LOD and motion vectors.
5. [ ] **PHYS-EVID-005** — Vehicle tests cover acceleration/braking, steady circle, slalom, bumps/jumps, different surfaces and reset across declared backends.
6. [ ] **PHYS-EVID-006** — Soak and stress evidence records bridge overhead, queues, memory and fixed-step catch-up under load.

### This is **not Done** when

- Rapier integration alone is called a Chaos replacement.
- WASM and native packages expose the same names but use incompatible semantics without conformance tests.
- Destruction is preanimated mesh swapping rather than bond/cluster-driven physical fracture.
- Cloth is only vertex animation or lacks collision/LOD/lifecycle.
- Vehicles are simple force scripts with no suspension, tire/slip, drivetrain or telemetry model.
- The suite claims unsupported fluids, flesh, hair or soft bodies by association.

### Parity extensions — valuable, but not required for the first Stable release

1. [ ] **[PARITY] PHYS-P001** — Ragdoll authoring, active ragdolls and physical animation profiles.
2. [ ] **[PARITY] PHYS-P002** — Tearing cloth, ropes/cables, deformable/soft bodies and flesh.
3. [ ] **[PARITY] PHYS-P003** — GPU fluids, two-way fluid/rigid coupling and large-scale granular simulation.
4. [ ] **[PARITY] PHYS-P004** — Deterministic network rollback and authoritative fracture replication.

### Primary research references

- [Epic — Physics and Chaos](https://dev.epicgames.com/documentation/en-us/unreal-engine/physics-in-unreal-engine)
- [Rapier — JavaScript rigid bodies](https://rapier.rs/docs/user_guides/javascript/rigid_bodies/)
- [Rapier — CCD](https://rapier.rs/docs/user_guides/javascript/rigid_body_ccd/)
- [Rapier — Determinism](https://rapier.rs/docs/user_guides/javascript/determinism/)
- [ThreeNative — physics package](https://www.npmjs.com/package/@threenative/physics)

<a id="f20"></a>

## F20. Path tracer and reference renderer

**ThreeNative working name:** `PathTracer`  

**Effort-impact priority:** **#20 of 20** · **Impact:** 60/100 · **Effort:** 9–10/10 · **Impact/effort:** 6.3 · **Priority score:** 46.5/100 · **Band:** D — Later / specialized  

**Done means:** ThreeNative can progressively render physically coherent reference-quality stills and fixed-frame sequences from the same scene/material assets, with robust acceleration, sampling, denoising/AOVs, invalidation and export. Real-time performance is not required for the first Stable release.

**Three.js starting point:** Three.js supplies scene/material data, compute/storage textures and community path-tracing work, but no official production path tracer integrated with the full ThreeNative feature contract. Standard WebGPU requires a software BVH; native hardware RT can be an optional acceleration tier.

**Critical dependencies:** `GLOB-RUN-001`, `LayeredMaterials`, `Sequencer`, `WorldPartition`, `VirtualGeometry`

### Functional Definition-of-Done checklist

#### Scene snapshot and acceleration

1. [ ] **PT-001** — Build a versioned immutable render snapshot from the live scene with stable object/material/light IDs and clear synchronization boundaries.
2. [ ] **PT-002** — Build/refit a top-level and bottom-level BVH or equivalent acceleration structure supporting instancing.
3. [ ] **PT-003** — Support static transforms, instanced/batched geometry and a documented snapshot/update path for skinned, morphing and vertex-deformed meshes.
4. [ ] **PT-004** — Support opaque and alpha-masked geometry; define transparent-volume and procedural-geometry support explicitly.
5. [ ] **PT-005** — Handle World Partition/Virtual Geometry by materializing or translating the required render snapshot without missing resident-independent detail promised by the capture.
6. [ ] **PT-006** — Build acceleration asynchronously with progress, cancellation, cache and memory budgets.
7. [ ] **PT-007** — Ship a software-BVH WebGPU implementation; optionally use native hardware acceleration behind the same scene/material contract.

#### Camera, lights, and integrator

8. [ ] **PT-008** — Generate perspective and orthographic camera rays plus depth of field from focal/aperture settings.
9. [ ] **PT-009** — Support camera and object motion blur for fixed-frame capture when enabled.
10. [ ] **PT-010** — Sample directional, point, spot, rect/area, emissive geometry and environment lights according to the declared support matrix.
11. [ ] **PT-011** — Implement direct and indirect transport with next-event estimation and multiple-importance sampling or a documented equivalent.
12. [ ] **PT-012** — Support multiple diffuse/specular/transmission bounces, Russian roulette, configurable depth and robust path termination.
13. [ ] **PT-013** — Importance-sample environment maps and emissive/area lights, including many-light selection without severe bias.
14. [ ] **PT-014** — Handle HDR energy and fireflies through robust sampling plus optional clamping that is disabled or disclosed for ground-truth comparisons.
15. [ ] **PT-015** — Use deterministic seeded sampling for reproducible tests and distribute samples consistently across tiles/frames.

#### Material and texture parity

16. [ ] **PT-016** — Translate all Layered Material lobes promised for path tracing, including dielectric/conductor, roughness, clearcoat, sheen, anisotropy, emission, transmission and supported subsurface approximation.
17. [ ] **PT-017** — Preserve normal/tangent maps, bump/displacement policy, UV transforms, texture color spaces, filtering and alpha masking.
18. [ ] **PT-018** — Keep material parameter values and light units consistent with the raster renderer so comparisons are meaningful.
19. [ ] **PT-019** — Render a documented fallback for unsupported material nodes and report the object/node instead of silently substituting black.
20. [ ] **PT-020** — Provide a material-conformance scene comparing raster and path-traced spheres/slabs under calibrated lighting.

#### Progressive rendering, denoising, and output

21. [ ] **PT-021** — Accumulate samples progressively with correct running statistics and no precision overflow at long sample counts.
22. [ ] **PT-022** — Invalidate accumulation on any camera, scene, material, light, environment, resolution or relevant setting change.
23. [ ] **PT-023** — Support fixed sample count, time budget, convergence threshold/adaptive sampling and pause/resume.
24. [ ] **PT-024** — Provide optional denoising with albedo/normal/depth/motion or other required guides, while retaining un-denoised output.
25. [ ] **PT-025** — Output beauty plus required AOVs: albedo, normal, depth, direct, indirect, diffuse, specular, emission, variance/sample count and object/material ID.
26. [ ] **PT-026** — Export linear HDR images and selected SDR formats with explicit color transform and metadata.
27. [ ] **PT-027** — Support tiled/high-resolution render and bounded memory for outputs larger than the interactive viewport.
28. [ ] **PT-028** — Integrate Sequencer fixed-frame rendering, temporal shutter sampling, frame naming, resume and failure reporting.

#### Diagnostics and correctness

29. [ ] **PT-029** — Visualize BVH bounds/levels, ray classes, traversal cost, light sampling distribution, path depth, variance, sample count and denoiser guides.
30. [ ] **PT-030** — Expose build/refit time, BVH bytes, rays/s, intersections/ray, samples/pixel, bounce distribution, active tiles, convergence and GPU time.
31. [ ] **PT-031** — Detect NaNs/Infs, invalid PDFs, negative throughput, stack overflow, degenerate triangles and unsupported nodes with contextual diagnostics.
32. [ ] **PT-032** — Provide analytic validation scenes for energy conservation, inverse-square lights, Lambertian response, perfect mirror/refraction, Fresnel, roughness and environment sampling.
33. [ ] **PT-033** — Version the integrator/sampler so golden references are intentionally regenerated when algorithms change.

### Candidate repositories and code-reuse plan

**Recommended blend:** Fork/extend `three-gpu-pathtracer` as the primary Three.js implementation, share three-mesh-bvh, use PBRT as the correctness reference and selectively port broader effects from the CC0 renderer. Keep browser software-BVH and optional native RT backends semantically aligned.

| Candidate | Reuse score | Recommended action | License status | Likely requirement coverage | What to borrow | Gaps and caveats |
|---|---:|---|---|---|---|---|
| [gkjohnson/three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer) | **99** | Fork/adopt primary implementation | ✅ MIT | Three.js scene/material packing, BVH traversal, progressive path tracing, environment lights, denoising integration and examples | Use as the executable starting point; extend materials/lights, AOVs, export, deterministic sampling and native abstraction. | Audit current feature coverage and performance; do not equate demo support with complete ThreeNative material parity. |
| [gkjohnson/three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) | **98** | Adopt acceleration foundation | ✅ MIT | BVH build, traversal, refit, serialization and GPU data structures | Share with path tracer, GI, picking and validation; retain upstream tests. | Top-level scene/instance acceleration and native hardware-RT mapping remain ThreeNative work. |
| [erichlof/THREE.js-PathTracing-Renderer](https://github.com/erichlof/THREE.js-PathTracing-Renderer) | **87** | Port/reference broad renderer features | ✅ CC0-1.0 | Large collection of path-traced materials, primitives, lights, camera effects and scenes | Use feature implementations and analytic/demo scenes to fill gaps and cross-check behavior. | Different architecture and code organization; port selectively and validate third-party assets separately. |
| [mmp/pbrt-v4](https://github.com/mmp/pbrt-v4) | **90** | Use as correctness oracle/reference | ✅ Apache-2.0 | Physically based integrators, sampling, materials, lights, cameras and reference tests | Use equations, furnace/analytic tests and high-quality ground truth—not as a web dependency. | CPU/GPU native research renderer with a much broader scope than real-time ThreeNative. |
| [jure/webgiya](https://github.com/jure/webgiya) | **79** | Port shared WebGPU BVH/compute patterns | ✅ MIT | Three.js WebGPU scene BVH, compute passes, ray integration and temporal buffers | Share fixes/data paths between GI and path tracing where technically sound. | Surfel GI architecture is not a path tracer; avoid forced coupling. |
| [daikiad/webgpu-path-tracer](https://github.com/daikiad/webgpu-path-tracer) | **30** | Blocked; study demo only | ⛔ No usable repository license found | WebGPU path-tracing implementation concepts | Observe performance/debug behavior only. | Do not copy source without explicit compatible licensing. |
| [Three.js](https://github.com/mrdoob/three.js) | **91** | Adopt scene/material/TSL base | ✅ MIT | Scene graph, materials, textures, loaders, color management and WebGPU renderer | Maintain one mapping from ThreeNative/Three assets into raster and path-traced representations. | Raster material internals do not automatically provide path-tracer parity. |

> **Reuse-score meaning:** engineering fit for this ThreeNative feature—not GitHub popularity. It weighs useful requirement coverage, proximity to Three.js/WebGPU/TypeScript, maturity, maintainability and license safety. A high score does not replace benchmark or legal review.

### Open-source integration checklist

1. [ ] Pin and reproduce `three-gpu-pathtracer` with the Three.js revision used by ThreeNative.
2. [ ] Inventory unsupported ThreeNative material, light, texture, geometry, camera and animation features and turn each into a test.
3. [ ] Define a deterministic sampler/integrator version and preserve un-denoised output for correctness checks.
4. [ ] Build PBRT/analytic comparison scenes for energy, Fresnel, roughness, transmission, environment sampling and emissive meshes.
5. [ ] Implement AOVs, linear HDR export, tiled rendering, cancellation/resume and Sequencer fixed-frame capture.
6. [ ] Share BVH/material packing with GI only through explicit reusable modules, not circular renderer dependencies.
7. [ ] Keep optional native hardware RT behind the same scene snapshot, material semantics and reference tests.

### Required completion evidence

1. [ ] **PT-EVID-001** — Canonical reference scenes include Cornell-box style diffuse transport, metals, glass/transmission, emissive mesh lighting, environment lighting, DOF, motion blur, instancing and alpha masking.
2. [ ] **PT-EVID-002** — Analytic and furnace tests pass declared numerical/image tolerances and catch material/light unit regressions.
3. [ ] **PT-EVID-003** — Repeated seeded renders are reproducible; unbiased modes converge toward the approved reference as sample count increases.
4. [ ] **PT-EVID-004** — Accumulation invalidation tests mutate every relevant input and prove no stale samples remain.
5. [ ] **PT-EVID-005** — A high-resolution Sequencer render exports the expected frame/AOV set, survives cancellation/resume and stays within the memory budget.
6. [ ] **PT-EVID-006** — Benchmarks separate BVH build/refit, traversal/shading, denoise, readback/export and peak memory on WebGPU and any TN-RT path.

### This is **not Done** when

- It is a screenshot effect supporting only a subset of Three.js materials.
- Scene/material changes continue accumulating into old samples.
- There is no deterministic sampler, analytic correctness suite or un-denoised output.
- The renderer cannot export HDR/AOVs or run fixed-frame Sequencer capture.
- The implementation assumes browser hardware ray tracing that WebGPU does not expose.

### Parity extensions — valuable, but not required for the first Stable release

1. [ ] **[PARITY] PT-P001** — Spectral rendering, polarization and physically measured camera/sensor response.
2. [ ] **[PARITY] PT-P002** — Bidirectional/path-guided integrators and production light transport features.
3. [ ] **[PARITY] PT-P003** — Distributed rendering and resumable cross-device sample accumulation.

### Primary research references

- [Epic — Path Tracer](https://dev.epicgames.com/documentation/en-us/unreal-engine/path-tracer-in-unreal-engine)
- [WebGPU specification](https://gpuweb.github.io/gpuweb/)
- [Three.js — TSL](https://threejs.org/docs/pages/TSL.html)
- [Khronos — glTF](https://registry.khronos.org/glTF/)

---

# Cross-system closure

No high-end subsystem is independently Done if its neighboring systems invalidate its result. The following integration requirements must pass before the full **ThreeNative UE5-class stack** can be described as production-ready.

## X1. Renderer integration

- [ ] **X-RENDER-001** — PostProcessing, TemporalUpscaler, DynamicGI, VirtualShadows, ManyLights, Volumetrics and Water execute through one render graph with declared resource dependencies.
- [ ] **X-RENDER-002** — LayeredMaterials produces consistent beauty, depth, shadow, motion, ID, GI/reflection and PathTracer behavior for the declared material matrix.
- [ ] **X-RENDER-003** — VirtualGeometry renders correctly into all promised passes and falls back per object for unsupported geometry/material features.
- [ ] **X-RENDER-004** — Temporal systems receive one authoritative camera-cut/teleport/origin-shift event and invalidate only their own histories.
- [ ] **X-RENDER-005** — Dynamic resolution changes propagate coherently to scene attachments, TemporalUpscaler, GI, reflections, volumetrics, post effects and picking.
- [ ] **X-RENDER-006** — Direct light, shadow, indirect diffuse, reflection, emission, atmosphere and post exposure are energy/composition tested to prevent double counting.
- [ ] **X-RENDER-007** — Transparent objects, particles, water and volumetrics have a documented ordering and lighting/fog path; no subsystem assumes it is the only transparency consumer.
- [ ] **X-RENDER-008** — Multiple cameras/render targets do not share temporal histories, page-demand buffers, exposure or culling state accidentally.
- [ ] **X-RENDER-009** — Device loss and renderer recreation rebuild shared resources in dependency order and leave the scene valid.
- [ ] **X-RENDER-010** — Debug modes from multiple systems can coexist or explicitly arbitrate without changing shipping output after they are disabled.

## X2. Asset, streaming, and world integration

- [ ] **X-WORLD-001** — One residency manager arbitrates WorldPartition cells, VirtualGeometry pages, VirtualTexture pages, audio streams and other large resources.
- [ ] **X-WORLD-002** — Streaming priorities share camera/player prediction and gameplay importance rather than independently saturating IO.
- [ ] **X-WORLD-003** — Cell activation/deactivation updates render geometry, collision, nav, PCG, Mass, audio, lights, GI representation, shadows, VFX and water in a defined order.
- [ ] **X-WORLD-004** — HLOD, VirtualGeometry and VirtualTexturing builders share source hashes and do not produce incompatible duplicate proxy data.
- [ ] **X-WORLD-005** — PCG output has deterministic cell ownership and can generate Mass entities, render instances and collision without per-element React objects.
- [ ] **X-WORLD-006** — Fast travel cancels obsolete work across every streaming subsystem and prioritizes a coherent minimal playable/visible set.
- [ ] **X-WORLD-007** — Large-world origin changes update physics, audio, VFX, water, animation, culling and temporal rendering in the same frame contract.
- [ ] **X-WORLD-008** — Save/load preserves authored and generated gameplay identity without serializing transient GPU cache state.
- [ ] **X-WORLD-009** — Asset-version mismatch produces a deterministic rebuild/migration/error path instead of partially loading stale runtime data.
- [ ] **X-WORLD-010** — A combined constrained-memory run proves global budget enforcement and absence of eviction ping-pong between subsystems.

## X3. Animation, simulation, audio, and timeline integration

- [ ] **X-SIM-001** — MotionMatching selects the base pose; ControlRig/IK layers apply in an explicit order; PhysicsSuite handoff/feedback does not create transform cycles.
- [ ] **X-SIM-002** — Current and previous transforms/poses are captured after the agreed simulation stages for correct motion vectors and temporal rendering.
- [ ] **X-SIM-003** — Sequencer can drive camera cuts, animation, rig controls, physics activation, VFX, audio, lights, materials and post effects with deterministic seek behavior.
- [ ] **X-SIM-004** — MetaAudio schedules Sequencer events against the audio clock and does not depend on render-frame timing.
- [ ] **X-SIM-005** — VFX and PhysicsSuite exchange bounded collision/damage/spawn events without recursive unbounded spawning.
- [ ] **X-SIM-006** — Water queries and buoyancy use the physics fixed step while rendered interpolation remains visually synchronized.
- [ ] **X-SIM-007** — Mass promotes/demotes agents to full scene/physics/animation representations without identity loss or duplicated transforms.
- [ ] **X-SIM-008** — Pause, time dilation, single-step, background/resume and long frame gaps have a documented effect on each clock domain.
- [ ] **X-SIM-009** — Capture mode can force deterministic fixed-step animation, physics, VFX, audio-offline rendering and temporal warm-up.
- [ ] **X-SIM-010** — Cross-system event queues are bounded, observable and tested under overflow.

## X4. Combined production acceptance scene

- [ ] **X-SCENE-001** — Maintain one redistributable “ThreeNative Production World” containing an interior/exterior transition, dense geometry, layered materials, dynamic sun/local lights, water, fog, VFX, animated characters, crowds and streamed cells.
- [ ] **X-SCENE-002** — The scene has a versioned deterministic camera/player route, interaction script, quality settings and reference captures.
- [ ] **X-SCENE-003** — The route exercises day/night lighting, camera cuts, fast travel, destruction, water entry, crowd promotion, VFX bursts, audio zones and world-origin movement.
- [ ] **X-SCENE-004** — Every feature exposes its counters into one machine-readable capture for the route.
- [ ] **X-SCENE-005** — The route passes visual-golden, functional-state, GPU-validation, memory, frame-time and streaming-deadline budgets on every declared platform tier.
- [ ] **X-SCENE-006** — A reduced TN-BASIC route proves graceful degradation and explicit feature fallbacks.
- [ ] **X-SCENE-007** — The scene can be built and run from a clean checkout with one documented command and no hidden licensed assets.
- [ ] **X-SCENE-008** — CI stores visual captures, traces, counters and failure diffs as release artifacts.

---

# Dependency-correct delivery order

The feature sections are sorted by effort-impact score. Actual execution must also respect shared infrastructure and technical dependencies.

## Raw effort-impact order

1. [`F1` — Post-processing](#f1) — impact 94, effort 3/10, score 89.8
2. [`F2` — Volumetrics / god rays](#f2) — impact 88, effort 5/10, score 79.6
3. [`F12` — Temporal upscaling / TSR-like](#f12) — impact 94, effort 6–7/10, score 79.3
4. [`F14` — Virtual Shadow Maps](#f14) — impact 96, effort 7/10, score 79.2
5. [`F3` — Niagara-like GPU VFX](#f3) — impact 90, effort 6/10, score 78.0
6. [`F17` — Virtualized geometry / Nanite-like](#f17) — impact 100, effort 8–9/10, score 77.5
7. [`F13` — Layered materials / Substrate-like](#f13) — impact 91, effort 6–7/10, score 77.2
8. [`F16` — Dynamic GI / Lumen-like](#f16) — impact 100, effort 9–10/10, score 74.5
9. [`F5` — PCG](#f5) — impact 80, effort 5/10, score 74.0
10. [`F9` — Motion Matching](#f9) — impact 84, effort 6/10, score 73.8
11. [`F4` — Water](#f4) — impact 75, effort 4/10, score 73.5
12. [`F18` — Many-light rendering / MegaLights-like](#f18) — impact 89, effort 7–8/10, score 72.8
13. [`F8` — World Partition / HLOD](#f8) — impact 79, effort 6/10, score 70.3
14. [`F11` — Control Rig / IK](#f11) — impact 77, effort 6/10, score 68.9
15. [`F6` — Mass / ECS crowds](#f6) — impact 68, effort 4/10, score 68.6
16. [`F7` — Sequencer](#f7) — impact 68, effort 4/10, score 68.6
17. [`F15` — Virtual Texturing](#f15) — impact 85, effort 8/10, score 68.5
18. [`F10` — Procedural audio](#f10) — impact 70, effort 5/10, score 67.0
19. [`F19` — Physics suite](#f19) — impact 82, effort 9/10 as a suite, score 63.4
20. [`F20` — Path tracer](#f20) — impact 60, effort 9–10/10, score 46.5

## Phase 0 — shared foundations

1. Capability registry and platform-tier contract
2. Shared render graph and scene-data buffers
3. Temporal-history service and authoritative camera-cut/origin-shift events
4. GPU resource/residency manager
5. Versioned asset-build framework and deterministic cache
6. Common diagnostics, benchmark manifest, profiler integration, and golden-test harness
7. Complete motion-vector/depth/normal/material-ID coverage for all supported renderable types

## Phase 1 — highest visual return

1. [`PostProcessing`](#f1)
2. [`Volumetrics`](#f2)
3. [`VFX`](#f3)
4. [`Water`](#f4)
5. Early [`TemporalUpscaler`](#f12) prototype using the shared velocity/history contract

This phase creates the fastest visible quality jump while proving render-graph composition, temporal history, compute workloads, scene attachments, transparency ordering, and declarative effect APIs.

## Phase 2 — image stability, materials, and shadows

1. Production [`TemporalUpscaler`](#f12)
2. [`LayeredMaterials`](#f13)
3. [`VirtualShadows`](#f14), beginning with a VSM-lite directional-light path
4. Minimal [`PathTracer`](#f20) correctness harness for material/light comparison—not its full Stable feature set

These are renderer multipliers: later GI, geometry, water, VFX, and many-light work depend on their correctness.

## Phase 3 — strategic renderer programs

Run these as parallel long-lead programs with explicitly staged closure rather than waiting for one to finish before starting the next:

1. [`VirtualGeometry`](#f17): meshlets → GPU culling → hierarchy/LOD → indirect submission → streaming
2. [`DynamicGI`](#f16): SSGI/SSR baseline → probes/world representation → off-screen contribution → robust denoising
3. [`ManyLights`](#f18): clustered baseline → bounded candidate sampling → scalable visibility/shadows → temporal reconstruction
4. Minimum [`VirtualTexturing`](#f15) page/residency infrastructure required by large-scene assets

## Phase 4 — world scale and procedural population

1. [`PCG`](#f5)
2. [`WorldPartition`](#f8)
3. [`Mass`](#f6)
4. Complete [`VirtualTexturing`](#f15)
5. Individually scoped [`PhysicsSuite`](#f19) modules: destruction, cloth, then vehicles; keep Rapier as the rigid-body core

`PCG`, `WorldPartition`, and `Mass` should share deterministic identity, cell ownership, residency, batching, and representation-LOD contracts rather than creating independent object graphs.

## Phase 5 — character, cinematic, and audio stack

1. [`MotionMatching`](#f9) database/build pipeline and runtime search
2. [`ControlRig`](#f11) solver/constraint stack and retargeting
3. [`Sequencer`](#f7) deterministic timeline, capture, and cross-system tracks
4. [`MetaAudio`](#f10) sample-accurate graph and Sequencer/audio-clock integration

MotionMatching and ControlRig should agree on pose ownership and evaluation order before either is declared Stable.

## Phase 6 — reference renderer and parity extensions

1. Complete the customer-facing [`PathTracer`](#f20)
2. Optional native RT acceleration behind capability flags
3. Advanced fluids, volumetric clouds, deformable geometry, hair/flesh, and other parity extensions
4. Editor-depth tooling once runtime contracts and asset formats are stable

## Parallelization rule

Parallel work is encouraged only where teams share written contracts for scene data, render-graph resources, histories, residency, material evaluation, transforms, and asset ownership. Two attractive prototypes that privately duplicate these foundations increase total effort and do not improve the Done score.

---

# Stable-release evidence template

Copy this block into the release issue/PR for each subsystem:

```md
## <Feature> Stable evidence

- Feature/version:
- Owner:
- Engine commit:
- Three.js revision:
- Runtime asset/build-tool version:
- Supported capability tiers:
- Supported platform/device matrix:
- Explicit exclusions:
- Canonical examples:
- Adversarial examples:
- Requirement IDs completed:
- Unit/integration test run:
- Visual-golden run:
- GPU validation run:
- Lifecycle/leak soak:
- Performance benchmark manifests:
- Memory/resource-pressure run:
- Device-loss/recovery run:
- Cross-system acceptance run:
- Known limitations:
- Rollback/disable mechanism:
- API documentation:
- Migration notes:
- Approval:
```

A status dashboard may summarize these records, but the evidence remains the source of truth.

---

# Research sources and implementation baselines

## Unreal Engine capability references

- [Lumen Global Illumination and Reflections](https://dev.epicgames.com/documentation/en-us/unreal-engine/lumen-global-illumination-and-reflections-in-unreal-engine)
- [Nanite Virtualized Geometry](https://dev.epicgames.com/documentation/en-us/unreal-engine/nanite-virtualized-geometry-in-unreal-engine)
- [Virtual Shadow Maps](https://dev.epicgames.com/documentation/en-us/unreal-engine/virtual-shadow-maps-in-unreal-engine)
- [Temporal Super Resolution](https://dev.epicgames.com/documentation/en-us/unreal-engine/temporal-super-resolution-in-unreal-engine)
- [MegaLights](https://dev.epicgames.com/documentation/en-us/unreal-engine/megalights-in-unreal-engine)
- [Substrate materials](https://dev.epicgames.com/documentation/en-us/unreal-engine/overview-of-substrate-materials-in-unreal-engine)
- [Niagara overview](https://dev.epicgames.com/documentation/en-us/unreal-engine/overview-of-niagara-effects-for-unreal-engine)
- [PCG overview](https://dev.epicgames.com/documentation/en-us/unreal-engine/procedural-content-generation-overview)
- [World Partition](https://dev.epicgames.com/documentation/en-us/unreal-engine/world-partition-in-unreal-engine)
- [Sequencer](https://dev.epicgames.com/documentation/en-us/unreal-engine/sequencer-cinematic-editor-unreal-engine)
- [Motion Matching](https://dev.epicgames.com/documentation/en-us/unreal-engine/motion-matching-in-unreal-engine)
- [Control Rig](https://dev.epicgames.com/documentation/en-us/unreal-engine/control-rig-in-unreal-engine)
- [MetaSounds](https://dev.epicgames.com/documentation/en-us/unreal-engine/metasounds-the-next-generation-sound-sources-in-unreal-engine)
- [Water Body Actors](https://dev.epicgames.com/documentation/en-us/unreal-engine/water-body-actors-in-unreal-engine)
- [Runtime Virtual Texturing](https://dev.epicgames.com/documentation/en-us/unreal-engine/runtime-virtual-texturing-in-unreal-engine)
- [Physics and Chaos](https://dev.epicgames.com/documentation/en-us/unreal-engine/physics-in-unreal-engine)
- [Path Tracer](https://dev.epicgames.com/documentation/en-us/unreal-engine/path-tracer-in-unreal-engine)

## Three.js and web-platform foundations

- [Three.js WebGPURenderer](https://threejs.org/docs/pages/WebGPURenderer.html)
- [Three.js WebGPU post-processing and MRT](https://threejs.org/manual/en/webgpu-postprocessing.html)
- [Three.js TSL](https://threejs.org/docs/pages/TSL.html)
- [Three.js ClusteredLighting](https://threejs.org/docs/pages/ClusteredLighting.html)
- [Three.js BatchedMesh](https://threejs.org/docs/pages/BatchedMesh.html)
- [Three.js IndirectStorageBufferAttribute](https://threejs.org/docs/pages/IndirectStorageBufferAttribute.html)
- [Three.js MeshPhysicalNodeMaterial](https://threejs.org/docs/pages/MeshPhysicalNodeMaterial.html)
- [Three.js CCDIKSolver](https://threejs.org/docs/pages/CCDIKSolver.html)
- [Three.js PositionalAudio](https://threejs.org/docs/pages/PositionalAudio.html)
- [WebGPU specification](https://gpuweb.github.io/gpuweb/)
- [Web Audio API](https://www.w3.org/TR/webaudio-1.0/)

## Asset and simulation foundations

- [Khronos glTF registry](https://registry.khronos.org/glTF/)
- [KTX 2.0 specification](https://registry.khronos.org/KTX/specs/2.0/ktxspec.v2.html)
- [KHR_texture_basisu](https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_texture_basisu)
- [meshoptimizer](https://github.com/zeux/meshoptimizer)
- [Rapier JavaScript documentation](https://rapier.rs/docs/user_guides/javascript/getting_started_js/)
- [ThreeNative physics package](https://www.npmjs.com/package/@threenative/physics)

---

# Final claim policy

ThreeNative may call an individual subsystem **Done** when its global, feature, evidence and applicable cross-system checkboxes pass.

ThreeNative should call the combined stack **UE5-class** only when the combined production scene passes its declared quality, performance, memory and platform targets. That phrase should describe a measured product capability—not the presence of similarly named demos.

# Repository crawl appendix

**Snapshot date:** 2026-08-30. Repository contents, package metadata and license files can change; re-run the intake gate against the pinned revision used by an implementation PR.

| Repository | Feature sections | Highest reuse score | Recommended uses | License status at research snapshot |
|---|---|---:|---|---|
| [dimforge/rapier](https://github.com/dimforge/rapier) | [F6](#f6), [F19](#f19) | **99** | Adopt promoted-agent physics; Adopt as rigid-body foundation | ✅ Apache-2.0 |
| [gkjohnson/three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer) | [F16](#f16), [F20](#f20) | **99** | Adopt as reference/oracle and share code; Fork/adopt primary implementation | ✅ MIT |
| [Three.js TSL and Node Materials](https://github.com/mrdoob/three.js) | [F13](#f13) | **99** | Adopt as runtime/compiler base | ✅ MIT |
| [zeux/meshoptimizer](https://github.com/zeux/meshoptimizer) | [F17](#f17) | **99** | Adopt offline/runtime utilities | ✅ MIT |
| [gkjohnson/three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) | [F17](#f17), [F16](#f16), [F5](#f5), [F8](#f8), [F20](#f20) | **98** | Adopt for acceleration and validation; Adopt shared software acceleration; Adopt spatial-query layer; Adopt spatial-query support; Adopt acceleration foundation | ✅ MIT |
| [jure/webgiya](https://github.com/jure/webgiya) | [F16](#f16), [F20](#f20) | **98** | Fork/port primary surfel-GI candidate; Port shared WebGPU BVH/compute patterns | ✅ MIT |
| [NASA-AMMOS/3DTilesRendererJS](https://github.com/NASA-AMMOS/3DTilesRendererJS) | [F17](#f17), [F8](#f8) | **98** | Port/adopt residency concepts; Adopt/fork traversal and cache modules | ✅ Apache-2.0 |
| [orangeduck/Motion-Matching](https://github.com/orangeduck/Motion-Matching) | [F9](#f9) | **98** | Port primary algorithm/reference implementation | ✅ MIT code; dataset has separate restrictions |
| [Three.js](https://github.com/mrdoob/three.js) | [F1](#f1), [F2](#f2), [F12](#f12), [F14](#f14), [F3](#f3), [F20](#f20) | **98** | Adopt as foundation; Adopt as frame-input foundation; Adopt rendering primitives; Adopt GPU foundation; Adopt scene/material/TSL base | ✅ MIT |
| [Three.js clustered lighting](https://github.com/mrdoob/three.js) | [F18](#f18) | **98** | Adopt as primary browser base | ✅ MIT |
| [Auburn/FastNoiseLite](https://github.com/Auburn/FastNoiseLite) | [F5](#f5) | **97** | Adopt procedural noise library | ✅ MIT |
| [pmndrs/upscaler](https://github.com/pmndrs/upscaler) | [F12](#f12) | **97** | Fork/adopt behind `TemporalUpscaler` | ✅ MIT |
| [Scthe/nanite-webgpu](https://github.com/Scthe/nanite-webgpu) | [F17](#f17) | **97** | Fork/port the prototype core | ✅ MIT |
| [shlomnissan/virtual-textures](https://github.com/shlomnissan/virtual-textures) | [F15](#f15) | **97** | Port primary VT prototype | ✅ MIT |
| [Tonejs/Tone.js](https://github.com/Tonejs/Tone.js) | [F10](#f10) | **97** | Adopt browser DSP/scheduling layer | ✅ MIT |
| [AcademySoftwareFoundation/MaterialX](https://github.com/AcademySoftwareFoundation/MaterialX) | [F13](#f13) | **95** | Adopt schema/interchange; map a subset | ✅ Apache-2.0 |
| [aiira-co/three-particles](https://github.com/aiira-co/three-particles) | [F3](#f3) | **95** | Evaluate, then fork/adopt GPU runtime | ✅ MIT |
| [BinomialLLC/basis_universal](https://github.com/BinomialLLC/basis_universal) | [F15](#f15) | **95** | Adopt encoder/transcoder tooling | ✅ Apache-2.0 |
| [isaac-mason/recast-navigation-js](https://github.com/isaac-mason/recast-navigation-js) | [F8](#f8), [F6](#f6) | **95** | Adopt streamed-navigation companion; Adopt navigation/crowd layer | ✅ MIT |
| [reed-soul/SeedOcean](https://github.com/reed-soul/SeedOcean) | [F4](#f4) | **95** | Fork/evaluate broad ocean stack | ✅ MIT |
| [kmammou/v-hacd](https://github.com/kmammou/v-hacd) | [F19](#f19) | **94** | Adopt offline convex decomposition | ✅ BSD-3-Clause |
| [takram-design-engineering/three-geospatial](https://github.com/takram-design-engineering/three-geospatial) | [F2](#f2) | **94** | Fork/port rendering modules | ✅ MIT |
| [Alchemist0823/three.quarks](https://github.com/Alchemist0823/three.quarks) | [F3](#f3) | **93** | Adopt/port authoring and asset model | ✅ MIT |
| [hmans/miniplex](https://github.com/hmans/miniplex) | [F6](#f6) | **93** | Evaluate/adopt ergonomic ECS | ✅ MIT |
| [owenyuwono/poseidon](https://github.com/owenyuwono/poseidon) | [F4](#f4) | **93** | Fork/port TSL ocean kernels | ✅ MIT |
| [Three.js animation system](https://github.com/mrdoob/three.js) | [F9](#f9), [F7](#f7) | **93** | Adopt playback foundation; Adopt clip/track foundation | ✅ MIT |
| [Three.js CCDIKSolver/Skeleton](https://github.com/mrdoob/three.js) | [F11](#f11) | **93** | Adopt core skeleton and CCD path | ✅ MIT |
| [KhronosGroup/KTX-Software](https://github.com/KhronosGroup/KTX-Software) | [F15](#f15) | **92** | Adopt selected KTX2 tools/runtime files | ⚠️ Mostly Apache-2.0; verify SPDX per file |
| [pixiv/three-vrm](https://github.com/pixiv/three-vrm) | [F9](#f9), [F11](#f11) | **92** | Adopt retargeting/humanoid utilities; Adopt optional humanoid/retarget layer | ✅ MIT |
| [playcanvas/engine](https://github.com/playcanvas/engine) | [F18](#f18) | **92** | Port/reference production light clustering | ✅ MIT |
| [pmndrs/postprocessing](https://github.com/pmndrs/postprocessing) | [F1](#f1) | **92** | Adopt where compatible; port WebGPU gaps | ✅ Zlib |
| [Sunset-Flock/Timberdoodle](https://github.com/Sunset-Flock/Timberdoodle) | [F14](#f14) | **92** | Port sparse-page algorithms | ✅ Apache-2.0 |
| [visgl/loaders.gl](https://github.com/visgl/loaders.gl) | [F8](#f8) | **92** | Adopt selected loaders/worker infrastructure | ✅ MIT with Apache-2.0/third-party notices |
| [dgreenheck/three-pinata](https://github.com/dgreenheck/three-pinata) | [F19](#f19) | **91** | Adopt/port runtime fracture and slicing | ✅ MIT |
| [NateTheGreatt/bitECS](https://github.com/NateTheGreatt/bitECS) | [F6](#f6) | **91** | Evaluate/adopt data-oriented core | ⚠️ MPL-2.0 file-level copyleft |
| [retejs/rete](https://github.com/retejs/rete) | [F5](#f5), [F11](#f11), [F10](#f10) | **91** | Adopt graph/runtime infrastructure; Adopt for editor graph only; Adopt graph editor/runtime tooling | ✅ MIT |
| [standardized-audio-context](https://github.com/chrisguttandin/standardized-audio-context) | [F10](#f10) | **91** | Adopt browser compatibility layer | ✅ MIT |
| [Three.js BatchedMesh/InstancedMesh/compute](https://github.com/mrdoob/three.js) | [F6](#f6) | **91** | Adopt representation foundation | ✅ MIT |
| [tweenjs/tween.js](https://github.com/tweenjs/tween.js) | [F7](#f7) | **91** | Adopt interpolation/easing utility | ✅ MIT |
| [mmp/pbrt-v4](https://github.com/mmp/pbrt-v4) | [F20](#f20) | **90** | Use as correctness oracle/reference | ✅ Apache-2.0 |
| [Theatre.js core](https://github.com/theatre-js/theatre) | [F7](#f7) | **90** | Adopt/reference permissive core packages | ✅ Apache-2.0 at repository/core level |
| [Ameobea/three-good-godrays](https://github.com/Ameobea/three-good-godrays) | [F2](#f2) | **89** | Port the light-shaft pass | ✅ Permissive custom license |
| [CesiumGS/cesium](https://github.com/CesiumGS/cesium) | [F8](#f8) | **89** | Study/port mature streaming policy | ✅ Apache-2.0 |
| [google/filament](https://github.com/google/filament) | [F13](#f13), [F18](#f18) | **89** | Port/reference BRDF and quality policy; Study/port froxel and mobile-lighting ideas | ✅ Apache-2.0 |
| [jsantell/THREE.IK](https://github.com/jsantell/THREE.IK) | [F11](#f11) | **89** | Port/adopt FABRIK and chain model | ✅ MIT |
| [pmndrs/react-three-rapier](https://github.com/pmndrs/react-three-rapier) | [F19](#f19) | **89** | Port React lifecycle/API patterns | ✅ MIT |
| [Three.js water examples/primitives](https://github.com/mrdoob/three.js) | [F4](#f4) | **89** | Adopt base materials/examples | ✅ MIT |
| [xyflow/xyflow](https://github.com/xyflow/xyflow) | [F5](#f5) | **89** | Adopt authoring canvas | ✅ MIT |
| [erichlof/THREE.js-PathTracing-Renderer](https://github.com/erichlof/THREE.js-PathTracing-Renderer) | [F20](#f20) | **87** | Port/reference broad renderer features | ✅ CC0-1.0 |
| [gkjohnson/three-bvh-csg](https://github.com/gkjohnson/three-bvh-csg) | [F5](#f5), [F19](#f19) | **87** | Adopt/port geometry operators; Adopt for cutting/Boolean tooling | ✅ MIT |
| [Three.js Audio/PositionalAudio](https://github.com/mrdoob/three.js) | [F10](#f10) | **87** | Adopt scene-listener/spatial bridge | ✅ MIT |
| [0beqz/realism-effects](https://github.com/0beqz/realism-effects) | [F1](#f1), [F12](#f12), [F16](#f16) | **86** | Port selected algorithms; Port temporal utilities; Port screen-space baseline | ✅ MIT |
| [jeantimex/threejs-water](https://github.com/jeantimex/threejs-water) | [F4](#f4) | **86** | Port local-wave and caustic modules | ✅ MIT |
| [TheRealMJP/Shadows](https://github.com/TheRealMJP/Shadows) | [F14](#f14) | **86** | Port/reference shadow quality | ✅ MIT |
| [motion-canvas/motion-canvas](https://github.com/motion-canvas/motion-canvas) | [F7](#f7) | **85** | Port/reference evaluator and capture concepts | ✅ MIT |
| [BabylonJS/Babylon.js](https://github.com/BabylonJS/Babylon.js) | [F13](#f13), [F16](#f16), [F5](#f5) | **84** | Study/port node-material and PBR patterns; Study/port WebGPU GI approaches; Study node-geometry architecture | ✅ Apache-2.0 |
| [pmndrs/react-postprocessing](https://github.com/pmndrs/react-postprocessing) | [F1](#f1) | **84** | Port API/lifecycle patterns | ✅ MIT |
| [AMD FidelityFX SDK](https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK) | [F12](#f12) | **83** | Port/reference selected algorithms | ⚠️ Verify license and third-party notices per pinned file |
| [jeantimex/fluid](https://github.com/jeantimex/fluid) | [F4](#f4), [F19](#f19) | **83** | Port optional fluid kernels; Port optional GPU fluid kernels | ✅ MIT |
| [joshbrew/webgpu_realtime_clouds](https://github.com/joshbrew/webgpu_realtime_clouds) | [F2](#f2) | **83** | Port compute/ray-march kernels | ✅ MIT |
| [jrouwe/JoltPhysics](https://github.com/jrouwe/JoltPhysics) | [F19](#f19) | **83** | Study/optional native module | ✅ MIT |
| [ebeaufay/threedtiles](https://github.com/ebeaufay/threedtiles) | [F8](#f8) | **81** | Port supplemental tile techniques | ✅ MIT |
| [jbouny/fft-ocean](https://github.com/jbouny/fft-ocean) | [F4](#f4) | **81** | Port/reference FFT correctness | ✅ MIT |
| [lo-th/fullik](https://github.com/lo-th/fullik) | [F11](#f11) | **81** | Port/reference alternate FABRIK | ✅ MIT |
| [THREE-CustomShaderMaterial](https://github.com/FarazzShaikh/THREE-CustomShaderMaterial) | [F13](#f13) | **80** | Adopt/port extension seams | ✅ MIT |
| [creativelifeform/three-nebula](https://github.com/creativelifeform/three-nebula) | [F3](#f3) | **79** | Port stable abstractions selectively | ✅ MIT |
| [donmccurdy/three-pathfinding](https://github.com/donmccurdy/three-pathfinding) | [F6](#f6) | **79** | Adopt as lightweight fallback/tool | ✅ MIT |
| [google/motive](https://github.com/google/motive) | [F9](#f9), [F11](#f11) | **77** | Study/port low-level animation math; Study efficient evaluation/blending | ✅ Apache-2.0 |
| [grame-cncm/faustwasm](https://github.com/grame-cncm/faustwasm) | [F10](#f10) | **77** | Optional isolated compiler/plugin | ⚠️ LGPL-3.0 |
| [alipbcs/ZetaRay](https://github.com/alipbcs/ZetaRay) | [F18](#f18) | **76** | Study/port for optional native RT tier | ✅ MIT |
| [retejs/rete / xyflow](https://github.com/xyflow/xyflow) | [F7](#f7) | **76** | Adopt editor infrastructure selectively | ✅ MIT |
| [Themaister/Granite](https://github.com/Themaister/Granite) | [F14](#f14), [F15](#f15) | **75** | Study/port utility patterns; Study residency/resource systems | ✅ MIT |
| [ConfettiFX/The-Forge](https://github.com/ConfettiFX/The-Forge) | [F14](#f14), [F15](#f15) | **72** | Study native backend patterns; Study native sparse-resource backend | ✅ Apache-2.0 |
| [aatishb/drape](https://github.com/aatishb/drape) | [F19](#f19) | **69** | Study/port cloth constraints | ✅ MIT |
| [EmbarkStudios/kajiya](https://github.com/EmbarkStudios/kajiya) | [F12](#f12), [F17](#f17), [F16](#f16) | **69** | Study only; Study temporal GI architecture | 🧊 Apache-2.0/MIT; archived |
| [pmndrs/lamina](https://github.com/pmndrs/lamina) | [F13](#f13) | **56** | Study declarative layer API only | 🧊 MIT; archived |
| [Theatre.js Studio](https://github.com/theatre-js/theatre/tree/main/packages/studio) | [F7](#f7) | **48** | Do not embed without explicit copyleft strategy | ⚠️ AGPL-3.0 |
| [NVIDIA RTXDI](https://github.com/NVIDIAGameWorks/RTXDI) | [F18](#f18) | **45** | Legal-review/study only | ⚠️ NVIDIA RTX SDK license |
| [seanhlewis/three-meshlet](https://github.com/seanhlewis/three-meshlet) | [F17](#f17) | **45** | Blocked for copying; study API/demo | ⛔ Package references a missing repository license |
| [Ameobea/three-volumetric-pass](https://github.com/Ameobea/three-volumetric-pass) | [F2](#f2) | **35** | Blocked; study behavior only | ⛔ No usable repository license found |
| [toji/webgpu-clustered-shading](https://github.com/toji/webgpu-clustered-shading) | [F18](#f18) | **35** | Blocked; study demo only | ⛔ No usable repository license found |
| [carloskiki/wgpu-virtual-texturing](https://github.com/carloskiki/wgpu-virtual-texturing) | [F15](#f15) | **30** | Blocked; study demo only | ⛔ No usable repository license found |
| [daikiad/webgpu-path-tracer](https://github.com/daikiad/webgpu-path-tracer) | [F20](#f20) | **30** | Blocked; study demo only | ⛔ No usable repository license found |
| [Nekuzaky/kinema-motion-matching](https://github.com/Nekuzaky/kinema-motion-matching) | [F9](#f9) | **30** | Blocked; study behavior only | ⛔ No usable repository license found |
| [octoon/UnityVSM](https://github.com/octoon/UnityVSM) | [F14](#f14) | **30** | Blocked; study behavior only | ⛔ No usable repository license found |
| [NVIDIAGameWorks/Blast](https://github.com/NVIDIAGameWorks/Blast) | [F19](#f19) | **0** | Blocked | ⛔ Restrictive NVIDIA repository license |

## Repository research closure checklist

1. [ ] Every feature has at least one viable permissive starting point or is explicitly marked build-in-house.
2. [ ] Every no-license or restrictive candidate is marked **Blocked** and excluded from source-copy plans.
3. [ ] Every archived candidate is treated as a frozen reference rather than a maintained dependency.
4. [ ] Every copyleft, SDK-specific or mixed-license candidate has an explicit isolation and legal-review plan.
5. [ ] Every direct dependency has an owner, update cadence, compatibility matrix and exit strategy.
6. [ ] Every port/fork records upstream commit hashes, copied-file provenance and retained notices.
7. [ ] Repository reuse is mapped to passing feature requirements—not to reproducing a showcase demo.

---

_End of repository reuse map._
