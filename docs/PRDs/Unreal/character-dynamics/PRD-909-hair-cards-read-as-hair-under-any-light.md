---
prd_contract: v1
---

# PRD-909 — Hair cards read as hair under any light

**Status:** IN PROGRESS (2026-11-23) — the vendored card material ships in the starter template and runs on the owned engine (blend pass set) on the PRD-910 strands arm. Alpha-to-coverage, the anisotropy map, shadow agreement, the `hair-cards` parity row and the judge are open.
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

- [ ] AC-1: At the close pose of the PRD-910 scene, a fresh visual judge returns IMPROVEMENT for the hair material over a plain `MeshStandardMaterial` with alpha test, and names the highlight and the soft edge. proof: headed `--browser-recipe webgpu` captures on the owned engine, 2 runs per arm, judge subagent. — 2026-11-23, open, parked on content: judged three times on the owned engine (`?arm=strands&cape=0&view=close`, `&hairMat=plain` for the control, 2 runs per arm, criteria in `~/Downloads/character-dynamics-hair-judge/criteria.md`). Run 1 NEUTRAL: no highlight, because the owned engine had no anisotropic BRDF (now ported, box below). Run 2 REGRESSION: highlight present but faint, body visible through the hair, a mid-height seam, stippled tips. Run 3 (denser 40-strand atlas, root coverage 0.82) not judged: the same see-through look. Cause: the test hair is ONE layer of 24 cards, and a coverage material (alpha-to-coverage at 0.6 coverage) shows the body through one layer, where the alphaTest control cuts to opaque. Blocker: a layered groom (several card layers per guide, or a real hair-card asset). The asset MCP search for CC0 hair cards returns nothing (ambientCG, Poly Haven, Sketchfab CC0, kenney/kaykit/quaternius), so the layered cards must be baked from the PRD-912 guides.
- [ ] AC-2: The hair shadow coverage matches the visible coverage within 5% of the masked pixels. proof: `pnpm exec vitest run packages/create-threenative/__tests__/hair-card-material.spec.ts`
- [ ] AC-3: The desktop host renders the hair close pose within the conformance tolerance. proof: `pnpm parity --target desktop --only-tests hair-cards`

## Execution Phases

#### Phase 1: The material in a template

- [x] The vendored `hairNodes` land with their MIT header, behind `createHairCardMaterial` in the starter template's `src/render/`. proof: `pnpm exec vitest run packages/create-threenative/__tests__/hair-card-material.spec.ts` — 2026-11-23: `templates/starter/src/render/vendor/hair-shader.js` is upstream byte for byte below its MIT header (SHA-256 checked by the spec); `hair.ts` exports `createHairCardMaterial` with every colour, gradient, anisotropy and density as a named option. `hair-card-material.spec.ts` 4/4, `looks.spec.ts` 22/22 (vendored files exempt from the 200-line cap), starter kit hash repinned. Upstream sets no separate shadow threshold: the visible outer pass is the casting material, so shadow and visible coverage share one `alphaTest`; AC-2 still needs the pixel measurement.
- [ ] The PRD-910 hair arm wears cards with the material. proof: AC-1.

#### Phase 2: Shadows and every engine

- [ ] Visible and shadow coverage agree. proof: AC-2.
- [ ] The owned engine supports alpha-to-coverage and the anisotropy map; the desktop host matches. proof: AC-3. — 2026-11-23, open on AC-3 only. Anisotropy now draws on the owned engine (a678f335f): three r187's anisotropic GGX D and V terms, `anisotropyRotation`, `anisotropyMap`, the derivative tangent frame and the bent normal, ported to `standard.cpp`; `material-anisotropy` row red (owned desktop mismatch 0.138, `TN_MATERIAL_UNSUPPORTED anisotropy`) then green (engine `threenative`, 3.3e-6 on owned desktop and owned web); `12-pbr-material` and `11-mesh-standard-material` stay 0. Alpha-to-coverage holds: with `alphaToCoverage: true` (mode `both`: A2C hair plus the blend fringe) `?arm=strands&cape=0` passes `acceptance-hair` on both engines, and the two hard-stop crops differ by a mean of 0.002/255 (owned run carries `wasmScene` stages, upstream none). A fifth gap blocked A2C: `node.discard()` was missing on both hosts (fixed in `browser-tsl.ts` and the V8 `tsl.cpp`; red on owned web as `covB.lessThan(...).discard is not a function`). The blend pass set (outer + opaque core) runs too. Four engine gaps blocked it first, each fixed at its root with a red-green proof: (1) the owned `three/webgpu` also exports a refusing `WebGLRenderer`, so upstream's detector took the GLSL path; `hair.ts` now states the WebGPU renderer (`hair-card-material.spec.ts` runs against that namespace). (2) `Material.id` was an enumerable getter-only field, and upstream's `toNodeMaterial` copy loop threw on it; three hides it (`material-fields.spec.ts`, web and V8). (3) V8 enumerated write-only setters (`needsUpdate`), so the copy loop wrote `undefined` back. (4) `THREE.TSL` and `materialReference("opacity")` were missing on both hosts (`tsl-extras.spec.ts`). The `hair-guides` parity row runs the copy loop, `THREE.TSL`, `materialReference` and `.discard()`: pixelMismatchRatio 0 on `--target desktop` for upstream three and for `--engine threenative` (report `engine: threenative`, fresh owned bundle); owned web renders it and passes. It was red on both owned lanes before the TSL fix and on owned web before the `id` fix. `?arm=strands&cape=0` passes `acceptance-hair` on both engines with the card material, and the two hard-stop frames match by eye (`/tmp` crops; no judge yet).

## Blocked on

- A license-clear hair-card asset with a coverage atlas. Unblocked by a CC0 search through the asset MCP (`asset_search` "hair cards"), or by cards baked from PRD-912 guides.

## Decisions

- 2026-11-22 (agent): this PRD supersedes PRD-VQ-15's plan, which never started. VQ-15 asked for the same outcome with no implementation path. The vendored TSL path gives it one.
