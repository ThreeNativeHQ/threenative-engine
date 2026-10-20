---
prd_contract: v1
---

# PRD-638 — A GI reference scene shows every Lumen behaviour, still and in motion

**Status:** NOT STARTED
**Priority:** P1 — no box is ticked: no Unreal frame tests colour bleed, light leaks, emissive light, a door or a light switch, so no GI PRD in this folder can prove a match.
**Complexity:** 5 (MEDIUM) — 1–5 implementation files in the PRD-631 harness and one visualize node in `packages/core` (+1), new state: a motion sequence per cell (+2), external tool: the headless Unreal editor (+1), native proof of one visualize mode (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-631](../look/PRD-631-an-unreal-reference-scene-measures-the-default-look.md) Phase 3 (the noise floor and the match thresholds). Every other PRD in [`gi/`](./) uses the cells, the motion series and the visualize modes of this PRD.

## Context

The PRD-631 scene has four poses: exterior, spheres, interior and backlit. The L7 row (GI) of that
ladder is the only GI evidence in the repo. It cannot isolate the separate GI behaviours:

- No pose has a strongly coloured wall beside a white one, so colour bleed is visible only as
  "the white sphere is a little warm". The sibling session reports that the red bleed onto the white
  sphere is faint, and no cell measures it alone.
- No pose has a dark room behind a thin wall. A leak shows only by accident: a warm leak of the
  emissive sphere onto the backlit wall appeared in commit `c0683da2c` and no gate caught it.
- No pose has a light that switches, a door that opens or an object that moves. Every PRD-631 cell
  is a still frame. Flicker, lag and smear do not show in a still frame.
- No ThreeNative visualize mode shows GI alone. The compare tool sees the sum of direct light, GI, AO,
  fog and post. A GI error and an exposure error look the same.

**Harness facts used here.** `pnpm unreal-look:capture --engine unreal|threenative` renders the cells
headless (`scripts/unreal-look/capture.ts`). Unreal runs `UnrealEditor-Cmd -ExecutePythonScript` with
`tools/unreal-reference/build_level.py`. ThreeNative scaffolds the starter and copies the overlay in
`scripts/unreal-look/scaffold/render/` over it. `pnpm unreal-look:compare` reports per-region
luminance quantiles and CIEDE2000 (`scripts/unreal-look/compare.ts`). The capture already scrapes
`TN_GI_CACHE`, `TN_SSGI`, `TN_PROBE_VOLUME` and `TN_RENDER_CHAIN` from the console.

### What Unreal does (UE 5.8.3, read 2026-10-20; clean-room summary, no code copied)

- **A fresh project runs Lumen at Epic.** Project creation sets `r.DynamicGlobalIlluminationMethod=1`
  and `r.ReflectionMethod=1` (UE 5.8.3: `Engine/Source/Editor/GameProjectGeneration/Private/GameProjectUtils.cpp`,
  `AddLumenConfigValues`). `sg.GlobalIlluminationQuality` defaults to 3, Epic
  (UE 5.8.3: `Engine/Source/Runtime/Engine/Private/Scalability.cpp`). Software tracing against the
  global distance field is the template default (UE 5.8.3: `Templates/TP_ThirdPersonBP/Config/DefaultEngine.ini`,
  `r.Lumen.TraceMeshSDFs=0`).
- **The quality level changes the algorithm, not only the ray count.** Low turns Lumen GI off,
  Medium uses the irradiance field gather and High, Epic and Cinematic use the screen probe gather
  (UE 5.8.3: `Engine/Config/BaseScalability.ini`, `[GlobalIlluminationQuality@0..4]`). A match at
  one level says nothing about the others, so this PRD captures three levels.
- **Lumen ships its own debug views.** `r.Lumen.Visualize` has 24 modes, among them Indirect
  lighting, Albedo, Emissive, Direct lighting updates and Indirect lighting updates
  (UE 5.8.3: `Engine/Source/Runtime/Engine/Private/LumenVisualizationData.cpp`,
  `Engine/Source/Runtime/Renderer/Private/Lumen/LumenVisualize.cpp`). `r.Lumen.Visualize.IndirectDiffuse`
  shows the indirect diffuse term alone. `r.Lumen.RadianceCache.Visualize` shows the probes.

## Solution

1. **One GI scene, five poses (Phase 1).** A second GLB, `tools/unreal-reference/gi/scene.glb`,
   built in Blender like the PRD-631 scene and under 1 MB. It holds:
   - a 5 × 4 × 3 m room with one red wall, one green wall, white floor and ceiling (colour bleed,
     multi-bounce, dark corners);
   - a 1.2 × 1.5 m window in the sunlit wall (sky and sun through an opening, the falloff into the
     room);
   - a door, 0.9 × 2.1 m, that the motion run opens;
   - a second room behind a 0.2 m wall, lit only through a door gap (the leak test);
   - a 1 × 0.1 m emissive strip (the neon) and a 5 cm bright emissive sphere (a tiny emitter);
   - a cluster of two-sided foliage cards and a glass pane outside the window.
   Poses: `cornell` (into the room), `window` (falloff from the opening), `neon`, `leak` (the dark
   room) and `foliage`. Suns: 60° and 15°. `--scene gi` selects it in both capture commands. Unreal
   renders each cell at GI quality Low, Medium and Epic (`sg.GlobalIlluminationQuality` 0, 1 and 3),
   and once more at Epic with `r.Lumen.Visualize.IndirectDiffuse 1`.
2. **Motion runs (Phase 2).** Four scripted runs on the GI scene, each 180 frames at a fixed step:
   a 90° camera pan in 2 s, the neon switched off and on, the door opened, and a 1 m box moved
   across the window. For each frame, both engines write the per-region scene-linear p50. The
   compare tool derives three numbers per region:
   - **flicker**: the frame-to-frame p50 change on a still camera after 60 settle frames;
   - **response**: frames until the p50 covers 90% of the change after a switch;
   - **overshoot**: the largest p50 above the settled value after a switch.
   Phase 2 first proves that the headless Unreal editor advances Lumen between captured frames. If it
   cannot, the decision goes under `## Decisions` and the motion compare uses the Unreal settled
   still as the end value and ThreeNative's own series for flicker and response.
3. **ThreeNative visualize modes (Phase 3).** `?giVisualize=` in the harness selects one mode. The
   names are Unreal's `r.Lumen.Visualize` mode names in camelCase, so an agent that knows Unreal
   finds them. Each mode is a node that the GI mechanism exposes, so a game can use the same mode:
   - `indirectDiffuse`: indirect diffuse only, the counterpart of `r.Lumen.Visualize.IndirectDiffuse`. The
     compare tool pairs it with the Unreal indirect-only cell. This isolates GI from exposure.
   - `ambientOcclusion`: the AO that reaches indirect light.
   - `radianceCache`: each probe as a dot. Valid probes show their irradiance, invalid probes show red and
     stale probes show green, as Unreal shows unallocated probes.
   - `indirectLightingUpdates`: the probes refreshed in this frame, the counterpart of mode 17.
   The modes read data that the GI PRDs create. A mode whose data does not exist yet reports
   `unavailable` in `TN_GI_VISUALIZE` and draws nothing. It never draws a fake picture.

**Where each part lives.** The scene, the poses and the motion scripts are harness tools under
`tools/unreal-reference/gi/` and `scripts/unreal-look/`. The debug nodes are mechanism beside the
GI code in `packages/core/src/render/`. The colours of the `radianceCache` mode are debug output, not game
appearance.

**Risks.** Unreal motion capture in a commandlet may not tick Lumen: Phase 2 tests this first. A
5 cm emitter at 1280 × 720 covers few pixels: the region mask grows it to the lit wall patch beside
it, which is what the test reads.

## Acceptance Criteria

- [ ] AC-1 [local]: One command produces every Unreal GI cell: 5 poses × 2 suns × 3 GI levels, plus 10 indirect-only cells, with the GI level of each cell read back from the log, not assumed. proof: `pnpm unreal-look:capture --engine unreal --scene gi --check-cvars` exit 0 and a cell count of 40 — Evidence: pending.
- [ ] AC-2 [local]: The same command produces the 30 ThreeNative cells and 10 `indirectDiffuse` cells on the owned engine (Wasm, WebGPU), engine named in the capture report. proof: `pnpm unreal-look:capture --engine threenative --scene gi` exit 0 and a cell count of 40 — Evidence: pending.
- [ ] AC-3 [local]: The motion compare reports flicker, response and overshoot for all four runs on both engines, and fails closed on a missing frame, a frame-count mismatch and an empty region. proof: `pnpm unreal-look:compare --scene gi --metric motion`, plus the fail-closed cases in `scripts/__tests__/unreal-look-compare.spec.ts` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| GI scene and poses | `pnpm unreal-look:capture --scene gi` → `tools/unreal-reference/gi/` | New, beside the PRD-631 scene | AC-1, AC-2 |
| Motion series and metrics | `pnpm unreal-look:compare --metric motion` | New metric in `compare.ts` | AC-3 |
| GI visualize modes | `?giVisualize=` in the harness; any game through `GIVisualize` | New. Reported in `TN_GI_VISUALIZE` | Phase 3 |

## Execution Phases

#### Phase 1: The GI scene in both engines
**Status:** NOT STARTED
**Files:** `tools/unreal-reference/gi/{scene.glb,poses.json,regions.json}` (new), `tools/unreal-reference/build_level.py`, `scripts/unreal-look/capture.ts`, `scripts/unreal-look/capture-threenative.ts`
- [ ] The Unreal-versus-Unreal noise floor of the GI scene is recorded under `## Decisions`. proof: `pnpm unreal-look:compare --scene gi --unreal-vs-unreal`.

#### Phase 2: Motion runs
**Status:** NOT STARTED
**Files:** `tools/unreal-reference/gi/motion.json` (new), `scripts/unreal-look/capture.ts`, `scripts/unreal-look/compare.ts`, `scripts/__tests__/unreal-look-compare.spec.ts`
- [ ] Whether the headless editor advances Lumen between frames is measured (the neon run must show a response over more than 1 frame) and the result is recorded under `## Decisions`. proof: `pnpm unreal-look:capture --engine unreal --scene gi --motion neon`.

#### Phase 3: Visualize modes
**Status:** NOT STARTED
**Files:** `packages/core/src/render/gi-visualize.ts` (new, exports `GIVisualize`), `packages/core/src/index.ts`, `packages/engine-mcp/__tests__/search.spec.ts`, `scripts/unreal-look/scaffold/render/worldEnvironment.ts`, `packages/runtime-native/conformance/scenes/shared/gi-visualize-indirect.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] The `indirectDiffuse` mode compare runs for L7 on the reference scene and the GI scene, and its report is the first row of the GI gap list in this PRD. proof: `pnpm unreal-look:compare --scene gi --layer L7 --visualize indirectDiffuse`.
- [ ] The `radianceCache` mode on the `leak` pose counts the same invalid probes as `TN_PROBE_VOLUME`. proof: a harness playtest assertion on `TN_GI_VISUALIZE.invalid == TN_PROBE_VOLUME.invalid`.
- [ ] A capability search for "lumen visualize indirect lighting" returns `GIVisualize`: its manifest entry carries `@alias lumen visualize` and the Unreal mode names. proof: `pnpm exec vitest run packages/engine-mcp/__tests__/search.spec.ts`.
- [ ] The `indirectDiffuse` mode renders on the native desktop host within tolerance of the browser. proof: `pnpm parity --target desktop --only-tests gi-visualize-indirect`.
