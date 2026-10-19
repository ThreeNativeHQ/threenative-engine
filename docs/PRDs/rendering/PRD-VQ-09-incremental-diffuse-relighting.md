---
prd_contract: v1
---

# PRD-VQ-09 — Diffuse probes refresh bounded changed regions without a visible half-bake

**Status:** PROPOSED — 2026-10-01. No implementation or qualification is claimed.
**Priority:** P2 — Proposed revision-aware dirty-region rebaking against a full-rebake reference.
**Batch:** Visual quality execution batch. **Wave:** 3 / gated GI extension.
**Dependencies:** First reconcile and qualify existing PRD-268. The incumbent ProbeVolume remains the single diffuse-probe owner.

## Grounding and intended outcome

[packages/core/src/render/probe-volume.ts](https://github.com/ThreeNativeHQ/threenative/blob/d72778382b134ef8763f58825cb4d4fd8cc0f6e3/packages/core/src/render/probe-volume.ts) already performs static diffuse capture and exposes rebaking. Existing [PRD-268](https://github.com/ThreeNativeHQ/threenative/blob/develop/docs/PRDs/lighting/PRD-268-light-that-comes-from-off-screen.md) owns that path. This proposal is only for measured gaps in incremental relighting; manual rebaking must be evaluated before new code is admitted.

**Outcome:** Changing an off-screen lamp or opening a door updates the affected diffuse lighting within a declared latency budget while unaffected regions retain a complete valid result. This is bounded probe relighting, not Lumen parity.

## Design and ownership

Use the existing ProbeVolume capture/sample infrastructure and explicit scene/light revision invalidation. Coalesce dirty regions and schedule work through the existing lifecycle. Publish completed coefficient generations atomically; no reader sees a half-updated atlas. Define previous-versus-current bounce inputs to avoid energy accumulation. Keep artistic response and application in generated materials. If the existing rebake path already satisfies the tests and budget, close this proposal as covered rather than adding a scheduler.

A small indoor volume, one changed lamp and one door/occluder case. No hardware RT dependency, whole-world fully dynamic GI, infinite bounces, or replacement of SSGI.

## Required behavior

- The off-screen source test changes diffuse response even when the lamp remains outside the camera.
- A completed refresh converges toward a full rebake reference within the declared fixture tolerance.
- Unchanged regions do not continually rebake, requests coalesce and cancelled generations never publish.
- Total energy remains bounded over repeated lamp toggles and repeated bake cycles.

## Execution phases

All proof paths below are **planned implementation targets**, not existing passing tests. Reuse an existing equivalent test or scenario after inspecting current code, and update the canonical proof path rather than adding a duplicate. Follow EXECUTE.md for fixture setup, variables, review and repository gates.

### Phase 1 — Bounded dirty-region updates

- [ ] Extend only the demonstrated gaps in existing rebaking with revision-aware dirty regions and bounded scheduling. proof: `pnpm exec vitest run packages/core/__tests__/vq-incremental-diffuse-relighting.spec.ts`.
- [ ] Implement atomic atlas/coefficients publication and cancellation without a second diffuse-probe cache. proof: `pnpm exec vitest run packages/core/__tests__/vq-incremental-diffuse-relighting.spec.ts`.

### Phase 2 — Convergence and stable composition

- [ ] Verify changed-lamp and door response against the full-rebake reference, including repeated bounce cycles. proof: `pnpm exec vitest run packages/core/__tests__/vq-incremental-diffuse-relighting.spec.ts`.
- [ ] Integrate the refreshed diffuse term with the existing material and SSGI composition without duplicate contribution. proof: `pnpm exec vitest run packages/core/__tests__/vq-incremental-diffuse-relighting.spec.ts`.

### Phase 3 — Qualify the visible result

- [ ] The lamp/door scenario records refresh latency, unchanged-region work and radiance convergence on WebGPU. proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/vq-incremental-diffuse-relighting.playtest.json --url ${VQ_URL:?} --browser-recipe webgpu`.
- [ ] The same scenario passes on Linux native with its own measured refresh budget and complete-generation observations. proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/vq-incremental-diffuse-relighting.playtest.json --target desktop --executable ${VQ_NATIVE_EXECUTABLE:?}`.

## Acceptance criteria

- [ ] The admitted incremental route performs less work than a full rebake for localized changes while meeting a predeclared image and latency bound; otherwise retain the incumbent. proof: the completed Phase 3 scenario outputs, with the named fixture, package/cohort and adapter recorded inline here.
- [ ] The feature preserves its documented inactive/fallback path and releases owned resources after repeated lifecycle transitions. proof: `pnpm exec vitest run packages/core/__tests__/vq-incremental-diffuse-relighting.spec.ts` plus the Phase 3 lifecycle scenario.

## Performance and promotion

Pin probe count, density, bounce count and changed region before comparison. A 500 ms response goal is an initial fixture target, not a claimed current engine capability. Numerical targets are proposed acceptance targets, not benchmark results. Pin the fixture, metrics and thresholds before changing the implementation; never relax a failing threshold just to mark this PRD complete. Shared abstractions must pass the repository's reuse/LOC admission rule. Appearance remains editable source.

## Blocked on

PRD-268 qualification and a representative dynamic-lighting consumer precede default admission; hardware-specific quality tiers remain separate.

## Completion record

Update the phase boxes and this PRD only after the named proof runs. Record actual results inline, including any remaining exclusions. A merged planning or implementation PR alone is not proof that every acceptance criterion passed. Archive according to the parent PRD filing rules when the work is genuinely complete.
