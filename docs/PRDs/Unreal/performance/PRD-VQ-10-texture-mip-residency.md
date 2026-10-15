---
prd_contract: v1
---

# PRD-VQ-10 — Texture residency releases real GPU memory rather than only biasing sampling

**Status:** PROPOSED — 2026-10-01. No implementation or qualification is claimed.
**Priority:** P3 — Speculative streaming feature: variant records and byte accounting all proposed.
**Batch:** Visual quality execution batch. **Wave:** 3 / memory-gated.
**Dependencies:** Reconcile PRD-454 resource budgets and VQ-01 decoder selection first.

## Grounding and intended outcome

Existing asset cooking and world-cell residency already manage models, compressed textures and lifetimes. [PRD-454](https://github.com/ThreeNativeHQ/threenative/blob/develop/docs/PRDs/unreal-like-features/PRD-454-worldcells-budget-real-resources.md) owns truthful world-resource budgeting. This slice addresses a measured residual texture-memory bottleneck; it does not assume that lack of virtual texturing is itself a defect.

**Outcome:** A detailed world uses high-detail textures near the player, evicts unnecessary high-detail representations under a hard byte budget and restores them without black materials, stale binds or unbounded cache growth.

## Design and ownership

Begin with separately loadable cooked resolution variants or an available portable mip-loading mechanism. Merely changing LOD bias or sampler LOD limits does not count as memory reclamation. The existing asset owner holds shared references; replace representations atomically and retire GPU resources only after in-flight use is safe. Prioritize current view demand with hysteresis and cancellation, preserve a valid low-detail fallback, and report both committed and pending GPU bytes. No sparse-texture assumption or full runtime virtual-texturing system in v1.

Color/normal/roughness texture families in a representative streamed world; preserve color-space, normal-map and material binding semantics. No tile-feedback renderer or unrelated geometry streaming rewrite.

### What Unreal does (UE 5.8.3, read 2026-10-09; clean-room summary, no code copied)

- **Demand comes from screen size.** For each texture, Unreal computes the largest on-screen size in
  texels over all views. It wants `ceil(1 + log2(max(1, size)))` mips, clamped to the texture's
  allowed range (`Engine/Source/Runtime/Engine/Private/Streaming/StreamingTexture.cpp:305-311`).
  A per-texture boost factor, summed from its group and other sources, is cached with the texture (`StreamingTexture.h:291`, set at `StreamingTexture.cpp:82`).
- **Over budget, it drops from the top, lowest priority first.** The streamer walks textures from
  the lowest priority. It first drops the top mip of textures that use their full resolution, then
  the next mip, and so on, until the total fits
  (`Engine/Source/Runtime/Engine/Private/Streaming/AsyncTextureStreaming.cpp:444-465`). Each drop is
  kept as a persistent per-texture `BudgetMipBias` (`StreamingTexture.h:318-320`). It never goes
  below the minimum allowed mips, and it keeps one step of room so the bias can reset when memory
  frees (`StreamingTexture.cpp:411-436`). "Lowest priority" is a sum of weights: visible, not huge
  and small textures score higher, and among hidden textures the most recently seen scores higher
  (`StreamingTexture.cpp:395-407`).
- **The pool is a quality setting.** The texture tiers set 400, 600, 800 and 1000 MB pools, and the
  Cinematic tier sets 3000 MB. Only the three lowest tiers cap the pool at the device's VRAM
  (`Engine/Config/BaseScalability.ini:740-794`).
- **Uploads can be rationed.** The lowest tier streams at most one texture per frame
  (`r.Streaming.AmortizeCPUToGPUCopy` with `r.Streaming.MaxNumTexturesToStreamPerFrame`,
  `BaseScalability.ini:743-744`, cvars at `StreamingManagerTexture.cpp:1644-1656`). Both default to off.

**What changes here.** Demand uses the same screen-size rule, mapped onto cooked variants instead
of mips: a texture asks for the smallest variant whose size covers its largest on-screen footprint.
Over budget, the drop order and the persistent per-texture bias above replace an unspecified
eviction policy. No fixed pool size is adopted: WebGPU exposes no VRAM figure, so the budget stays
the game's, and the synthetic 256 MiB below remains a fixture value only. **A WebGPU texture cannot
shrink in place.** A `GPUTexture` has a fixed size and mip count, and a mip cannot be freed. A drop
or a restore is therefore a new texture of the other variant, swapped into every material that
binds it, and the old one is destroyed only after the GPU has finished the frames that used it.
Mobile variants use [PRD-568](../../done/PRD-568-mobile-builds-ship-gpu-ready-astc.md)'s ASTC output,
where it applies.

## Required behavior

- Shared textures are counted once, and active materials never reference disposed textures.
- A hard budget includes pending replacement overlap and a reserved fallback; over-budget pressure is reported rather than hidden.
- Teleport, cancellation and two out-and-back routes return resident resources to the expected baseline.
- Improvement is shown in real allocation/residency accounting, not only smaller files or a visually blurrier frame.

## Execution phases

All proof paths below are **planned implementation targets**, not existing passing tests. Reuse an existing equivalent test or scenario after inspecting current code, and update the canonical proof path rather than adding a duplicate. Follow EXECUTE.md for fixture setup, variables, review and repository gates.

### Phase 1 — Cooked variants and truthful ownership

- [ ] Extend the existing cook/manifest only with the required variant records and capability-aware cache identity. proof: `pnpm exec vitest run packages/core/__tests__/vq-texture-mip-residency.spec.ts`.
- [ ] Implement shared variant lifetime and byte accounting including pending uploads and in-flight retirement. proof: `pnpm exec vitest run packages/core/__tests__/vq-texture-mip-residency.spec.ts`.

### Phase 2 — Bounded demand and safe replacement

- [ ] Add budgeted demand (smallest variant covering the largest on-screen footprint), lowest-priority-first drops with a persistent per-texture bias that resets when the budget recovers, hysteresis and cancellation, while retaining a valid fallback representation. proof: `pnpm exec vitest run packages/core/__tests__/vq-texture-mip-residency.spec.ts`.
- [ ] Wire atomic material replacement and verify repeated streaming/teleport cycles release actual high-detail allocations. proof: `pnpm exec vitest run packages/core/__tests__/vq-texture-mip-residency.spec.ts`.

### Phase 3 — Qualify the visible result

- [ ] A fixed world route stays inside the declared allocation budget and demonstrates near-detail restoration on browser WebGPU. proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/vq-texture-mip-residency.playtest.json --url ${VQ_URL:?} --browser-recipe webgpu`.
- [ ] The same cooked package and budget contract pass on Linux native, with explicit decoder/format reporting. proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/vq-texture-mip-residency.playtest.json --target desktop --executable ${VQ_NATIVE_EXECUTABLE:?}`.

## Acceptance criteria

- [ ] The route reduces measured resident texture bytes while preserving near-field quality and avoiding missing-texture frames; no demonstrated bottleneck means defer the feature. proof: the completed Phase 3 scenario outputs, with the named fixture, package/cohort and adapter recorded inline here.
- [ ] The feature preserves its documented inactive/fallback path and releases owned resources after repeated lifecycle transitions. proof: `pnpm exec vitest run packages/core/__tests__/vq-texture-mip-residency.spec.ts` plus the Phase 3 lifecycle scenario.

## Performance and promotion

Use a fixed 256 MiB test budget only for the synthetic fixture, not as a shipping default. Include overlap and fallback bytes; measure upload hitches separately, and cap new uploads per frame as Unreal's lowest tier does. Numerical targets are proposed acceptance targets, not benchmark results. Pin the fixture, metrics and thresholds before changing the implementation; never relax a failing threshold just to mark this PRD complete. Shared abstractions must pass the repository's reuse/LOC admission rule. Appearance remains editable source.

## Blocked on

A world with an observed texture-memory bottleneck is required for admission. Mobile claims require decoder qualification and a named device run.

## Completion record

Update the phase boxes and this PRD only after the named proof runs. Record actual results inline, including any remaining exclusions. A merged planning or implementation PR alone is not proof that every acceptance criterion passed. Archive according to the parent PRD filing rules when the work is genuinely complete.

## Decisions

- 2026-10-12 (Unreal source review): corrected the pool-tier claim. Only tiers 0 to 2 cap the pool at VRAM, and Cinematic is 3000 MB. Added the retention-priority weights and the per-frame upload cap from Unreal. No box changed: the per-frame upload cap is a measure under the existing "upload hitches" line, and the Phase 2 replacement box already covers it.
