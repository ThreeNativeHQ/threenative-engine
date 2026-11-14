# PRD-806 — Fix the medium and low findings of the PR #483 epic review

**Status:** DONE 2026-11-09 on PR #635 — every medium and low finding is fixed or rejected with its reason. Scope: the 14 medium findings (13 after one duplicate) and 45 low findings verified on HEAD `21c713b7d` on 2026-11-05. The high findings are in [PRD-805](PRD-805-epic-review-findings.md).
**Priority:** P2 — each open finding below is a real defect, and none makes the board red at HEAD
**Complexity:** 5 (MEDIUM); many small fixes in independent files
**Owner:** ThreeNative maintainers

## Problem

The per-finding facts, the cited `file:line` and a one-line fix sketch are in [the evidence file](../../../packages/terrain/docs/PRDs/strata-refactoring/PRD-805-epic-review-findings.evidence.md). The verifier was a DeepSeek arm, so read each cited line before you fix it. Each fix gets a red-green spec. A fix that changes what reaches the screen (E46, E56, E73) also needs the visual judge.

## Execution Phases

#### Phase 1: Engine and asset pipeline

- [x] E09 and E11 `packages/assets/src/compile.ts`: the pre-scan fails odd GLBs even with `models: "none"` (:339), and the terrain-world cache key ignores `PIPELINE_VERSION` (:584). proof: red-green specs in `packages/assets/__tests__/` — FIXED 2026-11-05: E09 in `32bcc9244`, E11 in `f6bd216f6` (DeepSeek arm, reviewed; red at `b1e89ac2a`, green after). `packages/assets/__tests__` 55 files, 868 tests pass.
- [x] E46 `packages/assets/src/lod/generate.ts:982`: scaled far cards clamp at the quantized POSITION bounds. proof: a red-green spec in `packages/assets/__tests__/` — FIXED 2026-11-07 on PR #635 (`5ba984939`, from `c2a06bdfc`): `card-copies-quantized.spec.ts` 1 failed without the fix, passes with it. The forest golden `world.glb` hash moves with it (`9000247e1`); the 25 MiB budget holds. Visual judge (headed WebGPU, RTX 2080, upstream three build, 2 runs per arm, 5 worlds): NEUTRAL, no visible change at the capture poses; the alpine shadow difference is run-to-run flake (see E73).
- [x] E49 `packages/runtime-native/src/engine/scene/texture.h:138`: a Texture copy copies its listeners. proof: a red-green case in the engine texture test — FIXED (`7d9510f88`, carried into PR #635). 2026-11-09, engine-only V8 player build (`-DTN_ENGINE_ONLY=ON -DTN_ENGINE_PLAYER=ON -DMYSTRAL_USE_V8=ON`): `tn-native-engine-v8-textures-test clone_listeners` FAILS with the copy constructor defaulted (`v8_textures_test.cpp:135` `clone->languageListeners == nullptr`, `:137` `fired == 1`) and PASSES with the fix; `half_float` passes.
- [x] E73 `packages/runtime-native/src/engine/renderer/renderer.cpp:4999`: the custom MRT slot of a `depthWrite=false` draw is not written at 1x. proof: a red-green case in the engine renderer test — FIXED 2026-11-08 on PR #635 (`8c1c9695d`): native `attachment-mask` 3/3, `pnpm wasm:build` 0; owned-engine judge (`TN_ENGINE=threenative`, headed WebGPU, RTX 2080, 2 runs per arm, 5 worlds × 4 poses) NEUTRAL, no lost shadow, halo or colour shift.
  History: the fix is on PR #635 (`460f9e5a4`; reverted in `d55471289` and restored in `8c1c9695d`). The Wasm build compiles it (`pnpm wasm:build` exit 0), and the native `attachment-mask` test passes 3/3. The first judge called the alpine boulder shadows lost and blamed E73. That was wrong: the preview's `build` ships upstream three unless `TN_ENGINE=threenative` is set (`examples/strata-terrain-preview/vite.config.ts:129`), so those frames never ran the C++ engine. Two more runs of one unchanged build showed the long boulder shadows in one run and not in the other: the shadow presence at the capture pose is run-to-run flake.

#### Phase 2: Game, editor and scripts

- [x] E17 and E29 (Strata example): a prop restream cancels the in-flight terrain update (`src/render/editorView.ts:251`), and the status line lost `role=status` and `aria-live` (`src/render/selection.ts:57`). proof: red-green specs in `examples/strata-terrain-preview/__tests__/` — E17 FIXED 2026-11-05 in `32829237d` (DeepSeek arm, reviewed; red at `b1e89ac2a`, green after): the drag restream and the terrain update now supersede only their own lane. E29 NOT-REAL: the epic moved every announcement into the single `#editor-announcements` live region on purpose, so the status line needs no own live region.
- [x] E39, E40 and E41 (terrain editor): the ortho extent subtracts `target[0]` from every axis (`cameras.ts:185`), the picker shows `assets[0]` but scatter paints `"pine"` (`tools.ts:112`), and the CSS ids do not match the camera rows (`cameras.ts:158`). proof: red-green specs in `packages/terrain/__tests__/` — FIXED 2026-11-05: E39 in `5b2d7cfdb`, E40 in `1695544a6`, E41 in `5ab0ba340` (DeepSeek arm, reviewed; red at `b1e89ac2a`, green after).
- [x] E52 and E59 (one finding) `scripts/ci-runner-admission.mjs:82`: rain goes to the GPU runner but is admitted as a CPU slot. proof: a red-green spec in `scripts/__tests__/` — FIXED 2026-11-05 in `6c526a522` (DeepSeek arm, reviewed; red at `b1e89ac2a`, green after). The `ci-*` script specs pass: 24 files, 838 tests.
- [x] E56 and E62 (terrain package): `bendCrownNormals` is not idempotent (`starter/forest/world.ts:154`), and the matrix pins 35 empty worlds as success (`__tests__/terrain-mcp.spec.ts:1173`). proof: `pnpm exec vitest run packages/terrain/__tests__/`
  Open: E56 FIXED 2026-11-07 on PR #635 (`b8f6c9db0`): `forest-crown-normals.spec.ts` 1 failed without the fix, passes with it; the five preview worlds judge NEUTRAL (upstream three build). E62 is on PR #635 (`b41bfaa61`) and `packages/terrain/__tests__/` passes 531/531, but it changes what a landform cook draws (firs on forest and coastal presets), so it needed a judge on an MCP-cooked world.
  E62 judge, 2026-11-09: `scripts/verify-forest-playtest.ts --target web` with `terrain_generate {kit: "forest", landform: "rollingHills"}`, spawn pose, two runs per arm, headed WebGPU nvidia/turing. First verdict REGRESSION (`prd-806/e62-spawn.jpg` on `pr635-screenshots`): firs grew through the spawn pad and inside the arena walls, because a preset's foliage had no keep-out (the kit worlds stay clear only through their own terrain). Fixed in `20fd01f7c`: each landform foliage rule clears a 23 m circle at the world centre, the starter arena's half-diagonal plus a fir crown; `terrain-mcp.spec.ts` `cooks 'rollingHills' under 'forest'|'coastal'` fail without it (nearest tree 3.3 m) and pass with it, `packages/terrain` 605/605. Rejudge IMPROVEMENT (`prd-806/e62-spawn-fixed.jpg`): a fir stand around the arena, none on the pad, floor or walls; the play area meters about 10 % brighter under the canopy, still readable. Judge notes, not regressions: sparkle on near fir branches, uniform trunk lean, a bare floor under the stand.

#### Phase 3: The 45 low findings

- [x] Fix or reject each REAL low finding in the evidence file, with the reason beside each rejection. proof: one line per finding in this box
  2026-11-09: 44 fixed, 1 rejected.
  - E01 FIXED in the EPIC squash `972d1e371`: fix(core): assert the concurrent spawn waiters clear their deadlines.
  - E02 FIXED in the EPIC squash `972d1e371`: fix(strata-terrain-preview): a failed horizon fetch no longer poisons every later world load.
  - E03 FIXED in the EPIC squash `972d1e371`: fix(strata-terrain-preview): the kit proof empties a reused artifact directory again.
  - E05 FIXED in the EPIC squash `972d1e371`: fix(strata-terrain-preview): the swimmer enters the sea the world draws.
  - E06 FIXED in the EPIC squash `972d1e371`: fix(strata-example): name the wildwood stage arm in the comments that list the arms.
  - E07 FIXED in the EPIC squash `972d1e371`: fix(wasm-engine-boot): the normal-node scenario fails a run that fell back to the geometric normal.
  - E13 FIXED in the EPIC squash `972d1e371`: fix(strata-terrain-preview): run the shared water regressions from the test lane.
  - E14 FIXED in the EPIC squash `972d1e371`: fix(strata-terrain-preview): drop the forest skip flag whose false arms its own throw made unreachable.
  - E15 FIXED in the EPIC squash `972d1e371`: fix(core): restore the frame-buffer texture name only once, after overlapping compiles.
  - E16 FIXED in the EPIC squash `972d1e371`: fix(core): the dither-partition test reads the mask instead of plain JS numbers.
  - E18 FIXED in the EPIC squash `972d1e371`: fix(strata-terrain-preview): name ?farForest=on as the override the flag actually reads.
  - E19 FIXED in the EPIC squash `972d1e371`: fix(strata-terrain-preview): delete the ?massif=before knob and the survey it swapped in.
  - E22 FIXED in the EPIC squash `972d1e371`: fix(create-threenative): stop the terrain-kit symlink walk at the first existing folder.
  - E23 FIXED in the EPIC squash `972d1e371`: fix(core): make the bundle row-cap test really cross 1,024 rows.
  - E24 FIXED in the EPIC squash `972d1e371`: fix(core): exercise the depth-buffer width check without a resize event.
  - E25 FIXED in the EPIC squash `972d1e371`: fix(core): endFrame's doc says a hitch still returns its split.
  - E26 FIXED in the EPIC squash `972d1e371`: fix(core): scale a zero-area kept card about its own centre.
  - E27 FIXED in the EPIC squash `972d1e371`: fix(playtest): a worker relaunch no longer reports the discarded attempt's cpu profile.
  - E28 FIXED in the EPIC squash `972d1e371`: fix(strata-terrain-preview): sway()'s doc says the shadow casts the rest pose, and why.
  - E30 FIXED in the EPIC squash `972d1e371`: fix(strata-terrain-preview): delete the ?peaks and ?meadowBase A/B knobs.
  - E31 FIXED in the EPIC squash `972d1e371`: fix(engine-mcp): drop a stop word's inflections too, not just the word.
  - E32 FIXED in the EPIC squash `972d1e371`: fix(physics): a forced trunk gets a positive capsule radius.
  - E33 FIXED in the EPIC squash `972d1e371`: fix(strata): the spruce terminal minimum is taken by the loader, and the gate test drives it.
  - E34 FIXED in the EPIC squash `972d1e371`: fix(strata-terrain-preview): bound each invalidated shadow region by the instance's own span.
  - E35 FIXED in the EPIC squash `972d1e371`: fix(strata-terrain-preview): river rocks must sit on the river's bank, not just be counted.
  - E37 FIXED in the EPIC squash `972d1e371`: fix(core): size the chunk shadow proxy index pool from the shadow ladder.
  - E38 FIXED in the EPIC squash `972d1e371`: fix(core): keep a file URL's triple slash when resolving terrain splat layer maps.
  - E42 FIXED in the EPIC squash `972d1e371`: fix(runtime-native): a missing MRT slot refuses one read instead of killing the web host.
  - E43 FIXED in the EPIC squash `972d1e371`: fix(native): state the parity bound the first-frame shadow row enforces.
  - E45 FIXED in the EPIC squash `972d1e371`: fix(terrain): a 409 rebase the external writer already landed settles instead of rejecting.
  - E47 FIXED in the EPIC squash `972d1e371`: fix(assets): report a GLB with no JSON chunk where the container shows it.
  - E50 FIXED in the EPIC squash `972d1e371`: fix(terrain): wait for the export cook to start instead of a fixed sleep.
  - E53 FIXED in the EPIC squash `972d1e371`: fix(three-native): release an object-valued uniform with the value it reads.
  - E54 FIXED in the EPIC squash `972d1e371`: fix(terrain): let the example guard see path-string reads, not only imports.
  - E55 FIXED in the EPIC squash `972d1e371`: fix(terrain): describe the placement record as position, quaternion and scale.
  - E58 FIXED in the EPIC squash `972d1e371`: fix(native-renderer): a mirror's pass is reused only while its reflector lives.
  - E60 FIXED in the EPIC squash `972d1e371`: fix(scripts): describe terrain peers as shipped or external.
  - E61 FIXED in the EPIC squash `972d1e371`: fix(scripts): resolve the terrain reply only on a newline-terminated line.
  - E63 FIXED in the EPIC squash `972d1e371`: fix(terrain): cook both AC-3 arms as tool calls in a fresh process.
  - E65 FIXED in the EPIC squash `972d1e371`: fix(scripts): the startup gate compares Three patch digests and records the arm's own patch.
  - E66 FIXED in the EPIC squash `972d1e371`: fix(terrain): the cook reports the water it floods, not the rows it was asked for.
  - E74 FIXED in the EPIC squash `972d1e371`: fix(native-renderer): accept a legal eight-attachment aux pass.
  - E75 FIXED in the EPIC squash `972d1e371`: fix(native-renderer): a volume texture carries the usage a texture copy reads.
  - E57 FIXED 2026-11-09 on PR #635 (`feaf012c6`): alpine, desert and tundra set `lighting.lods: true`, so the `boulder-mid.glb` each bakes at 35 m is sky-dressed; coastal bakes no mid level and keeps `false`. `kit-runtime.spec.ts` "dresses the mid level its own assets.json bakes": 3 failed without the fix, 5 passed with it; `packages/terrain/__tests__/` 605/605. Visual judge, 2026-11-09: `KIT=alpine pnpm test:kit` at `feaf012c6^` and `2c9262966`, two runs per arm, headed WebGPU nvidia/turing, sheets `prd-806/e57-{boulders,ground,edge}.jpg` on `pr635-screenshots`: a fresh judge returns NEUTRAL on all three frames, no regression (arm RMSE 0.0010 against run noise 0.0026-0.0035 on `boulders`). It also says the frames do not show the gain: the one far boulder in view draws the same in both arms, so these poses prove no regression, not the sky on the mid level.
  - E68 REJECTED: an explicit `kit` over a `biome` argument is the pinned contract (`terrain-mcp.spec.ts:1060` "keeps kit as the explicit override over a biome name"), and a request word that loses to an argument is reported as `decided.biome.source: "argument"` (`tools.ts:474`). A guard that threw on the conflict broke that pinned spec, so it was reverted.

## Acceptance Criteria

- [x] AC-1: `pnpm typecheck` and `pnpm lint` exit 0 after the fixes. proof: command output in the box — 2026-11-09: local `pnpm typecheck` exit 0 at `3817a9529` and `pnpm lint` exit 0 at `ecebc2fe5`; CI run 42609379659 on `2c9262966` (after every fix, E57 included): `typecheck` success, `lint` success, `ci-required` success.
