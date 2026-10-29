# PRD-765 — the RTS starter kit looks and plays like AstraCraft

**Status: PARTIAL** · **Priority:** P1 — the kit's look and HUD (phases 1-2 open) are what a "make me an RTS" request starts from · filed 2026-10-28 against `597faf225` · cites [PRD-471](../done/PRD-471-an-rts-template-from-astracraft.md).

Owner, 2026-10-28: "we should have cloned whats on file:///home/joao/Downloads/AstraCraft-v3(1).html - for the RTS
starter kit. Not that clunky shit we have" · "our goal is to have same AstraCraft look, but in our ThreeNative
engine" · AstraCraft "runs on 60FPS stuck. and its more complex in terms of textures, etc."

## Why

PRD-471 ported the AstraCraft *rules* into `templates/rts/src/sim/` (same 224 m map, three commanders, 18 types,
A*, economy, air units, four-state AI) and its procedural unit models into `src/render/models.ts`. It did not port
the *look* or the *HUD*. The kit draws a metre grid on a bare displaced plane under a photographed sky, and its HUD
is five loose button rows. AstraCraft draws a painted battlefield (noise ground, dirt roads with ruts, tiled base
aprons, damp shorelines, expansion rings), layered sandstone mesas, rubble, scrub grass, a bridge and props, and a
full command HUD. The reference is `AstraCraft-v3.html` (owner's file, three r140 WebGL, about 60 fps).

## Inventory: AstraCraft system to kit file

| AstraCraft (`game.js` line) | What | Kit today | Kit target |
| --- | --- | --- | --- |
| `Game`, `CommanderAI`, `TYPES` (534-952) | rules, 3-way AI, air | `src/sim/*` (PRD-471) | keep |
| `makeModel`, `palette` (1080-1224) | procedural units | `render/models.ts` | keep |
| `groundTexture` (957) | painted ground: noise, roads, ruts, pools, aprons, expansion rings, fissures | metre grid TSL material | `render/ground.ts`: CPU `DataTexture`, no DOM canvas |
| `sedimentTexture`, `grainTexture` (1001-1005) | banded rock map, grain bump | none | `render/ground.ts` |
| `buildEnvironment` (1007) | mesas, border cliffs, rubble, scrub grass, bridge, props, skirt | flat plain | `render/environment.ts`, instanced |
| `WorldView` ctor (1225) | ACES 1.02, hemi 0xc8e6ef/0x625343, sun 0xffe7c4 1.55, fill 0x83c8dc, fog 0x31464a | sky.jpg IBL, sun 4.5 | `render/lighting.ts` / `sky.ts` palette |
| `makeFog`/`updateFog` (1260) | blurred fog of war | fog in terrain material | keep, tune to the reference tint |
| `Hud` + CSS (1402-1565, head) | top bar, objective panel, rivals panel, control bar, minimap, selection card + portrait, command/construct tabs | five button rows | `src/ui/*` React + Tailwind |

Capability search (`engine_search_capabilities`, scope request, 2026-10-28): the only hit that owns a part of this is
the `rts` kit itself; `WaterSurface3D` and `WaveField` were read and rejected (the reference water is a flat tinted
disc, not reflective).

## Phases

### Phase 1 — look parity (`src/render/`, generated source)

- [ ] Painted ground replaces the metre grid: noise base, roads with ruts, shorelines, base aprons with tile grid and dashed border, expansion rings, fissures. proof: headed WebGPU capture of the spawn pose
- [ ] Environment: sandstone mesas on every obstacle plus the border ring, rubble, scrub grass, bridge, props; all instanced or merged. proof: the same capture plus `TN_PROJECTION` draw count
- [ ] Lighting and palette follow the reference (hemisphere + warm sun + cool fill, background and fog colour). proof: the same capture
- [ ] A fresh opus visual judge returns IMPROVEMENT against "matches the AstraCraft reference look", two runs per arm. proof: judge verdict and sheet on the PR

### Phase 2 — HUD and mechanics parity (`src/ui/`, `src/scenes/`)

- [ ] Top bar, objective panel and rival commanders panel. proof: headed capture beside the reference
- [ ] Control bar, tactical overview, selection card with portrait and roster, command / construct tabs. proof: headed capture beside the reference
- [ ] Selection, orders, build, economy, 3-way AI and air units unchanged. proof: `pnpm exec vitest run packages/create-threenative/__tests__/rts-sim.spec.ts`

### Phase 3 — performance and kit contracts

- [ ] 60 fps steady at 1920x913 on the default engine after boot. proof: `TN_FRAME_BUDGET` from a headed WebGPU run
- [ ] Contracts green: rts hash re-pinned with a dated comment, `TN_TEMPLATE_ONLY=rts pnpm test:templates`, `pnpm sync:agents`, `pnpm check:docs`, typecheck, lint. proof: those commands
