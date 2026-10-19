# PRD-490 — Cluster LOD wins on native too

**Status:** PROPOSED
**Priority:** P1 — Shipped default virtual geometry carries a named native regression no PRD owns.
**Complexity:** 3 (LOW) — 1–5 engine files (+1); a multi-draw binding would cross into the C++ host (+2); risk override: none
**Owner:** João
**Depends on:** None

## Context

Virtual geometry (`ClusteredMesh` and `ClusteredBatch`, in `packages/core/src/clustered-*.ts`) is on by default for any primitive of 65,536 triangles or more. Its batch is [done/nanite-like](../done/nanite-like/README.md), which shipped with a named native regression that no open PRD owns. Measured on the quarry ([PRD-283's file](../../verification/prd-283-native-and-the-kernel-2026-08-30.md)):

| | browser 1080p | native 720p |
| --- | --- | --- |
| `virtual` `gpuMs` | **1.28** | 3.05 |
| `decimated` `gpuMs` | 2.45 | **1.64** |
| `virtual` / `decimated` draws | 89 / 10 | 89 / 10 |
| `virtual` `render.p95` | | 649.6 ms |

Three findings change the audit's framing:
- **The 89 draws are the same on both hosts.** That count is one instanced draw per occupied distance band (`distanceRatio`, default 1.25). Native loses because each draw replays a record from the frame-op stream, which costs more per draw than the browser path. At 720p the saved fragment work no longer pays for that.
- **The 649.6 ms frame predates the fix.** [PRD-286](../../verification/prd-286-virtual-geometry-ships-on-2026-08-30.md) spread band creation over frames (`GROUPS_BUILT_PER_UPDATE = 4`, `clustered-batch.ts`), and its own file says native was not re-measured. That run also logged an undiagnosed `Frame op stream replay failed: malformed record header` in the `virtual` arm only.
- **"No native counterpart" to multi-draw indirect is false for the pinned Dawn.** `packages/runtime-native/third_party/dawn/dawn-headers/include/dawn/webgpu.h` declares `WGPUFeatureName_MultiDrawIndirect` and `wgpuRenderPassEncoderMultiDrawIndexedIndirect`. Whether a given adapter grants the feature is unmeasured. The browser has only a Chromium experiment.

No conformance case exercises a clustered mesh (`registry.json` has none).

## Solution

Measure first, then fix the cheapest cause the numbers name:
1. **Re-measure** the quarry on native at 720p with today's spread build, with draws and triangles captured. A run that trips the console policy loses them, so the replay error is checked as part of this.
2. **Per-draw cost decides band width, automatically.** Band count is a cost trade between per-draw overhead and over-detailed triangles. The engine can measure both, so `distanceRatio` without an override is derived from the host's measured per-draw cost (auto by default). An explicit `distanceRatio` still wins and is reported as overridden.
3. **Multi-draw is a fallback.** It applies only if step 2 cannot get `virtual` under `decimated` on native. All bands would share one index buffer and submit through `MultiDrawIndexedIndirect` where the adapter grants the feature, falling back to per-band draws otherwise. That fallback means a three backend patch, a binding, and the five registrations a new native surface needs. It reopens the batch's decision 4 ("native gets no indirect-dispatch binding") only for draws, citing Phase 1's number.

The game's material still draws every cluster (the batch's rule 1).

## Acceptance Criteria

- [ ] AC-1 [local]: on native at 720p, the quarry's `virtual` arm costs less GPU time than `decimated` and is still closer to `dense` (the batch's decision 6). proof: `pnpm --filter quarry measure -- --arm virtual --target desktop`, the same for `--arm decimated`, and `pnpm --filter quarry compare -- --reference artifacts/quarry/native-dense --candidate artifacts/quarry/native-virtual` (and the same for `native-decimated`).
- [ ] AC-2 [local]: no frame of the native route's arrival exceeds 33 ms `render`. proof: `TN_FRAME_BUDGET` `render.max` from the same run.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Band width from measured per-draw cost | loader → `ClusteredBatch` → engine `updateClusteredMeshes` before render | Fixed 1.25 default becomes the override path | AC-1, Phase 2 |

## Execution Phases

#### Phase 1: Today's native number
**Status:** NOT STARTED
**Files:** none expected; `examples/quarry/scripts/measure.ts` only if it still drops draws on a console error
- [ ] `virtual`, `decimated` and `dense` measured on native at 720p on current develop: `gpuMs`, `render.p50`, `render.p95`, `render.max`, draws and triangles, with the frame-op replay error present or absent. proof: `pnpm --filter quarry measure -- --arm <arm> --target desktop` for each arm.

#### Phase 2: Fewer draws where draws cost more
**Status:** NOT STARTED
**Files:** `packages/core/src/clustered-batch.ts`; `packages/core/__tests__/`
- [ ] Without an override, `distanceRatio` follows the measured per-draw cost: a costlier draw gives fewer bands. An explicit value is kept and reported as `overridden`. proof: red-green `pnpm exec vitest run packages/core/__tests__/clustered-batch.spec.ts`.
- [ ] The quarry's `virtual` arm on native: draws fall and `gpuMs` is below `decimated`. proof: `pnpm --filter quarry measure -- --arm virtual --target desktop`.
- [ ] Browser does not regress: `virtual` `gpuMs` at 1080p stays ≤ 1.28 ms + 10%. proof: `pnpm --filter quarry measure -- --arm virtual --target browser`.

#### Phase 3: Native proves it on every change
**Status:** NOT STARTED
**Files:** `packages/runtime-native/conformance/scenes/shared/clustered-batch.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] A conformance case draws a small baked `TN_virtual_geometry` batch at three distances and matches the browser reference within tolerance, with a capture that is not blank. proof: `pnpm parity --target desktop --only-tests clustered-batch`.

## Decisions

- 2026-10-03 (agent, drafting this PRD): multi-draw indirect is plan B, not plan A. It costs a three backend patch and a native binding. Band width is one constant the engine can already measure its way to.
