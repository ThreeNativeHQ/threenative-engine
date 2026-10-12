# Epic — Unreal-class performance, in release cycles

**Status: OPEN — five release cycles (v1–v5), none started.** The live plan, the decisions log, the
v1 slices and every PRD's status are in **[ROADMAP.md](./ROADMAP.md)**. Update it in the same
commit as any slice or PRD phase that lands.

## The route

One owned C++ engine behind the three.js API: native on Dawn or wgpu, Wasm
(`tn-native-engine-web`) on the web, game code on V8 or browser JS. A game opts in with
`engine: "native"`; native becomes the default when the v1 KPI passes; the legacy engine is deleted
after one clean release ([PRD-535](../native-engine/PRD-535-n21-the-js-engine-is-deleted.md)).
Perry is parked (owner, 2026-10-11).

Where Midway web stood when the epic opened (native Wasm page against the three.js page): steady CPU
busy per frame 2.32x faster, frame p50 0.24x, first frame 0.48–0.62x, `enter` 0.96–1.09x, `ready`
0.73–1.05x. Inside the engine: animation about 13%, cull and project about 11%, `Renderer::render`
21% inclusive, transforms about 8%, `weak_ptr::lock()` 2.9% (since removed from the binding path).

## Rules for every PRD in this folder

- **One PR per PRD**, as `docs/PRDs/AGENTS.md` requires, opened as a draft at the first commit and
  labelled from `pnpm prd:progress`. A phase that edits engine files starts after the v1 slice that
  lands those files on develop. No PR targets `feat/native-engine`.
- **Same-run ratio.** Subject and control run in one command and one load window
  (`pnpm profile:wasm-page -- --url A --control B`, or several `bench:engines` arms in one
  invocation). Each report records the one-minute load average. Prefer a counter gate (calls,
  compositions, evaluations, compiles) to a timing gate: a counter does not move with host load.
- **Tails, not only medians.** A timing box reports p95, p99 and the hitch count beside p50. A
  median win with a worse p99 does not pass.
- **Visual judge** for a change that can alter a pixel, per the root `AGENTS.md`.
- **Red-green** for every behaviour change.
- **Bindings.** A public binding change regenerates `packages/three-native/api/` in the same commit.
- **Unreal licence.** Unreal source is under the Epic Games EULA. Read the design, write new code,
  copy nothing. A `UE 5.8.3: <path>` citation names a design reference (UE `release` `396c9f059`).

## Owned elsewhere — link, do not file again

- **JS-to-Wasm calls and upload bytes:** PRD-553 (`docs/PRDs/native-engine/` on
  `origin/feat/native-engine`; it lands with the v1 slices).
- **Engine batching, visibility, LOD and the GPU-scene kernel:** [PRD-519](../native-engine/PRD-519-n12-native-batching-visibility-lod-gpu-scene.md).
- **Animation rate policy in core TypeScript:** [PRD-570](../unreal-source-borrowing/PRD-570-a-character-costs-what-the-camera-sees-of-it.md).
- **Pipelines on the legacy host:** [PRD-327](../performance/critical/PRD-327-first-use-pipeline-compilation-leaves-the-main-loop.md),
  [PRD-387](../performance/critical/PRD-387-shader-variants-are-prepared-off-frame-and-bounded.md),
  [PRD-540](../performance/critical/PRD-540-the-compile-walk-leaves-the-main-thread.md) and
  [PRD-368](../assets/PRD-368-compiled-pipelines-survive-a-relaunch.md).
- **Texture residency and compression:** [PRD-VQ-10](../performance/PRD-VQ-10-texture-mip-residency.md), [PRD-568](../unreal-source-borrowing/PRD-568-mobile-builds-ship-gpu-ready-astc.md).
- **Frame-rate floors per platform:** [PRD-222](../performance/critical/PRD-222-performance-targets-per-platform.md).
- **Default promotion and legacy deletion:** [PRD-533](../native-engine/PRD-533-n20-platform-qualification-performance-default-promotion.md), [PRD-535](../native-engine/PRD-535-n21-the-js-engine-is-deleted.md).
