---
prd_contract: v1
---

# PRD-VQ-06 — Many local lights use a qualified upstream tiled or clustered path

**Status:** PROPOSED — 2026-10-01. No implementation or qualification is claimed.
**Priority:** P2 — Proposed qualified tiled or clustered light route with a measured admission decision.
**Batch:** Visual quality execution batch. **Wave:** 2 / scalable lighting.
**Dependencies:** Use PRD-457 for local shadow work. This PRD owns direct-light selection, not a new shadow atlas.

## Grounding and intended outcome

The reviewed render surface does not expose a qualified many-light route. Current upstream documents [TiledLightsNode](https://threejs.org/docs/pages/TiledLightsNode.html), [ClusteredLightsNode](https://threejs.org/docs/pages/ClusteredLightsNode.html) and [DynamicLightsNode](https://threejs.org/docs/pages/DynamicLightsNode.html). [pnpm-workspace.yaml](https://github.com/ThreeNativeHQ/threenative/blob/d72778382b134ef8763f58825cb4d4fd8cc0f6e3/pnpm-workspace.yaml) pins Three 0.185.1: online availability is not proof that an addon exists or works in this pin.

**Outcome:** A corridor/city-night fixture with 256 unshadowed point lights renders the same intended lighting at a lower measured cost than the ordinary per-light baseline on a workload where light-list culling helps.

## Design and ownership

Inspect the installed Three pin and patches before selecting a donor. Prefer its supported tiled/clustered or dynamic-light implementation. Use an upstream-compatible upgrade only with regression qualification; do not write a parallel Forward+ renderer from the audit wording. Unsupported light types, cookies and shadowed lights retain an explicit stock route. Cluster overflow must preserve illumination through a correct fallback rather than dropping lights. Game source owns light intensities, colors and geometry.

Point-light throughput first; explicitly enumerate support for spots, directional lights, transparency and shadow-casting lights. Keep the existing renderer, material system and directional shadow path.

## Required behavior

- A correctness fixture compares the optimized and reference direct-light results before temporal or post effects.
- Overflow, camera clipping, light movement, addition/removal and depth-separated lights are covered.
- A missing addon or unsupported native feature is reported, not replaced with an unqualified backend.
- The existing PBR, animated/instanced and probe-consuming material fixtures keep their intended lighting.

## Execution phases

All proof paths below are **planned implementation targets**, not existing passing tests. Reuse an existing equivalent test or scenario after inspecting current code, and update the canonical proof path rather than adding a duplicate. Follow EXECUTE.md for fixture setup, variables, review and repository gates.

### Phase 1 — Admit the installed upstream path

- [ ] Integrate the smallest compatible upstream lighting route with explicit per-light support and a correct fallback. proof: `pnpm exec vitest run packages/core/__tests__/vq-many-local-lights.spec.ts`.
- [ ] Cover light-list correctness, overflow and scene-lifetime changes against the ordinary Three path. proof: `pnpm exec vitest run packages/core/__tests__/vq-many-local-lights.spec.ts`.

### Phase 2 — Connect real materials and measured selection

- [ ] Exercise the route on animated, instanced and transparent receiver fixtures without replacing their material ownership. proof: `pnpm exec vitest run packages/core/__tests__/vq-many-local-lights.spec.ts`.
- [ ] Add direct-light work counters and a measured opt-in/admission decision for the representative many-light workload. proof: `pnpm exec vitest run packages/core/__tests__/vq-many-local-lights.spec.ts`.

### Phase 3 — Qualify the visible result

- [ ] The 256-light scene passes image/correctness checks and a paired GPU-cost comparison on a named WebGPU adapter. proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/vq-many-local-lights.playtest.json --url ${VQ_URL:?} --browser-recipe webgpu`.
- [ ] The same fixture passes on Linux native and records its own cost result; a browser speedup is not reused as a native result. proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/vq-many-local-lights.playtest.json --target desktop --executable ${VQ_NATIVE_EXECUTABLE:?}`.

## Acceptance criteria

- [ ] The optimized route preserves the reference illumination and wins on the declared many-light workload; otherwise keep it opt-in or decline it with the measurement. proof: the completed Phase 3 scenario outputs, with the named fixture, package/cohort and adapter recorded inline here.
- [ ] The feature preserves its documented inactive/fallback path and releases owned resources after repeated lifecycle transitions. proof: `pnpm exec vitest run packages/core/__tests__/vq-many-local-lights.spec.ts` plus the Phase 3 lifecycle scenario.

## Performance and promotion

Measure direct-light and shadow cost separately. No claim that 256 shadowed lights or every spot-light feature is supported by a point-light cluster implementation. Numerical targets are proposed acceptance targets, not benchmark results. Pin the fixture, metrics and thresholds before changing the implementation; never relax a failing threshold just to mark this PRD complete. Shared abstractions must pass the repository's reuse/LOC admission rule. Appearance remains editable source.

## Blocked on

Additional hardware and Three upgrades require their own compatibility runs before default-on promotion.

## Completion record

Update the phase boxes and this PRD only after the named proof runs. Record actual results inline, including any remaining exclusions. A merged planning or implementation PR alone is not proof that every acceptance criterion passed. Archive according to the parent PRD filing rules when the work is genuinely complete.
