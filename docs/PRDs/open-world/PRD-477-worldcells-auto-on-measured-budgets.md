# PRD-477 — WorldCells auto-on + measured budgets

**Status:** PARTIAL — Phase 1 capture/judgment plumbing is implemented on the draft PR; real visual red/green and all acceptance claims remain open. No engine default has changed.
**Priority:** P1 — Gate unbuilt that must red on the known-bad impostors-default-on build.
**Complexity:** 6 (MEDIUM) — a standing visual gate (one script plus a judge), a native conformance case, and budget derivation inside `packages/core/src/world-cells.ts`. Risk override: none.
**Owner:** João
**Depends on:** PRD-475 (Machinefall's open world at 120 fps, no visual loss, #384), PRD-473 (GPU-driven world, #375).

## Context

The repo's standing rule: **auto by default** — if the engine can measure a value where it is used, it decides; a constant the author must revisit later is a bug. WorldCells still asks the game to supply constants the engine already knows at load time.

Machinefall hands the world its numbers in `apps/client/src/level/World.ts`:

```ts
export const WORLD_RING = 2;
export const WORLD_BUDGETS = { residentCells: 25, instances: 220_000, bytes: 8_000_000 } as const;
```

Those three budgets are arithmetic the game derived by hand from its own cooked package (218 assets, 256 cells of 128 m: peak 7 816 instances and 250 112 bytes in cell 8,8, times the 5×5 that `ring: 2` keeps resident). `cellSize` comes from the cooked manifest, and the per-asset `maxDistance` that culls ground cover is authored into the package — so the engine holds every input the numbers are derived from and asks the game to do the derivation anyway.

Alongside them sit per-feature switches an agent must know exist: `impostors`, `gpuScene`, `bundles`, `adaptiveLod`, and terrain tile merging (`mergeTiles`, or `TN_TERRAIN_MERGE` / `?tnTerrainMerge=1`). Agents write the games. Every knob is cold-build friction, and a knob nobody finds is a knob that never gets set.

**Cautionary evidence — two default-on changes broke the look while every unit test passed:**

- **Impostors default-on (#375).** The two-triangle card replaced the coarsest level the wide shadow levels draw, leaving the road and forest floor almost unshaded. Unit tests were green; the frame was wrong. Impostors are opt-in again (`impostors?: boolean`, default false, `world-cells.ts`).
- **Terrain super-tile merge (PRD-475).** A merged block's mesh sat at the world origin while its vertices were block-local, so every block but (0,0) drew displaced — floating slabs over a hole where the ground should be (`890578e81`). Unit tests only ever merged an island at the origin, where block-local and world coordinates agree.

So the gap is not "we did not dare turn streaming on". It is that **nothing in the world path can prove a default-on change kept the picture**, so every such change is opt-in by default and stays that way.

## Solution

In this order, because each step is what makes the next one safe.

1. **A standing visual gate, before any default flips.** Same-pose screenshots plus a popping capture series on a reference world, in the shape of Machinefall's `?scene=map-walk` and `?scene=map-views`, judged blind. Same-pose scoring reuses the shipped harness: `scripts/visual-ab.ts` via `pnpm visuals:ab --before <dir> --after <dir> --raters 3`. The popping half needs a capture series along a fixed leg and a judge that names every element that appears, disappears or swaps LOD inside the near band — no script exists for that today, so it is built here. Runnable on the GPU lane (WebGPU recipe, adapter named in the output). **Nothing in world streaming flips default-on without passing it.**
2. **Native and mobile proof — web-only is unfinished.** The GPU scene's CPU fallback (PRD-473 AC-6) and the streaming path under it run on the owned native host via a `--target` playtest (`packages/playtest`, `packages/runtime-native/conformance/registry.json`). A budget derived on the browser is not a budget on a phone.
3. **The automatic trigger, and measured budgets.**
   - Streaming turns itself on when the content is cell-cooked, or when the world exceeds one ring. Small arena and puzzle games are unaffected — they load and stay loaded.
   - `budgets` (`residentCells`, `instances`, `bytes`) and `ring` move from hand-set constants to values the engine measures: device memory where the platform reports it, the frame budget where it does not. Machinefall's numbers survive as named overrides, so a tuned world keeps its tuning.
   - Each per-feature switch (`impostors`, `gpuScene`, `bundles`, `adaptiveLod`, `mergeTiles`) becomes an engine decision with a named override on the same object and honest reporting when overridden — the convention shape already used for shadows.

## Non-goals

- Always-on streaming for every scene. An arena is not an open world and pays nothing for pretending to be one.
- Changing any default before the gate in item 1 exists and has red-greened once.

## Acceptance Criteria

- [ ] AC-1 [local]: a cold-start agent builds a streamed game with no `WorldCells` budget, ring or per-feature switch, and the resulting frame is within the same-pose visual A/B and the same popping capture series as the hand-set build it replaces. proof: the map-walk and map-views capture series plus `pnpm visuals:ab --raters 3` on both arms.

## Blocked on

- Phase 1's real hardware-WebGPU reference and known-bad captures. The current executor has no exposed hardware GPU; its Xvfb fails to establish Unix listening sockets, and the supported cloud browser rejects the local preview with `ERR_BLOCKED_BY_CLIENT`. No screenshot or blind judgment is claimed from this lane.
- Native execution setup in the current executor: the published 0.3.4 Linux host downloads with the release checksum but cannot load `libwebkit2gtk-4.1.so.0`; `adb` and an Android emulator are absent. Existing desktop/Android CI lanes remain potential execution routes, not verified results.
- Android and iOS hardware runs of the native streaming case. The emulator lane covers the mechanism; real thermals and real memory need a device, which only João can attach.
- A 120 Hz+ display for reading presented 120 fps. Xvfb's swap floor cannot show it (inherited from PRD-475).

## Decisions

- 2026-10-01 (João): yes for world streaming auto-on, not unconditional; only after a visual gate exists.

## Execution Phases

### Phase 1 — The standing visual gate

- [x] The gate runs on a reference world and judges blind: same-pose captures scored by `pnpm visuals:ab --raters 3`, plus a popping capture series along a fixed walk leg. proof: `pnpm visuals:ab --before <ref> --after <candidate> --raters 3` and the series' judge output naming every element that appears or swaps LOD inside the near band. **Pass 2026-10-05:** `pnpm visuals:world` (this PRD's gate, `scripts/world-visual-gate.ts`) on Machinefall's `map-walk` world-capture route, nvidia/turing. It now takes ≥ 2 runs per side; each run is an anonymous walk series of 33 frames with 12 same-pose images, judged blind by 3 fresh critics. Each critic's series output names every element that appears or goes missing, with distance and frame; none fell inside the 30 m near band in either bundle (`.afk/scratch/a2/{dev-vs-dev,dev-vs-bad}`).
  - Implementation checkpoint: `pnpm visuals:world` reuses the same-pose instrument, seals chronological walk captures and three independent critic verdicts, enforces the 4/5 candidate floor, and rejects incomplete or stale evidence. The [judge protocol](../../product/WORLD-VISUAL-GATE.md) describes capture inputs and scoring. `WorldProbe` supplies observed poses, landmarks, streaming/admission statistics, and a fixed-leg capture scenario. Unit verification is not real visual acceptance; this box stays open until captured reference/candidate worlds are judged.
  - 2026-10-02 verification: the gate, report importer, fixture and four adjacent suites pass 100/100; `pnpm typecheck` passes across the workspace, `pnpm lint` exits 0 with warnings, and documentation checks cover 2396 links. The workspace build passed with the local `tsx` launcher using `node --import tsx` to avoid unsupported Unix IPC. The full test gate is **not green**: package tests stop at unavailable Playwright Chromium; the separately run unit phase reports 6931 passed, 66 failed, 35 skipped and two worker exits. The related GPU-scene suite passes 57/57 in an isolated rerun. Full validation, actual captures and blind red/green remain open; detailed failure classification is kept on the PR.
  - 2026-10-02 diagnostic capture follow-up: the ordinary path-filtered `integration-world-capture.yml` workflow builds the runner at the exact PR head and requests 34 real WorldProbe frames, validating PNG dimensions/nonblank content, console errors, source provenance and the report importer. It requires the unchanged visual gate to reject the named software adapter with its exact hardware-provenance error. This is capture/import diagnostics only, not hardware acceptance, A/B quality, native proof or performance evidence. Hosted execution is pending. Five focused fixture/importer/gate/CI suites pass 196/196 using the equivalent `node --import tsx` launcher locally because the standard launcher cannot create Unix IPC sockets. Full validation and every phase remain open.
- [x] The gate **reds on a known-bad build** — impostors default-on as in #375, which removed the forest's shadow — and greens on develop. A gate that has never gone red is not a gate. proof: the same command on both builds, with the impostor-on run below the reference floor. **Pass 2026-10-05:** develop vs develop (2 + 2 runs): **pass, exit 0**, same-pose mean 4, at the floor. Develop vs impostors-default-on (2 + 2 runs): **regression, exit 1**, same-pose mean 3 with 0 at the floor (below the reference floor). All 3 critics marked the distant crowns at 120–150 m missing in both impostor runs and in no develop run. The gate change that makes this hold is in this PR: a candidate event counts only when it appears in every candidate run and in no reference run. A single run per side had redded on streaming-arrival noise, with two develop runs differing more than develop vs candidate. Red-green: 2 specs fail with that rule off; 60 gate specs pass.
  - 2026-10-03 Machinefall run (runbook A2; WorldProbe cannot carry this regression: 0 of its 8 assets are alpha foliage, so `impostors: true` is a no-op there). Capture: Machinefall `feat/world-gate-capture` `9f6954b`, `apps/client/playtests/scenes/world-capture.playtest.json`, RTX 2080 WebGPU (nvidia/turing, headed, private Xvfb), importer `--scenario machinefall-world-capture --world Machinefall`. Arms: develop `9cf955355` core twice (`world.js` sha256 `2993475…`), develop with `impostors ?? true` (`f6c68e6…`). Three fresh blind critics per leg.
  - **Red half shown:** develop → impostors-on exits 1 (`regression`) with two measured LOSS rows (walk-16 and walk-24, median 3 → 2); develop → develop has zero LOSS rows (all four INDETERMINATE, delta 0). The relative arm separates the known-bad build from develop.
  - **Green half blocked by a real develop defect:** develop → develop also exits 1, only on the absolute floor: `pose-start` median 2/5 on both arms. At that pose a band of tree shadows lies on the meadow (≈80–300 m) with no trees in it while 61,309 instances are resident and `loadsInFlight` is 0 — shadow casters outreach the main pass's tree draw (caster meshes on layers 26–28 are skipped by `#cullMainPass`, `world-cells.ts:4240`; `VirtualShadowNode` admits them to ≈354 m, `virtual-shadow.ts:1411`). Handed to PRD-478 Phase 1 (runbook A3). This box stays open until develop greens.

### Phase 2 — Native and mobile proof

- [ ] The GPU scene's CPU fallback (PRD-473 AC-6) reports why it fell back in `TN_WORLD_GPU_SCENE` and holds its frame budget on the owned native host. proof: a `--target desktop` playtest scenario in `packages/runtime-native/conformance/registry.json`, green with the marker in the log.
- [ ] Streaming residency and the admission budget hold on Android with no game-side option. proof: a `--target android` playtest run on an emulator, residency and admission reported in `state.stats`.

### Phase 3 — Auto trigger and measured budgets

- [ ] Streaming turns on by itself when the content is cell-cooked or the world exceeds one ring, and a small arena scene that fits in one ring is unaffected — no streaming, no resident-cell churn. proof: a red-green spec in `packages/core/__tests__/` covering both a multi-cell world and an arena scene.
- [ ] `budgets` (`residentCells`, `instances`, `bytes`) and `ring` are derived from device memory and the frame budget where the platform reports them; Machinefall's numbers stay available as named overrides and still win when set. proof: a red-green spec asserting the derived values on a stubbed device, plus the override path.
- [ ] Every per-feature switch (`impostors`, `gpuScene`, `bundles`, `adaptiveLod`, `mergeTiles`) is an engine decision with a named override on the same object, and reports honestly when overridden. proof: a red-green spec per switch plus the marker line each one emits.

### Diagnostic capture correction — 2026-10-02

Hosted run [37021313951](https://github.com/ThreeNativeHQ/threenative/actions/runs/37021313951) at `2ca504da` retained 34 actual software-rendered frames with a clean console, but failed the scenario: resident-cell counts were 3 at both endpoints despite the observed series 3→6→9→12→9→6→3, six further residency transitions and nine evictions. The fixture now requires the measured cumulative transition counter to change instead of requiring different endpoint counts; the existing residency/instance ceilings, throughout-step samples, evictions and strict hardware gate are unchanged. A real-evaluator regression reproduces the false failure and rejects frozen warm-up, no evictions, zero residents and over-budget endpoints (11 fixture tests pass). The failed raw report is preserved; a new hosted run is required before claiming diagnostic success. This does not close any phase or acceptance criterion.

The next hosted run [37023158531](https://github.com/ThreeNativeHQ/threenative/actions/runs/37023158531) passed the scenario and all 34 nonblank screenshot checks with no diagnostics, but the importer correctly rejected duplicate endpoint poses: the observed release-boundary tick made each ten-tick input step advance eleven ticks, reaching the end at walk 29. The capture scenario now requests nine ticks per step, retaining the observed release tick, all 32 forward-walking captures and the unchanged route endpoints. An actual-scene cadence regression fails on the former pacing and passes on the correction (12 fixture tests); the strict chronological importer is unchanged. Fresh hosted verification remains pending.
