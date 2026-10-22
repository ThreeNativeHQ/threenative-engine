---
prd_contract: v1
---

# PRD-679 — Sparks and glass in fog take the fog of their own distance and blend mode

**Status:** NOT STARTED
**Priority:** P2 — Phase 1 is open: an additive spark in height fog adds the fog colour instead of fading, and a post-applied haze fogs a near glass pane by the depth of the wall behind it.
**Complexity:** 5 (MEDIUM) — 6–10 files: the fog compose function, its spec, 12 template fog files, the native fog mix, one conformance scene (+2), template adoption (+1), native proof (+1), a render-order change across two passes (+1); risk override: none
**Owner:** João
**Depends on:** None. Builds on the `scene.fogNode` that [PRD-560](../../done/PRD-560-height-fog-follows-the-ground.md) shipped. Composes with [PRD-562](PRD-562-aerial-perspective-from-a-froxel-volume.md): its apply step reads opaque depth, so it inherits the Phase 3 order. [PRD-663](PRD-663-a-fog-bank-sits-where-the-game-puts-it.md) is not touched, because Unreal does not fog translucency with local fog volumes by default. PRD-643 (`docs/PRDs/Unreal/gi/PRD-643-glass-fog-and-leaves-take-the-bounce-light-too.md`, on `feat/unreal-look-epic`) lights translucency and fog with GI. This PRD only composes fog over translucency, so the two do not overlap.

## Context

**Unreal LOC:** the feature map row "Height fog, volumetric fog, local fog volumes" counts 10,713
lines. The translucency composition is about 230 of them: the fog block and the blend outputs of the
base pass, the volumetric-fog combine and the aerial-perspective-over-fog helper. **Port estimate:**
about 350 ThreeNative lines: 60 in a core fog function, 80 of spec, 2 lines in each of 12 template
fog files, 25 of C++ in the native fog mix, 120 in one conformance scene and 60 in the starter
post chain.

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

- **Opaque fog is a full-screen pass that runs before translucency.** The deferred fog pass reads
  scene depth (`UE 5.8.3: Engine/Source/Runtime/Renderer/Private/DeferredShadingRenderer.cpp:3823`).
  Translucency draws later (`DeferredShadingRenderer.cpp:4012`). So the fog behind a glass pane is
  already in scene colour when the pane draws.
- **Each translucent surface fogs itself at its own position.** A translucent material with fogging
  on computes height fog per vertex, or per pixel when the material asks for it
  (`UE 5.8.3: Engine/Shaders/Private/BasePassCommon.ush:30-35`). Volumetric fog is always sampled per
  pixel at the surface's own froxel coordinate (`BasePassCommon.ush:37-39`;
  `Engine/Shaders/Private/BasePassPixelShader.usf:1549-1560`). Aerial perspective and cloud fog are
  layered on in the same place (`BasePassPixelShader.usf:1576-1605`).
- **The fog is a pair: in-scattered light (RGB) and transmittance (A).** Local fog volumes, the
  height fog, volumetric fog and aerial perspective stack front to back into one pair
  (`BasePassPixelShader.usf:1525-1560`).
- **The blend mode decides how the pair applies.** `UE 5.8.3: Engine/Shaders/Private/BasePassPixelShader.usf:2319-2331`:
  - Alpha blend: colour × transmittance + in-scatter. This is the same as a mix toward the fog
    colour.
  - Additive: colour × transmittance × opacity. No in-scatter is added, so a far spark fades into the
    fog. It does not turn fog-coloured.
  - Modulate: a lerp from white to the colour by transmittance squared, so a far decal fades to "no
    change".
- **Defaults in a fresh project:** the level has height fog and a sky atmosphere, so aerial
  perspective is on. Volumetric fog is off, because `bEnableVolumetricFog` is not set in the
  component constructor
  (`UE 5.8.3: Engine/Source/Runtime/Engine/Classes/Components/ExponentialHeightFogComponent.h:136`;
  constructor at `Engine/Source/Runtime/Engine/Private/Components/ExponentialHeightFogComponent.cpp:72`).

### ThreeNative today

- Eleven templates assign a height-fog node to `scene.fogNode`. Each node ends in three's `fog(color,
  opacity)` (for example `packages/create-threenative/templates/starter/src/render/heightFog.ts:111,117`).
  `tower-defense` sets a plain `FogExp2`.
- three applies the fog node to every material with `fog: true`, after lighting and before
  premultiplied alpha (`three/src/materials/nodes/NodeMaterial.js:1128-1140, 1186-1198`, r185.1).
  `fog()` always mixes the colour toward the fog colour (`three/src/nodes/fog/Fog.js:93-97`). It does
  not read the blend mode.
- So alpha-blended glass already composes as Unreal does. Additive materials do not. Eight template
  files use `AdditiveBlending`, and none of them turns fog off: shooter `gunfx.ts`, `Rifle.ts`,
  `Play.ts`, snow `weather.ts`, runner `dust.ts`, action-rpg `vfx.ts`, tower-defense
  `materials.ts` and rain `lightning.ts`. In fog, each of these adds the fog colour at its distance.
- The native engine copies three's mix exactly
  (`packages/runtime-native/src/engine/shader/standard.cpp:445-453`), so both engines carry the bug.
- Post-applied media read opaque depth only. The starter mist ray-marches to scene depth
  (`packages/create-threenative/templates/starter/src/render/volumetricFog.ts`, off by default), and
  PRD-562's aerial perspective will do the same. The scene pass draws transparent objects before
  either medium runs. So a pane 5 m away takes the haze of the wall 200 m behind it.
- three's `PassNode` can draw opaque and transparent objects in separate passes
  (`three/src/nodes/display/PassNode.js:300, 308`). No template uses that split today.

## Solution

**The mechanism is how a fog pair composes per blend mode. The fog colour, density and curve stay
the game's.**

| Unreal piece | ThreeNative module | Layer |
| --- | --- | --- |
| Blend-mode composition of the fog pair | `composeFog(color, opacity)` in `packages/core/src/render/fog-compose.ts` (new). It reads the material's blending at build time: normal blending mixes, additive scales by transmittance, multiply lerps toward white by transmittance squared | core mechanism |
| Height fog on each translucent surface | Each template's `heightFog.ts` calls `composeFog` in place of three's `fog`. `tower-defense` gets the same call through a one-line fog node over its `FogExp2` | template source |
| The same rule on the native engine | `fogColor` in `packages/runtime-native/src/engine/shader/standard.cpp` reads the variant's blend mode | native engine |
| Opaque fog before translucency | The starter post chain draws the opaque pass, applies the mist, then draws the transparent pass on the same depth | template source (`postprocessing.ts`) |
| Volumetric fog sampled at the surface | A transparent surface in the mist takes the mist's analytic height term at its own position through its fog node | template source |

**Gate:** Phase 2 runs only if Phase 1 measures an additive or multiply error above 2/255 at a
shipped template density. Phase 3 runs only if Phase 1 measures a pane error above 2/255 under a
depth-read haze. A result under the threshold is recorded under `## Decisions` with its revisit
condition: a template that ships denser fog, or PRD-562's apply step landing.

**Honest reporting:** `TN_FOG` reports, per frame, the count of fogged materials by blend mode, and
it names every additive or multiply material that turned fog off.

Risks:

- The native engine compiles fog nodes from the node graph. Phase 2 confirms that a build-time branch
  on the material's blending reaches the native compiler. If it does not, the native engine applies
  the rule in `standard.cpp` from the variant's blend mode, and the core function stays web-only
  sugar over the same rule.
- Splitting the scene pass costs one more pass. Phase 3 measures it.

## Acceptance Criteria

- [ ] AC-1 [local]: In the `fog-translucency` conformance scene, the additive and multiply quads at 150 m match the blend-aware reference within 2/255 on browser WebGPU and on the desktop native host. proof: `pnpm parity --target desktop --only-tests fog-translucency` — Evidence: pending.
- [ ] AC-2 [local]: A fresh read-only judge returns IMPROVEMENT for shooter muzzle flashes and snow particles in fog, same pose before and after, with criteria written first: far additive effects fade into the fog and do not glow in the fog colour. proof: two headed `--browser-recipe webgpu` captures per arm, `adapter.info` checked — Evidence: pending.
- [ ] AC-3 [local]: With the starter mist on, a pane 5 m from the camera matches its per-surface reference within 2/255, and the pass split costs at most 0.2 ms GPU at 1080p on the RTX 2080 browser lane. proof: `node packages/playtest/dist/runner/cli.js perf` with `TN_FRAME_BUDGET`, split on against off — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| `composeFog` | 12 templates' `scene.fogNode` → every material with `fog: true` | Replaces three's blend-unaware `fog()` call in template source | AC-1, AC-2 |
| Native blend-aware fog | `standard.cpp` `fogColor`, every fogged native material | Replaces the plain mix at `standard.cpp:445-453` | AC-1 |
| Opaque, medium, then transparent | Starter `postprocessing.ts` when `STARTER_MIST.enabled` is true | New order. PRD-562's apply step takes the same slot when it lands | AC-3 |

## Execution Phases

#### Phase 1: How wrong is fog over translucency today
**Status:** NOT STARTED
**Files:** `packages/runtime-native/conformance/scenes/shared/fog-translucency.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] The `fog-translucency` scene draws a wall at 200 m, an alpha pane at 5 m, and an additive and a multiply quad at 150 m in starter-density height fog. The error of each region against the blend-aware reference is recorded under `## Decisions` for both engines. proof: `pnpm parity --target desktop --only-tests fog-translucency`.
- [ ] The same scene with a depth-read haze pass records the pane error against its per-surface reference under `## Decisions`, and the gate result for Phases 2 and 3. proof: `pnpm parity --target desktop --only-tests fog-translucency`.

#### Phase 2: Fog composes by blend mode
**Status:** NOT STARTED
**Files:** `packages/core/src/render/fog-compose.ts` (new), `packages/core/src/index.ts`, `packages/core/__tests__/fog-compose.spec.ts` (new), `packages/create-threenative/templates/*/src/render/heightFog.ts`, `packages/create-threenative/templates/tower-defense/src/render/sky.ts`, `packages/runtime-native/src/engine/shader/standard.cpp`
- [ ] `composeFog` mixes for normal blending, scales by transmittance for additive and lerps toward white by transmittance squared for multiply. A capability search for "fog translucency" returns it. proof: `pnpm exec vitest run packages/core/__tests__/fog-compose.spec.ts packages/engine-mcp/__tests__/search.spec.ts`.
- [ ] Every template with fog uses `composeFog`, and the template gate passes. proof: `pnpm test:templates`.
- [ ] The native engine applies the same rule, and the conformance row passes on desktop. proof: `pnpm parity --target desktop --only-tests fog-translucency`.
- [ ] The visual judge returns IMPROVEMENT for the AC-2 poses (shooter and snow). proof: fresh read-only judge subagent on two headed WebGPU captures per arm.

#### Phase 3: A post-applied medium fogs the opaque scene before glass draws
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/starter/src/render/postprocessing.ts`, `packages/create-threenative/templates/starter/src/render/volumetricFog.ts`, `packages/create-threenative/templates/starter/playtests/fog-translucency.playtest.json` (new)
- [ ] With the starter mist on, the opaque pass, the mist and the transparent pass draw in that order on one depth, and the pane meets AC-3 on browser WebGPU. proof: `node packages/playtest/dist/runner/cli.js packages/create-threenative/templates/starter/playtests/fog-translucency.playtest.json --browser-recipe webgpu`.
- [ ] The same scenario passes on the desktop native host. proof: the same command with `--target desktop`.
