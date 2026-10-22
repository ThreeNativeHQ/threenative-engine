---
prd_contract: v1
---

# PRD-663 — A fog bank sits where the game puts it, and the sun lights it

**Status:** NOT STARTED
**Priority:** P3 — AC-1 to AC-3 are open: no template or package can put a bounded patch of fog in a scene at analytic cost. A fresh Unreal project places no local fog volume, so the default look does not change.
**Complexity:** 4 (MEDIUM) — 1–5 implementation files (1), a new scene node with per-frame sorted state (+2), template adoption (+1); risk override: none
**Owner:** João
**Depends on:** None. Composes with the `scene.fogNode` that [PRD-560](../../done/PRD-560-height-fog-follows-the-ground.md) shipped. It is a cheap, analytic alternative to the ray-marched starter mist of [PRD-VQ-07](../../done/PRD-VQ-07-volumetric-fog.md), and it does not replace that mist. [PRD-562](PRD-562-aerial-perspective-from-a-froxel-volume.md) is kilometre-scale air and is not touched.

## Context

### What Unreal does (UE 5.8.3, read 2026-10-21)

Unreal's `LocalFogVolume` is an actor that a level designer places. A fresh project places none. The
renderer path is on by default (`r.LocalFogVolume` is 1).
`UE 5.8.3: Engine/Source/Runtime/Renderer/Private/LocalFogVolumeRendering.cpp:13-16`.

- **Shape and density.** Each volume is a unit sphere in its own space. The component transform
  stretches it into an ellipsoid. The base radius at scale 1 is 5 m.
  `UE 5.8.3: Engine/Source/Runtime/Engine/Classes/Components/LocalFogVolumeComponent.h:74-77`.
  Two density terms add up:
  - A radial term. Extinction falls with the square of the distance from the centre, to 0 at the
    surface. The ray integral has a closed form, so no ray march is necessary.
    `UE 5.8.3: Engine/Shaders/Private/LocalFogVolumes/LocalFogVolumeCommon.ush:175-205`.
  - A height term. Extinction falls exponentially with local height. It also has a closed form,
    with a clamp on the exponent so that it cannot overflow, and a floor on the vertical ray
    direction. `LocalFogVolumeCommon.ush:207-233`.
  - The two transmittances combine as one coverage value. Coverage is used as the integrated
    luminance factor because the model assumes that extinction equals scattering.
    `LocalFogVolumeCommon.ush:271-290`.
- **Defaults.** Radial density 1, height density 1, height falloff 1000 (the renderer scales it by
  0.01 and floors it at 1), height offset 0, phase g 0.2, albedo white, emissive black, start
  distance 0, sort priority 0. `LocalFogVolumeComponent.h:20-53`;
  `LocalFogVolumeRendering.cpp:428-431`.
- **Lighting.** The sun term is the sun colour times a Henyey-Greenstein phase. The sky term is the
  sky light's SH diffuse. No shadow is possible with the analytic integral. Albedo multiplies the
  in-scatter, and emissive adds after the albedo. `LocalFogVolumeCommon.ush:300-327`.
- **Composition.** Volumes sort on the CPU by priority, then by distance to the view. The shader
  composites them in order: the colour is attenuated by each volume's transmittance and the volume's
  in-scatter is added. `LocalFogVolumeRendering.cpp:513-531`; `LocalFogVolumeCommon.ush:409-424`.
- **Guards and limits.** A volume with both densities at 0 is skipped
  (`LocalFogVolumeRendering.cpp:421-424`). Every volume starts at least 10 m from the camera
  (`r.LocalFogVolume.GlobalStartDistance`, `LocalFogVolumeRendering.cpp:65-68`;
  `LocalFogVolumeCommon.ush:356-357`). The screen culls volumes in 128-pixel tiles, with at most 32
  volumes per view (`LocalFogVolumeRendering.cpp:45-53`, clamped to 256 at `:99-103`). Translucent
  materials do not sample the volumes by default (`:40-43`).

Unreal LOC: the feature map row "Height fog, volumetric fog, local fog volumes" is 10,713 lines. The
local-fog-volume files alone are about 2,320 lines: 1,258 renderer, 746 shader and 320 component.

### What ThreeNative does today

- Eleven templates ship `src/render/heightFog.ts`. It builds one `scene.fogNode` that three applies
  to every material (`packages/create-threenative/templates/sailing/src/render/sky.ts:146-149`).
  It is global. A game cannot put fog in one valley or one bay.
- The starter ships an opt-in, ray-marched, bounded mist with one box and a step count
  (`packages/create-threenative/templates/starter/src/render/volumetricFog.ts`, PRD-VQ-07). It is one
  volume, it is off by default, and its cost scales with the step count.
- `packages/create-threenative/capabilities.json` has no fog-volume entry (`rg -i 'FogVolume|LocalFog'`,
  2026-10-21).

## Solution

**The node and its sorted buffer are mechanism. The density model and the light are the game's.**

| Unreal piece | ThreeNative module | Layer |
| --- | --- | --- |
| `ALocalFogVolume` actor and component | `FogVolume` node (Godot's name, `@alias LocalFogVolume`) in `packages/core/src/render/fog-volume.ts` (new). It has `size` in metres, density and falloff values, albedo, emissive, phase g, start distance and priority. | core |
| CPU sort, 32-volume cap, skip of empty volumes | Same file. Each frame, it collects the visible `FogVolume` nodes, sorts them by priority then distance, and packs them into one uniform buffer. `TN_FOG_VOLUMES` reports the count, the cap and how many it dropped. | core |
| Analytic radial and height integral, sun and sky in-scatter, ordered composite | `localFogNode(base, volumes, sun)` in the template's `src/render/localFog.ts` (new). It wraps the existing `heightFogNode`, so `scene.fogNode` stays one node. | template |
| 128-pixel tile culling | Not ported until Phase 1 shows a need. A per-fragment loop over at most 32 volumes is the start. | — |
| Global start distance (10 m) | The same default, as a named override (`FogVolume.globalStartDistance`). `TN_FOG_VOLUMES` reports the value and where it came from. | core |

- **First consumer: the sailing template.** Fog banks on the sea are a real look for that game. The
  boat sails into and out of them, which also proves the inside-the-volume case.
- **The default look does not change.** No template that matches the Unreal default look (the
  starter) places a volume.
- **Port size:** about 350 to 450 ThreeNative lines, without tests. The core node is about 150 lines,
  and the template node is about 120 lines. The rest is the sailing placement and the native
  conformance scene.

Risks:

- `scene.fogNode` runs per fragment, so overdraw multiplies the loop. Phase 1 measures this before any
  other work.
- The owned C++ engine must lower a TSL loop over a uniform array. PRD-636 found that a loop body
  from the static import path can emit its statements twice. Phase 3 proves the native side.

## Acceptance Criteria

- [ ] AC-1 [local]: A fresh visual judge rates the sailing frame with fog banks IMPROVEMENT against the frame without them. Criteria: each bank reads as a bounded patch with a soft edge, and its sun side is brighter than its far side. proof: same pose before and after, headed `--browser-recipe webgpu`, two runs per arm, fresh read-only judge subagent — Evidence: pending.
- [ ] AC-2 [local]: Eight volumes on screen cost at most 0.2 ms GPU at 1080p on the RTX 2080 browser WebGPU lane. proof: `TN_FRAME_BUDGET` p50 delta from `node packages/playtest/dist/runner/cli.js perf`, 8 volumes against 0 — Evidence: pending.
- [ ] AC-3 [local]: The desktop native host draws the same fog banks as the browser within tolerance. proof: `pnpm parity --target desktop --only-tests local-fog-volume` — Evidence: pending.

## Blocked on

- Pixel 8 cost of eight volumes at the `low` tier: needs the shared Pixel, by owner call.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| `FogVolume` node and sorted buffer | sailing `src/render/sky.ts` → `scene.fogNode = localFogNode(heightFogNode(...), fogVolumes, sun)` | New. The global height fog stays and the bank composites over it | Phase 2 |
| Analytic local fog in `scene.fogNode` | every lit material in the sailing scene | New | AC-1, AC-2 |

## Execution Phases

#### Phase 1: The cost gate
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/sailing/src/render/localFog.ts` (new), `packages/create-threenative/__tests__/local-fog.spec.ts` (new)
- [ ] The closed-form radial and height optical depths match a 1,000-step numeric integral within 0.5% on 20 fixed rays, including a ray that starts inside the volume and a horizontal ray at the height offset. proof: `pnpm exec vitest run packages/create-threenative/__tests__/local-fog.spec.ts`.
- [ ] 1, 8 and 32 hard-coded volumes are measured in sailing at 1080p on the RTX 2080 browser lane. The result goes under `## Decisions`: continue if 8 volumes cost at most 0.2 ms; add tile culling as a Phase 2 box if 32 volumes cost more than 0.5 ms. proof: `node packages/playtest/dist/runner/cli.js perf` (`TN_FRAME_BUDGET` p50 delta, two runs per arm).

#### Phase 2: The node, and sailing adopts it
**Status:** NOT STARTED
**Files:** `packages/core/src/render/fog-volume.ts` (new), `packages/core/src/index.ts`, `packages/core/__tests__/fog-volume.spec.ts` (new), `packages/create-threenative/templates/sailing/src/render/sky.ts`, `packages/create-threenative/templates/sailing/src/scenes/Sailing.ts` (bank placement), `packages/create-threenative/templates/sailing/AGENTS.md` (and mirror)
- [ ] `FogVolume` sorts by priority then distance, skips volumes with both densities at 0, caps at 32, and reports the count, the drops and the start distance on `TN_FOG_VOLUMES`. proof: `pnpm exec vitest run packages/core/__tests__/fog-volume.spec.ts`.
- [ ] A sailing playtest sails the boat into a bank and out again. The labelled bank region darkens toward the fog colour inside and clears outside, and no frame is blank. proof: `node packages/playtest/dist/runner/cli.js packages/create-threenative/templates/sailing/playtests/fog-bank.playtest.json --browser-recipe webgpu` and `pnpm test:templates` (sailing).
- [ ] AC-1 passes on the visual judge. proof: the AC-1 capture pair and the judge verdict, posted on the PR.

#### Phase 3: Native
**Status:** NOT STARTED
**Files:** `packages/runtime-native/conformance/scenes/shared/local-fog-volume.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] The desktop native host renders three overlapping volumes to match the browser reference within tolerance for a fixed camera and sun. proof: `pnpm parity --target desktop --only-tests local-fog-volume`.

## Decisions

- 2026-10-21 (filing): The node takes Godot's name, `FogVolume`, because Godot is the only node source. The Unreal term is its `@alias` for capability search. Godot's `FogVolume` feeds a froxel grid. This one evaluates Unreal's closed-form model per fragment instead, because ThreeNative has no general froxel grid (PRD-VQ-07).
- 2026-10-21 (filing): The 10 m global start distance is Unreal's default. It stays the default here, with a named override, so that a camera inside a bank does not see a wall of fog at its own position.
