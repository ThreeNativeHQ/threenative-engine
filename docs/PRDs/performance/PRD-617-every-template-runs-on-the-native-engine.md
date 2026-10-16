# PRD-617 — Every template runs on the native engine

**Status:** IN PROGRESS
**Priority:** P0 — the owner blocks the v1 release until AC-1 to AC-7 pass (Decisions, 2026-10-15); 11 of 13 templates, the starter among them, still pin `engine: "legacy"`.
**Complexity:** 4 (MEDIUM)
**Owner:** João
**Depends on:** PRD-573 (PR #493 carries this work: native default, the `legacy` pins, the pin ratchet test, the CI engine artifact builds)

Recovery snapshots integrated into PR #493; publish-state tests: 46 passed. Runtime matrix and visual proof remain pending; no acceptance criteria are newly verified.

2026-10-15 reviewer input defect: the V8 player's playtest mailbox treated DOM `buttons` as
`button + 1`, misidentifying right/middle presses and every release. The pending fix tracks the
previous mouse mask and maps its changed bit to DOM `button`, preserving chord transitions and
touch contacts. `player-ui-input.mjs` now asserts actual canvas callbacks for right/middle
presses/releases, chords, unchanged/ambiguous masks and two touch contacts. Script syntax and
diff checks pass; Biome excludes this fixture. Runtime red reproduced against the existing
UI-enabled player SHA256 `43c490665a420539274469b9c050ae5ca1a51d4499f5c054fcbe362aa8a63d1f`:
right press reported button 1 instead of 2, middle press 3 instead of 1, releases 0 instead of
the released button (`/tmp/pr493-pointer-red.log`, exit 1). The shipped capture lock was held
and released. The same mailbox callback regression passed on rebuilt player SHA256
`ab5cbcc17223906fcacd70b4e9dd5b20e5331c2e0f31ab22ec7cf982ae881bdd`
(`/tmp/pr493-pointer-compute-green.log`); separate CTest results were real-input UI and compute
passed, compute-ops failed on duplicate sprite storage declarations. The UI-overlay presentation
test failed once at blue share 0 despite receiving its click intent, then passed unchanged on a
diagnostic rerun; its asynchronous presentation race remains under investigation.
No AC is ticked by this note.

2026-10-15 current-consumer replay: starter and snow web/desktop builds and installed/package artifact comparisons passed (player `5e40a3d5363c`, Wasm `490bfaa43d73`). Starter web movement passed; play failed frame-time P95 at 38.4 ms against 33 ms with no console errors. Production-readiness reached scene teardown and failed because native storage attributes lack `dispose()`. Snow web footsteps reached particle culling and failed because the Camera facade omitted its live projection conventions. These are engine issues; no game workaround or performance threshold change was made. Camera bindings now pass native ABI culling tests and rebuilds; a guarded Snow desktop survives replay passes all three assertions on rebuilt player `df34fb682d6d` with its unchanged game bundle. Fresh consumer-package/web replay, lifecycle repair and remaining qualification are pending. No acceptance box is newly verified.

2026-10-15 BufferAttribute synchronization: Snow's measured renderError (0.1227) came from native setters updating the engine while needsUpdate uploaded an older JS array. The facade now copies each setter's changed raw range back into the same JS array; retained game edits survive, copyAt synchronizes its source item, and bulk transforms synchronize their affected attributes. The private view API reuses the existing ABI, preserves scalar types, validates finite integer ranges, and retains exact-length validation for full writes. Repeated setters copy changed elements rather than the whole buffer (linear-cost regression). Verification: 203 unit tests, package typecheck, Biome and 31 document checks pass. Real ABI range/geometry checks pass in build/wasm; browser_gc passes. The complete browser_backend smoke still fails at "Fn returns cached graph built once at definition", reproduced with unchanged HEAD source and smoke test. That failure remains pending; it is not a green smoke gate. Fresh packaged starter/Snow replays, visual judgment and paired CPU measurements remain unverified. No acceptance box is ticked.


## Context

On 2026-10-15 the owner made the native C++ engine the default (`engine: "native"`) for v1. On the
release branch the V8 engine bundler refuses 7 of 13 templates with `TN_NATIVE_ENGINE_UNBOUND`
imports, and the V8 player fails 4 more at runtime. Only minimal and puzzle run on the native engine.
Measured by the PRD-573 release lane on 2026-10-15.

Refused by the bundler (post and TSL imports):

| Template | Refused imports | Examples |
| --- | --- | --- |
| starter | 18 | `film`, `lut3D`, `traa`, `luminance`, `renderOutput`, `rtt`, `struct`, `wgslFn`, `DepthTexture`, `LUTCubeLoader` |
| snow | 6 | |
| rain | 4 | |
| shooter | 2 | |
| action-rpg, runner, sailing | 1 each | |

On the web Wasm engine the starter fails all three playtests with `TN_NATIVE_UNCATALOGUED_NODEPROXY`
(`FilmNode`, `Lut3DNode`, `TRAANode`).

Bundle clean, but fail on the V8 player (missing runtime bindings):

| Template | Runtime failure |
| --- | --- |
| platformer, tower-defense | `MeshStandardMaterial.flatShading` unbound |
| racing | `Mesh.computeBoundingSphere` unbound |
| rts | `TN_V8_FRAME_FAILED` on `updateRanges.push`, every frame | PRD-573 Phase v1.8 ("slice 8", not started) and its v1.5 known red
(native lowering of the LUT, grain and TAA stages) name the same gap.

The exact per-template list is the input of the pin ratchet test that PR #493 adds: it asserts that
each pinned template is still refused (bundler codes, or the recorded runtime failure for the four
runtime-pinned templates), and it fails with "remove the legacy pin from <template>" when one runs. Read that test for the full lists; do not re-measure.

Files inspected:

- `packages/runtime-native/scripts/bundle-native-engine.mjs` — `unboundDiagnostic()` (about line 76)
  refuses `three/addons/tsl/display/*` because "the native renderer currently consumes cooked post
  graphs", and refuses `three/tsl` names that the native graph does not bind.
- `packages/runtime-native/src/engine/player/core-addons.mjs` — binds `ao`, `denoise`, `smaa` and
  `bloom` as live native effects through `definePostEffects` from
  `packages/three-native/src/addons/post-effects.ts`, shared with the Wasm back end. Other display
  nodes refuse by name (`unsupportedExport`).
- `packages/runtime-native/src/engine/renderer/renderer.h` — the renderer already owns a native
  `TraaPass` (`setTraa`, about line 331) between the scene and output passes.

## Solution

Extend the existing live-effect path. Do not add a second post system.

1. For each refused display node (`film`, `lut3D`, `traa`, and the others in the ratchet lists),
   add a binding to `definePostEffects` backed by a native pass. `traa` maps to the existing
   `TraaPass`. `film` and `lut3D` need native passes; `LUTCubeLoader` needs a loader binding that
   delivers the 3D LUT texture to that pass. The same binding serves the V8 player and the Wasm back
   end, as for `bloom`.
2. Bind the refused `three/tsl` names (`luminance`, `renderOutput`, `rtt`, `struct`, `wgslFn` and the
   others in the lists) in the native graph, and `DepthTexture` in the V8 renderer bindings. A name
   that cannot be lowered keeps its named refusal; it is not stubbed.
3. Bind the missing runtime members (`MeshStandardMaterial.flatShading`, `Mesh.computeBoundingSphere`,
   `BufferAttribute.updateRanges`) in the V8 bindings. These are smaller than the post nodes and unblock
   four templates.
4. When a template runs, delete its `engine: "legacy"` pin in the same commit. The ratchet test
   enforces this.

Appearance is owned by the template (`src/render/`): the bindings carry every parameter from the game
and decide nothing about the look. Each un-pinned template needs a visual judge (AGENTS.md owner
rule), because the native passes must reproduce the legacy look.

Risk: `film` grain and TAA are temporal. Capture the judge poses after the history settles, with the
same frame count on both arms.

## Acceptance Criteria

AC-1 to AC-4 sit under Phase 1 and AC-5 to AC-7 under Phase 2, each with its proof.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Display post nodes on the native engine | Template `src/render/` import → `bundle-native-engine.mjs` → `core-addons.mjs` → `definePostEffects` → native pass | `unsupportedExport` refusal for each bound node is deleted | AC-1, AC-2, AC-5, AC-6 |
| TSL names on the native graph | Template TSL code → native graph binding | Named refusal in `unboundDiagnostic()` stays only for names that remain unbound | AC-1, AC-5 |
| Runtime members on the V8 player | Template code → V8 bindings (`flatShading`, `computeBoundingSphere`, `updateRanges`) | Runtime failure deleted | AC-5, AC-6 |
| Native default for every template | `threenative.config.ts` without `engine` | The eleven `engine: "legacy"` pins are deleted | AC-1, AC-5 (ratchet test) |

## Decisions

- 2026-10-15 (João): "We're not in a rush, sort this shit out. No need to go legacy." The native engine
  stays the default. A legacy default for v1 is rejected; do not propose it again. The `engine: "legacy"`
  pins are temporary debt, removed only after native proof on web and desktop; native-in-name with
  legacy-pinned templates is not the finished state. The v1 release stays blocked until every template
  passes the web and desktop matrix (startup, visible rendering, zero frame or runtime errors). This work
  runs on PR #493 (the epic), not after it.

## Execution Phases

#### Phase 1: The starter runs on the native engine
**Status:** NOT STARTED
**Files:** `packages/three-native/src/addons/post-effects.ts`, `packages/runtime-native/src/engine/player/core-addons.mjs`, the native pass sources under `packages/runtime-native/src/engine/renderer/`, the native TSL and V8 binding sources, `templates/starter/threenative.config.ts`.
**Implementation:** Bind the starter's 18 refused imports as in the Solution, starting with `traa` (the pass exists). Delete the starter pin when the ratchet test reports it clean.
**Verification:**
- [ ] AC-1 [local]: The starter bundles clean on the V8 engine bundler and its `legacy` pin is deleted. proof: the pin ratchet test from PR #493 — Evidence: pending.
- [ ] AC-2 [local]: The starter's template playtests pass on the native engine on desktop (`--target desktop`) and on the web Wasm engine. proof: `pnpm test:templates` (starter kit) and the starter scenario with `--target desktop` — Evidence: pending.
- [ ] AC-3 [local]: A fresh judge subagent rates starter native against starter legacy NEUTRAL or IMPROVEMENT on desktop and web, with at least two runs per arm. proof: judge verdict on BEFORE/AFTER captures, `--browser-recipe webgpu`, `adapter.info` checked — Evidence: pending.
- [ ] AC-4 [local]: Starter main-thread CPU per frame on native is at or below legacy on desktop, at the same pose and frame count. proof: playtest `perf --executable` paired runs, host load recorded — Evidence: pending.

#### Phase 2: The other ten templates run on the native engine
**Status:** NOT STARTED
**Files:** the bindings that Phase 1 did not cover, the V8 runtime binding sources, and the ten template configs.
**Implementation:** Bind the three runtime members first (platformer, tower-defense, racing, rts), then each remaining refused import from the ratchet lists. Delete each pin when its template runs.
**Verification:**
- [ ] AC-5 [local]: Platformer, tower-defense, racing, rts, snow, rain, shooter, action-rpg, runner and sailing run on the V8 player and their `legacy` pins are deleted. proof: the pin ratchet test — Evidence: pending.
- [ ] AC-6 [local]: The playtests of those ten templates pass on the native engine. proof: `pnpm test:templates` for the six kits — Evidence: pending.
- [ ] AC-7 [local]: A fresh judge subagent rates each of the ten templates NEUTRAL or IMPROVEMENT against its legacy capture. proof: one judge verdict per template — Evidence: pending.
