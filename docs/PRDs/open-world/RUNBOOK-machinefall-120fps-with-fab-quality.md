# Runbook: Machinefall walks at 120 fps with Fab-quality assets

**Point an agent at this file and say "run it".** It holds the goal, the order, the rules and the stop condition. Each row links the PRD that holds the actual work.
Created 2026-10-03, after #390 merged.

**Goal.** Two outcomes:
- (A) Machinefall `?scene=map-walk` **walks** at CPU and GPU p95 ≤ 8.3 ms on the RTX 2080 WebGPU adapter, with no visual loss. These are [PRD-478](../done/open-world/PRD-478-open-world-frame-architecture.md)'s AC-1, AC-2 and AC-3.
- (B) A cold agent's Fab or Megascans game ships its assets at full quality through the default cook, with no hand-set knobs, and stays inside that frame budget.

**Stop condition.** Every row below is ticked, or sits under an owner gate that is recorded as asked.

## How to run this file

1. **Pick the next row.** Take the first unticked row in Lane A whose "after" rows are ticked. Run Lane B and Lane C rows only in a parallel session. Use the `ci-pipeline` skill's claim board, so two sessions never take the same row.
2. **One PRD, one draft PR, one worktree.**
   - Branch from `origin/develop` into `.worktrees/<prd-slug>/` (the `git-worktree` skill).
   - Open the draft PR at the first commit and label it with what `pnpm prd:progress <prd>` prints.
   - If the PRD already has an open PR, reuse it.
   - Follow the `prd-lifecycle` skill: tick each box with its proof in the same commit as the work.
3. **Do the PRD's own boxes.** The PRD is the spec, and this file only orders the work. If a PRD's phase has no boxes, `prd:progress` exits 1, so add the boxes first.
4. **Measure the same way every time** (any row marked ⏱):
   - Use the Machinefall checkout that pins current core. In a Machinefall checkout, the `apps/client` `@threenative/core` dependency must resolve to code equal to `origin/develop`; `main` was on a stale tarball on 2026-10-03.
   - Run `playtests/scenes/map-walk.playtest.json` with `--browser-recipe webgpu --headed`. Check that `adapter.info` names the NVIDIA adapter, not SwiftShader.
   - Do 3 runs each, interleaved with develop, and read the `TN_FRAME_BUDGET` walk windows through `playtest perf --file`. Add `?tnFrameSpans=1` for attribution.
   - Record the load average. If CI runners shared the host, mark the numbers noisy and rerun the closing numbers on a quiet host.
   - Update "Where we stand" below in the same PR.
5. **Visual judges on every pixel-changing row** (any row marked 👁). This is required, not optional.
   - Capture before and after on the same poses.
   - Hand **only the blind directory** to **3 fresh judge subagents**. Never use the builder, never reuse a judge, and never show judges the seal, the reveal files or another judge's verdict.
   - **World rows (🌍):**
     - `pnpm visuals:world --before <develop>/world.json --after <candidate>/world.json --out artifacts/world-gate`
     - then `pnpm visuals:world --score artifacts/world-gate --verdict c1.json --verdict c2.json --verdict c3.json`
     - The run must exit 0 (judged pass). Judges follow [WORLD-VISUAL-GATE.md](../../product/WORLD-VISUAL-GATE.md) for both same-pose frames and the fixed-walk pop series.
     - Until PRD-477 Phase 1 has shown this gate going red on a known-bad build, also run the template check below and get the owner's side-by-side review.
   - **Template-look rows (🎨):**
     - `pnpm visuals:ab --raters 3` on before and after.
     - A performance or plumbing change must show no delta beyond the bundle's own resolution (`INDETERMINATE` or better on every template).
     - A look change must score **higher** on the templates it targets, and no lower elsewhere.
   - Put the verdict line (exit code, score, resolution) on the PRD box or in the PR body. A red verdict blocks the merge. Fix the change; never re-roll the judges.
6. **Owner gates (🙋)** are things only the owner can do: a side-by-side review, pausing the CI runners, an emulator or device. Ask once with the `attention-ping` skill, record that you asked, and carry on with the next independent row.
7. **Finish a row.**
   - The PR merges green, and the PRD moves to `docs/PRDs/done/` in the finishing commit when it closes.
   - Then tick the row here, in that same PR.
   - A row naming one phase is done when that phase's boxes are ticked and merged.
   - Clean up the worktree after the merge.

## Where we stand

Last measured 2026-10-03 against `origin/develop` `4d5e07c98`: nvidia/turing, 1280×720, DPR 1, MSAA 4×, 3 runs, noisy host (CI load).

Session log of the 2026-10-03 run: PRs #420–#425 and #396; see each row's Status line.

| | Walking p50 | Walking p95 | Standing p95 | Gap at p95 |
| --- | --- | --- | --- | --- |
| CPU render | 6.9 ms | **21.2 ms** | 4.5 ms | **12.9 ms** |
| GPU | 7.0 ms | 10.1 ms | 4.5 ms | 1.8 ms |

**Update 2026-10-05 (this PR, `558f08cbf`), two readings of the same runs:** nvidia/turing, `map-walk`, host load 6–35 (other sessions' native builds and CI on the same machine, so not the quiet host AC-1 asks for).

- Read as PRD-478's ACs define it — walk windows are `TN_FRAME_BUDGET` windows under 100 fps — the target is **not met by this PR or by develop**. Over 3 interleaved runs each (`.afk/scratch/walk-ac-pair-*`, load 8–35), develop: render p95 median 22.2 ms (p95 across windows 53 ms), GPU p95 median 6.1 ms (18.4 ms); this PR: render 21.0 ms (55.8 ms), GPU 6.8 ms (12.8 ms). The windows under 100 fps are the loading interval and the multi-second stalls, so this reading is mostly about load and stalls, which PRD-494 AC-1 already asks the owner to rule on.
- A looser reading — every window after the fourth, render p95 as the median of the windows' p95 — gives develop 7.8 ms (its 3 runs of 2026-10-04) and this PR 6.4 ms render, 6.5 ms GPU over 6 runs. That reading counts mostly smooth walking windows and is **not** the AC.
- `gpuMain` p95 per run in the interleaved set: develop 5.9 / 5.1 / 5.2 ms, this PR 4.8 / 5.3 / 4.6 ms — no GPU cost from this PR's changes.

AC-1 and AC-2 stay open.

**Update 2026-10-06 (what is left of AC-1, measured):** the steady walking frame of this PR reads render p95 7.2 ms on a quiet host (lenient reading). AC-1's own reading is held up by its slow windows, and they are not what they first looked like:

- Not the present path: headless and private-Xvfb walks read the same.
- Not texture uploads: 586 compressed uploads, each once; 0.18 ms of a 2.6 ms slow-window gap.
- Not chunk merges: now 4x faster, byte-identical, under 0.5 s per walk.
- Not GPU-scene queue calls: coalescing them cut 99% of those writes and moved nothing.

What is left is renderer JavaScript per render object. three's `Bindings.updateForRender` makes about 750 uniform writes a frame, 72% of all `writeBuffer` calls, plus the first draws of newly streamed chunks.

Skipping settled bundle records cannot remove that cost. Each record holds a private copy of the shared render-group uniforms: the material's bind group mixes object and render groups, so `sharedGroup` is false. Every skip either left that copy stale (a dark tree band) or kept no win. The lever is [PRD-400](../performance/PRD-400-the-frame-gets-cheaper-one-measured-cost-at-a-time.md)'s `bindings.updateForRender` mass: bind the shared groups once per pass.

**Update 2026-10-03 evening (PRD-494, #424):** 3 interleaved runs per arm, nvidia/turing, 1280×720, load 3.8–6.4 (quiet).

| | Walking render p50 / p95 | Walking GPU p50 / p95 | Walking main draws p50 | Idle render p95 |
| --- | --- | --- | --- | --- |
| develop `9cf955355` | 6.9 / 23.2 ms | 8.0 / 14.7 ms | 323 | 4.8 ms |
| PRD-494 bundles on (chunks + main batches recorded) | 4.3 / **18.3 ms** | 7.3 / 13.7 ms | **36** | 4.8 ms |

The per-draw `draw` span p95 fell 5.0 ms (6.0/5.3/5.7 → 0.6/0.8/0.6), but walking render p95 is still ~10 ms over budget: the next costs are the shadow-level re-render (PRD-478 Phase 2) and streaming (Phase 3). GPU p95 here comes from the pre-PRD-389 sampler (few samples per window); #421 fixes that.

The gap is CPU while walking. The costs, as span p95s, which overlap and do not add:
- Main-pass draw submission: ~330 draws × 16–26 µs, about 7 ms every frame.
- Shadow level re-render: ~476 draws, 4–17 ms on 2–8% of frames.
- WorldCells streaming: p95 7–9 ms.
- Mid-walk pipeline compiles: spikes of 113–247 ms.
- Cull, projection and LOD: 2–3 ms.

**Update 2026-10-04 (row A7 baseline):** develop core `1a6298cd` (`origin/develop`), nvidia/turing,
1280×720, `map-walk` with `tnFrameSpans=1`, 5 runs, GPU quiet at every run's start (6–15 %, nothing
but the desktop compositors), **host load 18–48** — other agents' builds, so the CPU-side numbers are
inflated against the 11–19 of the runs above and only the paired before/after in one lane is a
comparison. Runs in `.afk/scratch/walk-quiet-r2-{1,2,4,5,6}`.

| | Walking render p50 / p95 | Walking GPU p50 / p95 | Frames > 33 ms | Worst present gap |
| --- | --- | --- | --- | --- |
| develop, median of 5 | 13.4 / 25.9 ms | 3.6 / 21.6 ms | 48 of 1024 | 17.1 s |

What the pipeline census says, per run, counting only creations after `startup.compileSettledMs`:

| | streamed batch | other passes | summed device service |
| --- | --- | --- | --- |
| every one of the 5 runs | **8** (7 main pass, 1 shadow caster half) | 16–22 compute, 12 main, 4–5 shadow | 3.6–7.8 ms, of the streamed 8: 1.1–1.6 ms |

Two facts the census forced out, both about the prewarm and not about the device:

1. `TN_WORLD_PREWARM minted=385 shadowPrewarmed=0 castersUnbuilt=182` in every run. The prewarm mints
   an empty `InstancedMesh` and waits for a draw to build its node. Three never submits one:
   `RenderObject.getDrawParameters()` returns `null` at `count === 0`, so an empty batch builds
   nothing in any pass, and the gate settles with 182 casters unbuilt.
2. The 8 streamed creations are the **GPU-driven main pass's** fresh objects. `#dressGpu` cannot
   re-dress a mesh three has compiled (its instancing node binds the `instanceMatrix` it held), so a
   key dressed after the gate gets a brand-new object whose node and pipeline the first draw builds —
   on a walking frame.

Off-frame preparation through the engine's own `compileAsync` seam **hangs the walk**: with the swap
deferred until that compile settles, `walk-a7-r2-1` reached the playtest's 900 s timeout (14 min
against 3.5 min for the same scenario on `core-dev2`, same host load), because `compileAsync` drives
the renderer's own frame state and a live renderer mid-walk is not a caller it survives. Behind the
gate, where nothing is presented, the same call is what `#warmChunk` already does. So A7's mechanism
is not a small change: it needs a preparation seam that does not borrow the live renderer.

**Update 2026-10-04 (row A7, attempt 2 — the prewarm draw made real, and the gate never opens):**
the first cause above was fixed at the mechanism level, unit-proved, and it **blocks Machinefall's
launch**, twice, so the row is still open and the fix is not to be merged as it stands. An empty
prewarmed batch now submits one instance of the zero matrix its own fresh buffer holds
(`SharedBatch#publish`; three refuses a `count === 0` draw outright), which is the submission that
builds the node and the pipeline, and `prewarmDrew` puts the honest count back. The harness that
counted the prewarm's draws had left out three's own count gate, so it passed with 8 of 17 casters
unbuilt; with that gate in, `world-cells-shadow-prewarm` reads `castersUnbuilt=8` before the change
and `castersUnbuilt=0` after it, and every prewarmed caster still first draws behind the gate.

Measured on the walk, alternating arms in one lane, `map-walk` with `tnFrameSpans=1`, nvidia/turing,
1280×720, host load 24–32 throughout (other lanes), runs in `.afk/scratch/walk-a7b-pair-{1,2,3,4}`:

| arm | core | outcome | streamed creations after settle | prewarm line | frames > 33 ms | render p50 / p95 | GPU p50 / p95 | load → compileSettled |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dev, pair-1 | `core-dev2` (`1a6298cd`) | pass in 2 min 59 s | 18 of 127 (1.7 ms) | `minted=385 shadowPrewarmed=0 castersUnbuilt=182` | 13 of 1024 | 8.2 / 15.7 ms | 1.6 / 10.6 ms | 17.8 s (`pipelines=1895`) |
| dev, pair-3 | `core-dev2` | **fail**: 2 state failures + 3 console/network errors, 4382 frames | — | — | — | — | — | — |
| a7, pair-2 | `core-a7b` | **blocks the page**: 900 s timeout | — | never printed | — | — | — | never |
| a7, pair-4 | `core-a7b` | **blocks the page**: 900 s timeout | — | never printed | — | — | — | never |

Both `a7` runs stall at the loading gate with `TN_STARTUP_STALLED: progress has stood at 0.0 % for
45 s — still loading: nothing, no asset is outstanding`, the page's main thread never yields again
(`Bridge operation 'describe' exceeded 915000 ms`), and the walk never starts, so there is no
mid-walk census, no frame series and nothing to capture. The `dev` arm's pair-3 failure is the same
host's noise (two failed loads and three network errors on an unchanged core) and the lane does not
claim a CPU comparison from these runs — the walk numbers in the row above are the 5-run baseline.

So the honest state of the row: the mechanism is right and provable in the fixture world, and fatal
at Machinefall's scale, where 385 keys × 2 variants behind the gate is a different cost than 24
keys × 2. What is **not** yet known is which of two things the gate is paying — the node builds
themselves, or `#drainPrewarm`'s own loop (it invalidates the shadow levels on every update while a
caster is owed, and each of those level renders now submits every prewarmed caster) — and the next
step is one instrumented run that separates them, not another guess. Until then A7 needs the
preparation seam PRD-387 describes, and this arm must not merge.

**Update 2026-10-05 (row A7, attempt 3 — the launch hang was not the prewarm):** the hang above was
PRD-493's splat table throw (`world-terrain-splat.ts`, a layer table written before the `orm` column),
which this PR now fixes: the same #437 core *without* the prewarm hung too, and with only the splat
file restored it loaded. With that fixed, the prewarm loads. Twelve alternating runs, `map-walk`,
`tnFrameSpans=1`, nvidia/turing, host load 6–26, in `.afk/scratch/walk-a7{c,d}-pair-*`:

| arm (6 runs each) | render p50 / p95 | GPU p95 | creations after settle | prewarm line |
| --- | --- | --- | --- | --- |
| #437 `558f08cbf` | 3.1 / 6.4 ms | 6.5 ms | 28 (12 compute, 12 main, 4 shadow) | `shadowPrewarmed=0 castersUnbuilt=182` |
| #437 + prewarm | 3.1 / 6.1 ms | 6.3 ms | 28, the same split | `shadowPrewarmed=0 castersUnbuilt=182` |

Render p95 is the median of the walk windows' p95 (`TN_FRAME_BUDGET` after the fourth window), and GPU
p95 the p95 of the windows' timestamp means. The arm that ran second was faster in both orders, so
the 0.3 ms between the arms is order, not prewarm. Reading the census:

- On Machinefall the prewarm prepares nothing. The caster admission this PR adds holds every caster
  half while the seed drains, so the prewarm's draw never reaches a shadow pass.
- No compile costs a frame. The 28 post-settle creations are streamed props and bridge pieces, at
  most 0.2 ms of device service each, 1.3–1.9 ms in a whole walk.
- AC-3 as written is still red: 28 creations after warm-up.

One prewarm run of six timed out on a 22.5 s `advance` stall. Both arms show multi-second stalls on
this host, so it is not attributed. The prewarm (`e580e76cb`) stays off this PR, on the local branch
`a7-prewarm-trial`. A7 stays open on AC-3, but it is no longer on the frame-time critical path.

## Lane A — the 120 fps walk (critical path)

- [x] **A0 · Land [PRD-484](../done/PRD-484-instanced-lod-and-mirror-by-default.md)** (instanced LOD + selective water mirrors by default). After: nothing. 🌍👁
  - Its commits exist only on the unpushed local branch `engine-defaults-484`, plus uncommitted edits in `.worktrees/prd-484-engine-defaults`.
  - Ask the owner 🙋 whether those edits are still wanted, then rebase onto `origin/develop` and open its own draft PR. Its old plan to ride #390 is moot, because #390 merged without it.
  - **Done 2026-10-05:** the PRD's phases landed through #423 (merged 2026-10-04; #420 closed unmerged). Its last box passed on the Strata game with the stopgap reverted, under the develop defaults: scene 96.4 M → 15.8 M triangles at the worst view, mirror 96.4 M → 0.92 M in 3 draws. The game edits are restored, and the PRD moved to `done/` in this PR.
  - Done when: its PRD is in `done/` on `develop`.
- [x] **A1 · [PRD-389](../performance/critical/PRD-389-the-frame-budgets-instruments-do-not-lie.md): the instrument gaps the 2026-10-03 probe hit.** After: nothing.
  - A standing scene can't be measured under `runtime.fixedStep` (it yields one window).
  - The update phase reads 0.
  - `passes.main.triangles` reads 338 M.
  - Only about 15 of 300 frames carry a GPU timestamp, too few for a GPU p95.
  - Done when: each gap has a ticked box in PRD-389.
  - **Done 2026-10-05:** PRD-389 Phase 4 ("the 2026-10-03 Machinefall probe's gaps") reads 5 ticked / 0 open on `origin/develop`, one box per gap above (counted tick batch charged to `update`, main-pass GPU-selected triangles beside three's CPU figure, the 1-in-N GPU sampler counting drawn frames, a standing scene measurable under the wall-clock opt-in); landed by #423, merged 2026-10-04.
- [x] **A2 · [PRD-477](PRD-477-worldcells-auto-on-measured-budgets.md) Phase 1: the world gate goes red, then green.** After: nothing; runs alongside A1.
  - The gate must red on an impostors-on build (#375) and green on develop. Every later 🌍 row trusts it.
  - Done when: both Phase 1 boxes are ticked.
  - **Done 2026-10-05:** both Phase 1 boxes ticked in this PR. On Machinefall with 2 + 2 runs and 3 blind critics each: develop vs develop **passes** (exit 0); develop vs impostors-default-on **reds** (exit 1, distant crowns missing in every impostor run). The gate change in this PR scores a candidate event only when it is in every candidate run and in no reference run.
- [ ] **A3 · PRD-478 Phase 1: measure the shadow-window work that #390 already merged.** After: A1 and A2. ⏱🌍👁🙋
  - The owner side-by-sides the camp and highway aerials against `?refShadow=1`. The first candidate failed exactly that review.
  - Status 2026-10-03: draft PR #423; two bias fixes landed (hold during load; drawable level), start-pose defect persists (GPU-scene path + bias ≥2 renders coarse levels invisibly); counters: `byMove` repeatable at labelled ticks. Owner side-by-side vs `?refShadow=1` still owed (🙋).
- [ ] **A4 · [PRD-494](../done/PRD-494-the-main-pass-fits-the-draw-budget.md): the main pass fits the draw budget.** After: A3. ⏱🌍👁
  - The largest cost. Attribute the ~323 draws by source, then take the largest source off three's per-draw path, `bundles` or a merged path.
  - Status 2026-10-03: draft PR #424 (prd:50%); main draws 323 → 36, `draw` span −5.0 ms (3 interleaved pairs), bundles on by default, blind gate 0 LOSS; AC-1 open only for the loading window.
- [ ] **A5 · PRD-478 Phase 2: shadow levels draw GPU-scene keys.** After: A4. ⏱🌍👁
- [x] **A6 · PRD-478 Phase 3: terrain merges and seams run in a worker.** After: A5. ⏱🌍👁
  - **Done 2026-10-05:** both Phase 3 boxes are ticked. The worker path's main-thread `terrainBlock` and `terrainSeam` spans read 0 ms at p50 and ≤ 0.7 ms at p95 over 2 Machinefall walks; worker vs inline bytes are identical by spec. The workerless inline path hashes identically on web and on the native desktop host (`world-terrain-inline-hash`).
  - The settled terrain must be byte-identical to the inline path.
- [ ] **A7 · No pipeline compiles mid-walk:** [PRD-459](PRD-459-smooth-streaming-one-admission-budget-per-frame.md) AC-3 with [PRD-387](../performance/critical/PRD-387-shader-variants-are-prepared-off-frame-and-bounded.md). After: A6. ⏱🌍👁
  - **Measured 2026-10-04, still open.** 8 pipeline creations attributable to a streamed batch after
    `compileSettledMs`, in all 5 baseline runs, from `#dressGpu`'s fresh objects; and a prewarm that
    cannot prepare anything, because three never submits a `count === 0` batch. The engine's
    `compileAsync` seam hangs a live renderer mid-walk (900 s timeout, measured), so the row needs a
    preparation seam that does not borrow the frame the walk is drawing. Details in "Where we stand".
  - **Attempt 2, measured 2026-10-04: the non-zero prewarm draw is proved and fatal.** Unit-proved
    (`castersUnbuilt=0` where the old harness read 8 of 17), and on the walk it blocks the launch in
    both alternating `a7` runs at 0.0 % progress with the page's main thread never yielding, so there
    is no walk to compare. Nothing ticked, nothing to capture, and that arm must not merge; the row
    needs one instrumented run to separate the gate's node builds from its own per-update shadow
    invalidation before this mechanism is retried. Details in "Where we stand".
- [ ] **A8 · [PRD-539](../Unreal/performance/PRD-539-low-resolution-temporal-reconstruction-quality-and-cost.md): temporal reconstruction closes the GPU gap (successor of PRD-455).** After: A7. ⏱🌍👁
- [ ] **A9 · PRD-478 acceptance.** After: A8. ⏱🌍👁
  - Done when: AC-1, AC-2 and AC-3 are ticked on a quiet host 🙋; then PRD-478 may move to `done/`.
- [ ] **A10 · PRD-477 Phases 2–3 and AC-1: budgets and switches become engine decisions.** After: A9. ⏱🌍👁
- [x] **A11 · [PRD-489](../done/PRD-489-gpu-scene-occlusion-culling.md) Phase 1 only: the occlusion go/no-go.** After: A9. ⏱
  - If it declines, record the decision and close the PRD. If it goes ahead, its Phases 2–3 become row A12. 🌍👁
  - **Done 2026-10-06: it declines (D32).** The first reading (share 0.61, "go") came from a pyramid bug that also deleted visible trees once culling ran. With the bug fixed, the share is a median of 0.013, and 0.013 × about 9 ms − 0.07 ms ≈ 0.05 ms, under the 1.0 ms threshold. PRD-489 is closed, and the corrected `?tnOcclusion=measure` stays as the instrument.

## Lane B — Fab-quality assets at that frame rate

- [x] **B1 · [VQ-01](../done/PRD-VQ-01-native-asset-capabilities.md): native asset capability guard.** After: nothing.
  - It already has a draft PR, #396. `assertNativeAssetsCompatible` currently rejects KTX2 and meshopt on every Android and iOS build.
  - **Done 2026-10-05:** #396 merged its phases (2026-10-04). The last box, the lifecycle release, passes on nvidia/turing: geometryGrowth 0, textureGrowth 0. The old 6/3 was a baseline read before the first world pass had drawn, not a leak; every owned dispose was counted at 6 + 3 per enter. The PRD moved to `done/` in this PR.
- [x] **B2 · [PRD-485](../done/PRD-485-high-quality-assets-go-through-the-cook.md): high-quality assets go through the cook.** After: B1 for its Android box only. 🎨👁
  - fab-import-proof, lumen-hall and metahuman-lab drop their escape hatches.
  - **Done 2026-10-06:** the last box, Android, passes on the emulator (not a phone): `fab-import-native.playtest.json --target android` 6/6 with 0 diagnostics, the Hornbeam cooked to KTX2 + Meshopt under Android V8. It needed Android V8 to admit KTX2/Meshopt and the native host to map ETC2/EAC/ASTC formats. The PRD moved to `done/`.
- [ ] **B3 · Texture residency:** [VQ-10](../Unreal/performance/PRD-VQ-10-texture-mip-residency.md) together with [PRD-454](PRD-454-worldcells-budget-real-resources.md). After: B2. ⏱🌍👁
  - Machinefall's 1024 texture cap is lifted to 2048 inside a hard GPU byte budget, with no black frames.
- [ ] **B4 · [PRD-377](../assets/PRD-377-auto-lod-is-on-by-default.md) Phase 4: AutoLOD on by default.** After: B2. ⏱🎨👁
- [ ] **B5 · [PRD-486](PRD-486-characters-get-a-lod-chain.md): characters get a LOD chain.** After: B4. ⏱🎨👁
- [ ] **B6 · [PRD-487](../Unreal/assets/PRD-487-imported-materials-keep-their-detail.md): imported materials keep their detail.** After: B2. 🎨👁
  - It needs a change in the asset-mcp repo; that repo's PRs target its `main`.
- [ ] **B7 · [PRD-488](PRD-488-foliage-moves-in-the-wind.md): foliage moves in the wind.** After: B6, and A5 for its shadow box. ⏱🌍👁
- [ ] **B8 · [PRD-351](../assets/PRD-351-compression-never-looks-worse-than-a-floor.md): compression quality floor.** After: B2. 🎨👁

## Lane C — look and native parity (independent; any free session)

- [x] **C1 · [PRD-339](../done/PRD-339-the-frame-sets-its-own-exposure.md): auto exposure.** 🎨👁
  - **Done 2026-10-05:** #397 merged 2026-10-04; `docs/PRDs/done/PRD-339-the-frame-sets-its-own-exposure.md` on `origin/develop` reads 11 ticked / 0 open.
- [x] **C2 · [PRD-492](../done/PRD-492-colour-grading-and-film-grain.md): colour grading and film grain.** 🎨👁
  - **Done 2026-10-05:** AC-2: 3 blind raters score the graded frame equal to the ungraded one, and the HUD is not graded. AC-1: grade + grain cost 0.0 ± 0.1 ms GPU at 1080p. The table loads as float, so an identity round trip is exact. The identity frame matches the chain-rebuild control; the proof decision is recorded in the PRD. The PRD moved to `done/` in this PR.
- [ ] **C3 · [PRD-493](PRD-493-terrain-layers-past-sixteen-textures.md): terrain layers past sixteen textures.** ⏱🌍👁
  - **Progress 2026-10-06:** the Android box passes on the emulator (not a phone): `terrain-splat-array` matches the browser reference at 0 pixel mismatch and 0 ΔE, with `samplers=4`. All three phases have landed. AC-1 and AC-2 still need Machinefall's private walk.
- [ ] **C4 · [PRD-491](PRD-491-water-and-atmosphere-run-native.md): water and atmosphere run native.** 👁
  - Compare native frames against web frames with the same judges.
- [ ] **C5 · [PRD-490](PRD-490-cluster-lod-wins-on-native.md): cluster LOD wins on native.** ⏱👁
- [ ] **C6 · Off-screen GI:** [PRD-245](../rendering/PRD-245-indirect-light-is-a-node-the-game-composites.md), [PRD-267](../useful-defaults/PRD-267-screen-space-gi-ships-in-the-templates.md), [PRD-268](../rendering/PRD-268-light-that-comes-from-off-screen.md), [PRD-270](../useful-defaults/PRD-270-no-lighting-node-ships-web-only.md). After: A4. ⏱🎨👁
  - Consolidated 2026-10-03: [PRD-267](../useful-defaults/PRD-267-screen-space-gi-ships-in-the-templates.md) is now the single plan in 3 phases; PRD-245, PRD-268 and PRD-270 are SUPERSEDED and folded into it. Start at PRD-267 Phase 1.

## Housekeeping (any session; docs-only, commit straight to `develop` per AGENTS.md)

- [x] Three PRDs share the number 339: AAA-visuals auto exposure, performance loading screen, critical compile walk. Renumber two of them and fix their links. **Result 2026-10-03:** auto exposure keeps 339 (PR #397); the other two are now 540 (compile walk; first 495, renumbered 2026-10-08 because #439 took 495) and 496 (loading screen). proof: `git mv` + `rg --no-ignore 'PRD-339'` returns only auto-exposure mentions.
- [x] Fix status drift:
  - critical [PRD-386](../performance/critical/PRD-386-gpu-driven-rendering-compute-culling-and-indirect-draws.md) and [PRD-390](../performance/critical/PRD-390-do-not-submit-what-the-render-camera-cannot-resolve.md) say NOT STARTED, but their mechanisms shipped in PRD-473 and #263; **Result 2026-10-03:** both now read PARTIAL and cite `8c182343f` (#263) and `a602467db` (#375, PRD-473 Phase 1). proof: `git show --stat 8c182343f a602467db`.
  - PRD-269 has landed (`3630847a`); **Result 2026-10-03:** PROPOSED → PARTIAL, cited to `3630847a`. Kept out of `done/` — criterion 3's playtest does not exist. proof: `git show --stat 3630847a`.
  - [PRD-461](../done/open-world/PRD-461-view-distance-basics.md)'s `terrain.streamRadius` blocker has landed. **Result 2026-10-03:** NOT STARTED → READY, citing `4f9638c2e` (#358). proof: `git log -S streamRadius -- packages/core/src`.
- [x] Remove the stale duplicates `meta-human/PRD-465` and the batch copy of `PRD-VQ-11`. **Result 2026-10-03:** both deleted; each was a strict prefix of its `done/` copy (465: 12 stale-only lines, all pre-execution status and unticked boxes; VQ-11: 14, all the same). No link pointed at either stale path. proof: `diff` against `docs/PRDs/done/`.
- [x] Update `00-REPO-GROUNDING.md` (virtual shadow maps ship) and WORLD-STREAMING.md (virtualized geometry ships; occlusion is now PRD-489's call). **Result 2026-10-03:** `VirtualShadowNode`/`readVirtualShadowMarker` ship from `@threenative/core` since `161d11222` (PR #46) — all three F14 rows corrected from "Nothing / greenfield" to Shipped with the page path (PRD-457) as the remaining work. The guide gained one section naming `ClusteredMesh`/`ClusteredBatch`, `gpuScene` on by default, and PRD-489 as the occlusion go/no-go. proof: `rg 'VirtualShadowNode' packages/core/src/index.ts`.
- [x] Refresh rows G04, G05, G11, G15 and G16 in `docs/unreal-engine/ThreeNative_Unreal_Visual_Gap_Tracker.xlsx`. **Result 2026-10-03:** all five read Partial with current state, next action and date: G04 → PR #397 in review, G05 → PRD-341 done + world gate pending A2, G11 → VQ-07 on PR #399, G15/G16 → PRD-386/390 PARTIAL. Edited in the sheet XML (34 cells), so formatting and formulas are untouched. proof: an openpyxl cell diff shows only those 34 cells changed.

## Not on this runbook, by decision

- Motion matching: gated on PRD-039's triggers.
- Large-world coordinates: only matter past 2 km.
- A Niagara-style module layer: it would own the look.
- Virtual texturing: out of scope per WORLD-STREAMING.md.
- WorldCells data layers: no consumer yet.
