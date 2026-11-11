# PRD-871 — Stress lab: an integrated GPU plays at vanilla speed, and the desktop frame loses its shadow planning cost

**Status:** IN PROGRESS — Phase 1 and Phase 2 done; Phase 3's `play` cut landed. The plan floor and AC-2 are handed to [PRD-872](PRD-872-static-casters-and-rigid-rigs-in-the-desktop-frame.md) (see Decisions), so this PRD moves to `done/` when PRD-872 ticks AC-2.
**Priority:** P1 — on a laptop GPU the engine draws the stress scene at 25 fps where vanilla three.js draws 53 (Phase 2), and the gameplay preset ran at half the speed of the orbit preset on the desktop (Phase 3, now 79.7 against 66.0 fps).
**Complexity:** 6 (MEDIUM)
**Owner:** João · 2026-11-10
**Depends on:** None. PR #659 (`perf/stress-lab-audit`) carries this PRD and the work before it.

## Context

The 2026-11-10 audit of the stress lab (PR #659) changed the method and found where the frame goes. Read
`PERFORMANCE-LEARNINGS.md` (section "2026-11-10") before the first candidate.

Rules the audit set, which each candidate in this PRD must follow:

- A keep needs a real-game holdout in the same fair window (`scripts/stress-loop.mjs fair`, commit `f7db10c02`).
- FPS counts drawn frames. The scoreboard reads only arms named `head`, `develop` or `stack`, and one GPU.
- Measure the `adaptive` lane on an integrated GPU. A pinned `high` tier is not what that player gets.
- Attribute before you choose: the ledger keeps the GPU frame by pass (`gpuMainMs`, `gpuShadowMs`, `gpuOtherMs`).

### Measured state (2026-11-10, 1280x720, uncapped)

Laptop, Intel Iris Xe (`intel gen-12lp`), stress lab `main.html?stress`, paired probe, two runs per arm:

| Lane | Before lamp range | After (commit `078aae53b`) | GPU frame after: scene / shadow / post |
| --- | --- | --- | --- |
| `real`, tier pinned `high` | 3.6 fps | 25.3 fps | 38 ms: 8.6 / 11.7 / 18.0 |
| `real&adaptive` (lands on `low`) | 6.3 fps | 34.8 fps | 27.4 ms: 8.5 / 11.8 / 6.8 |
| `real&play` | 3.35 fps | 19.9 fps | 49 ms: 12.3 / 12.4 / 23.6 |
| Vanilla three.js, one sun map (ledger #309) | 53 fps | not measured again | |

Desktop, RTX 2080, fair window `range-score`, ledger rows #334-#337 (one valid run per ThreeNative arm, two for vanilla; the second half was void because CI runners raised the load to 27):

| Arm | FPS | Frame p50 | GPU p95 |
| --- | --- | --- | --- |
| ThreeNative, virtual shadows, before lamp range | 95.0 | 10.16 ms | 5.99 ms |
| ThreeNative, virtual shadows, after | 96.7 | 9.84 ms | 5.05 ms |
| ThreeNative, one sun map (`plainShadow`), after | 137.1 | 6.61 ms | 3.89 ms |
| Vanilla three.js | 75.0 and 75.6 | 12.7 ms | |
| ThreeNative `play` preset (earlier single run, ledger #322 window) | 49.4 | 17.0 ms | |

What the numbers say:

1. **Laptop, adaptive lane:** the shadow pass is now the largest GPU cost, 11.8 of 27.4 ms. The `low` tier promises no
   shadow (`packages/core/src/look/quality.ts:268-286`, "`low` draws no shadow"), but only the kart kit applies
   `castShadows` from the tier. The lab and every other kit still draw the shadow pass at `low`.
2. **Desktop, `real`:** the frame is CPU-bound (frame 9.84 ms against GPU 5 ms). Virtual shadows cost 3.2 ms of CPU frame
   against one sun map (9.84 against 6.61 ms). The stage split names `planVirtualPages` at 1.64 ms and `planShadowLists`
   at 0.33 ms. Each frame also uploads 1,194 KB to the GPU with virtual shadows and about 820 KB with one sun map.
3. **Desktop, `play`:** the gameplay preset draws 114 main draws and 1,242 shadow draws per frame, against 57 and 144 for
   `real`. It has no stage split yet.

## Solution

Three phases, ordered by gain per hour. Each engine change lands in `packages/`, with a red-green test, a paired window and
a visual judge when it can change a pixel.

**Phase 1 closes the lamp range lever.** The standard and physical fragment programs now branch on a lamp's distance
attenuation (`packages/runtime-native/src/engine/shader/standard.cpp`, `ranged`, `held`, `shade`). It follows
`UE 5.8.3: Engine/Shaders/Private/DeferredLightingCommon.ush:334-344`. Two gaps stay: the Lambert and Phong loop in
`buildLit` still shades each lamp on each fragment, and the change has no native run.

**Phase 2 brings the laptop adaptive lane to vanilla speed.** Make the `low` tier keep its promise without a line of game
code. First name the layer: the quality policy (`packages/core/src/look/adaptiveQuality.ts`, `qualityPolicy.ts`) knows the
tier, and "the engine decides what it can measure" is the repository rule. The tier must still be a named override on the
same object, and the report must say that shadows are off. With the shadow pass gone the GPU frame is about 15.6 ms, so
the lane can pass 53 fps. Then re-measure at `medium`: the policy may hold a higher tier now that the lamps are cheap.

**Phase 3 cuts CPU frame time on the desktop.** Hypotheses, in the order to test them:

- `planVirtualPages` rebuilds per-caster state each frame: a `std::string` signature through `std::to_string`, a
  `std::set<uint64_t>` insert, a `motion_` map lookup, `protectedIds` inserts per page, and `writeTable` each frame
  (`renderer_frame.cpp:124-212`, `shadows/virtual/atlas.cpp`, `updateCasters`, `update`, `writeTable`). A static caster
  whose inputs did not change must cost nothing. The ceiling is the `plainShadow` arm: 3.2 ms.
- The 374 KB of extra upload per frame with virtual shadows, and the 820 KB base. Read the counters
  (`bufferUploadBytes`, `attributeUploadBytes`, `uniformUploadBytes`, `textureUploadBytes`, URL flag `tnDebug=1`) and
  find each buffer that uploads unchanged content.
- `play`: take a Chrome DevTools Performance trace (chrome-devtools MCP) and the stage split first. The 1,242 shadow
  draws point at moving casters that draw one by one.

Risks:

- **Disappearing meshes.** The auto batch fix of 2026-11 (aircraft yoke pieces vanished) must not regress. Run the auto
  batch specs after each change to draw lists.
- **Shadow cache staleness.** A caster that the planner skips must still dirty its pages when it moves. The existing
  `tn-native-engine-vsm-atlas-test` and `-vsm-test` suites are the guard.
- **Benchmark-only wins.** A change that helps only `?stress` fails the holdout and is rejected.

## Validation scene

- **Consumer and scene:** the stress lab, `main.html?stress`, preset `real` (4000 trees, 6000 rocks, 120 houses, 600 props,
  120 walkers, 300 bodies, 12 fires of 1500 particles, 16 torches, one sun with virtual shadows), plus `&play` and `&adaptive`.
- **Window:** `node scripts/stress-loop.mjs fair`, ABBA, two runs per arm, `--passes uncapped`, 1280x720, base and candidate
  lab builds served side by side. Desktop: RTX 2080. Laptop: Intel Iris Xe through `laptop-offload`.
- **Benefit workloads:** `?stress&adaptive` on the laptop (Phase 2); `?stress` and `?stress&play` on the desktop (Phase 3).
- **Controls that charge the change's own cost:** `?stress&plainShadow` (no virtual shadow planning, must not slow down),
  `?stress&still` (no camera motion), and `?stress&noLights` (the ceiling of any lamp work).
- **Holdout:** one scaffolded kit with lamps (`adventure` or `shooter`) in the same window. A keep needs it.
- **Pass:** the acceptance numbers below, frame p95 and hitches not worse than base by more than the A/A band, and a visual
  judge NEUTRAL or IMPROVEMENT on each change that can alter a pixel.

## Acceptance criteria

- [x] AC-1 [shared]: on the Iris Xe laptop, `main.html?stress&adaptive` draws at 60 fps or more in every run, uncapped, two runs per arm, with no stress lab source change that removes content. proof: ledger rows from a laptop fair window (`~/.agents/skills/laptop-offload/offload.sh start <job> --gpu`) — Evidence: laptop window `p8-laptop`, rows #349-#350, 2026-11-10: head runs 84.6 and 67.5 fps (base 78.2 and 47.0), GPU p95 12.3 → 9.0 ms, both arms at `low`; the second head run held 67.5 fps while the package reached 98 C. Before PRD-871: 7.1 fps (#338). Head = `cac3780a4` (no SSR at `low`) on top of Phase 2; no lab content removed. Visual judges: shadows NEUTRAL (`judge-p2c`), SSR NEUTRAL (`judge-ssr`, still, town and closeup).
- [ ] AC-2 [local]: on the RTX 2080, `main.html?stress&arm=head` holds a frame p50 of 8.4 ms or less (about 120 fps, the scoreboard goal) in a valid fair window. proof: ledger rows from `node scripts/stress-loop.mjs fair` — Evidence: 10.00 ms base (#362) and 10.65 ms head (#363) in window `play-lod-walk-b`, 2026-11-10; not met. Handed to PRD-872 AC-1 (see Decisions): zeroing `planVirtualPages` entirely still reads about 9.0-9.6 ms against 8.4, so the 120-rig crowd, not the planner, carries this number. This PRD moves to `done/` when PRD-872 ticks that criterion, the PRD-218 shape.
- [x] AC-3 [local]: on the RTX 2080, `main.html?stress&play&arm=head` draws at 60 fps or more in a valid fair window. proof: ledger rows from `node scripts/stress-loop.mjs fair` — Evidence: window `play-lod-walk-c`, rows #364 (base) and #365 (head), 2026-11-10, uncapped ABBA in one clean browser, two runs per arm, load peak 7.0: head 78.1 and 81.3 fps (base 63.9 and 68.0), frame p50 11.39/10.68 vs 12.09/11.33 ms, frame p95 18.4-18.5 vs 25.5-27.4 ms. Before PRD-871: 49.4 fps (row #322 window).

## Blocked on

- A valid desktop fair window needs host load under 18 for the whole window. The `tn-local` CI runner pool on the desktop
  raised it to 27 on 2026-11-10 — unblocked by a quiet period, or by João pausing the pool for 20 minutes.
- The Unreal 5.8.3 scoreboard rows (#287, #288) date from 2026-11-03, so the dashboard reads STALE until someone runs the
  Unreal arms again — unblocked by João's decision: rerun Unreal, or let the stale flag follow only the ThreeNative rows.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| A lamp shades only fragments in range | Any `MeshStandardMaterial` or `MeshPhysicalMaterial` lit by an unshadowed `PointLight` or `SpotLight` → `buildStandardProgram`, `standard.cpp` | The unbranched loop, deleted | Phase 1 |
| The `low` tier draws no shadow | Adaptive quality policy tier change → shadow pass | Per-kit `castShadows` wiring (kart `src/render/lighting.ts:22-31`) stays valid as the named override | AC-1 |
| Virtual shadow planning skips unchanged casters | `Renderer` frame → `planVirtualPages` → `atlas.updateCasters` | The per-frame rebuild, deleted | PRD-872 Phase 1 (handed, see Decisions) |

## Decisions

- 2026-11-10 (Claude, audit session): clustered or tiled light culling is not in scope. With the range branch, 16 lamps cost
  0.6 ms of the Iris Xe scene pass (8.55 ms against 7.96 ms with no lamp), so a light grid has nothing left to remove at
  this lamp count. Reopen it when a game ships more than about 64 lamps.
- 2026-11-10 (Claude, audit session): a depth prepass is not in scope. The scene pass is 8.6 ms on the Iris Xe after the lamp
  change, and PRD-766 phase 2 already holds the masked prepass as deferred.
- 2026-11-10 (Claude, PRD-871 session): the native proof of the GPU split is `player-gpu-stages.mjs` on the V8 player, not a
  `perf --file` log. The test reads the same `info.engine` fields that core's `gpuFrameSample` reads and asserts them per
  frame; a log read would add a game build and prove nothing more.
- 2026-11-10 (Claude, PRD-871 session): the low-tier shadow switch ships in the starter's generated `src/render/postprocessing.ts`,
  not in core. Repository rule: what decides how anything looks ships as generated source in `src/render/`; core supplies
  only `qualityTiers.shadow(tier).castShadows`. The named override is `setupPost(..., { shadows })`, reported as
  `shadows=on|off(tier|override)` on `TN_QUALITY_TIER`.
- 2026-11-10 (João): "laptop needs 60fps min". AC-1 rises from 53 fps to 60 fps, and every run must hold it, not the mean.
  The laptop reaches 97 C and then draws the same build at half speed (head 63 fps cool, 35 fps hot), so a window starts
  with the package under 80 C and the GPU frame at the low tier needs about 2x headroom: 12 ms or less cool.
- 2026-11-10 (Claude, PRD-871 session): the plan floor (Phase 3 box 1) and AC-2 move to PRD-872, filed by this PRD. Measured: `planVirtualPages` is 0.80-1.02 ms of a 10.00-10.65 ms `?stress` frame (#362-#363), so zeroing the whole stage still reads about 9.0-9.6 ms against the 8.4 ms goal; with `&noCrowd` the same frame is 5.6 ms, so the 120 walking rigs (4.5-6.5 ms) are what carries the number. A dirty list is a structural change across four loops with a named staleness risk, and it would land beside an acceptance criterion it cannot reach on its own: both phases ship under one PRD, each with its own window. PRD-871 keeps AC-2 as its own open criterion and moves to `done/` when PRD-872 ticks it.
- 2026-11-10 (João): no Midway work in this lane. Midway still ships `autoBatch: false`; that is a game-side note, not a
  box here.

## Execution Phases

#### Phase 1: the lamp range lever is closed

**Status:** DONE
**Files:** `packages/runtime-native/src/engine/shader/standard.cpp` (`buildLit`), `packages/runtime-native/tests/native-engine/material_test.cpp`, `docs/stress-loop/ledger.json`, `PERFORMANCE-LEARNINGS.md`.
**Implementation:** reuse `ranged`, `held` and the branch from `buildStandardProgram` for the Lambert and Phong loop. Record the laptop paired probe and one valid desktop window as ledger rows with the candidate arm named `head`. Add the learnings entry (method traps of the session included: scoreboard arm names, the desktop needs a live display for a headed browser, the owned engine reports its GPU split through `globalThis.__tnGpuSegments`, the glue constant `ASM_CONSTS` moves with each Wasm build).
**Verification:** `cmake --build build/wasm --target tn-native-engine-material-test && ctest --test-dir build/wasm -R native_engine_material` (run from `packages/runtime-native`, after `source ~/emsdk/emsdk_env.sh`).

- [x] Standard and physical programs branch on lamp range. proof: `ctest --test-dir build/wasm -R native_engine_material` — 21 passed, 2026-11-10; `native_engine_material_lamp_range_branch` failed on the old shader and passes on `078aae53b`.
- [x] Visual judge NEUTRAL on `?stress&still`, `?stress&freezeAt=12` and `?stress&play&freezeAt=8`, two runs per arm on the Iris Xe. proof: fresh Opus judge on `artifacts/stress-lab-audit/judge-range/` — NEUTRAL overall, 2026-11-10: torch glow on the house wall reads RGB 214.4/168.7/131.8 before and after (`freezeAt=12`), and 215.0-215.5 before against 215.2-215.9 after (`play`); no cutoff edge. The `still` pose shows no torch light, so it proves nothing about the lamps.
- [x] Lambert and Phong programs branch on lamp range too, and a kit with lamps (`adventure` or `shooter`) holds or gains FPS as the holdout. proof: `native_engine_material_lamp_range_branch` extended to `buildLambert` and `buildPhong`; holdout arm in one fair window; ledger rows. — `fa8f612a1`; `ctest -R native_engine_material` 21 passed, 2026-11-10 (`lit("dps") == lit("d") + 2`). Holdout: the `tower-defense` kit (point lamps, standard materials), laptop window `lit-holdout-laptop` rows #341-#344: kit 109.3 → 114.2 fps (holds); lab `?stress&adaptive` 7.1 → 36.0 fps. The desktop window `lit-holdout` (#338-#340) voided every lab head run (load 24-34 from the CI pool); its kit pair holds (320 → 333 fps). Native run: not done, the owned engine on desktop shares this shader source.

#### Phase 2: the laptop adaptive lane reaches vanilla speed

**Status:** DONE
**Files:** `packages/core/src/look/adaptiveQuality.ts`, `packages/core/src/look/qualityPolicy.ts`, their specs under `packages/core/__tests__/`, `packages/create-threenative/conventions.json` when the rule becomes a convention.
**Implementation:** run `engine_search_capabilities` for the shadow tier first. Decide the layer in writing (engine policy or kit source) and quote the repository rule that decides it. Apply the tier's `castShadows` where the tier changes, keep the named override, and report the overridden state. Feed the owned engine's GPU pass split into `TN_FRAME_BUDGET`, so a game reads it without the lab's hook.
**Verification:** a laptop fair window with base and candidate lab builds, arms `?stress&adaptive&arm=base` and `?stress&adaptive&arm=head`, plus a visual judge at each tier the change touches.

- [x] At the `low` tier a game with no shadow wiring of its own draws no shadow pass, and a game that sets its own shadow option keeps it. proof: a core spec red-green, and `gpuShadowMs` under 1 ms on `?stress&adaptive` in the laptop window. — `6dd609eca` (+ `99c719d30`, the rule moved to `tierShadows` in the starter's `quality.ts`; the spec is the starter's, see Decisions). `starter-shadow-tier.spec.ts` red before, green after: `low` off, `medium`/`high` on, `shadows: true` kept and reported `source: "override"`. Laptop rows #345-#346: `gpuShadowMs` 11.3 → 0, 35.8 → 63.2 fps. Visual judge (fresh Opus, `judge-p2c/`, still and town, two runs per arm at `low`): NEUTRAL; only cast shadows go, plus a uniform 2% auto-exposure re-meter. The tier flap this exposed (low ↔ medium every few seconds, shadows blinking) is fixed by `97c33a831` and `b3c90884b` (a failed raise waits until its measured cost would fit; `template-quality` red-green).
- [x] `TN_FRAME_BUDGET` carries the GPU frame by pass (shadow, scene, other) on the owned engine. proof: a core spec, and one native desktop run read with `node packages/playtest/dist/runner/cli.js perf --file <log>`. — `4bd398993` (Wasm facade, core) and `52876410f` (V8 player). `renderer.spec.ts` "hands out the engine's own pass split" red before, green after (65 passed). Stress lab `TN_FRAME_BUDGET`: desktop `gpu 4.8 = gpuMain 1.0 + gpuShadow 1.2 + gpuOther 2.6`; laptop at `low` `gpuMain 5.2, gpuShadow 0, gpuOther 5.9`. Native: `player-gpu-stages.mjs` on the V8 player, RTX 2080, PASS (the split names the sampled frame). The `perf --file` reading is replaced by that test (see Decisions).

#### Phase 3: the desktop frame loses its shadow planning cost

**Status:** IN PROGRESS — boxes 2 and 3 met; box 1 (the plan floor) moved to PRD-872 Phase 1.
**Files:** `packages/runtime-native/src/engine/renderer/renderer_frame.cpp`, `packages/runtime-native/src/engine/renderer/shadows/virtual/atlas.cpp`, `atlas.h`, `packages/runtime-native/tests/native-engine/vsm/vsm_atlas_test.cpp`.
**Implementation:** one hypothesis per candidate, each with its expected gain written first. Start with the per-caster work of `planVirtualPages` for casters whose transform and geometry did not change. Then attribute the per-frame upload by counter. Then profile `play` and cut its largest removable term. Use Opus 5.5 high for the C++ changes and DeepSeek V4.1 Flash max for searches and row bookkeeping (owner routing, 2026-11-10).
**Verification:** `ctest --test-dir build/wasm -L native-engine -R "vsm|render_database|renderer"`, then a paired desktop fair window (`--passes uncapped`, arms `base` and `head`, plus `plainShadow` as the ceiling), a holdout kit, and a visual judge on `?stress&closeup` and `?stress&freezeAt=12` for each change to shadow planning.

- [ ] A frame whose static casters did not change spends 0.5 ms or less in `planVirtualPages` on `?stress` (1.64 ms today). proof: a `vsm_atlas_test` case that counts per-caster work on an unchanged frame, red-green; stage split in the ledger row.
  Partial, 2026-11-10: `a38190bff` (a moving rigid caster keeps its vertex box; `virtual_shadow_bounds_cache` red-green) and
  `7482c204c` (a rig box reads each bone stretch alone): bounds rebuild 1.38 → 1.06 ms a frame by sub-timer. The stage still
  reads 1.25-1.6 ms under host load 12-20; the desktop window `shadow-plan` (#347-#348) is inconclusive (one valid base
  run). Most of what remains is the walking crowd (see Handover notes).
  Moved to PRD-872 Phase 1, 2026-11-10 (see Decisions): the 0.7 ms floor is every caster re-verified each frame, and the
  whole stage is 0.80-1.02 ms of a 10.00-10.65 ms frame, so a dirty list alone cannot carry AC-2 either.
  Attribution, 2026-11-10 (temporary sub-timers, desktop `?stress`, 1174 items, 1145 casters): bounds 0.95 ms (242 rig
  meshes about 0.64, 902 rigid cached casters about 0.28), caster states 0.08, `updateCasters` 0.18, atlas update 0.15.
  The rigs' bone joins are only about 0.2 ms of it. `3883e79f0`: two meshes on one skeleton read its bone poses once per
  plan (`bone_reach_bounds_hold_posed_vertices` red-green): bounds median 1.21 → 1.08 ms at load 17-23. Floor: with zero
  rig cost the stage stays near 0.7 ms, because every caster is re-verified each frame. 0.5 ms needs a scene dirty list
  that skips unchanged casters in all four loops; that is a structural change, not started.
- [x] No buffer with unchanged content uploads on `?stress&still`. proof: `tnDebug=1` upload counters before and after, in the ledger row notes. — The 39 KB a frame that `uniformUploadBytes` showed was the arena size, not an upload: the FM2 diff already sent only changed blocks. `a3ee875b2` makes the counter count written bytes; `bd1cd887d` stops the last unchanged write (the output pass block, 4 B a frame). `frame_slab_is_per_program` red-green both times: a still frame now uploads 0 bytes; 136 render database, 98 renderer and 14 post cases pass. Desktop `?stress&still&tnDebug=1`: 74.0 KB a frame, of it 6.7 KB uniforms (changed blocks only, by per-block compare) and the rest the walking crowd's bone palettes, which change each frame; with `noCrowd&noFires&noBodies` 516 → 512 B, all changed uniform blocks. No ledger row: the counters are not a window metric.
- [x] The `play` frame has a stage split that covers 95% of the frame, and its largest removable term is cut. proof: the split and the paired window in ledger rows; the DevTools trace named in the learnings entry. — Coverage: `stageSum` 13.07 ms against frame p50 12.55 ms (104%), row #360; the largest term is `wasmPlan` 2.53, of it `planVirtualPages` 1.02, then `update` 2.19. Cut: `e4fe59cb8`, the LOD-chain walk (`Pn → traverse → value → J`, 15% of main-thread time in the DevTools trace, learnings 2026-11-10) that found nothing on every `play` frame because the lab registers no chain. Window `play-lod-walk-c` (#364-#365, uncapped ABBA, two runs per arm, load peak 7.0): 66.0 → 79.7 fps (base 63.9/68.0, head 78.1/81.3), frame p50 11.71 → 11.04 ms, frame p95 26.46 → 18.35 ms. Holdout: the tower-defense kit (`holdout=td`, window `td-lod-holdout`, rows #366-#367, two runs per arm, load peak 13.1): 286.9 → 306.5 fps, frame p95 3.26 → 2.38 ms — no effect, and the kit registers no LOD chain either, so the arm pair differs only by the guard. No pixel can change (with no chain registered the walk dispatched nothing), so no visual judge was run; the reason is recorded here rather than left as a silent skip.

## Handover notes

- Work in `.claude/worktrees/stress-lab-audit`, branch `perf/stress-lab-audit`, PR #659. Commit by path.
- Lab source: `~/projects/threenative/sandbox/stress-lab` (commits go to `main` with a push). Lab flags: `stress`, `play`, `adaptive`, `plainShadow`, `still`, `closeup`, `freezeAt=<s>`, `noLights`, `noTrees`, `noRocks`, `noCrowd`, `noBodies`, `noFires`, `arm=<name>`.
- Probe tools from the audit, kept outside git: `artifacts/stress-lab-audit/tools/` in the worktree, and `~/offload/labs/stress-audit/` on the laptop (`dist-cand3` is the base lab build, `dist-cand4` the lamp range build). `seg-probe.mjs` prints the GPU pass split per URL variant. `cap-probe.mjs` takes the judge captures.
- A candidate lab build is a copy of the base `dist` with the two engine `.wasm` files replaced and the `ASM_CONSTS` address patched in the glue chunks. Do not rebuild a folder that a live server serves.
- Phase 3 attribution (2026-11-10, `?stress`, desktop, `TN_FRAME_BUDGET` stages, host load 12-20): frame p50 10.1-12.3 ms;
  `wasmPlan` 2.4-3.0 (of it `planVirtualPages` 1.25-1.6), `wasmScene` 2.2-2.8, `jsBefore` 1.4-1.8, `update` 1.4,
  `engineJs` 0.9-1.0, `wasmTargets` 0.8-0.9. With `&noCrowd` the frame is 5.6 ms: the 120 walking rigs cost about 4.5-6.5 ms.
  Every walker moves each frame, so its bones change in world space even when `updateRate: "auto"` skips its pose. Inside
  `planVirtualPages` (temporary sub-timers, not committed): 240 rig draws 0.72 ms, 1,174 bounds lookups 0.35 ms, 11
  instanced draws 0.20 ms, 214 moving rigid draws 0.13 ms. The next lever is per-rig engine work for a rig that moves
  rigidly (Unreal keeps bones in component space), not more shadow-plan micro cuts.
- The laptop `low` frame by pass (hot, 2026-11-10, `pass-probe.mjs`, `TN_GPU_PASSES`): scene 11.6 ms, `aux` G-buffer 6.7 ms (SSR's
  normal and material reads; gone with `cac3780a4`), post 4.3 ms over 8 passes, output 0.6 ms. The walking crowd is about 5 ms
  of the scene pass and 4.5 ms of `aux`.
- The `p2c` laptop window (2026-11-10) is void: an orphaned probe browser from a stopped job rendered beside it. Its rows were
  not recorded. Check `ps` for `ms-playwright/chromium` with PPID 1 after any `offload.sh stop`.
- The laptop reaches 100 C between runs; `offload.sh start` refuses then. Retry in a loop with 60 s waits. Head runs with the
  same GPU frame differ 50 to 76 fps from throttling: read `gpu` and `shadow` beside `fps`.
- Before a headed GPU browser on the desktop: read `nvidia-smi --query-gpu=memory.used --format=csv,noheader` and keep 3 GB free. Check `uptime`: a fair window is void above load 18.
