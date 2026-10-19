---
prd_contract: v1
---

# PRD-VQ-05 — Upper-body actions and additive reactions compose over locomotion

**Status:** PROPOSED — 2026-10-01. No implementation or qualification is claimed.
**Priority:** P2 — Proposed mask resolution and additive preparation, proved only by new unrun specs.
**Batch:** Visual quality execution batch. **Wave:** 1 / character motion.
**Dependencies:** Coordinate with VQ-04 through one action owner. Existing constrained IK must remain after authored animation evaluation.

## Grounding and intended outcome

[packages/core/src/animation.ts](https://github.com/ThreeNativeHQ/threenative/blob/d72778382b134ef8763f58825cb4d4fd8cc0f6e3/packages/core/src/animation.ts) exposes the Three mixer and existing clip transitions. Additive animation is an upstream Three capability, not missing mathematics. What needs qualification is masked layer composition, reference-pose handling, lifecycle and ordering for actual ThreeNative characters.

**Outcome:** A character continues walking while aiming or reloading; recoil and breathing add to the pose without replacing the lower-body gait. Removing a layer restores the underlying animation with no accumulated drift.

## Design and ownership

Keep state selection and masks in game-owned TypeScript. Resolve masks against cloned rigs, filter or weight tracks through a single mixer owner, and reuse upstream additive-clip preparation against an explicit reference pose. Never modify shared source clips. Distinguish override layers from additive deltas and define quaternion normalization. Order: locomotion/base, override/additive layers, IK, render; root movement retains its existing owner. A generalized animation graph is explicitly out of scope.

One base layer, one masked override and two bounded additive layers; masks are explicit bone names with optional descendant expansion. Face-control and root-motion ownership conflicts must be refused or explicitly excluded, not silently mixed.

## Required behavior

- With layer weight zero, sampled bone transforms equal the base-only result within numeric tolerance.
- Two cloned characters sharing source clips can use different masks and weights without cross-talk.
- Missing bones, incompatible tracks and missing additive reference poses are actionable errors.
- Loop/once completion, interrupted reloads, repeated weight ramps and removal/disposal leave no residual pose or live action.

## Execution phases

All proof paths below are **planned implementation targets**, not existing passing tests. Reuse an existing equivalent test or scenario after inspecting current code, and update the canonical proof path rather than adding a duplicate. Follow EXECUTE.md for fixture setup, variables, review and repository gates.

### Phase 1 — Correct layer data and ownership

- [ ] Implement mask resolution and immutable additive preparation using ordinary Three clips/actions. proof: `pnpm exec vitest run packages/core/__tests__/vq-masked-additive-animation.spec.ts`.
- [ ] Add deterministic composition and reference-pose tests, including independent cloned characters. proof: `pnpm exec vitest run packages/core/__tests__/vq-masked-additive-animation.spec.ts`.

### Phase 2 — Integrate locomotion and IK ordering

- [ ] Compose reload/aim and recoil over the VQ-04 or existing locomotion consumer with one updater. proof: `pnpm exec vitest run packages/core/__tests__/vq-masked-additive-animation.spec.ts`.
- [ ] Verify root ownership, IK-after-animation ordering, cancellation and layer removal through pose observations. proof: `pnpm exec vitest run packages/core/__tests__/vq-masked-additive-animation.spec.ts`.

### Phase 3 — Qualify the visible result

- [ ] A walking/reloading/recoiling character passes lower-body preservation and layer-removal assertions on WebGPU. proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/vq-masked-additive-animation.playtest.json --url ${VQ_URL:?} --browser-recipe webgpu`.
- [ ] The identical layered trace passes on Linux native with sampled bone transforms and retained source-clip hashes. proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/vq-masked-additive-animation.playtest.json --target desktop --executable ${VQ_NATIVE_EXECUTABLE:?}`.

## Acceptance criteria

- [ ] Layer weight zero is a base-only identity, and removing all added layers restores base animation without pose drift or shared-rig mutation. proof: the completed Phase 3 scenario outputs, with the named fixture, package/cohort and adapter recorded inline here.
- [ ] The feature preserves its documented inactive/fallback path and releases owned resources after repeated lifecycle transitions. proof: `pnpm exec vitest run packages/core/__tests__/vq-masked-additive-animation.spec.ts` plus the Phase 3 lifecycle scenario.

## Performance and promotion

Bound layer and action counts. Measure CPU per rig; no mandatory overhead for characters using only the existing player. Numerical targets are proposed acceptance targets, not benchmark results. Pin the fixture, metrics and thresholds before changing the implementation; never relax a failing threshold just to mark this PRD complete. Shared abstractions must pass the repository's reuse/LOC admission rule. Appearance remains editable source.

## Blocked on

Physical-device crowd scaling and additional character rigs need separate qualification; these do not block the two-runtime correctness slice.

## Completion record

Update the phase boxes and this PRD only after the named proof runs. Record actual results inline, including any remaining exclusions. A merged planning or implementation PR alone is not proof that every acceptance criterion passed. Archive according to the parent PRD filing rules when the work is genuinely complete.
