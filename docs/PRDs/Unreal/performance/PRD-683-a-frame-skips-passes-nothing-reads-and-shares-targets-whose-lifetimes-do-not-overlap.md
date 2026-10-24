---
prd_contract: v1
---

# PRD-683 — A frame skips the passes nothing reads and shares one target between passes that never overlap

**Status:** NOT STARTED
**Priority:** P3 — Phase 1 is open: the native render graph already plans shared targets, but no renderer allocates from that plan, and no measurement yet says how many bytes or passes a shipped template would save.
**Complexity:** 5 (MEDIUM) — 1–5 implementation files in `packages/runtime-native/src/engine/renderer/` (+1), GPU resource lifetime across frames and resizes (+2), one renderer for the web Wasm build and the desktop build (+1), native proof on two platforms (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-523](../../native-engine/N14-native-render-chain-and-advanced-visuals/PRD-523-n14a-the-render-graph-owns-passes-and-history.md). Its graph compile (dependency order, lifetime-based slot plan, diagnostics) is in the tree in `render_graph.cpp`, with its boxes still open. This PRD does not redo that compile. It adds pass culling and the consumer that allocates from the plan. Composes with [PRD-564](../../done/PRD-564-the-resolution-scale-changes-without-reallocating-a-target.md) (targets survive a scale change) and [PRD-213](../../performance/PRD-213-gpu-memory-is-accounted-and-bounded.md) (GPU memory is bounded).

## Context

**Unreal LOC:** 103,555 for "RenderCore (RDG, shader maps)" in the
[feature map](../research/unreal-visuals-and-performance-feature-map.md), complexity 9. The render
graph proper is about 21,000 of those lines (`RenderCore/Private/RenderGraph*`,
`RenderCore/Public/RenderGraph*`, `RenderTargetPool.*`). The rest is shader maps and RHI glue.
**Port estimate:** about 300 to 450 ThreeNative lines. About 60 lines of culling in
`render_graph.cpp`, about 150 lines of pooled allocation in `post/effects.cpp`, about 60 lines of
report, and about 120 lines of tests and sweep output.

The [Unreal README](../README.md) lists "RDG-class scheduling" as deferred until WebGPU exposes the
API. That is true for two parts only: async compute and heap aliasing (two resources of different
shapes in one memory block). Pass culling, same-shape target reuse and automatic barriers need no
new API. WebGPU implementations already insert every barrier, so that outcome is held today.

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

- **Pass culling is on by default.** The graph removes passes whose outputs nothing uses
  (`r.RDG.CullPasses`, default 1). `UE 5.8.3: Engine/Source/Runtime/RenderCore/Private/RenderGraphPrivate.cpp:231-238`.
- **The cull walks back from roots.** Each pass starts marked as culled. A pass is kept when it
  writes a cull root, has external outputs, or carries the never-cull flag. Keeping a pass pushes its
  producers onto a stack, and the walk un-culls them in turn.
  `UE 5.8.3: Engine/Source/Runtime/RenderCore/Private/RenderGraphBuilder.cpp:2372-2381`, and the
  stack walk at `RenderGraphBuilder.cpp:1278-1324`.
- **A cull root is a resource that leaves the graph:** an external resource or one extracted for a
  later frame (history). `UE 5.8.3: Engine/Source/Runtime/RenderCore/Public/RenderGraphResources.h:356-359`.
  Readback passes always carry the never-cull flag.
  `UE 5.8.3: Engine/Source/Runtime/RenderCore/Public/RenderGraphDefinitions.h:147,159`.
- **Transient resources come from a transient allocator by default** (`r.RDG.TransientAllocator`,
  default 1), which places resources with disjoint lifetimes in one heap.
  `UE 5.8.3: Engine/Source/Runtime/RenderCore/Private/RenderGraphPrivate.cpp:249-256`. Indirect
  argument buffers stay out of it, as a guard against driver crashes.
  `RenderGraphPrivate.cpp:416-420`.
- **Without heap aliasing, a pool reuses targets by descriptor.** The render-target pool hashes the
  descriptor and hands back a free element with an equal one, or creates a new one.
  `UE 5.8.3: Engine/Source/Runtime/RenderCore/Private/RenderTargetPool.cpp:211-234`.
- **The pool releases what goes unused.** An element unused for more than 10 frames is released.
  `RenderTargetPool.cpp:689-705`. Above a floor (`r.RenderTargetPoolMin`), the oldest element
  unused for more than 2 frames goes first. `RenderTargetPool.cpp:360-420`. The floor is 300 MB at
  the lowest post-process tier and 400 MB at the high tiers.
  `UE 5.8.3: Engine/Config/BaseScalability.ini:572,629,666`.
- **Contiguous raster passes with the same targets merge into one render pass**
  (`r.RDG.MergeRenderPasses`, default 1). `RenderGraphPrivate.cpp:240-247`, merge at
  `RenderGraphBuilder.cpp:1425-1490`.
- **Async compute runs tagged passes on a second queue** (`r.RDG.AsyncCompute`, default 1).
  `RenderGraphPrivate.cpp:210-218`. WebGPU has one queue.

### ThreeNative today

- **The native graph plans, but nobody allocates from the plan.**
  `packages/runtime-native/src/engine/renderer/graph/render_graph.cpp:97-196` orders passes and
  assigns each transient a physical slot. Two transients share a slot when their descriptors are
  equal and their lifetimes do not overlap. No renderer reads `physicalOf` or `physicalCount`
  (`rg physicalOf packages/runtime-native/src` finds only the graph, 2026-10-21). Only
  `tests/native-engine/render_graph_test.cpp:61-66` reads them.
- **Post allocates one texture per pass output.** `PostEffects::render` builds a graph each frame
  and uses only its order (`packages/runtime-native/src/engine/renderer/post/effects.cpp:389-420`).
  `PostEffects::resize` gives every pass output its own target (`effects.cpp:195-215`).
- **The main frame uses the graph only to validate virtual shadows.**
  `packages/runtime-native/src/engine/renderer/renderer.cpp:3355-3367`. Shadow passes, the main
  pass, the viewport copy and TRAA allocate and run outside it.
- **Post passes that the output cannot reach are already skipped.** `graph::postPasses` collects
  passes by walking from the output node
  (`packages/runtime-native/src/engine/shader/graph/post_effects.cpp:474-492`). The three.js path
  (`engine: "threejs"`, and the Android legacy host) builds its TSL graph from the output node in
  the same way, and `packages/core/src/render/chain.ts` drops refused stages before they build. So
  the open cull question is the main frame: a shadow map, an MRT attachment or a copy that no later
  pass reads.
- **The engine is the default on web (Wasm) and desktop.** Android still runs the legacy host
  ([`NATIVE-ENGINE-DECISION.md`](../../../architecture/NATIVE-ENGINE-DECISION.md), amendment of
  2026-10-15). The same renderer sources compile into both builds
  (`packages/runtime-native/cmake/NativeEngineCore.cmake:137-141`).
- **A sweep already builds the graph for every template's post chain.**
  `packages/runtime-native/tests/native-engine/template_post_packages.cpp:96-114`. It uses one
  320×240 descriptor for every target, so its slot count says nothing about real sizes yet.

## Solution

**Mechanism only. No pass, format or size changes, so the frame does not change.**

| Unreal outcome | ThreeNative module | Layer | Needs a new API? |
| --- | --- | --- | --- |
| Pass culling from roots | `RenderGraph::compile` gains roots: present, history writes, readbacks and timers. A pass that feeds no root is culled and named in the report | `packages/runtime-native/src/engine/renderer/graph/` | No |
| Transient reuse | `PostEffects` allocates one texture per physical slot, from a pool keyed by descriptor, and releases a texture unused for 10 frames | `packages/runtime-native/src/engine/renderer/post/effects.cpp` | No. Same-descriptor reuse only |
| Main-frame passes in the graph | Only the passes the Phase 1 census names as unread go through the graph | `packages/runtime-native/src/engine/renderer/renderer.cpp` | No |
| Automatic barriers | Held today: Dawn and the browser insert them | none | No |
| Render pass merging | Deferred. Revisit when a tile-GPU profile shows load and store traffic between adjacent passes with the same attachments | none | No |
| Heap aliasing of different shapes, async compute | Deferred until WebGPU exposes memory heaps or a second queue | none | Yes |

- **Report:** `TN_RENDER_GRAPH` prints passes run, passes culled with their names, transient
  targets, physical targets and transient bytes. A culled pass is never silent.
- **Override:** `TN_RENDER_GRAPH_CULL=0` and `TN_RENDER_GRAPH_SHARE=0` turn each half off for a
  bisect. The report names the override when it is set.
- **The three.js path is not changed.** Its render targets belong to three's nodes. Sharing them
  would need a three patch, which is a last resort. Android gets this PRD when it moves to the
  native engine.

Risks:

- A pass that reads a target from an earlier frame through a raw texture handle, not through a
  declared history, would read another pass's pixels after sharing. Phase 2 declares every history
  as external, and the desktop parity case catches a missed one.
- Culling a pass whose side effect is a timer or a readback. Both become roots before culling is on.

## Acceptance Criteria

- [ ] AC-1 [local]: On the web Wasm engine, the starter frame at 1920×1080 holds fewer transient target bytes than before by at least two full-resolution `rgba16float` targets (33 MB), or Phase 1 recorded a deferral under `## Decisions`. proof: the `TN_RENDER_GRAPH` line from `node packages/playtest/dist/runner/cli.js <starter scenario> --browser-recipe webgpu`, before against after — Evidence: pending.
- [ ] AC-2 [local]: A fresh judge subagent returns NEUTRAL or IMPROVEMENT for the same starter pose before and after, on the desktop native engine and on the web Wasm engine, at least two captures per arm, `adapter.info` checked. proof: judge verdict on the PR with the BEFORE and AFTER images — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Pass culling | Every frame on the native engine → `RenderGraph::compile` in `PostEffects::render` and the main frame | Adds a cull step. No pass is removed from source | Phase 2 |
| Shared transient targets | `PostEffects::resize` and `render` → one texture per physical slot | Replaces one texture per pass output in `effects.cpp:195-215` | Phase 2, AC-1 |
| `TN_RENDER_GRAPH` report | Playtest log on web Wasm and desktop | New line | Phase 1 |

## Decisions

- 2026-10-21 (filing): PRD-523's Solution names pool allocation and aliasing, but its boxes prove only the graph compile. This PRD takes the renderer consumer and pass culling. It does not reopen ordering, diagnostics or history, which stay with PRD-523.
- 2026-10-21 (filing): reuse is limited to targets with equal descriptors, which is what `render_graph.cpp` already plans. Unreal's heap aliasing of different shapes needs an API WebGPU lacks.

## Execution Phases

#### Phase 1: How many bytes and passes would the graph save?
**Status:** NOT STARTED
**Files:** `packages/runtime-native/tests/native-engine/template_post_packages.cpp`, `packages/runtime-native/tests/native-engine/template-post-packages.ts`, `packages/runtime-native/src/engine/renderer/renderer.cpp`
The rest of this PRD continues only when one shipped template would save at least 33 MB at 1920×1080, or has at least one main-frame pass that nothing reads. Otherwise record a deferral under `## Decisions`, delete the Phase 2 and 3 boxes (R4), and name the revisit condition: a template whose post chain holds three or more same-shape full-resolution targets.
- [ ] The template post sweep prints, per shipped template at 1920×1080 with each pass's real size and format, the transient count, the physical count and the bytes saved. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_template_post_packages`.
- [ ] The native renderer prints `TN_RENDER_GRAPH` with the count of main-frame passes and attachments that no later pass, present or readback reads, on starter, racing and shooter. proof: `node packages/playtest/dist/runner/cli.js <template scenario> --target desktop` log, one run per template.

#### Phase 2: Cull and share on the native engine
**Status:** NOT STARTED
**Files:** `packages/runtime-native/src/engine/renderer/graph/render_graph.h`, `packages/runtime-native/src/engine/renderer/graph/render_graph.cpp`, `packages/runtime-native/src/engine/renderer/post/effects.cpp`, `packages/runtime-native/src/engine/renderer/renderer.cpp`, `packages/runtime-native/tests/native-engine/render_graph_test.cpp`
- [ ] A pass that feeds no root is culled, and a pass that writes present, a history, a readback or a timer is never culled. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_render_graph_cull` (new).
- [ ] `PostEffects` allocates one texture per physical slot, reuses a pooled texture with an equal descriptor across frames and resizes, and releases one unused for 10 frames. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_post_transient_pool` (new).
- [ ] Each main-frame pass that the Phase 1 census named as unread goes through the graph and is reported as culled. proof: `node packages/playtest/dist/runner/cli.js <starter scenario> --target desktop` log.

#### Phase 3: Same pixels, same frame time
**Status:** NOT STARTED
**Files:** `packages/runtime-native/conformance/scenes/shared/render-graph-transients.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] The desktop native engine renders a post chain with shared targets to match the browser reference within tolerance. proof: `pnpm parity --target desktop --only-tests render-graph-transients`.
- [ ] The starter GPU frame p50 at 1920×1080 on the RTX 2080 desktop native lane stays within 1% of the before arm, in a paired A/B with at least two runs per arm. proof: `TN_FRAME_BUDGET` p50 from `node packages/playtest/dist/runner/cli.js perf`, share and cull on against off.
