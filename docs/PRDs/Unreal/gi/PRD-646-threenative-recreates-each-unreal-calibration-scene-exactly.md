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

- [x] AC-1 [local]: `cornell` and `sunlit-room` load on the owned engine with region-ID edges within 1 px of Unreal's, engine and adapter named in the capture report. proof: `pnpm unreal-look:capture --engine threenative --scene gi:cornell,gi:sunlit-room --layers ID` and `pnpm unreal-look:compare --sameness --scene gi:cornell,gi:sunlit-room` (the sameness gate: IoU is reported, the verdict is the edge distance) — Evidence: at the merged epic head, `cornell` (12 objects in 2 poses) and `sunlit-room` (40 objects in 6 poses) have 0 px beyond 1 px on every object and a farthest edge of 1 px; `neon-corridor`, which arrived later, scores 16 objects in 2 poses the same way (against its committed Unreal frames). The capture report (`gi-capture.json`) names the engine `threenative` and the adapter `nvidia`, `turing` (the RTX 2080). Before the `cornell` fix, four of its objects had 1012 px beyond 1 px (judge: IMPROVEMENT, AFTER matches UNREAL). Proof comment with the tables, sheets and judge verdict: https://github.com/ThreeNativeHQ/threenative-engine/pull/541#issuecomment-6327109477
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
- [x] `cornell` region-ID edges agree within 1 px, and its unsupported properties are listed under `## Decisions` with the PRD that owns each one. proof: the AC-1 commands for `gi:cornell` — `pnpm unreal-look:compare --sameness --scene gi:cornell`: 12 objects in 2 poses, 0 px beyond 1 px, farthest edge 1 px (Phase 1b); `pnpm unreal-look:capture --engine threenative --scene gi:cornell --layers L1` reports one unsupported property, `Lamp.sourceRadiusM` (see Decisions). Proof comment with the tables, sheets and judge verdict: https://github.com/ThreeNativeHQ/threenative-engine/pull/541#issuecomment-6327109477

#### Phase 1b: Both engines draw the same scene (the sameness gate)
**Status:** PARTIAL — the gate runs on every scene. `cornell`, `sunlit-room`, `neon-corridor`, `penumbra-lab`, `lamp-room` and the reference scene pass. The first procedural `foliage` scene fails, and the real-model `wildwood` scene replaces it.
**Files:** `scripts/unreal-look/sameness.ts` (new), `scripts/unreal-look/depth-ties.ts` (new), `scripts/unreal-look/compare.ts`, `scripts/unreal-look/capture-threenative.ts`, `scripts/__tests__/unreal-look-sameness.spec.ts` (new), `tools/unreal-reference/sameness-sheet.py` (new), `tools/unreal-reference/gi/cornell/scene.py`, `scene.json`, `scene.glb`
- [x] A gate scores every object of every pose from the ID frames both engines already capture, and fails closed on a missing frame, a missing object, two frame sizes and a pose with no object. proof: `pnpm exec vitest run scripts/__tests__/unreal-look-sameness.spec.ts` — 53 tests pass; `pnpm unreal-look:compare --sameness` scores 169 objects in 31 poses of 7 scenes (the reference scene, `cornell`, `sunlit-room`, `neon-corridor`, `penumbra-lab`, `lamp-room`, `foliage`) in about 2 minutes. Proof comment with the tables, sheets and judge verdict: https://github.com/ThreeNativeHQ/threenative-engine/pull/541#issuecomment-6327109477
- [x] The ThreeNative ID frame is single-sampled, as Unreal's is, so a blended edge pixel can no longer read as a third object. proof: `pnpm unreal-look:capture --engine threenative --scene gi --layers ID` — the cornell `Shade` ghost (372 px) and the `Box_Short` ghost (193 px) are gone, and the `sunlit-room` slivers of `Back_Right`, `Hall_Back` and `Front_Sill` (80, 465 and 428 px) with them. Proof comment with the tables, sheets and judge verdict: https://github.com/ThreeNativeHQ/threenative-engine/pull/541#issuecomment-6327109477
- [x] Every pose of `sunlit-room`, `penumbra-lab` and `lamp-room` passes the gate. proof: `pnpm unreal-look:compare --sameness --scene gi:sunlit-room,shadow:penumbra-lab,shadow:lamp-room --captures <root>` — 99 objects in 19 poses, 0 poses fail, 0 px beyond 1 px on every object, farthest edge 1 px (`sunlit-room/sun60-window/Wall_Left`); frames captured 2026-10-21 on the RTX 2080 (`adapter` nvidia turing), ThreeNative single-sampled. Proof comment with the tables, sheets and judge verdict: https://github.com/ThreeNativeHQ/threenative-engine/pull/541#issuecomment-6327109477
- [x] The four corner squares of the `cornell` floor, ceiling and walls are drawn by both engines in the same order. proof: `pnpm unreal-look:compare --sameness --scene gi:cornell --captures <root>` — BEFORE: `Floor`, `Ceiling`, `Wall_Red` and `Wall_Green` each had 1012 px beyond 1 px, farthest 23 px, IoU 0.9771 to 0.9835. AFTER: 12 objects in 2 poses, 0 px beyond 1 px on every object, farthest edge 1 px, IoU at least 0.9967. Cause: `scene.py` made both side walls 5.9 m tall, so their front faces at z = 0 overlapped the front faces of the floor and the ceiling in four 0.2 m squares; Unreal drew the floor, ThreeNative the wall. Fix: the walls are 5.5 m tall, so the four front faces meet along an edge (`scene.py`, `scene.json` and `scene.glb` re-exported by the editor). The Unreal `ID` frames were recaptured from the rebuilt level and the ThreeNative frames from the new `scene.glb`. Proof comment with the tables, sheets and judge verdict: https://github.com/ThreeNativeHQ/threenative-engine/pull/541#issuecomment-6327109477
- [ ] The real-model vegetation scene (`shadow:wildwood`, Fab GLBs, built by the wildwood lane) passes the gate, and the procedural `shadow:foliage` scene it replaces is retired. proof: `pnpm unreal-look:compare --sameness --scene shadow:wildwood`.

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

## Decisions

- **2026-10-21, scenes lane, after the owner said "just make sure both wasm/unreal scenes are the same!":** the sameness gate is `pnpm unreal-look:compare --sameness`. It reads the ID frames that `pnpm unreal-look:capture --layers ID` already writes for both engines (`--captures <root>`, default `tools/unreal-reference/captures`). It adds no second capture path.
- **The ID layer is single-sampled in ThreeNative.** Unreal draws its ID frames aliased. A multisampled ThreeNative edge blends two region colours, and some pairs blend into the colour of a third region. Measured on `cornell`: the lamp shade read 372 px of the green wall's edge, and a box out of view read 193 px of the red wall and floor. `capture-threenative.ts` turns `antialias` off for `?layer=ID` and `?tnRef=ID`.
- **The verdict is an edge distance. IoU is reported.** IoU depends on the size of the object. Measured on 153 objects in 29 poses: a correct 45 px sphere scores 0.91 to 0.97, because its edge differs by under one pixel. A real defect, four 22 px corners of a 57000 px floor, scores 0.977. No flat IoU threshold separates them. The gate counts the pixels of an object that lie more than 1 px (AC-1) from the other engine's drawing of it, and passes an object with at most 10. Measured with the two rules below: at most 3 on every one of the 159 objects that pass in 31 poses (the reference spheres pose has 3 on a sphere at a grazing contact with the floor); 1012 on the `cornell` corners before the fix and 0 after; 0 on `neon-corridor`; 148 to 3423 on the first `foliage` scene, and 0 once its cut-out cards keep only the alpha of their texture. A frame passes with at most 2% of its pixels in a colour that is no ID (measured: none, except the foliage cards at 0.35% to 0.58%).
- **A feature thinner than three pixels is counted apart (`thin`).** Each edge may sit one pixel off (AC-1), so a feature of one or two pixels can close or open by itself, and no edge distance pins it down. The gate counts the pixels beyond 1 px in a feature thinner than three pixels (not in a 3 x 3 block the object fills) in `thin`, outside the verdict, and still shows the number. An object with no body at all in a frame (a wire) is scored on every pixel. Found on the first `foliage` scene with the cut-out cards fixed (below): the cut-out edges of Unreal and ThreeNative differ by one pixel, which leaves 1 px cracks between blades and leaf tips. The wall around them read 49 to 95 px beyond 1 px (`Floor`) and `Leaves` 19, all in features of one pixel. Moving a thick feature still fails: the `cornell` corners (16 px squares) stay at 1012 and the specs fail a 3 px crack. The blind spot is a feature thinner than three pixels that is misplaced: only its presence is checked, so a pose must show an object at three pixels or more.
- **A pixel the other engine draws with no ID colour counts as `lost`.** The edge distance scores only the pixels that both frames give an object colour, and the thin rule then let the first `foliage` scene pass with its tinted cut-out cards: the dark edge pixels left the two masks agreeing, and the cards read 0.35% to 0.58% of the frame, under the 2% frame limit. The gate now counts, per object, its pixels that the other engine draws in a colour that is no ID, and adds them to `far` in the verdict. Measured: 0 to 3 on the passing objects; 1134 to 3423 on the tinted `Leaves` and `Grass`, 148 to 219 on the `Floor` around them; 0 after the fix. The specs fail a card with a darkened thin ring (76 px) whose thick features did not move.
- **Cause of the first `foliage` mismatch, proved (2026-10-21).** The ID material of a cut-out card kept the texture as a `map`, so the sampled texture colour multiplied the ID colour. The card PNGs are pure white, so the darkening comes from filtering at the cut-out edge. The loader of the wildwood lane (PRD-651) takes only the texture's alpha. Captured on the same four poses with that loader (`CalibrationScene.ts.in`, applied for the capture only, not committed here): `Leaves` 56966 px against Unreal's 57001 (53711 before), `Grass` 7045 against 6977 (4991 before), 0 `lost` pixels, 0 px beyond 1 px on all 18 objects, farthest edge 1 px, so the gate passes. The remaining differences are 1 px cracks and leaf tips (`thin`).
- **Ground truth for a silhouette.** The gate was checked against a rasterization of the triangles of `scene-id.glb` at pixel centres. Unreal's spheres are 1.1% too large in that count and ThreeNative's 3.7% too small, which is under one pixel at the radius of a 45 px sphere. Both are inside the one-pixel edge of AC-1, so neither engine is changed for it.
- **Why `cornell` differed, and the rule it leaves.** Two slabs that share a face in one plane, look the same way and overlap leave a depth tie, and each engine settles it its own way. In `cornell` the side walls (5.9 m) and the floor and ceiling ended at the same open front, so four 0.2 m squares were a tie: Unreal drew the floor, ThreeNative the wall. The scene is data, so it is fixed in `scene.py` (walls 5.5 m, no overlap), never in an engine. `depth-ties.ts` finds such ties from `scene.json` alone, and the gate prints them under a failing scene as `possible cause`. The old `cornell` data reports the four ties and the new data none (specs in `unreal-look-sameness.spec.ts`).
- **Latent ties that pass.** `lamp-room` keeps four 0.1 m ties at its open front (`Floor` and `Ceiling` against `Wall_L` and `Wall_R`, seen from the `spot`, `spot-soft` and `point` poses). The gate measures 0 px beyond 1 px there, so the scene and the Unreal frames that other lanes tuned against stay as they are. A new scene must not add one, and `depth-ties.ts` names it when a pose fails.
- **Rebuilt Unreal frames move by seam pixels.** The recaptured Unreal `cornell` ID frame differs from the first by 255 px, all on the diagonal seams between the green wall and the floor and ceiling (a tie at an edge, one pixel wide). Recapture the Unreal frames whenever `scene.json` changes, and read a seam pixel as within the 1 px of AC-1.
- **`cornell` unsupported properties (2026-10-21).** The lit capture (`TN_CALIBRATION_SCENE` in the capture log and `gi-capture.json`) reports one: `Lamp.sourceRadiusM`. ThreeNative's point light has no area, so the highlight of the lamp stays hard. The loader names PRD-634 for it. The shadow of the lamp does follow the radius, which PRD-650 owns. Every other `scene.json` property of `cornell` reaches ThreeNative: the box sizes and places and the three materials (through `scene.glb`), the lamp's place, intensity, units, attenuation radius, colour and shadow flag, and the fixed exposure. The two lamp flags the loader does not read (`useTemperature` false, `inverseSquaredFalloff` true) equal what it uses (white, decay 2). A mesh or a light class the loader does not know fails the load (`TN_CALIBRATION_SCENE_UNMAPPED`, `TN_CALIBRATION_SCENE_LIGHT`).
- **The gate runs without the editor for a scene with committed frames.** When the capture root holds no Unreal capture of a scene, the gate reads the committed Unreal ID frames of it (`<scene>/id/<pose>.png`, written by `compare --write-stats`), as the GI compare does (PRD-638 AC-2). `sunlit-room`, `cornell` and `neon-corridor` have them, so the AC-1 proof needs ThreeNative captures only, and the report says whose Unreal frames it used. The `cornell` ID frames were refreshed from the rebuilt level. `reference-stats.json` was left as the GI lane measured it: its lit frames differ from the new level only along the seams of the corner squares, and the file holds no mask size that the compare checks.
