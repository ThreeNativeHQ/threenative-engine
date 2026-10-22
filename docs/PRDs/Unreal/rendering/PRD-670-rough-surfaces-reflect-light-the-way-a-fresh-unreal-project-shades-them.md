---
prd_contract: v1
---

# PRD-670 — Rough surfaces reflect light the way a fresh Unreal project shades them

**Status:** NOT STARTED
**Priority:** P2 — Phase 1 is an unbuilt gate: a fresh Unreal 5.8.3 project turns Substrate on, and no measurement says whether its rough diffuse and forced energy conservation move the L1 sphere rows past the PRD-631 thresholds.
**Complexity:** 5 (MEDIUM) — 1–5 implementation files (+1), a second Unreal capture project with one setting changed (+1), a lighting-model hook that the owned host must compile too (+2), a visual judge (+1); risk override: none
**Owner:** João
**Depends on:** `docs/PRDs/Unreal/look/PRD-631-an-unreal-reference-scene-measures-the-default-look.md` (on `origin/feat/unreal-look-epic`, all boxes ticked: the capture harness and the L1 thresholds). `docs/PRDs/Unreal/look/PRD-632-the-frame-is-exposed-and-tone-mapped-the-way-a-fresh-unreal-project-is.md` must close the L1 tone gap before Phase 2 judges a shading change, because a tone gap hides a BSDF gap.

## Context

**Unreal size.** Substrate is 29,136 lines in the feature map (12,154 C++, 16,982 shader). The
part a fresh project uses is much smaller: one slab per pixel, rough diffuse and the energy tables.
A ThreeNative port of that part is about 250 TypeScript lines plus about 150 C++ lines. The
layered features (haze, fuzz, thin film, glints, vertical layering) map onto fields that
`MeshPhysicalNodeMaterial` already has, and they are out of this PRD.

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

- **A fresh project turns Substrate on.** The engine default of `r.Substrate` is 0
  (`UE 5.8.3: Engine/Source/Runtime/RenderCore/Private/RenderUtils.cpp:2068-2072`). The project
  generator writes `r.Substrate=True` and `r.Substrate.ProjectGBufferFormat=0` into every new
  project's `DefaultEngine.ini` (`Engine/Source/Editor/GameProjectGeneration/Private/GameProjectUtils.cpp:198-212`,
  called at `:1895` and `:2214`). The source notes this at `RenderUtils.cpp:2080-2083`. The PRD-631
  reference project carries the same two keys
  (`tools/unreal-reference/Config/DefaultEngine.ini` on `origin/feat/unreal-look-epic`).
- **Format 0 is the blendable GBuffer, one closure per pixel.** The help text says it forces one
  closure per pixel and loses fidelity (`RenderUtils.cpp:2084-2091`). So a fresh project shades one
  slab per pixel, which is the same budget as a three.js material.
- **A default-lit material becomes one slab.** Base colour and metallic become a diffuse albedo and
  an F0, and F90 is 1 (`Engine/Shaders/Private/Substrate/SubstrateLegacyConversion.ush:100-114`,
  `:269-276`).
- **Rough diffuse is on for desktop.** The engine default of `r.Substrate.RoughDiffuse` is 0
  (`RenderUtils.cpp:2153-2157`). The Linux, Windows and Mac platform files set it to 1, with shading
  quality 1 (`Engine/Config/Linux/BaseLinuxEngine.ini:21-27`, `Engine/Config/Windows/BaseWindowsEngine.ini:36-41`).
  With Substrate on, the shader compiler uses that switch for the rough-diffuse define
  (`Engine/Source/Runtime/Engine/Private/ShaderCompiler/ShaderCompiler.cpp:4168-4171`). The slab then
  evaluates a GGX rough-diffuse model instead of Lambert
  (`Engine/Shaders/Private/Substrate/SubstrateEvaluation.ush:551-560`, `Engine/Shaders/Private/BRDF.ush:236-238`).
  The model is published: Chan, "Material Advances in Call of Duty: WWII", SIGGRAPH 2018.
- **Energy conservation is forced on with Substrate.** The help text of
  `r.Material.EnergyConservation` says so, and the energy tables are built whenever Substrate is on
  (`Engine/Source/Runtime/Renderer/Private/ShadingEnergyConservation.cpp:72-74`, `:97-100`).

### ThreeNative today

- three.js r185 `PhysicalLightingModel` already adds multiple-scattering energy compensation to the
  GGX specular, for direct light and for image-based light
  (`node_modules/three/src/nodes/functions/PhysicalLightingModel.js:567-587`, `:626`). Its diffuse is
  Lambert.
- The owned engine mirrors the same functions in C++, including `BRDF_GGX_Multiscatter`
  (`packages/runtime-native/src/engine/shader/standard.cpp:86-87`, `:233-238`). It has no hook for a
  game-supplied diffuse term.
- The feature map says three.js r185 already matches Unreal default lit. That is true for the
  specular energy. It is unmeasured for the diffuse term, because Unreal's default is no longer
  Lambert on desktop.

## Solution

| Unreal part | ThreeNative module | Layer |
| --- | --- | --- |
| Substrate on, one closure (`GameProjectUtils.cpp:198-212`) | no work: one material per pixel is already the three.js budget | none |
| Energy conservation (`ShadingEnergyConservation.cpp`) | no work: three r185 multiscatter already covers the specular | none |
| Rough diffuse (`BRDF.ush:236-238`, from the published Chan 2018 model) | a TSL diffuse function in `templates/*/src/render/roughDiffuse.ts`, written from the paper | template look |
| The hook that lets a material swap its diffuse term | a named diffuse-term hook on the lighting model, on the web and in the owned engine's shader IR | core and native mechanism |

- **Phase 1 decides.** The harness renders L1 twice in Unreal, with Substrate on and off. If the
  five spheres agree within the PRD-631 thresholds, Lambert is close enough and Phases 2 and 3 are
  deleted under `## Decisions`.
- **Never own the look.** The rough-diffuse function is generated template source. The package
  adds only the hook. A game can delete the file and keep Lambert.

## Acceptance Criteria

- [ ] AC-1 [local]: The L1 rows of the rough dielectric and rough metal spheres pass the PRD-631 thresholds against the Substrate reference in all 12 poses. proof: `pnpm unreal-look:compare --layer L1` — Evidence: pending.
- [ ] AC-2 [local]: A fresh visual judge returns IMPROVEMENT for the L1 sphere frames, before and after, against the Unreal frame. proof: headed `--browser-recipe webgpu` captures, two runs each, fresh visual-judge subagent — Evidence: pending.
- [ ] AC-3 [local]: The desktop native host renders the same L1 sphere rows within the conformance tolerance of the browser. proof: `pnpm parity --target desktop --only-tests rough-diffuse` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Diffuse-term hook | starter `src/render/materials.ts` → `roughDiffuse.ts` → the hook on each lit material | Replaces Lambert only in templates that keep the file | Phase 2, AC-1 |

## Decisions

- 2026-10-21 (filing): The rest of Substrate (haze, fuzz, thin film, glints, vertical layering, adaptive GBuffer) is deferred, not declined, under the owner rule of 2026-10-21. A fresh project uses the blendable GBuffer, which keeps one closure per pixel. `MeshPhysicalNodeMaterial` already carries clearcoat, sheen, iridescence and anisotropy. The revisit condition is a game that needs two closures on one pixel that `MeshPhysicalNodeMaterial` cannot express.

## Execution Phases

#### Phase 1: Does Substrate move the spheres?
**Status:** NOT STARTED
**Files:** `tools/unreal-reference/layers.json`, `tools/unreal-reference/Config/DefaultEngine.ini` (a copy with `r.Substrate=False`)
- [ ] The harness captures L1 with Substrate off in a second project copy, and the run records which `DefaultEngine.ini` each capture used. proof: `pnpm unreal-look:capture --engine unreal --layers L1 --out tools/unreal-reference/captures/substrate-off` exit 0, and the same for the Substrate-on project.
- [ ] The Substrate-on against Substrate-off delta for each of the five spheres is written under `## Decisions`, with the gate verdict: continue only if a rough sphere exceeds the L1 threshold. proof: `pnpm unreal-look:compare --unreal-vs-unreal tools/unreal-reference/captures/substrate-off --layer L1`.

#### Phase 2: Rough diffuse as template source
**Status:** NOT STARTED
**Files:** `packages/core/src/render/diffuse-term.ts` (new), `packages/core/__tests__/diffuse-term.spec.ts`, `packages/create-threenative/templates/starter/src/render/roughDiffuse.ts` (new), `packages/create-threenative/templates/starter/src/render/materials.ts`
- [ ] The rough-diffuse function returns Lambert at roughness 0 within 1%, and its white-furnace albedo stays at or below 1 for every roughness and view angle. proof: `pnpm exec vitest run packages/core/__tests__/diffuse-term.spec.ts`.
- [ ] The starter renders L1 with the template's rough diffuse on browser WebGPU. proof: AC-1 compare and AC-2 visual judge.

#### Phase 3: The owned host
**Status:** NOT STARTED
**Files:** `packages/runtime-native/src/engine/shader/standard.cpp`, `packages/runtime-native/conformance/scenes/shared/rough-diffuse.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] The owned engine compiles the template's diffuse term through the same hook and matches the browser spheres. proof: `pnpm parity --target desktop --only-tests rough-diffuse`.
