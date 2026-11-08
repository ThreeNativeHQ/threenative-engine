# PRD-857: The GPU world scene runs on the owned engine

**Status:** NOT STARTED
**Priority:** P1 — a cooked forest world draws 19.5 M main-pass triangles on the CPU world path on the default engine, because the GPU world scene is off there (all boxes open).
**Complexity:** 6 (MEDIUM-HIGH)
**Depends on:** [PRD-762](PRD-762-an-mcp-terrain-runs-on-the-default-engine.md) (the MCP terrain path and its sandbox)
**Epic:** [Strata terrain hardening](README.md), part of chain step PR-1 in [PR-CHAIN.md](PR-CHAIN.md)

## Problem

Measured on 2026-11-08 in a fresh `pnpm sandbox` game with an MCP-cooked forest, NVIDIA RTX 2080, Chrome DevTools with `?tnDebug=1`: after the LOD fix in PRD-762, the default engine's main pass draws 19.5 M triangles in about 163 draws, at 15.7 ms GPU time. `TN_WORLD_GPU_SCENE off reason=backend=webgpu-without-hasFeature`, `dressed=0/44`. On `engine: "threejs"` the same world runs the GPU-driven scene (`dressed=44/44`).

A static audit of `packages/core/src/world-gpu-*.ts` against the owned facade (`packages/three-native/src/`) found five gaps. The owned engine already has compute (PRD-620), storage buffers, atomics and the full cull-kernel TSL shape.

1. `renderer.raw.backend` has no `hasFeature`, and the Wasm host does not request `indirect-first-instance` (`packages/runtime-native/src/engine/wasm/web_host.cpp:232-234`).
2. The facade has no `IndirectStorageBufferAttribute` and no `BufferGeometry.setIndirect` / `indirect` / `indirectOffset`.
3. `GeometryCache::sync` keeps the usage of the first caller, so a buffer needed as `Storage` and `Vertex`, or `Storage` and `Indirect`, fails wgpu validation (`geometry_cache.cpp:28-56`).
4. The C++ renderer has no per-mesh indirect draw: `geometry.indirect` is never read. Its own retained rows already encode `DrawIndexedIndirect` (`renderer.cpp:6283`).
5. `storage(attr, <struct>, n)` throws on the owned engine, and the cull kernel reads a `GpuPlacement` struct (`world-gpu-reference.ts:405`).

Without gap 4, turning the scene on draws `capacity` instances from a partly filled buffer: a wrong picture, not only a slow frame. Every step lands behind the existing `gpuScene: false` / `?tnGpuScene=0` override.

## Execution Phases

### Phase 1 — the facade and the device answer truthfully

- [ ] `renderer.backend.hasFeature` answers `core-features-and-limits` (true) and `indirect-first-instance` (the device's own answer), and the Wasm host requests `indirect-first-instance` when the adapter has it (web host ABI bump). proof: a facade spec, `web-host-abi.spec.ts`, and `TN_WORLD_GPU_SCENE` in the sandbox no longer reads `backend=webgpu-without-hasFeature`
- [ ] `IndirectStorageBufferAttribute` and `BufferGeometry.setIndirect` / `indirect` / `indirectOffset` exist on the facade and in `api/native-registry.json`. proof: a facade spec against a fake runtime
- [ ] A storage buffer bound as storage and as vertex or indirect data carries every usage it is bound with. proof: a native renderer test

### Phase 2 — the engine draws indirect

- [ ] An `InstancedMesh` whose geometry carries an indirect record draws with `DrawIndexedIndirect` from that record, on the bundle and the pass paths, and a replaced record re-records the bundle. proof: a native renderer test that asserts the encoded command
- [ ] The cull kernel's placements reach the owned engine without a struct-typed storage element (repack `GpuPlacement` to `vec4` rows in core). proof: `world-gpu-scene.spec.ts` and the existing world GPU specs green

### Phase 3 — proof

- [ ] The sandbox forest runs with `dressed=44/44` on the default engine, and the main pass draws fewer triangles and less GPU time than 19.5 M and 15.7 ms. proof: the PRD-762 sandbox scenario with `?tnDebug=1`, Chrome DevTools counters, adapter checked
- [ ] Visual judge: the default engine with the scene on against the same engine with `?tnGpuScene=0`, same poses, 2 runs per arm, NEUTRAL or better. proof: a fresh judge verdict on the PR

## Acceptance Criteria

- [ ] The MCP-cooked forest draws at most half the main-pass GPU time of the CPU path on the default engine, with the same look. proof: the Phase 3 boxes
