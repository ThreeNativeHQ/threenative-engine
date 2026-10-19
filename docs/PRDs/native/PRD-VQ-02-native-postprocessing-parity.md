---
prd_contract: v1
---

# PRD-VQ-02 — A requested post-processing stage never turns the native world into a blank frame

**Status:** PROPOSED — 2026-10-01. No implementation or qualification is claimed.
**Priority:** P1 — Bloom at threshold 0.92 blanked the native world; open boxes add the assertion and repair it.
**Batch:** Visual quality execution batch. **Wave:** 0 / correctness.
**Dependencies:** None. Can start alongside VQ-01.

## Grounding and intended outcome

The merged [PR #382](https://github.com/ThreeNativeHQ/threenative/pull/382) reports that bloom at threshold 0.92 blanked the native snow world while web worked; the kit shipped bloom disabled. This is a reported regression, not a reproduced root cause. [packages/core/src/render/chain.ts](https://github.com/ThreeNativeHQ/threenative/blob/d72778382b134ef8763f58825cb4d4fd8cc0f6e3/packages/core/src/render/chain.ts) reports graph installation, which alone cannot prove visible output.

**Outcome:** A minimal emissive fixture and the snow kit render correctly with bloom enabled on browser and native, or the stage is explicitly rejected before a blank frame is presented. The repair belongs to the identified failing layer, not to a hidden game-only workaround.

## Design and ownership

First reduce the reported snow case using its exact exposure, threshold, attachments and renderer cohort. Trace graph output, tone mapping, MRT allocation and native texture lifetime without assuming which is faulty. Keep one tone-map/output transform. A stage being constructed is not a visual success criterion. Preserve the no-post path, lazy attachment allocation and existing stage-disposal contract.

Inspect the snow generated render source, shared `worldEnvironment.ts`, `RenderChain`, renderer output installation and native WebGPU replay only as the reproduction directs. No unrelated post-stack rewrite and no arbitrary brightness changes disguised as a bug fix.

## Required behavior

- Run bloom off/on, thresholds below/at/above 0.92, resize, scene switch and quality-tier transitions on the same fixture.
- Assert finite pixels, a nonblank world region and a measurable halo around the emissive test patch; inspect the world separately from the HUD.
- An unsupported stage reports its reason and preserves a valid world output; it must not be reported as visually qualified.
- Keep enabled and disabled resource lifetimes bounded across at least 20 toggles.

## Execution phases

All proof paths below are **planned implementation targets**, not existing passing tests. Reuse an existing equivalent test or scenario after inspecting current code, and update the canonical proof path rather than adding a duplicate. Follow EXECUTE.md for fixture setup, variables, review and repository gates.

### Phase 1 — Reproduce and repair the failing layer

- [ ] Add the regression fixture and an assertion that detects the reported blank world independently of the HUD. proof: `pnpm exec vitest run packages/core/__tests__/vq-native-postprocessing-parity.spec.ts`.
- [ ] Fix the demonstrated source of failure while preserving exposure, tone mapping and the authored snow appearance. proof: `pnpm exec vitest run packages/core/__tests__/vq-native-postprocessing-parity.spec.ts`.

### Phase 2 — Keep graph replacement safe

- [ ] Cover resize, stage replacement and tier transitions without stale targets or duplicate output transforms. proof: `pnpm exec vitest run packages/core/__tests__/vq-native-postprocessing-parity.spec.ts`.
- [ ] Add effect-region assertions and allocation-lifetime checks, then restore bloom only on qualified paths. proof: `pnpm exec vitest run packages/core/__tests__/vq-native-postprocessing-parity.spec.ts`.

### Phase 3 — Qualify the visible result

- [ ] The emissive fixture and snow scene pass the off/on and threshold matrix on browser WebGPU. proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/vq-native-postprocessing-parity.playtest.json --url ${VQ_URL:?} --browser-recipe webgpu`.
- [ ] The same fixture and authored snow settings pass on a packaged Linux native host, with real world captures and zero GPU validation errors. proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/vq-native-postprocessing-parity.playtest.json --target desktop --executable ${VQ_NATIVE_EXECUTABLE:?}`.

## Acceptance criteria

- [ ] The original reported case is either reproduced and fixed or explicitly reclassified with the exact non-reproducing cohort; no unrelated change is presented as its fix. proof: the completed Phase 3 scenario outputs, with the named fixture, package/cohort and adapter recorded inline here.
- [ ] The feature preserves its documented inactive/fallback path and releases owned resources after repeated lifecycle transitions. proof: `pnpm exec vitest run packages/core/__tests__/vq-native-postprocessing-parity.spec.ts` plus the Phase 3 lifecycle scenario.

## Performance and promotion

Record bloom cost separately from world rendering. No unbounded render-target growth across 20 toggles and resizes. Numerical targets are proposed acceptance targets, not benchmark results. Pin the fixture, metrics and thresholds before changing the implementation; never relax a failing threshold just to mark this PRD complete. Shared abstractions must pass the repository's reuse/LOC admission rule. Appearance remains editable source.

## Blocked on

Other native operating systems and physical Android require their own runs before extending the qualification claim.

## Completion record

Update the phase boxes and this PRD only after the named proof runs. Record actual results inline, including any remaining exclusions. A merged planning or implementation PR alone is not proof that every acceptance criterion passed. Archive according to the parent PRD filing rules when the work is genuinely complete.
