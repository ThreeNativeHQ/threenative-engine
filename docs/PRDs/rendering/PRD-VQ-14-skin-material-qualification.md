---
prd_contract: v1
---

# PRD-VQ-14 — Skin shading reuses upstream material support and preserves facial animation

**Status:** PROPOSED — 2026-10-01. No implementation or qualification is claimed.
**Priority:** P2 — Proposed generated-source skin route with thickness controls and a low-cost fallback.
**Batch:** Visual quality execution batch. **Wave:** 3 / character-quality gate.
**Dependencies:** Use a license-clear rigged head. Preserve existing MetaHuman/GLTF binding and expression ownership.

## Grounding and intended outcome

Current upstream documents experimental [MeshSSSNodeMaterial](https://threejs.org/docs/pages/MeshSSSNodeMaterial.html). The prior audit's wording should not be read as absence of every subsurface-scattering primitive. Verify the installed pin; the product task is a controllable, portable skin look with real assets and explicit limits.

**Outcome:** A rigged head retains expressions, normals and authored texture detail while thin regions respond plausibly to backlighting; the result is compared with its ordinary PBR baseline rather than declared AAA from an effect name.

## Design and ownership

Use the installed physical/SSS material or a supported upgrade, with appearance in generated source. Keep thickness, albedo, roughness, normal detail and artistic scattering controls asset/game-owned. Distinguish an approximate transmission term from a full diffusion model. Preserve skinning and morph-target paths and avoid counting the same lighting twice when probes or SSGI are active. No new mandatory core material class or MetaHuman-only render dependency.

One textured, expression-capable head plus a synthetic thin-surface test. No offline path-traced skin, texture generation, pore synthesis, face-rig rewrite or claim that an approximate SSS node matches a production diffusion renderer.

## Required behavior

- The baseline and candidate share geometry, pose, exposure and lights; only the intended material route changes.
- Thickness-zero and disabled-scattering controls reduce to the declared baseline behavior.
- Expression/morph changes preserve texture bindings, tangent/normal continuity and independent character instances.
- A low tier has an explicit PBR fallback and does not fetch unused scattering assets.

## Execution phases

All proof paths below are **planned implementation targets**, not existing passing tests. Reuse an existing equivalent test or scenario after inspecting current code, and update the canonical proof path rather than adding a duplicate. Follow EXECUTE.md for fixture setup, variables, review and repository gates.

### Phase 1 — Admit the pinned material path

- [ ] Implement the smallest generated-source skin route using compatible upstream support and declared thickness/texture inputs. proof: `pnpm exec vitest run packages/create-threenative/__tests__/vq-skin-material-qualification.spec.ts`.
- [ ] Cover disabled/thickness controls, finite output and immutable borrowed asset data. proof: `pnpm exec vitest run packages/create-threenative/__tests__/vq-skin-material-qualification.spec.ts`.

### Phase 2 — Preserve the animated character

- [ ] Exercise expressions, skinning and morph targets with the candidate material and existing lighting composition. proof: `pnpm exec vitest run packages/create-threenative/__tests__/vq-skin-material-qualification.spec.ts`.
- [ ] Add an explicit low-cost fallback and scene/material lifetime checks across two independent head instances. proof: `pnpm exec vitest run packages/create-threenative/__tests__/vq-skin-material-qualification.spec.ts`.

### Phase 3 — Qualify the visible result

- [ ] The neutral/backlit expression sweep runs on WebGPU with matched baseline/candidate captures and numeric control cases. proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/vq-skin-material-qualification.playtest.json --url ${VQ_URL:?} --browser-recipe webgpu`.
- [ ] The same head, expressions and generated material run on Linux native without feature loss or unexpected target errors. proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/vq-skin-material-qualification.playtest.json --target desktop --executable ${VQ_NATIVE_EXECUTABLE:?}`.

## Acceptance criteria

- [ ] The authored scattering controls are effective, facial animation remains correct, and the human reviewer can compare matched images without an automatic aesthetic score being invented. proof: the completed Phase 3 scenario outputs, with the named fixture, package/cohort and adapter recorded inline here.
- [ ] The feature preserves its documented inactive/fallback path and releases owned resources after repeated lifecycle transitions. proof: `pnpm exec vitest run packages/create-threenative/__tests__/vq-skin-material-qualification.spec.ts` plus the Phase 3 lifecycle scenario.

## Performance and promotion

Report added shader/texture cost and frame contribution. Keep experimental/opt-in until the visual and platform evidence supports broader use. Numerical targets are proposed acceptance targets, not benchmark results. Pin the fixture, metrics and thresholds before changing the implementation; never relax a failing threshold just to mark this PRD complete. Shared abstractions must pass the repository's reuse/LOC admission rule. Appearance remains editable source.

## Blocked on

The owner supplies or approves redistribution rights for any third-party head. Human aesthetic approval is a named external checkpoint, not a falsely ticked test.

## Completion record

Update the phase boxes and this PRD only after the named proof runs. Record actual results inline, including any remaining exclusions. A merged planning or implementation PR alone is not proof that every acceptance criterion passed. Archive according to the parent PRD filing rules when the work is genuinely complete.
