---
prd_contract: v1
---

# PRD-704 — A spark streaks along its own motion, and a far spark does not flicker

**Status:** NOT STARTED
**Priority:** P2 — Phase 1 is open: four effects hand-write their own streak alignment (`rain.ts`, `lightning.ts`, the gallery and the action-rpg sparks), and the action-rpg sparks align to a world axis, not to the screen.
**Complexity:** 6 (MEDIUM) — 6–10 files: `particles.ts`, its spec, the index tags, the gallery probe, the action-rpg template, a conformance scene and registry row (+2), new options on a public class (+2), a vertex-stage change that every sprite emitter can take (+1), native proof (+1); risk override: none
**Owner:** João
**Depends on:** None. Coordinates with [PRD-674](PRD-674-an-ambient-particle-is-a-function-of-its-age-and-seed-and-costs-no-simulation.md): its rain adoption may drop the hand-projected streak endpoints only when this PRD ships the velocity mode. Respects [PRD-316](PRD-316-forty-six-vfx-are-generated-render-source-not-an-engine-inside-the-engine.md) (§3): the size, colour and texture of a streak stay the game's.

## Context

**Unreal LOC:** 1,808 lines for sprite facing, alignment and pixel coverage
(`NiagaraRendererSprites.cpp`, `NiagaraRendererSprites.h`, `NiagaraSpriteVertexFactory.*`). The
vertex-factory shader that applies the modes lives in the Niagara `Shaders/` folder, which the local
sparse clone does not hold, so the count is C++ only. **Port estimate:** about 250 to 350
ThreeNative lines: about 120 in `packages/core/src/particles.ts`, about 150 of specs, and a
conformance scene of about 60.

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

- **Alignment and facing are two separate choices.** Alignment turns the sprite's up axis: no
  alignment (rotation only), along the particle velocity, or along a custom axis attribute. Facing
  turns the sprite's plane: toward the camera position with the camera's up axis, parallel to the
  camera plane, toward a custom vector, toward the camera position with world up (stable under
  camera rotation), or a blend of the last two by distance.
  `UE 5.8.3: Engine/Plugins/FX/Niagara/Source/Niagara/Public/NiagaraSpriteRendererProperties.h:17-28, 33-48`.
- **The default is automatic.** Both fields default to `Automatic`
  (`NiagaraSpriteRendererProperties.h:180, 187`). At setup, automatic alignment becomes custom
  alignment when the emitter binds an alignment attribute and no alignment otherwise. Automatic
  facing becomes a custom vector when the emitter binds a facing attribute and camera facing
  otherwise (`UE 5.8.3: Engine/Plugins/FX/Niagara/Source/Niagara/Private/NiagaraRendererSprites.cpp:179-188`).
- **A missing attribute falls back, it does not fail.** A custom facing or a custom alignment
  without its attribute falls back to camera facing or to no alignment
  (`NiagaraRendererSprites.cpp:503-511`). The default alignment axis is +X when nothing is bound
  (`NiagaraRendererSprites.cpp:581`).
- **Sub-pixel sprites keep their energy.** Pixel coverage is `Automatic` per renderer
  (`NiagaraSpriteRendererProperties.h:260`), and the project default turns automatic on
  (`UE 5.8.3: Engine/Plugins/FX/Niagara/Source/Niagara/Public/NiagaraSettings.h:235`). When a sprite
  covers less than a pixel, the renderer computes the covered fraction and darkens or fades the
  sprite by it. The header says that without it, sub-pixel sprites flicker, especially under
  temporal super resolution (`NiagaraSpriteRendererProperties.h:251-260`). The blend weight is 1
  (`NiagaraSpriteRendererProperties.h:267`).
- **Coverage follows the blend mode.** It runs only in a perspective view. In automatic mode it
  runs only for translucent materials: an alpha-blended sprite scales its alpha, an additive sprite
  scales all four channels, and any other blend mode turns it off
  (`NiagaraRendererSprites.cpp:598-631`).
- **Stateless emitters carry the same choice.** The stateless module set includes a sprite facing
  and alignment module (`UE 5.8.3: Engine/Plugins/FX/Niagara/Source/Niagara/Private/Stateless/Modules/NiagaraStatelessModule_SpriteFacingAndAlignment.cpp`).

### ThreeNative today

- `GPUParticles3D` extends `Sprite` and sets `material.positionNode` to its positions buffer
  (`packages/core/src/particles.ts:338`). A three `SpriteNodeMaterial` faces the camera plane and
  turns by `rotationNode`. Nothing in core aligns a sprite to motion or keeps a sub-pixel sprite
  visible.
- The action-rpg sparks set `rotationNode = atan(direction.y, direction.x)` from a world-space
  launch direction (`packages/create-threenative/templates/action-rpg/src/render/vfx.ts:218-219`).
  That angle matches the screen only when the camera looks along world Z.
- The gallery does the same for its stretched "ribbon" layers
  (`examples/vfx-gallery/src/render/fireSmokeWeather.ts:379-395`).
- The rain template projects two endpoints of each drop by hand, offsets the quad sideways in pixels
  and throws a quad off screen when an endpoint is behind the camera
  (`packages/create-threenative/templates/rain/src/render/rain.ts:196-225`). The lightning bolt
  repeats that projection and that guard (`packages/create-threenative/templates/rain/src/render/lightning.ts:210-221`).
- The rain streak width is 0.42 to 0.85 pixels (`rain.ts:218-222`). That is sub-pixel by
  construction, and nothing scales its opacity for the lost coverage.
- `engine_search_capabilities` for "sparks stretched along their velocity as streaks" returned only
  the rain template's own `createStormRain` (2026-10-21).

Layer: engine. Billboarding is mechanism (root `AGENTS.md`, "Where a change goes"). The streak's
size, colour, texture and length factor stay the game's.

## Solution

| Unreal piece | ThreeNative module | Layer |
| --- | --- | --- |
| Alignment: none, velocity, custom axis | `GPUParticles3D` option `transformAlign` with Godot's names: `"billboard"` (today's behaviour, the default) and `"zBillboardYToVelocity"` (Unreal velocity alignment with camera facing). The axis is `buffers.velocities` unless the game passes an `alignment` node (Unreal custom alignment) | `packages/core/src/particles.ts` |
| Fallback when the axis is missing | A zero or non-finite axis keeps the camera-up billboard. An endpoint behind the near plane collapses the quad, as the rain template does today | `particles.ts` |
| Pixel coverage | On by default for transparent materials in a perspective view: the vertex stage keeps the sprite at one pixel and the engine multiplies the game's colour by the covered fraction (alpha only for normal blending, all channels for additive). Named override: `pixelCoverage: false`. `stats` reports the mode | `particles.ts` |
| Streak length, width, colour, texture | The game's `scaleNode`, `colorNode` and map, unchanged | the game's `src/render/` |

- **Auto by default.** The engine measures the projected axis and the projected size where it draws
  them. The game never supplies a screen-space angle.
- **No new class.** `transformAlign` is Godot's `GPUParticles3D.transform_align`, in camelCase.
- **Deferred, not built:** camera-position facing with world up and the distance blend. Revisit when
  a large near sprite shows a visible swing under camera rotation. Custom facing (a sprite flat to a
  surface): revisit when a template ships ground splashes or ripples as particles.

## Acceptance Criteria

- [ ] AC-1 [local]: In the gallery alignment probe, the median angle between each drawn streak and its screen-space motion is at most 3° with `"zBillboardYToVelocity"`, against the Phase 1 baseline. proof: `node packages/playtest/dist/runner/cli.js examples/vfx-gallery/playtests/align-probe.playtest.json --url http://127.0.0.1:5187 --server-command 'pnpm --filter vfx-gallery dev --host 127.0.0.1 --port 5187 --strictPort' --browser-recipe webgpu --live-clock` — Evidence: pending.
- [ ] AC-2 [local]: A far emitter of sub-pixel sparks shows at most half the frame-to-frame luminance variance of the Phase 1 baseline in its labelled region, at matched mean luminance within 10%. proof: the same playtest, coverage arm — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| `transformAlign: "zBillboardYToVelocity"` | action-rpg hit sparks in `src/render/vfx.ts` | Replaces `rotationNode = atan(direction.y, direction.x)` | Phase 3, AC-1 |
| Pixel coverage | Every transparent `GPUParticles3D` | None (new). Far sparks flicker today | AC-2 |
| Capability search | `engine_search_capabilities "velocity aligned sparks"` | New `@alias velocity aligned sprite, sprite alignment, pixel coverage` on `GPUParticles3D` | Phase 2 |

## Execution Phases

#### Phase 1: Measure the misalignment and the flicker
**Status:** NOT STARTED
**Files:** `examples/vfx-gallery/src/scenes/alignProbe.ts` (new), `examples/vfx-gallery/playtests/align-probe.playtest.json` (new)
**Implementation:** the probe drives the gallery `impact-sparks` preset with the action-rpg rotation rule from three camera poses (side, 45° down, behind). It reads `positions` for two frames through `GPUReadback`, projects both, and reports the median angle between the screen motion and the drawn axis. A second arm places the same emitter 40 m away and reports the share of sparks under one pixel and the frame-to-frame luminance variance of its region over 60 stepped frames. **Gate:** continue the alignment work if the median angle is at least 10° in any pose. Continue the coverage work if at least 20% of the far sparks are under one pixel. Record the verdict under `## Decisions` and delete the boxes of a part that fails (R4).
- [ ] The probe prints the median angle per pose on a named WebGPU adapter. proof: the AC-1 playtest command, baseline arm.
- [ ] The probe prints the sub-pixel share and the luminance variance for the far emitter. proof: the AC-1 playtest command, coverage arm.

#### Phase 2: Core aligns and covers
**Status:** NOT STARTED
**Files:** `packages/core/src/particles.ts`, `packages/core/__tests__/particles.spec.ts`, `packages/core/src/index.ts`, `packages/engine-mcp/__tests__/search.spec.ts`
- [ ] With `"zBillboardYToVelocity"`, the vertex node turns the sprite's up axis onto the projected axis, keeps the camera-up billboard for a zero or non-finite axis, and collapses the quad when an endpoint is behind the near plane. proof: red-green `pnpm exec vitest run packages/core/__tests__/particles.spec.ts`.
- [ ] Pixel coverage scales alpha for normal blending, all channels for additive blending, does nothing for opaque or orthographic draws, and does nothing with `pixelCoverage: false`. proof: red-green `pnpm exec vitest run packages/core/__tests__/particles.spec.ts`.
- [ ] A capability search for "velocity aligned sparks" returns `GPUParticles3D`. proof: `pnpm exec vitest run packages/engine-mcp/__tests__/search.spec.ts`.

#### Phase 3: The action-rpg sparks adopt it, judged, and native
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/action-rpg/src/render/vfx.ts`, `packages/create-threenative/templates/action-rpg/AGENTS.md` (and mirror), `packages/runtime-native/conformance/scenes/shared/vfx-sprite-align.js` (new), `packages/runtime-native/conformance/registry.json`
**Verification:** this changes what reaches the screen. Visual criteria: each hit spark points along its own flight from every camera pose, no spark pops in or out at distance, and colour and size stay as before.
- [ ] The hit sparks use `"zBillboardYToVelocity"` with an `alignment` node from their launch direction, the combat scenario stays green, and a fresh visual judge returns IMPROVEMENT with no REGRESSION frame. proof: `pnpm test:templates` (action-rpg) and headed `--browser-recipe webgpu` captures, 2 runs per arm, judged by a fresh read-only subagent.
- [ ] The conformance row `vfx-sprite-align` passes on the desktop lane within its tolerance. proof: `pnpm parity --target desktop --only-tests vfx-sprite-align`.
- [ ] The template instructions, mirrors and manifest name `transformAlign` and `pixelCoverage`. proof: `pnpm sync:agents && pnpm check:docs && pnpm budgets`.
**Verification:** AC-1 and AC-2.

## Decisions

- 2026-10-21 (filing): no motion vectors for particles in this PRD. Unreal writes velocity for a translucent material only when the material opts in (`UE 5.8.3: Engine/Source/Runtime/Engine/Public/Materials/Material.h:1098`, read at `Engine/Source/Runtime/Engine/Private/Materials/Material.cpp:7512`), and every template spark is additive with `depthWrite: false`. Revisit when an opaque or masked particle runs under a temporal stage and a capture shows a ghost.
- 2026-10-21 (filing): no per-particle depth sort here. Unreal's sprite sort mode defaults to none (`NiagaraSpriteRendererProperties.h:191`). Sort and composition stay with [PRD-VQ-12](../../rendering/PRD-VQ-12-transparent-effects-composition.md).
