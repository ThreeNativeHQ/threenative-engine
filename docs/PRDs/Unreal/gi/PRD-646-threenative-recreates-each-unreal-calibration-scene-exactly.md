---
prd_contract: v1
---

# PRD-646 — ThreeNative recreates each Unreal calibration scene exactly

**Status:** NOT STARTED
**Priority:** P1 — no box is ticked: until ThreeNative loads the Unreal calibration scenes with the same geometry, materials, lights and units, a GI difference cannot be told apart from a scene difference.
**Complexity:** 6 (MEDIUM) — 1–5 files: a scene loader in the harness, the unit conversions, one visualize node, specs (+1), new module: the calibration scene loader (+2), crosses the engine boundary: the owned engine must render every light class the scenes use (+2), native proof (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-638](PRD-638-calibration-scenes-are-built-in-unreal-and-captured-as-the-gi-target.md) Phase 1 (`cornell`, its `scene.json` and `scene.glb`). [PRD-632](../look/PRD-632-the-frame-is-exposed-and-tone-mapped-the-way-a-fresh-unreal-project-is.md) (light units and EV100). The loop that uses the recreated scenes is [PRD-647](PRD-647-a-visual-judge-calibrates-gi-against-the-unreal-scenes-until-parity.md).

## Context

- The ThreeNative side of the harness scaffolds the starter template, copies the overlay in
  `scripts/unreal-look/scaffold/render/` over it, loads the PRD-631 GLB from `Reference.ts.in` and
  captures headed on WebGPU with `adapter.info` checked (`scripts/unreal-look/capture-threenative.ts`).
- That GLB came from Blender and both engines loaded it. A PRD-638 scene comes from Unreal: geometry and
  materials in `scene.glb`, and lights, environment, exposure and post in `scene.json`. Nothing in the
  harness reads `scene.json` yet.
- Owner rule (PRD-631): tune on the owned C++ engine only (Wasm on web), and name the engine of
  every capture. A feature the engine lacks is built in the engine, never pinned to `engine: "threejs"`.

### What Unreal does (UE 5.8.3, read 2026-10-20; clean-room summary, no code copied)

- **Coordinates and units.** Unreal is Z-up, left-handed, in centimetres. A point light's intensity
  is in candela or lumens (`ELightUnits`), a directional light's in lux, and its falloff ends at an
  attenuation radius with a smooth window (UE 5.8.3: `Engine/Source/Runtime/Engine/Classes/Components/PointLightComponent.h`,
  `LocalLightComponent.h`). three.js uses the same kind of window for a punctual light with `distance`
  set, so the falloff maps one to one.
- **Some light properties have no three.js field.** `SourceRadius`, `SoftSourceRadius` and
  `SourceLength` widen highlights and soften shadows (UE 5.8.3: `PointLightComponent.h`). A rect light
  has `BarnDoorAngle` and `BarnDoorLength` (UE 5.8.3: `RectLightComponent.h`). The recreation reports
  each one it cannot carry.

## Solution

1. **A calibration scene loader (Phase 1).** `CalibrationScene.ts.in` in the harness scaffold reads
   `scene.glb` and `scene.json` for a scene name. It converts Unreal Z-up centimetres to Y-up metres,
   maps each light class to its three.js class with the PRD-632 unit conversions, sets the fixed
   EV100, and builds the environment actors through the harness render source that PRD-632 to
   PRD-636 already tune (sky, fog, post). It runs on the owned engine and names it in the report.
2. **Prove the recreation before GI is judged (Phase 1 and 2).** Three checks, in order. Each one
   isolates a cause, so a later GI difference can only be GI:
   - **Geometry:** the region-ID frames of both engines agree within 1 px on every region edge.
   - **Properties:** every actor in `scene.json` maps to a ThreeNative object, or appears in
     `TN_CALIBRATION_SCENE.unsupported` with the property and the reason. An actor that is neither
     fails the load. Each unsupported property is a gap, and by the owner rule each gap becomes its
     own PRD or joins an existing one, named in `## Decisions`.
   - **Direct light:** with GI off (layer L1 for the sun, a direct-only cell for local lights), each
     region matches the Unreal cell within the PRD-631 thresholds. If direct light does not match, the
     GI comparison stops for that scene.
3. **GI alone (Phase 3).** `GIVisualize` with mode `indirectDiffuse` returns the indirect diffuse
   term only, the counterpart of `r.Lumen.Visualize.IndirectDiffuse`. The compare tool pairs it with
   the Unreal diagnosis frame. The name follows Unreal's visualize mode, and the manifest entry
   carries `@alias lumen visualize` and `@alias indirect diffuse only`. Other GI PRDs add their own
   modes to the same node when their data exists (for example `radianceCache` in PRD-604,
   `framesAccumulated` in PRD-641).
4. **Motion replay.** `scene.json` carries the Level Sequence keys of each motion run, and the loader
   replays them at the same fixed step, so both engines produce the same 180-frame series.

**Where each part lives.** The loader and the conversions are harness tools in
`scripts/unreal-look/scaffold/`. The visualize node is mechanism in `packages/core/src/render/`. Every
appearance value still comes from the scene data or the tuned render source.

## Acceptance Criteria

- [ ] AC-1 [local]: `cornell` and `sunlit-room` load on the owned engine with region-ID edges within 1 px of Unreal's, engine and adapter named in the capture report. proof: `pnpm unreal-look:capture --engine threenative --scene gi:cornell,gi:sunlit-room --layers ID` and `pnpm unreal-look:compare --scene gi --layer ID` — Evidence: pending.
- [ ] AC-2 [local]: The direct-light cells of both scenes match Unreal within the PRD-631 thresholds in every region. proof: `pnpm unreal-look:compare --scene gi:cornell,gi:sunlit-room --layer L1` — Evidence: pending.
- [ ] AC-3 [local]: The `indirectDiffuse` frames of both scenes are captured and paired with Unreal's diagnosis frames, which gives the first GI gap list of PRD-647. proof: `pnpm unreal-look:compare --scene gi --layer L7 --visualize indirectDiffuse` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Calibration scene loader | `pnpm unreal-look:capture --engine threenative --scene gi:<name>` → `CalibrationScene.ts.in` | New, beside `Reference.ts.in` | AC-1 |
| Unsupported-property report | `TN_CALIBRATION_SCENE` in the capture log | New. Feeds the gap list | Phase 1 |
| `GIVisualize` `indirectDiffuse` | `?giVisualize=indirectDiffuse` in the harness; any game through `GIVisualize` | New | AC-3 |

## Execution Phases

#### Phase 1: `cornell` loads, and the properties map
**Status:** NOT STARTED
**Files:** `scripts/unreal-look/scaffold/CalibrationScene.ts.in` (new), `scripts/unreal-look/capture-threenative.ts`, `scripts/__tests__/unreal-look-calibration-scene.spec.ts` (new)
- [ ] Unreal Z-up centimetres, lumens, candela, lux and attenuation radius convert to ThreeNative values, and an actor that neither maps nor appears as unsupported fails the load. proof: `pnpm exec vitest run scripts/__tests__/unreal-look-calibration-scene.spec.ts`.
- [ ] `cornell` region-ID edges agree within 1 px, and its unsupported properties are listed under `## Decisions` with the PRD that owns each one. proof: the AC-1 commands for `gi:cornell`.

#### Phase 2: Direct light matches
**Status:** NOT STARTED
**Files:** `scripts/unreal-look/scaffold/CalibrationScene.ts.in`, `scripts/unreal-look/capture-threenative.ts`
- [ ] `cornell` direct-light cells match within the thresholds. proof: `pnpm unreal-look:compare --scene gi:cornell --layer L1`.
- [ ] `sunlit-room` loads and its direct-light cells match within the thresholds. proof: `pnpm unreal-look:compare --scene gi:sunlit-room --layer L1`.

#### Phase 3: GI alone, and the motion replay
**Status:** NOT STARTED
**Files:** `packages/core/src/render/gi-visualize.ts` (new, exports `GIVisualize`), `packages/core/src/index.ts`, `packages/engine-mcp/__tests__/search.spec.ts`, `scripts/unreal-look/scaffold/render/worldEnvironment.ts`, `packages/runtime-native/conformance/scenes/shared/gi-visualize-indirect.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] A capability search for "lumen visualize indirect diffuse" returns `GIVisualize`. proof: `pnpm exec vitest run packages/engine-mcp/__tests__/search.spec.ts`.
- [ ] The `pan` run replays on the owned engine and its series has the same frame count as Unreal's. proof: `pnpm unreal-look:compare --scene gi:cornell --metric motion`.
- [ ] The `indirectDiffuse` mode renders on the native desktop host within tolerance of the browser. proof: `pnpm parity --target desktop --only-tests gi-visualize-indirect`.
**Verification:** AC-3.
