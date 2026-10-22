---
prd_contract: v1
---

# PRD-672 — Terrain shades its layers once into cached pages, not every pixel every frame

**Status:** NOT STARTED
**Priority:** P3 — Phase 1 is an unbuilt gate: no measurement says that terrain splat shading or texture memory limits a shipped game, and texture mip residency (PRD-VQ-10) comes first.
**Complexity:** 8 (HIGH) — 6–10 implementation files (+2), a page table, a physical page pool and a feedback readback are three new GPU resources (+2), page production competes with the frame budget (+2), a visual judge (+1), native proof on the owned host (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-VQ-10](PRD-VQ-10-texture-mip-residency.md) (texture residency comes first, and its result feeds the Phase 1 memory number). Builds on the terrain splat from [PRD-493](../../open-world/PRD-493-terrain-layers-past-sixteen-textures.md) and [PRD-567](../../done/PRD-567-terrain-layers-blend-by-their-own-height.md).

## Context

**Unreal size.** Virtual texturing is 17,313 lines in the feature map (15,462 C++, 1,851 shader).
A ThreeNative port of the runtime virtual texture for terrain is about 900 TypeScript lines and
about 400 C++ lines. Streaming virtual textures from disk are out of this PRD.

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

- **The system is on, and a level opts in.** `r.VirtualTextures` defaults to 1
  (`UE 5.8.3: Engine/Source/Runtime/Engine/Private/Texture.cpp:66-70`). A runtime virtual texture
  draws only when a level places a volume for it and a material writes to it. The OpenWorld
  template map is binary, so the source cannot say whether it holds one.
- **A runtime virtual texture has fixed page sizes.** The defaults are 256 tiles across the largest
  world axis, 256-pixel tiles and a 4-pixel border. The content is base colour, normal and
  specular (`Engine/Source/Runtime/Engine/Classes/VT/RuntimeVirtualTexture.h:24-42`). Continuous
  update is off (`:79`).
- **Feedback says which pages the frame wants.** The feedback buffer is the render resolution
  divided by 16, rounded up to a power of two (`Engine/Source/Runtime/Engine/Private/VT/VirtualTextureScalability.cpp:96-99`).
- **Page work has a frame budget.** At most 32 pages are produced per frame, and at most 2 uploads
  per frame run in game, or 32 for streaming textures (`VirtualTextureScalability.cpp:12-30`).
- **Quality tiers set anisotropy.** `r.VT.MaxAnisotropy` is 4 at the two low tiers and 8 above
  (`Engine/Config/BaseScalability.ini:747-791`).
- **The renderer side** is the page pool, the page table, the allocator, the feedback readback and
  the runtime producer that renders a page from the material
  (`Engine/Source/Runtime/Renderer/Private/VT/TexturePagePool.cpp`, `TexturePageMap.cpp`,
  `VirtualTextureFeedback.cpp`, `RuntimeVirtualTextureProducer.cpp`, `RuntimeVirtualTextureRender.cpp`).

### ThreeNative today

- The terrain splat samples every layer at every pixel each frame. Same-size layers stack into one
  array texture per set, because WebGPU guarantees 16 sampled textures per stage
  (`packages/core/src/world-terrain-splat.ts:278-279`, `:351`, `:440`).
- PRD-567 added height blending per layer, so each pixel reads each layer's height too.
- PRD-VQ-10 plans mip residency under a byte budget and rules out a tile-feedback renderer for
  itself. This PRD is that renderer, for terrain only.
- The Unreal README lists runtime virtual textures under "Declined by rule". The owner rule of
  2026-10-21 replaces that with a deferral, recorded under `## Decisions`.

## Solution

| Unreal part | ThreeNative module | Layer |
| --- | --- | --- |
| Page pool and page table (`TexturePagePool.cpp`, `TexturePageMap.cpp`) | `packages/core/src/virtual-texture.ts`: one physical atlas of 256-px pages with a 4-px border, and a page-table texture | core mechanism |
| Feedback (`VirtualTextureFeedback.cpp`, factor 16) | the terrain pass writes wanted page IDs at 1/16 resolution, read back without a stall one frame late | core mechanism |
| Runtime producer (`RuntimeVirtualTextureProducer.cpp`) | renders the game's splat material into a page, at most 32 pages a frame, nearest first | core mechanism |
| Material output (base colour, normal, specular) | the game's splat material decides what a page holds. The template passes it | template look |
| Anisotropy per tier | the template `quality.ts` | template look |

- **Auto by default.** The page budget, the pool size and the feedback size come from the screen
  size and the frame budget. `TN_VIRTUAL_TEXTURE` reports pages resident, pages produced, misses
  and the pool bytes.
- **Never own the look.** A page is the game's own splat material, rendered once. The package adds
  no colour.

Risks:

- A page miss shows a coarser mip for a frame. The feedback reads one frame late, so a fast camera
  sees it. The visual judge checks a camera sweep.
- The pool costs memory. The pool replaces no texture, so this PRD saves shading time, not bytes.

## Acceptance Criteria

- [ ] AC-1 [local]: The strata forest terrain costs at least 30% less GPU time with cached pages than with the per-pixel splat at 1080p on the RTX 2080 browser WebGPU lane. proof: `node packages/playtest/dist/runner/cli.js perf`, pages on against off — Evidence: pending.
- [ ] AC-2 [local]: A fresh visual judge returns NEUTRAL or IMPROVEMENT for the same terrain poses and a camera sweep, before and after. proof: headed `--browser-recipe webgpu` captures, two runs each, fresh visual-judge subagent — Evidence: pending.
- [ ] AC-3 [local]: The desktop native host fills and samples the page pool within the conformance tolerance. proof: `pnpm parity --target desktop --only-tests virtual-texture` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| `VirtualTexture` for terrain | `packages/terrain/starter/forest/world.ts` → terrain splat material → page producer → page-table sample | Replaces the per-pixel splat only where AC-1 passes. The splat stays the fallback | Phase 2, AC-1 |

## Decisions

- 2026-10-21 (filing): Deferred, not declined, under the owner rule of 2026-10-21. The Unreal README line "Declined by rule: ... runtime virtual textures" predates that rule. The revisit condition is a Phase 1 result where the terrain splat costs more than 1.5 ms at 1080p, or where texture memory still limits a shipped game after PRD-VQ-10.

## Execution Phases

#### Phase 1: Measure the splat bill
**Status:** NOT STARTED
**Files:** `examples/strata-terrain-preview/scripts/splat-cost.ts` (new)
- [ ] The strata forest records terrain GPU time with the full splat against a flat single-layer material at 1080p, and the resident texture bytes. proof: `pnpm --filter strata-terrain-preview exec tsx scripts/splat-cost.ts`.
- [ ] The gate verdict is written under `## Decisions`: continue only if the splat costs more than 1.5 ms. proof: the Phase 1 table in this PRD.

#### Phase 2: Pages on the web
**Status:** NOT STARTED
**Files:** `packages/core/src/virtual-texture.ts`, `packages/core/src/world-terrain-splat.ts`, `packages/core/src/index.ts`, `packages/core/__tests__/virtual-texture.spec.ts`
- [ ] The page table maps every world position to the right page and mip, and borders keep a trilinear tap inside its page. proof: `pnpm exec vitest run packages/core/__tests__/virtual-texture.spec.ts`.
- [ ] The producer renders at most 32 pages a frame, nearest first, and the pool evicts the least recently wanted page. proof: `pnpm exec vitest run packages/core/__tests__/virtual-texture.spec.ts`.
- [ ] The strata forest terrain samples cached pages on browser WebGPU. proof: AC-1 perf run and AC-2 visual judge.

#### Phase 3: The owned host
**Status:** NOT STARTED
**Files:** `packages/runtime-native/conformance/scenes/shared/virtual-texture.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] The desktop host fills the pool from feedback and matches the browser reference. proof: `pnpm parity --target desktop --only-tests virtual-texture`.
