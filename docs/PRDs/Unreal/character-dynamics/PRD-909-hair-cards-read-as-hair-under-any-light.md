---
prd_contract: v1
---

# PRD-909 — Hair cards read as hair under any light

**Status:** NOT STARTED
**Priority:** P2 — No hair material exists. A character with hair cards renders them as opaque or sorted-alpha planes with a plastic highlight.
**Complexity:** 6 (MEDIUM) — vendored TSL card path (+1), alpha-to-coverage and core pass on the owned engine (+2), shadow alpha agreement (+1), visual judge (+1), native proof (+1)
**Owner:** João
**Depends on:** [PRD-910](PRD-910-a-running-character-proves-its-cape-and-hair-in-one-scene.md) (the scene that shows the hair). Supersedes the unstarted plan in [PRD-VQ-15](../../rendering/PRD-VQ-15-hair-card-material-qualification.md). Strand drawing stays in [PRD-671](../rendering/PRD-671-a-character-wears-strand-hair-that-catches-light-along-each-strand.md).

## Context

Unreal draws far and low-tier hair as cards and near hair as strands (PRD-671). The cards use the hair shading model with a coverage mask and a tangent. threejs-hair-shader (MIT) has a TSL card path for `MeshPhysicalNodeMaterial`: a data atlas (R coverage, G root-to-tip, B per-strand seed), root colour, per-strand colour and roughness jitter, GGX anisotropy, and alpha-to-coverage with an opaque core pass. It has no shadow handling.

## Solution

- **Look is game source.** `createHairCardMaterial(options)` ships as generated source in `templates/*/src/render/hair.ts` (rule 1b). The TSL node code from `src/hair-shader.js` (`hairNodes`) is vendored verbatim with its MIT header. Every colour, root gradient, anisotropy and density is a named option.
- **Coverage, not sorting.** With MSAA, it uses alpha-to-coverage plus a blended fringe. Without MSAA, it uses the upstream's two passes: an opaque core at `alphaTest 0.5` and a depth-written outer pass. The shadow pass uses the same coverage threshold, so the shadow matches the visible hair.
- **Engine mechanism, if any.** Any missing alpha-to-coverage or `anisotropyMap` support on the owned engine is fixed in `runtime-native` with a conformance case, not worked around in the material.
- **Searchable.** `@situation` lines cover "hair cards look flat", "hair material", "anisotropic hair highlight" and "hair alpha sorting".

## Acceptance Criteria

- [ ] AC-1: At the close pose of the PRD-910 scene, a fresh visual judge returns IMPROVEMENT for the hair material over a plain `MeshStandardMaterial` with alpha test, and names the highlight and the soft edge. proof: headed `--browser-recipe webgpu` captures on the owned engine, 2 runs per arm, judge subagent.
- [ ] AC-2: The hair shadow coverage matches the visible coverage within 5% of the masked pixels. proof: `pnpm exec vitest run packages/create-threenative/__tests__/hair-card-material.spec.ts`
- [ ] AC-3: The desktop host renders the hair close pose within the conformance tolerance. proof: `pnpm parity --target desktop --only-tests hair-cards`

## Execution Phases

#### Phase 1: The material in a template

- [ ] The vendored `hairNodes` land with their MIT header, behind `createHairCardMaterial` in the starter template's `src/render/`. proof: `pnpm exec vitest run packages/create-threenative/__tests__/hair-card-material.spec.ts`
- [ ] The PRD-910 hair arm wears cards with the material. proof: AC-1.

#### Phase 2: Shadows and every engine

- [ ] Visible and shadow coverage agree. proof: AC-2.
- [ ] The owned engine supports alpha-to-coverage and the anisotropy map; the desktop host matches. proof: AC-3.

## Blocked on

- A license-clear hair-card asset with a coverage atlas. Unblocked by a CC0 search through the asset MCP (`asset_search` "hair cards"), or by cards baked from PRD-912 guides.

## Decisions

- 2026-11-22 (agent): this PRD supersedes PRD-VQ-15's plan, which never started. VQ-15 asked for the same outcome with no implementation path. The vendored TSL path gives it one.
