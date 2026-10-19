# Effective default mechanism map

All paths are relative to `packages/create-threenative/templates/`. Each conventional new
expression is actual source in `src/render/backlightMaterial.ts`, with live named `rimGain`,
`fillGain`, black `fillColor`, direction and angular-size controls. Reporting survives zero
controls. The rim is view grazing × key-behind × surface-backlit; fill is directional diffuse
plus a roughness-broadened reflected disc. Admission is hardware high-tier desktop WebGPU.

| Template | Existing authored source and behavior | New default rim / fill | Effective opening and proof limit |
| --- | --- | --- | --- |
| minimal | `src/render/lighting.ts`: sun4.5; `sky.ts`: photo IBL | .12 / 1 | Measured bright IBL suppresses extra fill; static-material scene |
| starter | `lighting.ts`: sun4.5; `sky.ts`: photo IBL | .12 / 1 | Measured bright IBL suppresses fill; actual mannequin supplies global difficult-light controls |
| action-rpg | `lighting.ts`: sun4.5; photo IBL; `dungeon.ts`: torch points | .12 / 1 | Bright-source fill off; spawned loot enrolled |
| platformer | `lighting.ts`: following sun4.2; photo IBL | .12 / 1 | Bright-source fill off |
| shooter | `lighting.ts`: sun4.5; photo IBL | .12 / 1 | Bright-source fill off |
| racing | `lighting.ts`: sun4.5; photo IBL | .12 / 1 | Bright-source fill off; read-only matrix fix preserves road/shadows |
| rts | `lighting.ts`: following sun4.5; photo IBL | .12 / 1 | Bright-source fill off; dynamic armies enrolled, custom terrain/water excluded |
| sailing | `lighting.ts`: palette sun3.4; photo IBL | .12 / 1 | Bright-source fill off |
| runner | `lighting.ts`: sun4.5 plus camera directional fill .9 | .12 / 0 (actual `Run.ts` override) | Original fill retained; not analytic-disc equivalence |
| snow | `lighting.ts`: storm sun3.3, hemisphere2.2, camera directional fill .45 | .12 / 0 | Original storm fill retained; custom snow material excluded; no analytic-disc equivalence |
| puzzle | `lighting.ts`: key.8, hemisphere.6, cold directional rim.24; vault lantern/seal points | 0 / 0 | Measured missing environment zero, added terms disabled; originals not key-gated grazing/disc equivalence |
| tower-defense | `lighting.ts`: key3.4, hemisphere1.5, cold directional rim.9; photo IBL | 0 / 0 | Originals preserved; authored directional rim/hemisphere not requested expressions |
| rain | `lighting.ts` forwards key/fill/flash into actual custom `world-shader.ts`; cloud `uSky` camera pass | Not integrated | Existing hemisphere-like fill and flash diffuse are not grazing/disc; cloud-source mean unknown |

Twelve matched full opening pairs establish authored-palette preservation. The starter mannequin
fixture supplies positive/zero rim, positive/black fill and omitted-report red-green controls.
Those global controls do not prove difficult-light behavior in every template. Bright-source
reports prove why fill is suppressed, not dark/no-sun behavior in every template.

Existing directional rim/hemisphere lights are useful authored illumination, but are not
mathematically equivalent to the requested terms. All-template acceptance remains open for
puzzle/tower disabled additions, runner/snow analytic-fill omission, rain and enabled native
appearance. Do not stack duplicate ambient merely to make new gains nonzero. A coherent
replacement or qualified authored alternative requires actual behavioral/palette proof and
preserved original acceptance. Native/mobile/software/WebGL original-material fallback is
preservation evidence, not enabled-mechanism acceptance.
