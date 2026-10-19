---
prd_contract: v1
---

# PRD-VQ-13 — Depth of field and motion blur are qualified optional stages, not a second camera pipeline

**Status:** PROPOSED — 2026-10-01. No implementation or qualification is claimed.
**Priority:** P2 — Proposed DOF and motion-blur stages with pre-install validation and no duplicate pass.
**Batch:** Visual quality execution batch. **Wave:** 3 / optional cinematics.
**Dependencies:** PRD-269 motion correctness and PRD-455 history/reset rules; VQ-02 output lifetime qualification.

## Grounding and intended outcome

Current upstream supplies [DepthOfFieldNode](https://threejs.org/docs/pages/DepthOfFieldNode.html); the repository already lists motion-blur/temporal stage names and velocity infrastructure. The missing work is coherent generated-source integration and qualification, not implementing blur mathematics from scratch.

**Outcome:** A cinematic route changes focus between a near and far target and applies motion blur to actual moving world geometry without smearing a camera cut, the HUD or an explicitly excluded first-person viewmodel.

## Design and ownership

Reuse installed upstream nodes after verifying the pinned versions. Keep focus, bokeh scale, shutter controls and enablement in generated render source. Reuse scene depth and velocity; specify stage ordering relative to reconstruction, bloom and the single output transform. Focus distance uses the node API's documented world units, not an invented millimeter lens equation. Camera cuts and projection/size changes reset any history. Disabled stages allocate and dispatch nothing.

One optional DOF stage and one velocity-driven motion-blur stage in an existing generated-source consumer. No sequencer editor, autofocus AI, camera-physics package or forced gameplay blur.

## Required behavior

- A depth-target fixture keeps the focus plane sharp while the out-of-focus region changes, rather than blurring the entire image.
- Stationary geometry under a stationary camera has no motion blur; a moving rig and instance use their real motion history.
- The HUD remains outside the world post graph, and viewmodel inclusion is an explicit game decision.
- Off/on, cut, resize and tier switching preserve a valid frame and bounded targets.

## Execution phases

All proof paths below are **planned implementation targets**, not existing passing tests. Reuse an existing equivalent test or scenario after inspecting current code, and update the canonical proof path rather than adding a duplicate. Follow EXECUTE.md for fixture setup, variables, review and repository gates.

### Phase 1 — Reuse the existing stage seams

- [ ] Add generated-source factories for installed DOF and motion-blur nodes with documented controls and no duplicate scene pass. proof: `pnpm exec vitest run packages/create-threenative/__tests__/vq-cinematic-stage-integration.spec.ts`.
- [ ] Validate depth, velocity, stage order and unsupported-camera/material conditions before installation. proof: `pnpm exec vitest run packages/create-threenative/__tests__/vq-cinematic-stage-integration.spec.ts`.

### Phase 2 — Make transitions and exclusions correct

- [ ] Implement history resets and explicit HUD/viewmodel composition boundaries. proof: `pnpm exec vitest run packages/create-threenative/__tests__/vq-cinematic-stage-integration.spec.ts`.
- [ ] Add focus-plane, stationary-motion and stage-off identity assertions plus repeated-toggle disposal checks. proof: `pnpm exec vitest run packages/create-threenative/__tests__/vq-cinematic-stage-integration.spec.ts`.

### Phase 3 — Qualify the visible result

- [ ] The focus/motion/camera-cut route passes on browser WebGPU with effect-region image checks. proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/vq-cinematic-stage-integration.playtest.json --url ${VQ_URL:?} --browser-recipe webgpu`.
- [ ] The same optional stages and camera route pass on Linux native, including disabled-path parity. proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/vq-cinematic-stage-integration.playtest.json --target desktop --executable ${VQ_NATIVE_EXECUTABLE:?}`.

## Acceptance criteria

- [ ] Both effects respond to the intended depth/motion inputs and disappear cleanly when disabled; no new rendering pipeline is introduced. proof: the completed Phase 3 scenario outputs, with the named fixture, package/cohort and adapter recorded inline here.
- [ ] The feature preserves its documented inactive/fallback path and releases owned resources after repeated lifecycle transitions. proof: `pnpm exec vitest run packages/create-threenative/__tests__/vq-cinematic-stage-integration.spec.ts` plus the Phase 3 lifecycle scenario.

## Performance and promotion

Measure each stage independently. Keep optional/cinematic by default; no quality improvement is inferred from blur alone. Numerical targets are proposed acceptance targets, not benchmark results. Pin the fixture, metrics and thresholds before changing the implementation; never relax a failing threshold just to mark this PRD complete. Shared abstractions must pass the repository's reuse/LOC admission rule. Appearance remains editable source.

## Blocked on

Additional camera models and physical mobile performance are separate qualifiers, not assumed support.

## Completion record

Update the phase boxes and this PRD only after the named proof runs. Record actual results inline, including any remaining exclusions. A merged planning or implementation PR alone is not proof that every acceptance criterion passed. Archive according to the parent PRD filing rules when the work is genuinely complete.
