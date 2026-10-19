# PRD-567 — Terrain layers blend by their own height, and the game owns the curve

**Closed:** 2026-10-10 at `5990ceb27`, archived to `done/`.

**Status:** DONE — 2026-10-10. Every phase and acceptance box verified.
**Priority:** P2 — Height set, weight seam and the game-side height blend are all unbuilt.
**Complexity:** 3 (LOW) — 1–5 implementation files (`world-terrain-splat.ts`, the two `export_world.py` copies, the example's render source) (+1); a game-supplied weight seam on an existing material (+0); native rows reuse PRD-493's conformance case (+0); risk override: none
**Owner:** João
**Depends on:** [PRD-493](../open-world/PRD-493-terrain-layers-past-sixteen-textures.md) (same-size sets stack into one array texture; its phases 1–3 landed, so the extra set costs one sampler)

## Context

`loadTerrainSplat` (`packages/core/src/world-terrain-splat.ts`) blends each table layer over the layers below it with one weight. The weight is the layer's mask, pushed by breakup noise, remapped from `lo..hi` and clamped (`world-terrain-splat.ts:463-470`). Colour, normal and ORM all mix by that weight (`:471-474`). A mask edge is therefore as smooth as the mask texture and its noise. It cannot follow the detail inside the textures, for example grass that fills the gaps between stones first.

**What Unreal does.** Clean-room summary, no code copied:

- UE 5.8.3: `Engine/Source/Runtime/Landscape/Classes/Materials/MaterialExpressionLandscapeLayerBlend.h:19-24` defines three blend types: weight, alpha and height. Each height-blended layer takes a `HeightInput` (`:40-41`), usually the layer's own height or displacement texture, with a constant fallback (`:51-53`).
- UE 5.8.3: `Engine/Source/Runtime/Landscape/Private/Materials/MaterialExpressionLandscapeLayerBlend.cpp:218-230`. For a height-blended layer, the painted weight w becomes `clamp(lerp(-1, 1, w) + h, 0.0001, 1)`. The blend then divides every layer by the sum of all weights (`:237`). At w = 0.5 the layer shows only where its height h is above 0. At w = 1 it covers fully, and at w = 0 it never shows.

An earlier scout read this as "edges follow the terrain's relief". That is wrong: h is the layer texture's own height, not world elevation.

**Where the code goes.** Two repository rules apply:

- `packages/core/AGENTS.md`: "Anything a screenshot shows — materials, shaders, TSL … must never enter this package". The existing splat lives in core only because every value it applies comes from the game's table.
- PRD-493's Solution: "No new curve vocabulary goes into the package. A game that wants a different curve edits the returned material."

A height-blend formula is a curve, so it must not go into core. Today a game also cannot edit the curve, because the returned material exposes no per-layer weight. The mechanism core may own is therefore loading and stacking a fifth texture set (texture lifetime, as for ORM), plus one seam that hands each layer's weight and height to a game function. The formula itself ships as game source.

## Solution

1. **Height set (core, mechanism).** A table layer with `height: true` loads `<id>_h.jpg` as linear data. Same-size height maps stack into one array texture through the existing `stackLayers` path. The `TN_TERRAIN_SPLAT` marker counts the set, so a 16-layer package reports `samplers=5`. A table that names no `height` loads nothing more.
2. **Weight seam (core, mechanism).** `ILoadTerrainSplatOptions.layerWeight?: (weight, context) => Node<"float">`. `context` carries the layer, its height sample (or `undefined`), and its table index. The default is the identity, and with no seam the built node graph is the same as today. The seam returns a weight. It does not return a colour, so the package's mix chain stays as it is.
3. **The curve (game source).** `examples/prd493-terrain-splat/src/render/heightBlend.ts` implements the Unreal form above as an ordinary TSL function: `saturate((2w − 1) + h · k)`, where k is a game constant. The example passes it to `loadTerrainSplat`. Over-compositing needs no renormalisation, because each layer mixes over the result below it. The guide points games at this file.
4. **Recipe.** Both `export_world.py` copies write `<id>_h.jpg` for a table layer with `height: true`. They fail closed when the table names no height source, which matches the ORM rule.

**Risks:**

- **Sampler budget.** Five array sets plus an open-world shadow's maps must stay inside WebGPU's 16 sampled textures per stage. The marker reports the count.
- **Seam abuse.** A game could put a whole look into `layerWeight`. That is allowed: it is the game's code. Core still owns no constant.

## Acceptance Criteria

- [x] AC-1 [local]: A table without `height` and without `layerWeight` builds the same node graph and texture requests as before this PRD. proof: red-green `pnpm exec vitest run packages/core/__tests__/world-terrain-splat.spec.ts` — Evidence: 15/15 green. With the height filter reverted (every layer asks for `<id>_h.jpg`) 4 of 15 go red, among them the default-table case (`samplers=4 stacked=3`) and the sixteen-layer stacking case. Restored, 15/15 green.
- [x] AC-2 [local]: The example renders a stone layer over grass at mask weight 0.5. Its coverage inside the transition band follows the stone height map: pixels where h > 0 are stone, and the identity seam shows a plain 50 % mix. Judged on a capture, with the marker at `samplers=5`. proof: `node packages/playtest/dist/runner/cli.js examples/prd493-terrain-splat/playtests/terrain-splat.playtest.json --url <dev url> --browser-recipe webgpu` — Evidence: Intel `gen-12lp` (laptop real display, `--headed`), same orbit pose at tick 240, two runs per arm. Marker `TN_TERRAIN_SPLAT layers=16 samplers=5 stacked=4`. The height-blend arm exits 0 both runs. The `?heightBlend=off` arm exits 1 both runs, red on the new `heightBlend equals 1` assertion. Frame difference between the arms is 2207 pixels (0.24 %, max channel step 34), all on the two dark/pink band edges, identical in both runs. Close-up pose `?pose=close` (camera 3.3 m above the `layer-14`/`layer-15` gradient, low side sun, same pose in both arms, two runs per arm, NVIDIA `turing` named in `capture.json`, runs pixel-identical): fresh read-only judge on both runs, a 2x crop and the 4x difference image: **IMPROVEMENT** for run 1, run 2 and the crop. AFTER shows purple stone lobes and dark pockets interlocking across the join. BEFORE is a smooth even fade with a straight edge. The judge saw no banding, streaks or hard seam, and only one small olive highlight. The blend zone is a little darker and muddier than BEFORE. Judged NEUTRAL or worse first, and fixed before this verdict: (1) the orbit pose, judged "intended, weak, not visible at full frame", which counts as NEUTRAL; (2) a close-up over hard one-texel mask edges, NEUTRAL, because a band about 1 m wide gives the curve nothing to act on, so `make_world.py` now ramps each mask edge over 8 texels and keeps the lower layer under the ramp of the layer above it; (3) a close-up looking along the band, REGRESSION on a dark vertical line, far-field streaks and a green shift. The line is also in the BEFORE frames, so the blend does not cause it. The height maps were not tileable, so they now wrap whole cycles per tile. The close pose now looks across the band, so the far field is out of the frame. Rejected attempts, kept: the first pair (`layer-01`/`layer-02`) sat under later layers in this pose and gave pixel-identical frames, so the flag moved to `layer-14`/`layer-15`; the first curve, a centred `(h-0.5)*2`, broke "w = 1 covers" and was replaced by the unsigned-height form above.
- [x] AC-3 [local]: The example's `gpuMain` p95 with the height blend rises by no more than 0.3 ms over the same example without it, in 3 interleaved runs on a named adapter. proof: `node packages/playtest/dist/runner/cli.js perf` with `TN_FRAME_BUDGET` — Evidence: Intel `gen-12lp` on the laptop's real display (`--gpu`), 3 interleaved runs per arm of 120 s, arms `/` and `/?heightBlend=off`, window 1 discarded, 21 windows per run, 0 hitches, 59.88 fps in every run. GPU main-pass time per run (window median), blend on: p95 0.34, 0.42, 0.34 ms; blend off: p95 0.42, 0.34, 0.41 ms. Median over runs: p95 0.34 ms on against 0.41 ms off (rise -0.07 ms), mean 0.32 ms both, p50 0.33 ms both. The rise is under the 0.3 ms limit. The job measured the build before the mask ramp, which changes mask pixels only and adds no sample or shader work. CPU temperature and load were not recorded by that job, so the claim stands on the interleaved order and the equal means.

## Blocked on

- **Owner reading of PRD-493's "no new curve vocabulary" line.** RESOLVED 2026-10-09 by João: the weight seam is not new curve vocabulary. The curve stays in game source and core adds only the seam. Nothing is blocked.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Height texture set | A world package whose table marks `height: true`, loaded by `loadTerrainSplat` | New; same stacking path as ORM | AC-1, AC-2 |
| `layerWeight` seam | A game passes its TSL function to `loadTerrainSplat` | New; identity by default | AC-1, AC-2 |
| Height-blend curve | `examples/prd493-terrain-splat/src/render/heightBlend.ts`, referenced from the guide | Nothing; game source | AC-2, AC-3 |

## Execution Phases

#### Phase 1: Height set and seam in core
**Status:** DONE
**Files:** `packages/core/src/world-terrain-splat.ts`, `packages/core/__tests__/world-terrain-splat.spec.ts`, `packages/core/gpl/recipes/export_world.py`, `packages/blender-mcp/gpl/recipes/export_world.py`
**Verification:** AC-1 closes the default path.
- [x] A `height: true` layer requests `<id>_h.jpg`, the set stacks, and the marker counts it. proof: `pnpm exec vitest run packages/core/__tests__/world-terrain-splat.spec.ts` 15/15 pass; the stacking case asserts `samplers=5 stacked=4`. Green only — the seam did not exist before, so no earlier red run was possible.
- [x] The recipe writes `<id>_h.jpg` for a height layer and fails closed without a source. proof: red-green `pnpm exec vitest run packages/blender-mcp/__tests__/export-world.spec.ts -t terrain` — 2 red with the recipe reverted, 3/3 green with it.

#### Phase 2: The game's height blend
**Status:** DONE
**Files:** `examples/prd493-terrain-splat/src/render/heightBlend.ts` (new), `examples/prd493-terrain-splat/src/game.ts`, the example's package data, `examples/prd493-terrain-splat/playtests/terrain-splat.playtest.json`, `docs/guides/world-streaming.md`
**Verification:** AC-2 and AC-3 close this phase.
- [x] The example ships one height-blended layer pair and asserts `samplers=5`. proof: `pnpm --filter prd493-terrain-splat build` — exit 0. The pair is `layer-14`/`layer-15` (`height: true`), and both playtests assert `samplers lte 5`, `stacked equals 4` and `heightBlend equals 1`. The browser marker read `samplers=5 stacked=4`.
- [x] The guide shows the seam and names the example file as the reference curve. proof: `pnpm check:docs` — `Checked 2989 relative documentation links across 1331 Markdown files`, exit 0. Section "Terrain layers that blend by their own height" in `docs/guides/world-streaming.md`. Two stale `PRD-VQ-01` links in this batch's README and PRD-568 were repointed to `done/` to get there.

#### Phase 3: Native
**Status:** DONE
**Files:** `packages/runtime-native/conformance/scenes/shared/terrain-splat-array.js`, `packages/runtime-native/conformance/registry.json`
- [x] The `terrain-splat-array` row gains a height set and still matches the browser reference on desktop. proof: `pnpm parity --target desktop --only-tests terrain-splat-array` — row `pass`, `pixelMismatchRatio` 0 and `perceptualDeltaE` 0 against the web reference (0 pixels differ). Both ran on this machine's NVIDIA `turing` adapter, so the figure proves the same code path, not a cross-vendor match. The scene asserts `stacked === 4` and `samplers === 5`. The command exits 2 because the other 102 rows are reported blocked, as the registry rules require.
- [x] The same row on the Android emulator. proof: `pnpm parity --target android --only-tests terrain-splat-array --device emulator-5554` — row `pass`, mismatch 0, deltaE 0, no GPU validation errors, fresh install, APK bundle SHA verified. Emulator, not a phone. Built with `ORG_GRADLE_PROJECT_threenativeJsEngine=quickjs` and one `x86_64` slice, because the V8 payload in `third_party/v8-android` has no build receipt. The emulator renders through the host RTX 2080 GLES translator.

## Decisions

- **2026-10-09, João: the weight seam is not new curve vocabulary.** Core loads and stacks the height set and exposes `layerWeight`. The curve is game source (`examples/prd493-terrain-splat/src/render/heightBlend.ts`). Core owns no constant of it.
- **2026-10-09, curve form.** The shipped curve is `saturate((2w - 1) + h * k)` with unsigned h in 0..1 and k = 1. A centred height (`h - 0.5`) was tried first and rejected: it let a fully painted layer lose pixels, which breaks "w = 1 covers".
- **2026-10-09, example pair.** The height flag sits on `layer-14` and `layer-15`, the topmost bands of the example, because a lower pair is hidden by the layers above it and gives a pixel-identical frame.
