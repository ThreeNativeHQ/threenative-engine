---
prd_contract: v1
---

# PRD-VQ-15 — Hair cards preserve coverage, tangent highlights and shadow behavior across quality tiers

**Status:** PROPOSED — 2026-10-01. No implementation or qualification is claimed.
**Priority:** P2 — Proposed hair-card material with alpha and tangent contracts on rigged hair.
**Batch:** Visual quality execution batch. **Wave:** 3 / character-quality gate.
**Dependencies:** Uses qualified temporal/alpha behavior from PRD-455; VQ-12 is optional and not assumed to solve hair.

## Grounding and intended outcome

Ordinary Three physical materials, anisotropy and alpha techniques are the first candidates. A dedicated strand renderer is not established as necessary by a manifest search. The bounded target is a license-clear hair-card asset that survives camera motion, lighting changes and native rendering.

**Outcome:** A character's hair cards show authored directional highlights without losing silhouette coverage, sorting into obvious layers or casting an unrelated opaque block as their shadow.

## Design and ownership

Keep tangents, root-tip texture data, alpha thresholds, anisotropy and colors in generated materials. Prefer cutout/alpha-to-coverage or a qualified temporal technique when it preserves the asset. Do not silently use the smoke OIT approximation for hair, and do not promise order-independent physical scattering. Match visible and shadow alpha semantics. A low tier is an authored cheaper material/card representation, not an automatic deletion of random cards.

Hair cards only, one rigged character asset and a synthetic crossed-card fixture. No procedural grooming, individual strands, hair simulation, multiple-scattering solver or new core material system.

## Required behavior

- Tangent and alpha inputs are validated; missing data has an explicit fallback or error.
- The synthetic test exercises crossed cards, back/front views, moving highlights and shadow silhouettes.
- Camera motion and quality switches are evaluated as frame sequences for coverage/flicker, not one screenshot.
- Two character instances keep independent materials where controls differ and share immutable assets safely.

## Execution phases

All proof paths below are **planned implementation targets**, not existing passing tests. Reuse an existing equivalent test or scenario after inspecting current code, and update the canonical proof path rather than adding a duplicate. Follow EXECUTE.md for fixture setup, variables, review and repository gates.

### Phase 1 — Coverage and directional shading

- [ ] Implement a game-owned hair-card material from admitted upstream features with explicit alpha and tangent contracts. proof: `pnpm exec vitest run packages/create-threenative/__tests__/vq-hair-card-material-qualification.spec.ts`.
- [ ] Add coverage, highlight-direction and visible/shadow agreement checks on the synthetic fixture. proof: `pnpm exec vitest run packages/create-threenative/__tests__/vq-hair-card-material-qualification.spec.ts`.

### Phase 2 — Integrate the real character and tiers

- [ ] Apply the material to the rigged hair-card consumer without breaking skinning or borrowed resource ownership. proof: `pnpm exec vitest run packages/create-threenative/__tests__/vq-hair-card-material-qualification.spec.ts`.
- [ ] Implement explicit lower-cost tiers and temporal/cutout compatibility with scene-switch disposal tests. proof: `pnpm exec vitest run packages/create-threenative/__tests__/vq-hair-card-material-qualification.spec.ts`.

### Phase 3 — Qualify the visible result

- [ ] The moving-camera/head/light trace passes coverage and shadow checks on browser WebGPU with matched sequence review. proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/vq-hair-card-material-qualification.playtest.json --url ${VQ_URL:?} --browser-recipe webgpu`.
- [ ] The same hair asset and tier trace run on Linux native, reporting the actual alpha and temporal route. proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/vq-hair-card-material-qualification.playtest.json --target desktop --executable ${VQ_NATIVE_EXECUTABLE:?}`.

## Acceptance criteria

- [ ] The supported hair-card path preserves silhouette and shadow coverage through motion and tier changes; no strand-renderer support is implied. proof: the completed Phase 3 scenario outputs, with the named fixture, package/cohort and adapter recorded inline here.
- [ ] The feature preserves its documented inactive/fallback path and releases owned resources after repeated lifecycle transitions. proof: `pnpm exec vitest run packages/create-threenative/__tests__/vq-hair-card-material-qualification.spec.ts` plus the Phase 3 lifecycle scenario.

## Performance and promotion

Record alpha overdraw, card triangles, shader cost and temporal artifacts by tier. A visually worse but faster thinning is not accepted as a quality fix. Numerical targets are proposed acceptance targets, not benchmark results. Pin the fixture, metrics and thresholds before changing the implementation; never relax a failing threshold just to mark this PRD complete. Shared abstractions must pass the repository's reuse/LOC admission rule. Appearance remains editable source.

## Blocked on

A redistributable hair-card asset and human visual approval are external requirements. Grooming and physical-device scaling remain separate.

## Completion record

Update the phase boxes and this PRD only after the named proof runs. Record actual results inline, including any remaining exclusions. A merged planning or implementation PR alone is not proof that every acceptance criterion passed. Archive according to the parent PRD filing rules when the work is genuinely complete.
