---
prd_contract: v1
---

# PRD-VQ-03 — Off-screen specular reflections come from a complete local probe

**Status:** PROPOSED — 2026-10-01. No implementation or qualification is claimed.
**Priority:** P2 — Proposed incremental cube capture and PMREM publication; all proofs unrun.
**Batch:** Visual quality execution batch. **Wave:** 1 / lighting.
**Dependencies:** Coordinate with PRD-381 row 5; this is its bounded child specification. Do not duplicate its capture-completeness work elsewhere.

## Grounding and intended outcome

[packages/core/src/render/probe-volume.ts](https://github.com/ThreeNativeHQ/threenative/blob/d72778382b134ef8763f58825cb4d4fd8cc0f6e3/packages/core/src/render/probe-volume.ts) owns diffuse irradiance, not local specular reflection. The existing [PRD-381](https://github.com/ThreeNativeHQ/threenative/blob/develop/docs/PRDs/feature-mining/PRD-381-nine-mineable-seams-in-eanpa-sky.md) already identifies a dynamic local reflection probe. SSR and a global environment remain useful incumbents.

**Outcome:** A polished object in a room reflects an off-camera landmark from that room. Entering a second room changes the fallback smoothly, without a half-updated cubemap, self-capture recursion or global-environment replacement for unrelated objects.

## Design and ownership

Reuse Three cube capture and PMREM. Maintain separate capture, completed and published generations; a six-face capture is published only after prefilter completion. A scene/light revision change invalidates an inconsistent generation. Bound capture work and coalesce refresh requests. Exclude the reflective receiver and viewmodel explicitly. Supply box-projection data and completed textures as mechanism; the generated material owns roughness, intensity and the SSR-to-probe-to-global composition. SSR confidence must not double-add specular energy.

One box probe first, then deterministic blending of two overlapping probes. New shared code is limited to capture scheduling, versioning and ownership and must beat the two-consumer direct baseline. Shader sampling and all look choices stay in generated `src/render/`.

## Required behavior

- A failed or cancelled capture retains the last complete result; disposal releases owned targets without disposing borrowed scene assets.
- The two-room test uses a contrasting off-screen landmark and verifies a changed reflection without changing the visible room lighting.
- Box projection handles translation and declared scale; unsupported transforms fail explicitly.
- Material assignment is receiver-specific, and no enabled probe adds a second uncontrolled game loop.

## Execution phases

All proof paths below are **planned implementation targets**, not existing passing tests. Reuse an existing equivalent test or scenario after inspecting current code, and update the canonical proof path rather than adding a duplicate. Follow EXECUTE.md for fixture setup, variables, review and repository gates.

### Phase 1 — Complete captures and bounded ownership

- [ ] Implement generation-safe incremental cube capture and PMREM publication using the existing render lifecycle. proof: `pnpm exec vitest run packages/core/__tests__/vq-local-reflection-probes.spec.ts`.
- [ ] Implement cancellation, coalesced invalidation and bounded two-probe resource ownership. proof: `pnpm exec vitest run packages/core/__tests__/vq-local-reflection-probes.spec.ts`.

### Phase 2 — Compose the local specular fallback

- [ ] Add game-owned box-projected sampling and deterministic overlap blending. proof: `pnpm exec vitest run packages/core/__tests__/vq-local-reflection-probes.spec.ts`.
- [ ] Integrate the existing SSR fallback without double-counting specular light and without capturing the viewmodel or receiver recursively. proof: `pnpm exec vitest run packages/core/__tests__/vq-local-reflection-probes.spec.ts`.

### Phase 3 — Qualify the visible result

- [ ] The two-room off-screen-landmark scenario verifies local reflection, overlap continuity and refresh behavior on WebGPU. proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/vq-local-reflection-probes.playtest.json --url ${VQ_URL:?} --browser-recipe webgpu`.
- [ ] The same package executes the two-room scenario on Linux native with complete-generation markers and matching probe selection. proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/vq-local-reflection-probes.playtest.json --target desktop --executable ${VQ_NATIVE_EXECUTABLE:?}`.

## Acceptance criteria

- [ ] The off-screen reflected landmark survives a camera turn that removes it from screen space; every visible probe generation is complete. proof: the completed Phase 3 scenario outputs, with the named fixture, package/cohort and adapter recorded inline here.
- [ ] The feature preserves its documented inactive/fallback path and releases owned resources after repeated lifecycle transitions. proof: `pnpm exec vitest run packages/core/__tests__/vq-local-reflection-probes.spec.ts` plus the Phase 3 lifecycle scenario.

## Performance and promotion

Report capture faces, prefilter cost, capture age and resident bytes. Bound active probes and skip redundant captures; no claim that dynamic probes are free. Numerical targets are proposed acceptance targets, not benchmark results. Pin the fixture, metrics and thresholds before changing the implementation; never relax a failing threshold just to mark this PRD complete. Shared abstractions must pass the repository's reuse/LOC admission rule. Appearance remains editable source.

## Blocked on

Physical-device quality/performance tiers are qualified separately; native support must not be extrapolated from a browser cube render.

## Completion record

Update the phase boxes and this PRD only after the named proof runs. Record actual results inline, including any remaining exclusions. A merged planning or implementation PR alone is not proof that every acceptance criterion passed. Archive according to the parent PRD filing rules when the work is genuinely complete.
