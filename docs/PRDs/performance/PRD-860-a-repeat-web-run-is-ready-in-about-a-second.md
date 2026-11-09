# PRD-860 — A repeat web run is ready in about a second

**Status:** IN PROGRESS
**Priority:** P1 — AC-1 and AC-2 are open: a repeat run of the collectathon kit takes about 1.46 s against the 1.2 s bar, and a first visit about 3.13 s against the 2.7 s bar.
**Complexity:** 6 (MEDIUM) — 6-10 implementation files (+2), a new generated-content cache (+2), engine packages and a kit template change together (+2); risk override: none.
**Owner:** João
**Depends on:** None. Follows PRD-743 (asset disk cache) and PRD-828 (engine work moves into C++).

## Context

Owner, 2026-11-08: "Goal is to run as fast as possible initially and sequential runs are almost instant. in all platforms." Then: "setup a benchmark on this PRD and only stop when its significantly faster, setup some realistic goal."

Spike, 2026-11-08: the collectathon kit (`--genre mario`) from the published 0.3.12 packages, `pnpm build:web`, `vite preview`, Chromium WebGPU, time from navigation to `__TN_STARTUP_READY__`. The clean numbers come from the quiet laptop (Intel Iris Xe, load 0.3). The desktop numbers were about 4x higher at host load 57, so this PRD uses none of them.

| Run | localhost | 20 Mbit/s, 40 ms |
| --- | --- | --- |
| first visit (empty profile) | 2.36 s | 5.05 s |
| repeat, same browser | 2.00 s | 2.28 s |
| repeat, browser relaunched | 2.01-2.03 s | 2.37-2.39 s |

A repeat run downloads 6 KB, so the 2.0 s floor is work, not bytes:

- **1.2 s scene build.** `Play.load` regenerates the same seeded world in JS every run. A CPU profile splits it into about 65% course and foliage placement (`src/level/Course.ts`, `src/render/foliage.ts`; per-instance `setMatrixAt`, `pathDistance`, `traverse`), about 25% a 2048x1024 sky painted per pixel in JS (`src/render/`), and about 10% collider boxes.
- **0.4 s pipeline warm-up.** 350 pipelines, created after the scene build, not during it.
- **0.3 s boot.** The engine Wasm compiles by `compileStreaming` in about 89 ms.

The first visit adds about 2.7 s of download at 20 Mbit/s for 6.0 MB. The engine Wasm crossed uncompressed because `vite preview` does not serve the `.br` copies the build writes. Rapier sits in `index.js` as a 2.09 MB base64 string (two-thirds of the bundle), so it cannot use streaming compile or the Wasm code cache, and its decode costs about 150 ms each run. The generated `_headers` sets COOP/COEP only, with no `Cache-Control`, so each repeat visit revalidates every file.

Unreal answers the repeated-pipeline part with a user pipeline cache: it records the pipelines a run used and precompiles them on the next launch in batches under a frame budget (UE 5.8.3: Engine/Source/Runtime/RenderCore/Private/ShaderPipelineCache.cpp:66-100 for the batch size of 50 and the 16 ms batch time, :214 for `r.ShaderPipelineCache.SaveUserCache`). WebGPU has no serialized pipeline to restore (`packages/core/src/warmup.ts:1112`), so this PRD borrows the order, not the file: start the recorded pipelines while the scene builds.

## Solution

1. **Benchmark first.** `pnpm bench:load` scaffolds a kit from the local packages, builds it for web and serves `dist/` as a production host does: the `.br` copies with `Content-Encoding`, and the headers in `_headers`. Then it drives Chromium with `--browser-recipe webgpu` flags, a persistent profile and a CDP throttle of 20 Mbit/s with 40 ms latency. Each arm makes one first visit and five relaunches, and the bench reports the median `readyMs`. It also reports the adapter, bytes on the wire and the stage marks (`TN_STATIC_COLLIDERS`, `TN_STARTUP_WARMUP`). The goal machine is the laptop (Intel Iris Xe) through `laptop-offload --gpu --quiet`, because the desktop runs at load 50+.
2. **Repeat-run levers.**
   - `_headers` gives hashed `/assets/*` files `Cache-Control: public, max-age=31536000, immutable`.
   - A generated-content cache (`ctx.assets.memo(key, build)`) keeps typed arrays the game generates in the per-game CacheStorage cache that PRD-743 already owns. The key carries the build identity, so a new build regenerates. On a native host it calls `build` every time and reports why. The kit moves its foliage instances, course buffers and sky pixels behind it, so the look stays the same.
   - The pipelines a run created are recorded and started while the next run builds its scene, in the Unreal order.
3. **First-run levers.** Rapier loads as its own hashed `.wasm` through `instantiateStreaming`. The bench confirms the host serves `.br` for the engine Wasm. Then the bench decides whether more is needed.

Each lever lands only when the bench shows a gain above run noise on the paired arms, and it is reverted otherwise.

## Acceptance Criteria

- [ ] AC-1 [local]: a repeat run of the collectathon kit, browser relaunched, is ready in at most 1.2 s median at 20 Mbit/s and 40 ms on the laptop (bench baseline 2.51 s, at least 2x faster). proof: `pnpm bench:load --kit collectathon --network 20000:40 --runs 5` — Evidence: pending.
- [ ] AC-2 [local]: the first visit of the same kit is ready in at most 2.7 s median under the same conditions (bench baseline 3.90 s, at least 30% faster). proof: `pnpm bench:load --kit collectathon --network 20000:40 --runs 5` — Evidence: pending.
- [x] AC-3 [local]: the control, the minimal kit, which uses none of the new caches, is no slower than its develop baseline on either arm, within the spread of three runs. It charges the levers' own bookkeeping to a game that gains nothing. proof: `pnpm bench:load --kit minimal --network 20000:40 --runs 5` — 2026-11-08, `49c1ae3cb`, laptop, three runs: first visit 2931 / 2983 / 2981 ms (baseline 3507-3596), repeat 1400 / 1457 / 1479 ms (baseline 2249-2292). Faster on both arms.
- [x] AC-4 [local]: a fresh visual judge rates the spawn frame NEUTRAL or IMPROVEMENT against the develop baseline, two headed WebGPU captures per arm. proof: visual judge subagent on the bench captures — 2026-11-08: NEUTRAL on all four pairs (two runs, first and repeat visit; `TN_LOAD_BENCH_SHOTS`, laptop `intel/gen-12lp`, develop `4dd50f4c2` against `49c1ae3cb`), only animation-phase differences; images on PR #641 (`prd-860-screenshots` `0af50ae8e`).

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Load benchmark | `pnpm bench:load` → `scripts/load-bench.ts` | none, new harness | Phase 1 |
| Generated-content cache | kit `Play.load` → `ctx.assets.memo` → `packages/core/src/asset-cache.ts` | the per-run regeneration | Phase 2 |
| Immutable asset headers | `threenative build --target web` → `_headers` | headers with no `Cache-Control` | Phase 2 |
| Rapier out of line | `@threenative/physics` web import → its own chunk, awaited by `initialize` (`packages/physics/src/web.ts`) | the static import in the entry chunk | Phase 3 |
| Engine Wasm preload | `threenative build --target web` → head script (`withEnginePreload`, `packages/create-threenative/src/web-brand.ts`) | the glue's late fetch on a first visit | Phase 3 |
| Shared-memory matrix view | any game's `Matrix4`/`Matrix3` `elements` on the threads build (`packages/three-native/src/browser-value-views.ts`) | the per-element Proxy write | Phase 2 |

## Decisions

- 2026-11-08 (agent): AC-2 moves from "at most 3.5 s against 5.05 s" to "at most 2.7 s against 3.90 s". The spike served no Brotli; the bench does, as a production host does, and its first-visit baseline is 3.90 s. The bar stays at least 30% faster.
- 2026-11-08 (agent): the minimal kit, with almost no scene, repeats in 2.25 s, so most of a repeat run is startup every kit shares (the sky's cloud noise first), not the collectathon's world. The levers start there. The collectathon's course placement shares one seeded random stream with the rest of the course, so it is not cached: skipping it on a hit would change the world.

- 2026-11-08 (agent, from the spike): the goal machine is the quiet laptop, not the desktop, because desktop runs at host load 50+ read 4x high and vary by 40% between runs.
- 2026-11-08 (agent): the cache stores bytes in TypeScript in core, next to the PRD-743 asset cache. It is I/O, not compute, and core must not carry Wasm. Generation that stays per run moves into C++ through the PRD-828 bulk calls only when the bench shows that the cache alone misses AC-2.
- 2026-11-08 (agent): native relaunch (pipeline cache on the owned engine, V8 code cache) stays with PRD-368 and PRD-335. This PRD reports native as `memo` disabled with its reason and changes nothing else there.
- 2026-11-08 (agent): the box "the recorded pipelines start while the scene builds" is deleted. Two attempts measured no gain on paired laptop arms: the environment bake beside the first compile (1755/1748/1785 against 1732/1773/1781 ms), and a JS-side pipeline precache, which Chrome does not dedupe. Chrome's GPU process creates pipelines and runs queue submits in series, so earlier starts only queue earlier.
- 2026-11-08 (agent): the box "Rapier loads as a hashed `.wasm` through `instantiateStreaming`" is replaced. That build (`cf58debc9`) cut 155 KB but no time, because the static import still held the entry module. What pays is moving Rapier off the boot path: its own chunk, fetched as physics imports (c10).
- 2026-11-08 (agent): two readiness changes were measured and dropped: exposure reads every frame until measured, and quiet frames counted from the compile (1565/1593/1644 against 1509/1616/1648 ms). The five frames after the compile wait on GPU frames (7-11 ms of CPU each), not on the gate.
- 2026-11-08 (agent): an always-on Wasm preload (`a1fe3000c`) made a repeat visit 150-200 ms slower, because a preloaded response loses V8's compiled-code cache. The preload runs only for a Wasm URL the browser has not fetched (`49c1ae3cb`).

## Execution Phases

#### Phase 1: The benchmark and its baseline
**Status:** DONE
**Files:** `scripts/load-bench.ts` (new), `package.json` (the `bench:load` script).

- [x] `pnpm bench:load` reports median first-visit and repeat `readyMs`, the adapter and bytes on the wire for one kit. proof: `pnpm bench:load --dist <kit>/dist --network 20000:40 --runs 5` on the laptop — 2026-11-08, `3ebe059ed`: adapter `intel/gen-12lp`, 5 first and 10 repeat visits per run, `.br` served (2805 KB first visit), `scripts/__tests__/load-bench.spec.ts` 2 passed.
- [x] The develop baseline is recorded here: three bench runs on the laptop for collectathon and for the minimal control, 20 Mbit/s and 40 ms. proof: `pnpm bench:load --dist <kit>/dist --network 20000:40 --runs 5` — packages from `origin/develop` `4dd50f4c2`, laptop load under 2, 74-98 °C:
  - collectathon first visit 3846 / 3902 / 3907 ms, repeat 2433 / 2512 / 2568 ms.
  - minimal first visit 3507 / 3555 / 3596 ms, repeat 2249 / 2292 / 2284 ms.
  - Unthrottled repeat-visit CPU profile (unminified build): in the minimal kit `cloudTextures()` (`templates/*/src/render/clouds.ts`, shared by six kits) runs about 0.6 s of main-thread JS before the first frame, and `bakedRadiance` about 0.12 s.

#### Phase 2: A repeat run does not redo the last run's work
**Status:** IN PROGRESS
**Files:** `packages/create-threenative/src/` (the `_headers` writer), `packages/core/src/asset-cache.ts` and `assets.ts` (`memo`), the collectathon template `src/level/` and `src/render/`, the warm-up path in `packages/core/src/warmup.ts`.

- [x] Hashed assets ship `Cache-Control: public, max-age=31536000, immutable`, and a repeat run makes no revalidation request. proof: `pnpm exec vitest run packages/create-threenative/__tests__` plus the bench request count — 2026-11-08, `3ebe059ed`: `web-brand.spec.ts`, `asset-memo.spec.ts`, `asset-cache.spec.ts`, `load-bench.spec.ts` 46 passed; a repeat visit makes 12 requests with 1 KB on the wire (the page itself).
- [ ] `ctx.assets.memo` returns the stored arrays on a repeat run, and the collectathon kit builds its world through it with its playtests green. proof: `pnpm exec vitest run packages/core/__tests__/asset-cache.spec.ts` plus `pnpm test:templates` for collectathon.
- [x] The hot paths a repeat run walks cost less, each kept only on a paired laptop gain. proof: `pnpm bench:load --kit collectathon --network 20000:40 --runs 5` — 2026-11-08: the scattering table built once in six kits and the reach cull over vertices (`e6f24156f`, repeat 1586-1632 ms from 1784-1795); foliage composes plain matrices and the path distance is a loop (`03414c30b`, 70-100 ms paired); a matrix over shared engine memory is a view, not a Proxy (`bf9a55778`, 1512/1569/1555 against 1566/1616/1644 ms paired). `browser-math.spec.ts` red-green, three-native 536 passed, physics 267 passed.

#### Phase 3: A first visit downloads and compiles less
**Status:** IN PROGRESS
**Files:** `packages/physics/src/web.ts`, the web build in `packages/create-threenative/src/`, the collectathon `src/scenes/Play.ts`.

- [x] Rapier downloads beside the engine boot, and `index.js` carries no base64 module. proof: `pnpm exec vitest run packages/physics/__tests__` plus the bench byte report — 2026-11-08, `3ae3ff027`: physics 267 passed; `index.js` 864 → 250 KB Brotli, Rapier its own 614 KB chunk; collectathon first visit 3545-3616 ms from 3695-3725, minimal 3132-3252 from 3268-3434.
- [x] The engine Wasm starts with the page and Rapier after it, on a first visit only. proof: `pnpm exec vitest run packages/create-threenative/__tests__/web-brand.spec.ts` plus a paired bench — 2026-11-08, `49c1ae3cb`: 8 passed; the Wasm lands at 670 ms, not 805; collectathon first 3123/3124/3140 against 3169/3277/3314 ms paired, repeat flat; minimal first 2931-2983 ms.
- [x] The collectathon paints its sky while its surface textures download. proof: `pnpm bench:load --kit collectathon --network 20000:40 --runs 5` — 2026-11-08, `637eda3a9`: first visit 3084/3221/3265 ms from 3545-3616.
