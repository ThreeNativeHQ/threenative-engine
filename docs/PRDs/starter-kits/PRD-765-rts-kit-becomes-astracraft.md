# PRD-765 — the RTS starter kit looks and plays like AstraCraft

**Status: PARTIAL** · **Priority:** P1 — the 60 fps reading and the contracts (phase 3) are open; the kit's look and HUD are what a "make me an RTS" request starts from · filed 2026-10-28 against `597faf225` · cites [PRD-471](../done/PRD-471-an-rts-template-from-astracraft.md).

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

- [x] Painted ground replaces the metre grid: noise base, roads with ruts, shorelines, base aprons with tile grid and dashed border, expansion rings, fissures. proof: headed WebGPU capture of the spawn pose — `0e83878f8`, painter 2.2 s -> 0.67 s in Node (`f3518b085`); [after-run1](https://github.com/ThreeNativeHQ/threenative-engine/blob/prd-765-screenshots/look/after-run1.jpg)
- [x] Environment: sandstone mesas on every obstacle plus the border ring, rubble, scrub grass, bridge, props; all instanced or merged. proof: the same capture plus `TN_PROJECTION` draw count — 427 mesas, 1098 stones, 1762 tufts; whole frame 129 main-pass draws, 234k triangles (`TN_FRAME_BUDGET` passes.main, 2026-10-28)
- [x] Lighting and palette follow the reference (hemisphere + warm sun + cool fill, background and fog colour). proof: the same capture — ACES, fixed exposure 1.02, `kit-look-defaults.spec.ts` names the override
- [x] Rock shadows reach the frame's edge at every zoom; no line slides with a pan (owner bug, 2026-10-28). proof: `pnpm exec vitest run packages/create-threenative/__tests__/rts-shadow-coverage.spec.ts` — red 4/4 on the 64 m window, green 4/4 with the frame-sized window; the same cut-off on `engine: "threejs"`, so layer = kit
- [x] Sand, pad and scene colour match the AstraCraft frame within 10 degrees of hue and 0.05 lightness (owner bug "yellowish tone"). proof: region HSL against `astra.png`, Wasm and threejs engines — sand near/top/far dl 0.00/0.00/+0.02, pad +0.01, scene +0.01; hue 0/+2/-19 (sat 0.07)/+1/+10
- [x] A fresh opus visual judge returns IMPROVEMENT against "matches the AstraCraft reference look", two runs per arm. proof: judge verdict and sheet on the PR — IMPROVEMENT run 1, run 2 and overall, no readability regression; sheets [run 1](https://github.com/ThreeNativeHQ/threenative-engine/blob/prd-765-screenshots/look/sheet-run1.png), [run 2](https://github.com/ThreeNativeHQ/threenative-engine/blob/prd-765-screenshots/look/sheet-run2.png)

### Phase 2 — HUD and mechanics parity (`src/ui/`, `src/scenes/`)

- [x] Top bar, objective panel and rival commanders panel. proof: headed capture beside the reference — `ecae23136`, same judge sheets; the top-right HQ and music icons are not ported
- [x] Control bar, tactical overview, selection card with portrait and roster, command / construct tabs. proof: headed capture beside the reference — `ecae23136`, same judge sheets
- [x] Selection, orders, build, economy, 3-way AI and air units unchanged. proof: `pnpm exec vitest run packages/create-threenative/__tests__/rts-sim.spec.ts` — with `rts-runtime-cost` and `kit-look-defaults`, 119/119 passed (2026-10-28)

### Phase 3 — performance and kit contracts

- [ ] 60 fps steady at 1920x913 on the default engine after boot. proof: `TN_FRAME_BUDGET` from a headed WebGPU run
  Open: 2026-10-28 RTX 2080 run read 48-55 fps (6 windows after boot), CPU frame p50 8 ms, GPU 5-6 ms, `hostGap` share 55%; the host was loaded (load 12-16, other WebGPU pages in the same browser). The AstraCraft reference read 38 fps in the same browser that minute. Remeasure on a quiet host.
- [ ] Contracts green: rts hash re-pinned with a dated comment, `TN_TEMPLATE_ONLY=rts pnpm test:templates`, `pnpm sync:agents`, `pnpm check:docs`, typecheck, lint. proof: those commands
  Open: 2026-10-28 desktop `TN_TEMPLATE_ONLY=rts pnpm test:templates` did not reach a scenario: the pack failed with `TN_PACK_WEB_ENGINE_STALE` because this lane's `build/web` Wasm came from another tree. Rerun after `node scripts/build-wasm.mjs`.

### Phase 4 — owner feel and look report (2026-10-28: judder, yellowish tone, thick moving bars)

- [x] Units move every frame, not in 20 Hz jumps. Cause (kit): `Play.ts` drew the raw positions of its own 20 Hz rules step; `army.ts` now blends the last two rules poses in a `ctx.beforeRender` draw. proof: `rts-motion.spec.ts` red with the blend forced to 1, green after; headed Brave on the RTX 2080, one walking unit over 240 frames: BEFORE 116-158 zero-step frames, step CV 0.99-1.42; AFTER 0 zero-step frames, step CV 0.10-0.33
- [x] Health bars match AstraCraft: 30 x 3 px unit and 60 x 3 px building fill, 1 px `#08151e` frame, team fill for rivals, pixel-snapped so the frame does not shimmer during a pan. proof: `rts-motion.spec.ts` asserts every bar edge on an integer pixel over a sub-pixel pan and the sizes 30x3/32x5/60x3/62x5; fresh judge: IMPROVEMENT in both runs
- [x] Tone matches AstraCraft in the same browser at the same pose (headed Brave, game clock 00:11-00:15, two runs per arm). Causes (kit): an unblurred fog edge left a ring of bright lit sand, the 0.4 vignette turned the fog olive at the edges, and `envStandard` colours were read as legacy linear where AstraCraft decodes them from sRGB. Fixes: AstraCraft's 5 px fog blur as a 7-tap Gaussian, no vignette, fog sheet `2, 10, 22`, sRGB-decoded mesa, scrub and underlay colours. proof: region means against AstraCraft — fog right `(81,94,101)` vs `(82,97,100)` (was `(69,78,78)`), pad `(154,167,166)` vs `(155,169,168)`, lit sand `(168,163,134)` vs `(165,161,131)`, mesa top `(178,167,128)` vs `(157,143,99)` (was `(181,171,138)`); fresh judge on BEFORE/AFTER/ASTRACRAFT sheets: tone IMPROVEMENT, no regression, both runs. Left: mesa tops stay lighter than the reference; selection rings are cyan where AstraCraft draws thin white ones
- [x] 60 fps presented on a production build after the change. proof: headed Brave rAF intervals on `vite build` + `vite preview` (scripted pan, order, pan back, 18 s) on the RTX 2080, 2026-10-28 22:42: AFTER 59.8 fps, p95 16.73 ms (GPU 1% before the run) and 59.0 fps, p95 16.72 ms; BEFORE same minute 59.7 fps, p95 16.68 ms; `TN_FRAME_BUDGET` presented p95 16.72-16.73 ms, CPU frame p50 2.6-3.0 ms; dev server 58.0 fps, p95 16.72 ms. Left: 4-13 intervals over 30 ms per run in both arms (host gaps, not this change). Under another session's 100% GPU load both arms fell to 41-42 fps alike

### Phase 5 — judge loop against AstraCraft (owner, 2026-10-28: "do the visual judge side by side until ours match the html version")

- [x] Stability at least AstraCraft's. proof: one tool for every arm (headed Brave, production builds, pan / order / walk / pan back, rAF intervals and screencast pan steps by phase correlation), GPU median 37-50%: AstraCraft 57.9-59.0 fps, 3-9 intervals over 20 ms, 7-18 pan steps outside 0.5-1.5x median; ours Wasm 60.0 fps, 0 intervals over 20 ms, 0-9 steps; ours threejs 60.0 fps, 0, 0-0. Left: with another process holding the GPU at 87-100% both of our WebGPU engines lose more frames than AstraCraft's WebGL (Wasm 55.9 fps / 40 over 20 ms, threejs 48 fps / 127-140); engine/backend item, reported to the lead
- [x] Judge round 2. proof: fresh Opus judge on ASTRACRAFT / OURS WASM / OURS THREEJS sheets, two runs: tone MATCH, bars MATCH, motion MATCH, smoothness MATCH; palette CLOSE (crystals deep blue, cyan rings), shadows CLOSE; engine A/B: threejs drew white bars. Fixes (kit): bar and marker colour attributes made before the first draw (three.js compiles once; `rts-motion.spec.ts` red without it), AstraCraft's two crystal materials and unit cone (crystal pixels `(125,183,206)` vs `(118,180,202)`, was `(82,147,181)`), thin legacy-colour selection rings without an underlay, shadow radius 1, AstraCraft's `(-66, 57)` start target (frames now pixel-aligned, were 56 x 16 px off)
- [x] Judge round 3. proof: fresh Opus judge on pixel-aligned sheets, two runs: tone MATCH, health bars MATCH, motion MATCH, smoothness MATCH or better; palette CLOSE (crystal field sparser and bluer), shadows CLOSE (tank shadow / lit sand 0.60 vs 0.57; a hard PCF arm read the same 0.60, so the kernel is not the cause); no render difference between Wasm and threejs, so no engine bug in the look. Left: world-space building labels and building paint details (content, not the six criteria)

## Open engine issues (layer: engine, not fixed in this kit)

- TSL `pow` through `material.outputNode` (the `output` node) fails on the Wasm engine: `TN_START_FAILED: TN_ABI_1: TSL pow: TN_ABI_ARGUMENT expected a TSL node or number`. It works on `engine: "threejs"`. The kit's fog-of-war blend uses `colorNode` plus `emissiveNode` instead.
