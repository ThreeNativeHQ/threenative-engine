---
prd_contract: v1
---

# PRD-VQ-12 — Overlapping transparent effects have an explicit correct or bounded-approximate path

**Status:** PROPOSED — 2026-10-01. No implementation or qualification is claimed.
**Priority:** P2 — Proposed correct-or-bounded transparent route with order and history tests.
**Batch:** Visual quality execution batch. **Wave:** 3 / scene-gated transparency.
**Dependencies:** Coordinate attachment/history ownership with VQ-02 and PRD-455. Preserve existing alpha-cutout foliage behavior.

## Grounding and intended outcome

[packages/core/src/world-cells.ts](https://github.com/ThreeNativeHQ/threenative/blob/d72778382b134ef8763f58825cb4d4fd8cc0f6e3/packages/core/src/world-cells.ts) distinguishes blended scatter from alpha cutout because individual instances are not ordinarily sorted. This is not a lack of all transparency support. A demand-backed improvement must compare sorting, cutout/alpha hashing and an optional OIT route before adding another pass.

**Outcome:** A deterministic scene of intersecting smoke cards no longer visibly changes just because emitter insertion order changes, while glass/transmission and foliage keep their explicitly chosen existing paths.

## Design and ownership

Use upstream supported sorting/alpha techniques first. If the fixture still demonstrates a material gap, admit a bounded weighted-blended OIT route for eligible nonrefractive effects, with independent accumulation/revealage attachments and explicit composition. This is an approximation, not physically exact multi-layer refraction. Define eligibility, color space, premultiplied alpha and depth semantics. Unsupported materials stay sorted or fail with a reason; never silently route refractive glass into a smoke approximation.

Nonrefractive smoke/particle cards first. No universal hair/glass/water fix, depth peeling, arbitrary material substitution or new renderer backend.

## Required behavior

- Insertion-order permutations produce equivalent eligible-effect output within a declared floating-point tolerance.
- Opaque geometry occludes eligible effects; alpha zero is an identity and dense overlap remains finite.
- Water/transmission, cutout foliage and custom depth materials retain their original route unless explicitly admitted.
- Resize, MSAA changes, scene switch and temporal-history invalidation release/recreate the right attachments once.

## Execution phases

All proof paths below are **planned implementation targets**, not existing passing tests. Reuse an existing equivalent test or scenario after inspecting current code, and update the canonical proof path rather than adding a duplicate. Follow EXECUTE.md for fixture setup, variables, review and repository gates.

### Phase 1 — Eligibility and the smallest useful technique

- [ ] Implement explicit material-route selection using the existing renderer and test the cheaper sorted/cutout controls. proof: `pnpm exec vitest run packages/core/__tests__/vq-transparent-effects-composition.spec.ts`.
- [ ] Only where needed, add bounded accumulation/composition for eligible effects with numerical alpha and order-permutation tests. proof: `pnpm exec vitest run packages/core/__tests__/vq-transparent-effects-composition.spec.ts`.

### Phase 2 — Compose safely with the world

- [ ] Integrate opaque depth, premultiplied color and the existing output graph without altering excluded materials. proof: `pnpm exec vitest run packages/core/__tests__/vq-transparent-effects-composition.spec.ts`.
- [ ] Cover target lifetime, resize, quality fallback and temporal-history invalidation for the admitted route. proof: `pnpm exec vitest run packages/core/__tests__/vq-transparent-effects-composition.spec.ts`.

### Phase 3 — Qualify the visible result

- [ ] The overlapping-effects scene passes order permutations, occlusion and exclusion checks on browser WebGPU. proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/vq-transparent-effects-composition.playtest.json --url ${VQ_URL:?} --browser-recipe webgpu`.
- [ ] The same material-route and composition cases pass on Linux native with no unsupported attachment fallback hidden. proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/vq-transparent-effects-composition.playtest.json --target desktop --executable ${VQ_NATIVE_EXECUTABLE:?}`.

## Acceptance criteria

- [ ] The technique materially improves the demonstrated artifact and stays within its declared cost; otherwise retain the simpler existing routes and record a decline. proof: the completed Phase 3 scenario outputs, with the named fixture, package/cohort and adapter recorded inline here.
- [ ] The feature preserves its documented inactive/fallback path and releases owned resources after repeated lifecycle transitions. proof: `pnpm exec vitest run packages/core/__tests__/vq-transparent-effects-composition.spec.ts` plus the Phase 3 lifecycle scenario.

## Performance and promotion

Record attachment bytes, fill rate and total effect cost. A 50-card stress fixture is a test, not a universal scene limit. Numerical targets are proposed acceptance targets, not benchmark results. Pin the fixture, metrics and thresholds before changing the implementation; never relax a failing threshold just to mark this PRD complete. Shared abstractions must pass the repository's reuse/LOC admission rule. Appearance remains editable source.

## Blocked on

A real overlapping-effects consumer is the admission gate. Correct multi-layer refraction and strand hair remain out of scope.

## Completion record

Update the phase boxes and this PRD only after the named proof runs. Record actual results inline, including any remaining exclusions. A merged planning or implementation PR alone is not proof that every acceptance criterion passed. Archive according to the parent PRD filing rules when the work is genuinely complete.
