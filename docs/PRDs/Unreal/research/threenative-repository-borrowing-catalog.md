# ThreeNative Repository Borrowing Catalog

**Research snapshot:** 2026-08-30  
**Scope:** Curated implementation candidates for the 20 UE5-class ThreeNative feature checklists.  
**Companion specification:** `threenative-ue5-feature-checklists-and-repo-scan.md`

> This is a technical triage catalog, not legal clearance. Re-check the pinned commit, every reused file, third-party notices, assets and submodules before adoption. Repositories with no detected license or proprietary terms are reference-only unless explicit permission/legal approval is obtained.

## Decision legend

- **ADOPT / WRAP:** direct dependency behind a ThreeNative adapter.
- **FORK / PORT:** maintain a pinned fork or translate meaningful source into a ThreeNative module.
- **MINE:** borrow algorithms, data models, tests or API ideas selectively.
- **REFERENCE:** compare behavior and quality; do not make it runtime source.
- **WATCH:** promising but immature, unstable or insufficiently licensed.

## Portfolio summary

- **Feature mappings:** 119
- **Unique repositories:** 90
- **Feature domains:** 20

## Unique repository index

| Repository | Used by features | Best observed fit | License posture(s) | Primary value |
|---|---|---:|---|---|
| [AcademySoftwareFoundation/MaterialX](https://github.com/AcademySoftwareFoundation/MaterialX) | F13 | **5/5** | Apache-2.0 | Portable material graph representation, node definitions, standard libraries, validation and interchange. |
| [AcademySoftwareFoundation/OpenPBR](https://github.com/AcademySoftwareFoundation/OpenPBR) | F13 | **5/5** | Apache-2.0 | Consistent artist-facing parameter model for layered physically based materials. |
| [BinomialLLC/basis_universal](https://github.com/BinomialLLC/basis_universal) | F15 | **5/5** | Apache-2.0 | GPU texture compression/transcoding, mip processing and compact streamable source assets. |
| [CesiumGS/cesium](https://github.com/CesiumGS/cesium) | F14, F8, F15 | **5/5** | Apache-2.0 | Battle-tested quadtree/tileset traversal, priority scheduling, cache pressure, origin precision and failure handling. |
| [cl0nazepamm/speedball](https://github.com/cl0nazepamm/speedball) | F16 | **5/5** | MIT | Current Three.js WebGPU dynamic GI add-on, update lanes, diagnostics, reflections and clustered-light integration. |
| [dimforge/rapier](https://github.com/dimforge/rapier) | F19 | **5/5** | Apache-2.0; verify crate/package grant | Rigid bodies, colliders, joints, character controllers, queries, determinism controls and WASM/native parity base. |
| [elemaudio/elementary](https://github.com/elemaudio/elementary) | F10 | **5/5** | MIT | Declarative DSP graph, graph diffing, native/web runtimes and render-thread-safe parameter updates. |
| [gkjohnson/three-bvh-csg](https://github.com/gkjohnson/three-bvh-csg) | F5, F19 | **5/5** | MIT | Fast CSG/boolean geometry node implementation built on three-mesh-bvh. |
| [gkjohnson/three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer) | F1, F16, F20 | **5/5** | MIT | Three.js material/scene conversion, BVH-based path tracing, accumulation, environment lighting, denoising hooks and reference captures. |
| [gkjohnson/three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) | F17, F8, F20 | **5/5** | MIT | BVH construction, serialization, refit, traversal utilities and spatial-query validation. |
| [GPUOpen-LibrariesAndSDKs/FidelityFX-SDK](https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK) | F12 | **5/5** | MIT; third-party notices apply | Authoritative FSR pass ordering, constants, quality modes, reactive masks, exposure and reconstruction math. |
| [hmans/miniplex](https://github.com/hmans/miniplex) | F6 | **5/5** | MIT | Developer-friendly typed ECS queries, archetype/world organization and React-friendly integration. |
| [jure/webgiya](https://github.com/jure/webgiya) | F16 | **5/5** | MIT | WebGPU + Three.js surfel GI, cascaded spatial hash grids, surfel lifecycle, BVH tracing, temporal moments, denoising and resolve/composite passes. |
| [KhronosGroup/KTX-Software](https://github.com/KhronosGroup/KTX-Software) | F15 | **5/5** | Apache-2.0 | KTX2 creation, validation, metadata, mip chains and Basis/UASTC packaging. |
| [mrdoob/three.js](https://github.com/mrdoob/three.js) | F1, F2, F12, F14, F3, F13, F16, F9, F4, F18, F11, F7, F15 | **5/5** | MIT | WebGPURenderer, TSL, PostProcessing, MRT attachments, tone mapping, depth/normal/velocity/emissive outputs. |
| [Mugen87/yuka](https://github.com/Mugen87/yuka) | F6 | **5/5** | MIT | Steering, perception, goals, state machines, spatial partitioning and game-AI utilities. |
| [mustache-dev/Three-VFX](https://github.com/mustache-dev/Three-VFX) | F3 | **5/5** | MIT | WebGPU compute particles, emitter shapes, curves, sprites/meshes, turbulence, attractors, collisions, PBR particles and CPU fallback. |
| [NASA-AMMOS/3DTilesRendererJS](https://github.com/NASA-AMMOS/3DTilesRendererJS) | F8 | **5/5** | Apache-2.0 | Three.js-native hierarchical tileset traversal, screen-space error, request scheduling, cache eviction, loaders and large-scene streaming. |
| [NVIDIA-RTX/RTXDI](https://github.com/NVIDIA-RTX/RTXDI) | F18 | **5/5** | Proprietary NVIDIA RTX SDK license | Authoritative ReSTIR DI reservoir layout, temporal/spatial reuse, light sampling and validation concepts. |
| [orangeduck/Motion-Matching](https://github.com/orangeduck/Motion-Matching) | F9 | **5/5** | MIT | Canonical motion-matching database build, feature normalization, trajectory matching, inertialization and runtime search. |
| [pmndrs/postprocessing](https://github.com/pmndrs/postprocessing) | F1 | **5/5** | Zlib | Composer architecture, effect lifecycle, bloom, SMAA, DOF, GTAO/SSR patterns, selection masks, pass fusion ideas. |
| [pmndrs/react-three-rapier](https://github.com/pmndrs/react-three-rapier) | F19 | **5/5** | MIT | React lifecycle, declarative bodies/colliders/joints, event mapping, instancing and debug rendering patterns. |
| [pmndrs/upscaler](https://github.com/pmndrs/upscaler) | F1, F12 | **5/5** | MIT | Shared temporal guides, jitter, reactive masks, exposure handling, disocclusion, history reset, RCAS and TSL integration. |
| [recastnavigation/recastnavigation](https://github.com/recastnavigation/recastnavigation) | F6 | **5/5** | Zlib | Navmesh generation, Detour pathfinding, crowd agents, avoidance and industry-proven navigation data. |
| [reed-soul/SeedOcean](https://github.com/reed-soul/SeedOcean) | F4 | **5/5** | MIT | Three.js/WebGPU FFT ocean, cascades, foam, buoyancy queries, underwater effects, spray/rain and WebGL fallback. |
| [Scthe/nanite-webgpu](https://github.com/Scthe/nanite-webgpu) | F17 | **5/5** | MIT | Meshlet LOD hierarchy, meshoptimizer/METIS preprocessing, GPU instance/meshlet culling, Hi-Z occlusion, software rasterization, impostors, quantization and diagnostics. |
| [shlomnissan/virtual-textures](https://github.com/shlomnissan/virtual-textures) | F14, F15 | **5/5** | MIT | Modern virtual-texture page tables, feedback, cache allocation, LRU/residency logic and visualization. |
| [SkyeShark/Eanpa-Sky](https://github.com/SkyeShark/Eanpa-Sky) | F2 | **5/5** | MIT; inspect bundled assets | WebGPU/TSL sky, atmosphere, volumetric clouds, weather and physically based scattering patterns. |
| [Sunset-Flock/Timberdoodle](https://github.com/Sunset-Flock/Timberdoodle) | F2, F14, F17 | **5/5** | Apache-2.0 | Virtual/physical page tables, GPU page allocation, dirty tracking, page caching, wraparound cascades and hierarchical dirty-page culling. |
| [theatre-js/theatre](https://github.com/theatre-js/theatre) | F7 | **5/5** | Apache-2.0 | Timeline/editor architecture, object bindings, keyframes, sheets, sequencing and React/Three integrations. |
| [Tonejs/Tone.js](https://github.com/Tonejs/Tone.js) | F10 | **5/5** | MIT | Web Audio graph nodes, transport/scheduling, synthesis, effects, automation and browser audio lifecycle. |
| [travisdmathis/plume](https://github.com/travisdmathis/plume) | F3 | **5/5** | MIT | Niagara-like VFX data model, authoring/editor concepts, emitters, modules and effect serialization. |
| [zeux/meshoptimizer](https://github.com/zeux/meshoptimizer) | F17 | **5/5** | MIT | Meshlet generation, simplification/error metrics, vertex/index optimization and geometry compression for the asset pipeline. |
| [0beqz/realism-effects](https://github.com/0beqz/realism-effects) | F1, F12, F16 | **4/5** | MIT | TRAA, motion blur, SSGI, velocity handling, temporal accumulation and denoising patterns. |
| [achrefelouafi/BuildingGeneratorThreeJS](https://github.com/achrefelouafi/BuildingGeneratorThreeJS) | F5 | **4/5** | MIT | Procedural building grammar, parameterized mesh generation and Three.js authoring patterns. |
| [adobe/openpbr-bsdf](https://github.com/adobe/openpbr-bsdf) | F13 | **4/5** | Apache-2.0; verify at pin | Reference BSDF evaluation, layer interactions and conformance cases for OpenPBR. |
| [Ameobea/three-volumetric-pass](https://github.com/Ameobea/three-volumetric-pass) | F2 | **4/5** | No license detected | Screen-space volumetric raymarching, light-volume integration and compositing ideas for a first prototype. |
| [CesiumGS/3d-tiles-tools](https://github.com/CesiumGS/3d-tiles-tools) | F8 | **4/5** | Apache-2.0 | Offline tileset generation, conversion, optimization, validation and metadata handling. |
| [daybrush/scenejs](https://github.com/daybrush/scenejs) | F7 | **4/5** | MIT | Keyframe tracks, easing, nested timelines, iteration and serialization. |
| [dgreenheck/ez-tree](https://github.com/dgreenheck/ez-tree) | F5 | **4/5** | MIT | Production-friendly procedural vegetation generation, seeded parameters and export/runtime integration. |
| [donmccurdy/three-pathfinding](https://github.com/donmccurdy/three-pathfinding) | F6 | **4/5** | MIT | Pure-JS Three.js navmesh zones and pathfinding for basic/browser fallback scenarios. |
| [erichlof/THREE.js-PathTracing-Renderer](https://github.com/erichlof/THREE.js-PathTracing-Renderer) | F20 | **4/5** | MIT; verify at pin | Large library of path-traced scenes/materials, accumulation, camera models and shader techniques. |
| [godotengine/godot](https://github.com/godotengine/godot) | F16 | **4/5** | MIT | Voxel/SDFGI architecture, probe update budgets, cascades, temporal filtering and debug tooling. |
| [goldst/IK.ts](https://github.com/goldst/IK.ts) | F11 | **4/5** | MIT; verify at pin | Typed inverse-kinematics algorithms and constraint modeling. |
| [google/filament](https://github.com/google/filament) | F12, F13, F18 | **4/5** | Apache-2.0 | Production PBR implementation, material compiler, IBL, clearcoat, sheen, transmission and mobile quality tiers. |
| [google/motive](https://github.com/google/motive) | F9, F11 | **4/5** | Apache-2.0 | Compact animation runtime, curve evaluation, skeleton blending and mobile-oriented data layout. |
| [GoogleChromeLabs/web-audio-samples](https://github.com/GoogleChromeLabs/web-audio-samples) | F10 | **4/5** | Apache-2.0 | AudioWorklet patterns, low-latency processing, scheduling and browser edge-case examples. |
| [grame-cncm/faust](https://github.com/grame-cncm/faust) | F10 | **4/5** | GPL/LGPL-family and component-specific terms | DSP language/compiler, optimized generated processors and a large library of audio algorithms. |
| [InteractiveComputerGraphics/PositionBasedDynamics](https://github.com/InteractiveComputerGraphics/PositionBasedDynamics) | F19 | **4/5** | MIT | XPBD cloth, rods, soft bodies, fluids and constraint solvers. |
| [jbouny/fft-ocean](https://github.com/jbouny/fft-ocean) | F4 | **4/5** | MIT; verify at pin | Classic Three.js FFT ocean architecture, spectrum update and displacement/normal generation. |
| [jeantimex/procedural-clouds](https://github.com/jeantimex/procedural-clouds) | F2 | **4/5** | MIT | WebGPU volumetric cloud raymarching, density/noise fields, lighting and weather-oriented controls. |
| [jeantimex/threejs-water](https://github.com/jeantimex/threejs-water) | F4 | **4/5** | MIT; verify at pin | Interactive water surface, refraction/reflection, caustics and object-water interaction patterns. |
| [jrouwe/JoltPhysics](https://github.com/jrouwe/JoltPhysics) | F19 | **4/5** | MIT | High-performance rigid bodies, characters, vehicles, constraints and multithreading architecture. |
| [jsantell/THREE.IK](https://github.com/jsantell/THREE.IK) | F11 | **4/5** | MIT | Three.js FABRIK-style chains, constraints, targets and solver visualization. |
| [jspdown/cloth](https://github.com/jspdown/cloth) | F19 | **4/5** | No license detected; verify | WebGPU XPBD cloth implementation and GPU constraint-solve patterns. |
| [kchapelier/poisson-disk-sampling](https://github.com/kchapelier/poisson-disk-sampling) | F5 | **4/5** | MIT | Deterministic 2D/3D blue-noise placement for scatter nodes. |
| [lo-th/fullik](https://github.com/lo-th/fullik) | F11 | **4/5** | MIT; verify at pin | Full-body/FABRIK chain solving and joint constraints in JavaScript. |
| [mitsuba-renderer/mitsuba3](https://github.com/mitsuba-renderer/mitsuba3) | F20 | **4/5** | BSD-3-Clause | Differentiable/production path tracing, emitters, media, BSDFs and scene validation. |
| [mmp/pbrt-v4](https://github.com/mmp/pbrt-v4) | F20 | **4/5** | BSD-2-Clause | Physically based transport, BSDFs, sampling, cameras and authoritative reference images. |
| [nackdai/aten](https://github.com/nackdai/aten) | F18 | **4/5** | MIT | ReSTIR/SVGF/path-tracing research code useful for reservoir sampling, reuse and denoising concepts. |
| [NateTheGreatt/bitECS](https://github.com/NateTheGreatt/bitECS) | F6 | **4/5** | MPL-2.0 | Data-oriented SoA components, high-throughput queries and compact entity storage. |
| [NVIDIA-Omniverse/Blast](https://github.com/NVIDIA-Omniverse/Blast) | F19 | **4/5** | BSD/custom notices; verify at pin | Fracture graphs, damage propagation, chunk activation and destruction workflows. |
| [NVIDIA-Omniverse/PhysX](https://github.com/NVIDIA-Omniverse/PhysX) | F19 | **4/5** | BSD-3-Clause | Vehicles, articulations, scene queries, contact generation and production physics test cases. |
| [octoon/UnityVSM](https://github.com/octoon/UnityVSM) | F14 | **4/5** | No license detected | A second implementation of virtual shadow page marking, allocation and rendering behavior. |
| [pixiv/three-vrm](https://github.com/pixiv/three-vrm) | F9, F11 | **4/5** | MIT | Humanoid rig mapping, look-at, expressions, spring bones and standardized character integration. |
| [playcanvas/engine](https://github.com/playcanvas/engine) | F18 | **4/5** | MIT | Production web clustered lighting, cookie/shadow handling, light textures, quality tiers and browser performance lessons. |
| [potree/potree](https://github.com/potree/potree) | F8 | **4/5** | BSD-style; verify notices | Octree traversal, point-budget scheduling, out-of-core loading, LOD and large-coordinate handling. |
| [retejs/rete](https://github.com/retejs/rete) | F5 | **4/5** | MIT | Extensible node editor and graph-processing plugin model. |
| [RustAudio/cpal](https://github.com/RustAudio/cpal) | F10 | **4/5** | MIT OR Apache-2.0 | Cross-platform native audio device/stream abstraction. |
| [seanhlewis/three-meshlet](https://github.com/seanhlewis/three-meshlet) | F17 | **4/5** | No license detected | Three.js-oriented meshlet and multi-LOD experiments close to ThreeNative’s desired integration surface. |
| [squall01337/abyssal-ocean](https://github.com/squall01337/abyssal-ocean) | F4 | **4/5** | MIT | Compact spectral FFT ocean, JONSWAP/TMA spectra, three cascades, physical foam, caustics and underwater rendering. |
| [SreeXD/Three-PT](https://github.com/SreeXD/Three-PT) | F20 | **4/5** | MIT | WIP Three.js WebGPU path tracer, GPU LBVH and modern WebGPU integration ideas. |
| [tweenjs/tween.js](https://github.com/tweenjs/tween.js) | F7 | **4/5** | MIT | Compact interpolation/easing runtime and predictable update control. |
| [visgl/loaders.gl](https://github.com/visgl/loaders.gl) | F8 | **4/5** | MIT | Worker-based streaming parsers, binary loading, cancellation and format plugin architecture. |
| [wayne-wu/webgpu-crowd-simulation](https://github.com/wayne-wu/webgpu-crowd-simulation) | F6 | **4/5** | BSD-3-Clause | WebGPU crowd simulation, GPU position-based dynamics/avoidance and render integration. |
| [wwwtyro/speck-pbr](https://github.com/wwwtyro/speck-pbr) | F20 | **4/5** | MIT | Compact WebGPU path-traced PBR example and WGSL compute/ray traversal patterns. |
| [xyflow/xyflow](https://github.com/xyflow/xyflow) | F5 | **4/5** | MIT | Node-graph editing, connection validation, selection, layout and React authoring UI. |
| [xzdarcy/react-timeline-editor](https://github.com/xzdarcy/react-timeline-editor) | F7 | **4/5** | MIT | React timeline lanes, drag/resize interactions, markers and editing controls. |
| [AIFanatic/three-nanite](https://github.com/AIFanatic/three-nanite) | F17 | **3/5** | MIT | Earlier Three.js Nanite-style experiments, scene/API integration and practical renderer constraints. |
| [Ameobea/three-good-godrays](https://github.com/Ameobea/three-good-godrays) | F2 | **3/5** | No license detected | Depth-aware light-shaft reconstruction, occlusion and temporal/composition ideas. |
| [core-code/LibVT](https://github.com/core-code/LibVT) | F15 | **3/5** | No clear reusable license detected | Classic virtual-texturing architecture, feedback buffers, page caches and offline tiling concepts. |
| [creativelifeform/three-nebula](https://github.com/creativelifeform/three-nebula) | F3 | **3/5** | MIT | Mature emitter/initializer/behavior architecture, JSON configuration and WebGL-compatible fallback ideas. |
| [motion-canvas/motion-canvas](https://github.com/motion-canvas/motion-canvas) | F7 | **3/5** | MIT | Code-driven timeline, deterministic playback, editor transport and render/export workflow. |
| [Nekuzaky/kinema-motion-matching](https://github.com/Nekuzaky/kinema-motion-matching) | F9 | **3/5** | Verify before use | Modern motion-matching implementation ideas and a second point of comparison for search/features. |
| [NewKrok/three-particles](https://github.com/NewKrok/three-particles) | F3 | **3/5** | MIT | TypeScript emitter API, serialization-friendly particle behaviors and lower-tier Three.js integration. |
| [orangeduck/lafan1-resolved](https://github.com/orangeduck/lafan1-resolved) | F9 | **3/5** | Dataset/provenance terms require verification | Motion corpus and preprocessing conventions useful for prototype quality and regression tests. |
| [PavelDoGreat/WebGL-Fluid-Simulation](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation) | F4 | **3/5** | MIT | Stable grid-fluid advection, pressure solve, splats and visual-fluid interaction for specialized local water/smoke modules. |
| [pmndrs/lamina](https://github.com/pmndrs/lamina) | F13 | **3/5** | MIT | Ergonomic declarative material-layer API and React integration patterns. |
| [RustAudio/rodio](https://github.com/RustAudio/rodio) | F10 | **3/5** | MIT OR Apache-2.0 | Native playback, decoding, sinks and mixer patterns on top of cpal. |
| [wizgrav/cl2](https://github.com/wizgrav/cl2) | F18 | **3/5** | Verify before use | Compute-less clustered lighting suitable as a TN-BASIC/WebGL fallback reference. |

## Feature-by-feature scan

### 1. F1 — Cinematic post-processing stack

| Candidate | Mode | Fit | License | Borrow | Caveat |
|---|---|---:|---|---|---|
| [mrdoob/three.js](https://github.com/mrdoob/three.js) | ADOPT / WRAP | **5/5** | MIT | WebGPURenderer, TSL, PostProcessing, MRT attachments, tone mapping, depth/normal/velocity/emissive outputs. | Three.js rendering APIs evolve; keep a narrow ThreeNative adapter and conformance tests. |
| [pmndrs/postprocessing](https://github.com/pmndrs/postprocessing) | ADOPT / PORT | **5/5** | Zlib | Composer architecture, effect lifecycle, bloom, SMAA, DOF, GTAO/SSR patterns, selection masks, pass fusion ideas. | Primarily WebGL/WebGL2; reuse APIs and algorithms without creating a second incompatible renderer graph. |
| [pmndrs/upscaler](https://github.com/pmndrs/upscaler) | ADOPT | **5/5** | MIT | Shared temporal guides, jitter, reactive masks, exposure handling, disocclusion, history reset, RCAS and TSL integration. | WebGPU-only and touches Three.js backend internals; pin Three.js versions and isolate the bridge. |
| [0beqz/realism-effects](https://github.com/0beqz/realism-effects) | MINE / PORT | **4/5** | MIT | TRAA, motion blur, SSGI, velocity handling, temporal accumulation and denoising patterns. | Older renderer assumptions and lower recent maintenance; treat as algorithm source, not the sole production dependency. |
| [gkjohnson/three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer) | REFERENCE / ADOPT TEST TOOL | **4/5** | MIT | Reference-quality image oracle for tone mapping, DOF, materials, reflections, exposure and golden-scene comparisons. | Not a real-time post stack; use for validation and captures rather than frame production. |

**Recommended sequence**

1. Make the Three.js WebGPU post graph and MRT outputs the single core path behind a ThreeNative adapter.
2. Adopt `pmndrs/upscaler` temporal guides early; port only the `pmndrs/postprocessing` effects that cannot be expressed cleanly in the shared graph.
3. Use `realism-effects` as a temporal/image-quality reference and `three-gpu-pathtracer` as the golden-image oracle.

### 2. F2 — Volumetrics, fog, and god rays

| Candidate | Mode | Fit | License | Borrow | Caveat |
|---|---|---:|---|---|---|
| [mrdoob/three.js](https://github.com/mrdoob/three.js) | ADOPT / WRAP | **4/5** | MIT | 3D/storage textures, compute, depth, lights, shadow maps, TSL and post-composition plumbing. | No complete froxel volumetric system; ThreeNative still owns injection, lighting, temporal resolve and fallbacks. |
| [Ameobea/three-volumetric-pass](https://github.com/Ameobea/three-volumetric-pass) | MINE ONLY | **4/5** | No license detected | Screen-space volumetric raymarching, light-volume integration and compositing ideas for a first prototype. | No usable license was detected: do not copy code unless the author adds a compatible license or grants permission. |
| [Ameobea/three-good-godrays](https://github.com/Ameobea/three-good-godrays) | MINE ONLY | **3/5** | No license detected | Depth-aware light-shaft reconstruction, occlusion and temporal/composition ideas. | No usable license was detected; use only as behavioral inspiration until permission exists. |
| [jeantimex/procedural-clouds](https://github.com/jeantimex/procedural-clouds) | PORT / MINE | **4/5** | MIT | WebGPU volumetric cloud raymarching, density/noise fields, lighting and weather-oriented controls. | Small and early project; production integration, transparency and temporal stability remain ThreeNative work. |
| [SkyeShark/Eanpa-Sky](https://github.com/SkyeShark/Eanpa-Sky) | FORK / MINE | **5/5** | MIT; inspect bundled assets | WebGPU/TSL sky, atmosphere, volumetric clouds, weather and physically based scattering patterns. | Early-stage API and mixed asset licenses; reuse code separately from sample content. |
| [Sunset-Flock/Timberdoodle](https://github.com/Sunset-Flock/Timberdoodle) | MINE / PORT | **4/5** | Apache-2.0 | Atmosphere lookup-table generation, temporal cubemap accumulation, debug views and render-graph integration. | Daxa/Vulkan-style engine rather than Three.js; algorithms require a WGSL/TSL port. |

**Recommended sequence**

1. Build the production froxel/injection contract on Three.js compute and 3D textures.
2. Port physically based atmosphere/cloud pieces from Eanpa-Sky and Timberdoodle; use the Ameobea repos only as no-copy behavioral references until licensed.
3. Unify fog, clouds, VFX injection and temporal guides instead of shipping separate one-off god-ray passes.

### 3. F12 — TSR-like temporal anti-aliasing and upscaling

| Candidate | Mode | Fit | License | Borrow | Caveat |
|---|---|---:|---|---|---|
| [pmndrs/upscaler](https://github.com/pmndrs/upscaler) | ADOPT / FORK | **5/5** | MIT | FSR-style temporal reconstruction, jitter, motion/depth dilation, disocclusion, reactive masks, history clipping, RCAS and temporal guides. | WebGPU only; backend-internal access must be isolated and continuously tested against Three.js upgrades. |
| [mrdoob/three.js](https://github.com/mrdoob/three.js) | ADOPT / WRAP | **5/5** | MIT | Velocity node, MRT, depth, jitterable cameras, FSR1Node, TRAA primitives and post graph integration. | Motion-vector coverage for deformation, particles and custom materials still needs ThreeNative contracts. |
| [GPUOpen-LibrariesAndSDKs/FidelityFX-SDK](https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK) | PORT / REFERENCE | **5/5** | MIT; third-party notices apply | Authoritative FSR pass ordering, constants, quality modes, reactive masks, exposure and reconstruction math. | HLSL/DX12/Vulkan-oriented source requires careful WGSL translation and parity tests. |
| [0beqz/realism-effects](https://github.com/0beqz/realism-effects) | MINE / PORT | **4/5** | MIT | Temporal anti-aliasing, velocity generation, neighborhood clipping and ghosting test scenes. | Not a full modern temporal upscaler; use as an additional implementation reference. |
| [google/filament](https://github.com/google/filament) | REFERENCE / MINE | **3/5** | Apache-2.0 | Production temporal AA/upscaling architecture, frame history, dynamic resolution and image-quality test philosophy. | Native C++ renderer with different abstractions; port concepts, not subsystem code wholesale. |

**Recommended sequence**

1. Integrate `pmndrs/upscaler` behind a ThreeNative `TemporalUpscaler` interface and pin its supported Three.js range.
2. Promote its temporal-guide products into the shared renderer service used by GI, SSR, volumetrics and denoisers.
3. Validate pass math and quality modes against FidelityFX reference code and adversarial ThreeNative scenes.

### 4. F14 — Virtual Shadow Maps

| Candidate | Mode | Fit | License | Borrow | Caveat |
|---|---|---:|---|---|---|
| [Sunset-Flock/Timberdoodle](https://github.com/Sunset-Flock/Timberdoodle) | PORT / MINE | **5/5** | Apache-2.0 | Virtual/physical page tables, GPU page allocation, dirty tracking, page caching, wraparound cascades and hierarchical dirty-page culling. | Native bindless/mesh-shader architecture differs from WebGPU; translate the data model and algorithms. |
| [shlomnissan/virtual-textures](https://github.com/shlomnissan/virtual-textures) | ADOPT ALGORITHMS / PORT | **4/5** | MIT | Page-table encoding, physical cache allocation, residency feedback and debug visualization reusable for shadow pages. | Texture paging is not shadow rendering; invalidation, caster culling and depth filtering remain new work. |
| [octoon/UnityVSM](https://github.com/octoon/UnityVSM) | MINE ONLY / WATCH | **4/5** | No license detected | A second implementation of virtual shadow page marking, allocation and rendering behavior. | No usable license detected and Unity-specific integration; do not copy without permission. |
| [mrdoob/three.js](https://github.com/mrdoob/three.js) | ADOPT / WRAP | **3/5** | MIT | Shadow-camera setup, material shadow variants, depth rendering, light integration and render-target management. | Conventional shadow architecture; a virtual page renderer will require deeper renderer hooks or a dedicated path. |
| [CesiumGS/cesium](https://github.com/CesiumGS/cesium) | MINE | **3/5** | Apache-2.0 | Large-scale request scheduling, cache eviction, visibility prioritization and residency diagnostics. | General tile streaming rather than shadow pages; reuse scheduler/cache ideas only. |

**Recommended sequence**

1. Port Timberdoodle’s VPT/PPT, dirty-page, cache and hierarchical-page-buffer design into WebGPU data structures.
2. Reuse `virtual-textures` page allocation/residency utilities where they generalize cleanly.
3. Build a dedicated Three.js shadow-material/render adapter and prove static-cache invalidation before adding local-light variants.

### 5. F3 — Niagara-like GPU VFX and particles

| Candidate | Mode | Fit | License | Borrow | Caveat |
|---|---|---:|---|---|---|
| [mustache-dev/Three-VFX](https://github.com/mustache-dev/Three-VFX) | ADOPT / FORK | **5/5** | MIT | WebGPU compute particles, emitter shapes, curves, sprites/meshes, turbulence, attractors, collisions, PBR particles and CPU fallback. | Vanilla Three.js support is described as experimental; extract the core runtime from framework-specific adapters. |
| [travisdmathis/plume](https://github.com/travisdmathis/plume) | ADOPT / MINE | **5/5** | MIT | Niagara-like VFX data model, authoring/editor concepts, emitters, modules and effect serialization. | Validate current package boundaries and WebGPU renderer compatibility before making it foundational. |
| [mrdoob/three.js](https://github.com/mrdoob/three.js) | ADOPT / WRAP | **4/5** | MIT | Compute/storage buffers, indirect rendering, node materials and official linked-particle/VFX examples. | Examples are primitives, not a production emitter/module/runtime contract. |
| [NewKrok/three-particles](https://github.com/NewKrok/three-particles) | ADOPT / MINE | **3/5** | MIT | TypeScript emitter API, serialization-friendly particle behaviors and lower-tier Three.js integration. | Smaller CPU/WebGL-oriented scope than Niagara; use mainly for API/fallback patterns. |
| [creativelifeform/three-nebula](https://github.com/creativelifeform/three-nebula) | MINE / FALLBACK | **3/5** | MIT | Mature emitter/initializer/behavior architecture, JSON configuration and WebGL-compatible fallback ideas. | CPU/WebGL design does not scale like WebGPU compute; avoid inheriting its performance ceiling. |

**Recommended sequence**

1. Spike `Three-VFX` and `plume` against the same canonical effects and choose one runtime/data model as the base.
2. Separate the compute simulation core from React/editor adapters, then add a stable serialized module schema.
3. Use Three.js compute/indirect primitives for the high tier and `three-nebula`/`three-particles` ideas for the deliberate fallback path.

### 6. F17 — Nanite-like virtualized geometry

| Candidate | Mode | Fit | License | Borrow | Caveat |
|---|---|---:|---|---|---|
| [Scthe/nanite-webgpu](https://github.com/Scthe/nanite-webgpu) | FORK / PORT / MINE | **5/5** | MIT | Meshlet LOD hierarchy, meshoptimizer/METIS preprocessing, GPU instance/meshlet culling, Hi-Z occlusion, software rasterization, impostors, quantization and diagnostics. | Research implementation lacks production streaming/residency, full visibility-buffer material path, shadows and multiview. |
| [zeux/meshoptimizer](https://github.com/zeux/meshoptimizer) | ADOPT | **5/5** | MIT | Meshlet generation, simplification/error metrics, vertex/index optimization and geometry compression for the asset pipeline. | ThreeNative must define stable preprocessing outputs, hierarchy construction and runtime page formats. |
| [Sunset-Flock/Timberdoodle](https://github.com/Sunset-Flock/Timberdoodle) | MINE / PORT | **5/5** | Apache-2.0 | GPU-driven work expansion, mesh/meshlet culling, visibility buffer, compressed meshlets, mega-draw organization and debug views. | Uses native bindless resources and mesh shaders unavailable in standard WebGPU; adapt the architecture. |
| [gkjohnson/three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) | ADOPT | **4/5** | MIT | CPU/WASM spatial queries, bounds generation, picking, collision support and software-ray visibility utilities. | A BVH does not replace meshlet LOD traversal or GPU residency management. |
| [seanhlewis/three-meshlet](https://github.com/seanhlewis/three-meshlet) | WATCH / MINE ONLY | **4/5** | No license detected | Three.js-oriented meshlet and multi-LOD experiments close to ThreeNative’s desired integration surface. | No usable license detected; do not copy source unless licensed or permission is obtained. |
| [AIFanatic/three-nanite](https://github.com/AIFanatic/three-nanite) | MINE | **3/5** | MIT | Earlier Three.js Nanite-style experiments, scene/API integration and practical renderer constraints. | Older and less complete than the WebGPU implementation; useful mainly as a comparative prototype. |

**Recommended sequence**

1. Adopt meshoptimizer immediately for the offline pipeline and pin a deterministic output format.
2. Use `nanite-webgpu` as the primary WebGPU seed and Timberdoodle as the GPU-driven/visibility-buffer architecture reference.
3. Ship meshlet culling + hierarchical LOD first, then add page residency/streaming; defer software rasterization until measured necessity.

### 7. F13 — Substrate-like layered materials

| Candidate | Mode | Fit | License | Borrow | Caveat |
|---|---|---:|---|---|---|
| [mrdoob/three.js](https://github.com/mrdoob/three.js) | ADOPT / EXTEND | **5/5** | MIT | TSL, NodeMaterial, MeshPhysicalNodeMaterial, BSDF building blocks, shader generation and WebGPU/WebGL material integration. | No general layered-BSDF closure system; ThreeNative must own composition semantics and permutation control. |
| [AcademySoftwareFoundation/MaterialX](https://github.com/AcademySoftwareFoundation/MaterialX) | ADOPT / PORT | **5/5** | Apache-2.0 | Portable material graph representation, node definitions, standard libraries, validation and interchange. | Runtime compiler integration and compact mobile/WebGPU targets require a focused subset. |
| [AcademySoftwareFoundation/OpenPBR](https://github.com/AcademySoftwareFoundation/OpenPBR) | ADOPT SPEC / MINE | **5/5** | Apache-2.0 | Consistent artist-facing parameter model for layered physically based materials. | A specification/model, not a complete Three.js runtime implementation. |
| [adobe/openpbr-bsdf](https://github.com/adobe/openpbr-bsdf) | PORT / MINE | **4/5** | Apache-2.0; verify at pin | Reference BSDF evaluation, layer interactions and conformance cases for OpenPBR. | Shader language and renderer assumptions need translation to TSL/WGSL. |
| [google/filament](https://github.com/google/filament) | REFERENCE / MINE | **4/5** | Apache-2.0 | Production PBR implementation, material compiler, IBL, clearcoat, sheen, transmission and mobile quality tiers. | Different renderer/material language; reuse equations, tests and architecture rather than APIs. |
| [pmndrs/lamina](https://github.com/pmndrs/lamina) | MINE API | **3/5** | MIT | Ergonomic declarative material-layer API and React integration patterns. | Visual shader layering is not a physically correct layered-BSDF system. |

**Recommended sequence**

1. Keep TSL/NodeMaterial as the executable substrate and define a compact ThreeNative layered-BSDF IR above it.
2. Align artist parameters and conformance assets with OpenPBR; use MaterialX for interchange rather than exposing either format as runtime state.
3. Port verified BSDF math from OpenPBR/Filament and borrow only Lamina’s declarative ergonomics.

### 8. F16 — Lumen-like dynamic global illumination and reflections

| Candidate | Mode | Fit | License | Borrow | Caveat |
|---|---|---:|---|---|---|
| [jure/webgiya](https://github.com/jure/webgiya) | FORK / PORT / MINE | **5/5** | MIT | WebGPU + Three.js surfel GI, cascaded spatial hash grids, surfel lifecycle, BVH tracing, temporal moments, denoising and resolve/composite passes. | Research code needs production scene-update, memory, quality-tier and native-backend integration. |
| [cl0nazepamm/speedball](https://github.com/cl0nazepamm/speedball) | ADOPT / WATCH | **5/5** | MIT | Current Three.js WebGPU dynamic GI add-on, update lanes, diagnostics, reflections and clustered-light integration. | Very new project; run a code/benchmark audit before committing to its public API. |
| [0beqz/realism-effects](https://github.com/0beqz/realism-effects) | ADOPT / PORT | **4/5** | MIT | SSGI, screen-space ray marching, temporal reprojection, denoising and motion-vector infrastructure. | Screen-space GI cannot provide reliable off-screen contribution; use as one layer of a hybrid system. |
| [mrdoob/three.js](https://github.com/mrdoob/three.js) | ADOPT / WRAP | **4/5** | MIT | SSGI/SSR examples, probes, MRT, depth/normals/velocity, TSL, compute and clustered-light plumbing. | No world-space radiance representation or complete GI scene-update system. |
| [godotengine/godot](https://github.com/godotengine/godot) | REFERENCE / MINE | **4/5** | MIT | Voxel/SDFGI architecture, probe update budgets, cascades, temporal filtering and debug tooling. | Large C++ engine with different renderer interfaces; port concepts and validation cases. |
| [gkjohnson/three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer) | ADOPT TEST ORACLE | **4/5** | MIT | Ground-truth diffuse/specular transport and scene/material comparison captures. | Offline/progressive output; not a direct real-time GI runtime. |

**Recommended sequence**

1. Run side-by-side spikes of `webgiya` and `speedball` on the canonical indoor/outdoor dynamic-GI scenes.
2. Retain Three.js/realism-effects SSGI as near-field detail while choosing one world-space surfel/probe representation.
3. Use `three-gpu-pathtracer` captures as the quality oracle and gate adoption on memory/update-budget evidence.

### 9. F5 — Procedural Content Generation framework

| Candidate | Mode | Fit | License | Borrow | Caveat |
|---|---|---:|---|---|---|
| [achrefelouafi/BuildingGeneratorThreeJS](https://github.com/achrefelouafi/BuildingGeneratorThreeJS) | FORK / MINE | **4/5** | MIT | Procedural building grammar, parameterized mesh generation and Three.js authoring patterns. | Feature-specific generator, not a generic PCG graph or deterministic world scheduler. |
| [dgreenheck/ez-tree](https://github.com/dgreenheck/ez-tree) | ADOPT / MINE | **4/5** | MIT | Production-friendly procedural vegetation generation, seeded parameters and export/runtime integration. | Tree generation is a leaf node; ThreeNative still needs the graph, data flow, caching and world binding. |
| [xyflow/xyflow](https://github.com/xyflow/xyflow) | ADOPT UI | **4/5** | MIT | Node-graph editing, connection validation, selection, layout and React authoring UI. | UI only; do not let editor component state become the PCG runtime data model. |
| [retejs/rete](https://github.com/retejs/rete) | ADOPT / MINE | **4/5** | MIT | Extensible node editor and graph-processing plugin model. | Runtime determinism, asset versioning and spatial data semantics must remain ThreeNative-owned. |
| [gkjohnson/three-bvh-csg](https://github.com/gkjohnson/three-bvh-csg) | ADOPT | **5/5** | MIT | Fast CSG/boolean geometry node implementation built on three-mesh-bvh. | Generated topology/material groups need deterministic cleanup and asset-pipeline tests. |
| [kchapelier/poisson-disk-sampling](https://github.com/kchapelier/poisson-disk-sampling) | ADOPT | **4/5** | MIT | Deterministic 2D/3D blue-noise placement for scatter nodes. | One placement primitive; large-world streaming and exclusion-query integration are still needed. |

**Recommended sequence**

1. Define the deterministic PCG data model and evaluator before selecting the graph-editor UI.
2. Adopt focused primitives such as `three-bvh-csg`, Poisson sampling and ez-tree as library nodes behind stable adapters.
3. Use xyflow or Rete only for authoring; compile graphs into editor-independent versioned runtime assets.

### 10. F9 — Motion Matching

| Candidate | Mode | Fit | License | Borrow | Caveat |
|---|---|---:|---|---|---|
| [orangeduck/Motion-Matching](https://github.com/orangeduck/Motion-Matching) | PORT / MINE | **5/5** | MIT | Canonical motion-matching database build, feature normalization, trajectory matching, inertialization and runtime search. | Reference C++/demo architecture; production retargeting, compression and worker/native paths remain. |
| [mrdoob/three.js](https://github.com/mrdoob/three.js) | ADOPT / WRAP | **4/5** | MIT | AnimationMixer, clips, skeletons, morphs, blending and runtime pose application. | No feature database, search index, trajectory predictor or inertial transition system. |
| [google/motive](https://github.com/google/motive) | REFERENCE / PORT | **4/5** | Apache-2.0 | Compact animation runtime, curve evaluation, skeleton blending and mobile-oriented data layout. | Not a motion-matching system and requires a native/WASM or TypeScript bridge. |
| [orangeduck/lafan1-resolved](https://github.com/orangeduck/lafan1-resolved) | DATASET / REFERENCE | **3/5** | Dataset/provenance terms require verification | Motion corpus and preprocessing conventions useful for prototype quality and regression tests. | Do not redistribute in ThreeNative until source asset and derived-data rights are confirmed. |
| [Nekuzaky/kinema-motion-matching](https://github.com/Nekuzaky/kinema-motion-matching) | WATCH / MINE | **3/5** | Verify before use | Modern motion-matching implementation ideas and a second point of comparison for search/features. | Young project and license/build maturity must be audited before copying. |
| [pixiv/three-vrm](https://github.com/pixiv/three-vrm) | ADOPT / MINE | **3/5** | MIT | Humanoid bone mapping, retarget-friendly conventions, look-at and spring-bone integration. | VRM runtime is not motion matching; use only for rig normalization and character integration. |

**Recommended sequence**

1. Port the Orange Duck reference pipeline into an offline database builder plus a compact runtime query library.
2. Use Three.js only for final pose application/blending and isolate database search from render-frame allocations.
3. Treat external motion datasets as test inputs with separately verified redistribution rights.

### 11. F4 — Water system

| Candidate | Mode | Fit | License | Borrow | Caveat |
|---|---|---:|---|---|---|
| [reed-soul/SeedOcean](https://github.com/reed-soul/SeedOcean) | ADOPT / FORK | **5/5** | MIT | Three.js/WebGPU FFT ocean, cascades, foam, buoyancy queries, underwater effects, spray/rain and WebGL fallback. | Audit numerical stability, mobile cost and renderer-version coupling before using as the production water core. |
| [squall01337/abyssal-ocean](https://github.com/squall01337/abyssal-ocean) | MINE / PORT | **4/5** | MIT | Compact spectral FFT ocean, JONSWAP/TMA spectra, three cascades, physical foam, caustics and underwater rendering. | Very new single-file-oriented implementation; refactor and validate before adoption. |
| [jbouny/fft-ocean](https://github.com/jbouny/fft-ocean) | MINE / PORT | **4/5** | MIT; verify at pin | Classic Three.js FFT ocean architecture, spectrum update and displacement/normal generation. | Older WebGL assumptions and precision/performance model need modernization. |
| [jeantimex/threejs-water](https://github.com/jeantimex/threejs-water) | MINE | **4/5** | MIT; verify at pin | Interactive water surface, refraction/reflection, caustics and object-water interaction patterns. | Focused demo rather than complete ocean/river/lake body system. |
| [mrdoob/three.js](https://github.com/mrdoob/three.js) | ADOPT / WRAP | **4/5** | MIT | Water/WaterMesh examples, planar reflection/refraction, flow maps, render targets and material nodes. | Example-level rendering only; no unified body topology, shoreline, buoyancy or streaming contract. |
| [PavelDoGreat/WebGL-Fluid-Simulation](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation) | REFERENCE / PORT MODULE | **3/5** | MIT | Stable grid-fluid advection, pressure solve, splats and visual-fluid interaction for specialized local water/smoke modules. | 2D screen/grid fluid, not a general 3D world-water solution. |

**Recommended sequence**

1. Benchmark SeedOcean as the first runtime base because it already spans FFT, buoyancy, underwater and fallback concerns.
2. Mine abyssal-ocean and older FFT/water repos for spectra, caustics and simpler fallbacks rather than merging multiple runtimes.
3. Build a ThreeNative water-body topology/query layer above the renderer so oceans, rivers and lakes share gameplay APIs.

### 12. F18 — MegaLights-like many-light rendering

| Candidate | Mode | Fit | License | Borrow | Caveat |
|---|---|---:|---|---|---|
| [mrdoob/three.js](https://github.com/mrdoob/three.js) | ADOPT / EXTEND | **5/5** | MIT | Forward+ ClusteredLighting, light data packing, culling primitives, TSL materials and WebGPU compute. | Cluster assignment solves candidate selection, not scalable shadow/visibility for every light. |
| [playcanvas/engine](https://github.com/playcanvas/engine) | MINE / PORT | **4/5** | MIT | Production web clustered lighting, cookie/shadow handling, light textures, quality tiers and browser performance lessons. | Different engine/material architecture; port algorithms and tests selectively. |
| [google/filament](https://github.com/google/filament) | REFERENCE / MINE | **4/5** | Apache-2.0 | Froxel/tiled light assignment, PBR integration, shadowing and mobile-first many-light tradeoffs. | Native C++ renderer; no direct Three.js package surface. |
| [nackdai/aten](https://github.com/nackdai/aten) | MINE | **4/5** | MIT | ReSTIR/SVGF/path-tracing research code useful for reservoir sampling, reuse and denoising concepts. | CUDA/native rendering assumptions and research scope require a clean WGSL reimplementation. |
| [NVIDIA-RTX/RTXDI](https://github.com/NVIDIA-RTX/RTXDI) | REFERENCE / LEGAL REVIEW | **5/5** | Proprietary NVIDIA RTX SDK license | Authoritative ReSTIR DI reservoir layout, temporal/spatial reuse, light sampling and validation concepts. | Do not copy into an open-source core without legal approval; license restricts source redistribution and sublicensing. |
| [wizgrav/cl2](https://github.com/wizgrav/cl2) | MINE / FALLBACK | **3/5** | Verify before use | Compute-less clustered lighting suitable as a TN-BASIC/WebGL fallback reference. | Older/specialized implementation and license status need review. |

**Recommended sequence**

1. Extend Three.js Forward+ as the baseline candidate-light system instead of replacing it.
2. Port reservoir sampling from permissive references such as aten; use RTXDI documentation/source only under explicit legal guidance.
3. Solve scalable visibility with VSM/shadow caches first, then add stochastic sampling and temporal reuse.

### 13. F8 — World Partition, streaming, and HLOD

| Candidate | Mode | Fit | License | Borrow | Caveat |
|---|---|---:|---|---|---|
| [NASA-AMMOS/3DTilesRendererJS](https://github.com/NASA-AMMOS/3DTilesRendererJS) | ADOPT / FORK | **5/5** | Apache-2.0 | Three.js-native hierarchical tileset traversal, screen-space error, request scheduling, cache eviction, loaders and large-scene streaming. | 3D Tiles semantics may not map one-to-one to ThreeNative world cells; wrap rather than expose directly. |
| [CesiumGS/cesium](https://github.com/CesiumGS/cesium) | MINE / PORT | **5/5** | Apache-2.0 | Battle-tested quadtree/tileset traversal, priority scheduling, cache pressure, origin precision and failure handling. | Large engine; extract algorithms and policies rather than pulling Cesium into core. |
| [CesiumGS/3d-tiles-tools](https://github.com/CesiumGS/3d-tiles-tools) | ADOPT TOOLING / MINE | **4/5** | Apache-2.0 | Offline tileset generation, conversion, optimization, validation and metadata handling. | Build tooling targets 3D Tiles; ThreeNative may need its own manifest and package format. |
| [visgl/loaders.gl](https://github.com/visgl/loaders.gl) | ADOPT | **4/5** | MIT | Worker-based streaming parsers, binary loading, cancellation and format plugin architecture. | A loader framework does not provide world-cell scheduling or HLOD generation. |
| [potree/potree](https://github.com/potree/potree) | REFERENCE / MINE | **4/5** | BSD-style; verify notices | Octree traversal, point-budget scheduling, out-of-core loading, LOD and large-coordinate handling. | Point-cloud renderer rather than general mesh world partition. |
| [gkjohnson/three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) | ADOPT | **3/5** | MIT | Spatial queries, bounds, ray tests and tooling support for cell assignment and HLOD analysis. | Does not provide streaming, packaging, request queues or HLOD construction. |

**Recommended sequence**

1. Adopt 3DTilesRendererJS traversal/cache code behind a ThreeNative cell-manifest adapter for the first streaming implementation.
2. Mine Cesium for prioritization, precision and failure behavior; use loaders.gl workers for asynchronous decoding.
3. Keep offline HLOD generation and runtime streaming as separate packages with a versioned manifest between them.

### 14. F11 — Control Rig and full-body IK

| Candidate | Mode | Fit | License | Borrow | Caveat |
|---|---|---:|---|---|---|
| [mrdoob/three.js](https://github.com/mrdoob/three.js) | ADOPT / EXTEND | **5/5** | MIT | Skeleton/skinning runtime, CCDIKSolver, AnimationMixer, bone constraints and debug helpers. | CCDIK alone is not a Control Rig graph, full-body solver or retargeting system. |
| [jsantell/THREE.IK](https://github.com/jsantell/THREE.IK) | PORT / MINE | **4/5** | MIT | Three.js FABRIK-style chains, constraints, targets and solver visualization. | Older Three.js API assumptions and limited recent development; vendor tested solver code if used. |
| [lo-th/fullik](https://github.com/lo-th/fullik) | PORT / MINE | **4/5** | MIT; verify at pin | Full-body/FABRIK chain solving and joint constraints in JavaScript. | Needs TypeScript, numerical-stability and modern Three.js integration work. |
| [goldst/IK.ts](https://github.com/goldst/IK.ts) | MINE / PORT | **4/5** | MIT; verify at pin | Typed inverse-kinematics algorithms and constraint modeling. | Small project; audit edge cases, allocation and maintenance before adoption. |
| [pixiv/three-vrm](https://github.com/pixiv/three-vrm) | ADOPT / MINE | **4/5** | MIT | Humanoid rig mapping, look-at, expressions, spring bones and standardized character integration. | VRM-specific conventions should remain an adapter, not the core rig representation. |
| [google/motive](https://github.com/google/motive) | REFERENCE / PORT | **3/5** | Apache-2.0 | Efficient animation curves, pose blending and mobile runtime data layout. | Native C++ and not an IK/control-rig authoring system. |

**Recommended sequence**

1. Use Three.js skeleton/animation and CCD IK as the baseline runtime contract.
2. Port and benchmark FABRIK/full-body solvers from THREE.IK/fullik/IK.ts behind interchangeable solver interfaces.
3. Use three-vrm only as a humanoid adapter and build the Control Rig graph/constraint asset independently.

### 15. F6 — Mass/ECS crowds and large-scale agents

| Candidate | Mode | Fit | License | Borrow | Caveat |
|---|---|---:|---|---|---|
| [hmans/miniplex](https://github.com/hmans/miniplex) | ADOPT | **5/5** | MIT | Developer-friendly typed ECS queries, archetype/world organization and React-friendly integration. | Benchmark high-entity mutation/query patterns against ThreeNative requirements before standardizing. |
| [NateTheGreatt/bitECS](https://github.com/NateTheGreatt/bitECS) | EVALUATE / ISOLATE | **4/5** | MPL-2.0 | Data-oriented SoA components, high-throughput queries and compact entity storage. | MPL file-level copyleft affects modified source files; legal/packaging review is required before vendoring. |
| [Mugen87/yuka](https://github.com/Mugen87/yuka) | ADOPT / MINE | **5/5** | MIT | Steering, perception, goals, state machines, spatial partitioning and game-AI utilities. | Object-oriented runtime may not scale to maximum crowd counts; separate high-level AI from ECS storage. |
| [recastnavigation/recastnavigation](https://github.com/recastnavigation/recastnavigation) | ADOPT NATIVE/WASM | **5/5** | Zlib | Navmesh generation, Detour pathfinding, crowd agents, avoidance and industry-proven navigation data. | C++ integration, tiling and asynchronous rebuilds need explicit native/WASM contracts. |
| [donmccurdy/three-pathfinding](https://github.com/donmccurdy/three-pathfinding) | ADOPT / FALLBACK | **4/5** | MIT | Pure-JS Three.js navmesh zones and pathfinding for basic/browser fallback scenarios. | Not a full dynamic crowd/avoidance system and less scalable than Recast/Detour. |
| [wayne-wu/webgpu-crowd-simulation](https://github.com/wayne-wu/webgpu-crowd-simulation) | PORT / MINE | **4/5** | BSD-3-Clause | WebGPU crowd simulation, GPU position-based dynamics/avoidance and render integration. | Research prototype; deterministic gameplay, navigation coupling and mobile limits need production work. |

**Recommended sequence**

1. Spike Miniplex and bitECS with the actual crowd benchmark; prefer Miniplex ergonomics unless SoA gains justify MPL isolation.
2. Adopt Recast/Detour for navmesh and low-level crowd navigation; layer Yuka-style decision/steering above ECS data.
3. Use GPU crowd simulation only for representation/avoidance LODs where deterministic gameplay state is not required.

### 16. F7 — Sequencer and cinematic timeline

| Candidate | Mode | Fit | License | Borrow | Caveat |
|---|---|---:|---|---|---|
| [theatre-js/theatre](https://github.com/theatre-js/theatre) | ADOPT / MINE | **5/5** | Apache-2.0 | Timeline/editor architecture, object bindings, keyframes, sheets, sequencing and React/Three integrations. | Do not couple Stable runtime playback to editor internals; audit project activity and serialized-format stability. |
| [mrdoob/three.js](https://github.com/mrdoob/three.js) | ADOPT / WRAP | **4/5** | MIT | AnimationClip, KeyframeTrack, AnimationMixer, cameras and object property animation. | No deterministic multi-track cinematic evaluation, shot system, event semantics or editor. |
| [tweenjs/tween.js](https://github.com/tweenjs/tween.js) | ADOPT | **4/5** | MIT | Compact interpolation/easing runtime and predictable update control. | Tween chaining is not a full sequence asset/evaluation model. |
| [motion-canvas/motion-canvas](https://github.com/motion-canvas/motion-canvas) | REFERENCE / MINE | **3/5** | MIT | Code-driven timeline, deterministic playback, editor transport and render/export workflow. | 2D presentation focus and generator-based programming model differ from game cinematics. |
| [xzdarcy/react-timeline-editor](https://github.com/xzdarcy/react-timeline-editor) | ADOPT UI / MINE | **4/5** | MIT | React timeline lanes, drag/resize interactions, markers and editing controls. | UI component only; own the sequence asset and evaluation engine separately. |
| [daybrush/scenejs](https://github.com/daybrush/scenejs) | ADOPT / MINE | **4/5** | MIT | Keyframe tracks, easing, nested timelines, iteration and serialization. | DOM/CSS-oriented assumptions require an adapter for ThreeNative object/property binding. |

**Recommended sequence**

1. Define an editor-independent deterministic sequence asset/evaluator using Three.js tracks and a fixed event-order contract.
2. Mine Theatre.js for binding/editor architecture and select a focused React timeline component for authoring.
3. Use tween/Scene.js primitives internally only where their time/easing semantics match the sequence evaluator exactly.

### 17. F15 — Streaming and runtime virtual texturing

| Candidate | Mode | Fit | License | Borrow | Caveat |
|---|---|---:|---|---|---|
| [shlomnissan/virtual-textures](https://github.com/shlomnissan/virtual-textures) | FORK / PORT | **5/5** | MIT | Modern virtual-texture page tables, feedback, cache allocation, LRU/residency logic and visualization. | Validate texture formats, page borders, anisotropic filtering and Three.js WebGPU integration at production scale. |
| [BinomialLLC/basis_universal](https://github.com/BinomialLLC/basis_universal) | ADOPT TOOLCHAIN | **5/5** | Apache-2.0 | GPU texture compression/transcoding, mip processing and compact streamable source assets. | Compression alone is not virtual texturing; integrate page-independent encoding and quality rules. |
| [KhronosGroup/KTX-Software](https://github.com/KhronosGroup/KTX-Software) | ADOPT TOOLCHAIN | **5/5** | Apache-2.0 | KTX2 creation, validation, metadata, mip chains and Basis/UASTC packaging. | Page tiling/manifests and runtime feedback/residency are still ThreeNative-specific. |
| [CesiumGS/cesium](https://github.com/CesiumGS/cesium) | MINE | **4/5** | Apache-2.0 | Request scheduling, cache eviction, retry, prioritization, memory pressure and diagnostics for streamed resources. | General tiles/resources rather than shader-visible texture page tables. |
| [core-code/LibVT](https://github.com/core-code/LibVT) | REFERENCE / MINE ONLY | **3/5** | No clear reusable license detected | Classic virtual-texturing architecture, feedback buffers, page caches and offline tiling concepts. | Old codebase and unclear license posture; do not copy without confirming rights. |
| [mrdoob/three.js](https://github.com/mrdoob/three.js) | ADOPT / EXTEND | **4/5** | MIT | Texture loaders, KTX2Loader, compressed textures, storage textures, mip handling and shader sampling integration. | No complete feedback-driven virtual-texture residency layer. |

**Recommended sequence**

1. Port `virtual-textures` as the first page-table/cache prototype and share its residency service with VSM and Virtual Geometry.
2. Standardize offline pages on KTX2/Basis tooling with deterministic borders, mips and manifests.
3. Reuse Cesium-style request prioritization and add device-memory-pressure tests before production adoption.

### 18. F10 — MetaSounds-like procedural audio

| Candidate | Mode | Fit | License | Borrow | Caveat |
|---|---|---:|---|---|---|
| [Tonejs/Tone.js](https://github.com/Tonejs/Tone.js) | ADOPT / WRAP | **5/5** | MIT | Web Audio graph nodes, transport/scheduling, synthesis, effects, automation and browser audio lifecycle. | Browser-centric API; define a backend-neutral ThreeNative graph rather than leaking Tone types publicly. |
| [elemaudio/elementary](https://github.com/elemaudio/elementary) | ADOPT / MINE | **5/5** | MIT | Declarative DSP graph, graph diffing, native/web runtimes and render-thread-safe parameter updates. | Backend/build footprint and platform support need validation for ThreeNative targets. |
| [GoogleChromeLabs/web-audio-samples](https://github.com/GoogleChromeLabs/web-audio-samples) | REFERENCE / PORT | **4/5** | Apache-2.0 | AudioWorklet patterns, low-latency processing, scheduling and browser edge-case examples. | Sample collection rather than a supported runtime dependency. |
| [grame-cncm/faust](https://github.com/grame-cncm/faust) | OPTIONAL / LEGAL REVIEW | **4/5** | GPL/LGPL-family and component-specific terms | DSP language/compiler, optimized generated processors and a large library of audio algorithms. | Licensing and generated-code/runtime terms must be reviewed before embedding in an open-source core. |
| [RustAudio/cpal](https://github.com/RustAudio/cpal) | ADOPT NATIVE | **4/5** | MIT OR Apache-2.0 | Cross-platform native audio device/stream abstraction. | Low-level I/O only; ThreeNative still needs mixing, DSP graph, scheduling and spatialization. |
| [RustAudio/rodio](https://github.com/RustAudio/rodio) | REFERENCE / ADOPT NATIVE | **3/5** | MIT OR Apache-2.0 | Native playback, decoding, sinks and mixer patterns on top of cpal. | Higher-level playback library is not a MetaSounds-like graph or precise game-audio scheduler. |

**Recommended sequence**

1. Define a backend-neutral immutable DSP graph and validate whether Elementary can serve as its execution core.
2. Use Tone.js as the browser feature/reference layer while implementing native output through cpal or an equivalent backend.
3. Keep Faust optional until its compiler/runtime/generated-code licenses are cleared for ThreeNative distribution.

### 19. F19 — Chaos replacement: modular physics, destruction, cloth, and vehicles

| Candidate | Mode | Fit | License | Borrow | Caveat |
|---|---|---:|---|---|---|
| [dimforge/rapier](https://github.com/dimforge/rapier) | ADOPT CORE | **5/5** | Apache-2.0; verify crate/package grant | Rigid bodies, colliders, joints, character controllers, queries, determinism controls and WASM/native parity base. | ThreeNative must lock cross-backend semantics, serialization, threading and version compatibility. |
| [pmndrs/react-three-rapier](https://github.com/pmndrs/react-three-rapier) | MINE / ADOPT ADAPTER IDEAS | **5/5** | MIT | React lifecycle, declarative bodies/colliders/joints, event mapping, instancing and debug rendering patterns. | React Three Fiber assumptions; reuse ergonomics without coupling ThreeNative to R3F internals. |
| [jrouwe/JoltPhysics](https://github.com/jrouwe/JoltPhysics) | REFERENCE / OPTIONAL NATIVE | **4/5** | MIT | High-performance rigid bodies, characters, vehicles, constraints and multithreading architecture. | A second physics backend increases conformance burden; use only for capabilities Rapier cannot satisfy. |
| [InteractiveComputerGraphics/PositionBasedDynamics](https://github.com/InteractiveComputerGraphics/PositionBasedDynamics) | PORT / MINE | **4/5** | MIT | XPBD cloth, rods, soft bodies, fluids and constraint solvers. | Native C++ research framework; a production GPU/WASM port and renderer coupling are substantial work. |
| [NVIDIA-Omniverse/PhysX](https://github.com/NVIDIA-Omniverse/PhysX) | REFERENCE / OPTIONAL NATIVE | **4/5** | BSD-3-Clause | Vehicles, articulations, scene queries, contact generation and production physics test cases. | Large native dependency and backend divergence; not appropriate as an implicit browser dependency. |
| [NVIDIA-Omniverse/Blast](https://github.com/NVIDIA-Omniverse/Blast) | REFERENCE / LEGAL REVIEW | **4/5** | BSD/custom notices; verify at pin | Fracture graphs, damage propagation, chunk activation and destruction workflows. | Native/CUDA ecosystem and asset pipeline complexity; inspect all notices before reuse. |
| [jspdown/cloth](https://github.com/jspdown/cloth) | WATCH / PORT | **4/5** | No license detected; verify | WebGPU XPBD cloth implementation and GPU constraint-solve patterns. | Do not copy until licensing is clear; production collision, tearing and authoring are not guaranteed. |
| [gkjohnson/three-bvh-csg](https://github.com/gkjohnson/three-bvh-csg) | ADOPT SUPPORT TOOL | **3/5** | MIT | Runtime/editor fracture geometry, cuts and boolean preparation for destruction assets. | CSG alone does not provide fracture simulation, connectivity, debris or networking. |

**Recommended sequence**

1. Keep Rapier as the single rigid-body contract and mine react-three-rapier for lifecycle/API ergonomics.
2. Treat cloth/soft bodies, destruction and vehicles as independently shippable modules with separate backends and gates.
3. Port permissive XPBD/fracture algorithms selectively; use PhysX/Jolt/Blast primarily as behavior and benchmark references unless a native-only module is justified.

### 20. F20 — Path tracer and reference renderer

| Candidate | Mode | Fit | License | Borrow | Caveat |
|---|---|---:|---|---|---|
| [gkjohnson/three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer) | ADOPT / FORK | **5/5** | MIT | Three.js material/scene conversion, BVH-based path tracing, accumulation, environment lighting, denoising hooks and reference captures. | WebGL-oriented implementation and progressive renderer; WebGPU/native parity may require a new backend. |
| [SreeXD/Three-PT](https://github.com/SreeXD/Three-PT) | FORK / MINE / WATCH | **4/5** | MIT | WIP Three.js WebGPU path tracer, GPU LBVH and modern WebGPU integration ideas. | Young project with incomplete production coverage; use as a prototype seed, not a Stable dependency yet. |
| [erichlof/THREE.js-PathTracing-Renderer](https://github.com/erichlof/THREE.js-PathTracing-Renderer) | MINE / PORT | **4/5** | MIT; verify at pin | Large library of path-traced scenes/materials, accumulation, camera models and shader techniques. | Monolithic demo architecture and WebGL shader constraints require substantial refactoring. |
| [gkjohnson/three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) | ADOPT | **5/5** | MIT | BVH construction, serialization, refit, traversal utilities and spatial-query validation. | CPU-built BVH may be too slow for fully dynamic scenes; GPU build/refit remains separate work. |
| [mmp/pbrt-v4](https://github.com/mmp/pbrt-v4) | REFERENCE ORACLE | **4/5** | BSD-2-Clause | Physically based transport, BSDFs, sampling, cameras and authoritative reference images. | Offline C++ renderer; use for math and validation, not runtime integration. |
| [mitsuba-renderer/mitsuba3](https://github.com/mitsuba-renderer/mitsuba3) | REFERENCE ORACLE | **4/5** | BSD-3-Clause | Differentiable/production path tracing, emitters, media, BSDFs and scene validation. | Large native/JIT system and different scene model; reference only. |
| [wwwtyro/speck-pbr](https://github.com/wwwtyro/speck-pbr) | MINE / PORT | **4/5** | MIT | Compact WebGPU path-traced PBR example and WGSL compute/ray traversal patterns. | Small educational renderer; missing broad material, animation and production tooling coverage. |

**Recommended sequence**

1. Adopt three-mesh-bvh plus three-gpu-pathtracer as the immediate validation renderer and golden-scene generator.
2. Prototype a WebGPU backend using Three-PT/speck-pbr patterns while keeping material/scene conversion shared.
3. Use PBRT and Mitsuba images/math as external correctness oracles; do not make full offline-renderer parity a launch blocker.

## Adoption record template

```md
Repository:
Pinned commit/tag:
Feature requirement IDs covered:
Reuse mode: dependency | fork | port | algorithm reference | test-only
License and NOTICE review:
Third-party assets/submodules reviewed:
Three.js/native compatibility spike:
Canonical scene results:
Adversarial scene results:
GPU/CPU/memory benchmark:
Required local modifications:
Upstreaming strategy:
Owner and maintenance plan:
Exit/replace strategy:
Approval:
```
