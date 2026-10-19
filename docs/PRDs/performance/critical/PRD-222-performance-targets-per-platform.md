---
prd_contract: v1
---

# PRD-222 — every platform has a frame-rate target, and a gate that fails when it is missed

**Status:** PARTIAL — Phase 0 measured 2026-08-25; native/browser parity is 0.319 on the physical
Pixel 8. **Phase 1 landed 2026-09-03** (`assert.parity` + shipped `minFps` floors, red observed —
`docs/verification/prd-222-phase1-2026-09-03.md`); Phase 2 engine work is next. This PRD is written
to be executed by an agent looping until the bar is met, so every target below names the command
that decides it and the evidence that closes it.
**Complexity:** +3 measurement across five platform lanes, +2 complex performance work,
+1 device seam = **6 → HIGH mode**, checkpoint after every phase.

**Priority:** P2 — Remaining boxes fill Tier 1 and Tier 3 floors and one sustained run per lever.
**Moved to `performance/critical/` 2026-09-02.** This is the acceptance bar for every row in
[`README.md`](README.md); it is critical because nothing else decides when a launch or frame
change is done. What changed since Phase 0: a scaffolded template now holds Tier 1 on an
unplugged Pixel 8 at full resolution (`runtime-perf-state.md` §1.3.8: 59.99–60.02 fps, three
captures, SurfaceFlinger 0 dropped), so **Phase 1's gates can be written red-green today** against
that lane; Tier 2's parity row gets its first matched-pixel number from
[PRD-329](PRD-329-the-native-gpu-frame-matches-chrome-at-matched-pixels.md); the launch half of
Tier 3 is executed by
[PRD-327](PRD-327-first-use-pipeline-compilation-leaves-the-main-loop.md). Phase 2 engine work
here must not duplicate those PRDs — this PRD owns the gates and the tiers, they own the
mechanisms. Execute Phase 1 after PRD-327 lands, or earlier if a lane is free.

**Depends on:** `packages/core/src/frame-budget.ts` (`TN_FRAME_BUDGET`, landed by PRD-214 Phase 3),
`assert.performance` in `packages/playtest` (`minFps`, `maxFrameMsP95`, `maxPhaseMsP95`),
`observations.deviceMetrics` and `packages/runtime-native/scripts/device-preflight.mjs`.

## Context

The owner's bar, stated 2026-08-25: **"we should run with the same performance as web."** That is
the right target and it is not yet a gate. Today the only fps floor in the repo is a single
`minFps: 24` on one example scenario; no platform has a stated ceiling, no lane compares native
against web, and the phone number nobody can beat has been re-derived by hand three times in three
sessions.

### What is measured today, and what it is worth

Every row is from a physical Pixel 8 (`shiba`, Mali-G715, 60 Hz) or a desktop Chromium WebGPU run.
Rows marked **pre-fix** were taken before the material-keyed batch lane landed (`385fd50e`,
2026-08-25) and are therefore a baseline, not a current state.

| lane | scene | fps | frame p50/mean | render | notes |
| --- | --- | --- | --- | --- | --- |
| native Android, 2400×1080 | bayview | **17.3** | 51.8 ms | 41.7 ms | pre-fix, cool: 31 °C, thermal 0 |
| native Android, 1200×540 | bayview | **23.1** | 41.5 ms | 35.2 ms | pre-fix; ¼ the pixels buys 15% of render |
| **native Android, 2400×1080** | bayview | **20.1** | 34.9 / 33.7 ms | 28.5 ms | post-fix (`385fd50e`), cool ~29 °C start, thermal 0 — full record in the bug file below |
| **native Android, 1200×540** | bayview | **30.1 → 34.5** | — / 32.4 → 25.0 ms | 31.4 → 21.6 ms | post-fix matched-warm A/B pair (~36 °C both arms): pre-fix declined at 30.1 fps, post-fix folded 13 batches at 34.5 |
| native Android, 2400×1080 | starter | **59.99** | 8.47 ms | 7.88 ms | light scene, same host, same phone |
| browser desktop (Vulkan) | bayview | ~69 | 14.5 ms p95 | — | `frame-smoothness.playtest.json`, 1302 frames, 0 spikes |
| **browser Android (Chrome 151)** | bayview | **59.99** | 9.5 / — ms | 10.1 ms p95 | Phase 0, physical Pixel 8, same build/thermal window as native; full record below |

The post-fix device rows come from the bug file's device record
(`docs/bugs/render-projection-cannot-batch-differing-geometries-2026-08-25.md`, commit `ba78ce42`),
which this PRD named as the first measurement to collect. The headline floor is still missed at
native resolution: 20.1 against a 30 fps Floor — but the margin math below says it is close.
Phase 0's matched browser/native run is in `docs/verification/runtime-perf-state.md`: Chrome
measured 59.99 fps and native 19.15 fps, for 0.319 fps parity and 0.301 inverted render-p95 parity.

Three things follow, and they shape every target below.

1. **The host is not the ceiling.** The same native runtime on the same phone renders the starter
   template at 59.99 fps. Whatever costs bayview 42 ms of render is content and draw submission,
   not the C++ host.
2. **It is draw-bound, not fill-bound.** Quartering the pixel count cut render time 15%. Recorded
   refuted twice; do not re-test it.
3. **"Same performance as web" is only meaningful on the same device.** Desktop Chromium runs on a
   discrete GPU; the Pixel does not. Comparing 69 fps there against 17 fps here measures the
   hardware, not the framework. The honest comparison is Chrome-on-the-Pixel against
   native-on-the-Pixel, and that number has never been taken.

### What the batch-lane device session already showed (2026-08-25)

Four findings from the session that took the post-fix rows above, recorded here so the loop does
not pay for them again.

1. **The 60 Hz panel quantizes bayview's fps to vblank cells, and the 30 fps Floor sits exactly
   one cell away.** Post-fix at native resolution: `frame.mean` 33.7 ms inside a `presented.mean`
   of 49.8 ms = 49.8 ÷ 16.67 ≈ **2.99 vblank cells** per frame — the game renders in ~2 cells
   then waits for the third. That is why the fix moved fps 17.3 → 20.1 (an unstable 3-to-4-cell
   cadence became a solid 3) without render dropping proportionally. To hold 30 fps the whole
   frame must fit **2 cells**: `render.p95` has to come down from 34.8 ms to under ~33 ms — a
   bounded 5–7 ms lever, not an open-ended climb. It also means fps improvements will arrive in
   steps (20 → 30 → 60), never smoothly, and a gate should expect that.
2. **After the fix, render still owns the frame; hostGap is vsync, not host.** Cool window:
   render 28.5 of 33.7 ms (~57 %), update 1.8 ms, residual 0.4 ms, hostGap 16.1 ms — but that
   hostGap is present-wait quantization (frames ready early, panel not), so chasing it as a host
   cost would burn a rung on nothing. PRD-214's ranking stands: material/node evaluation first,
   shadow pass second.
3. **A pre-existing SIGSEGV kills ~1 launch in 3 at 25–40 s, on both sides of any A/B.**
   Physics-bridge callback dispatch, null/dangling `std::function`, A/B-proven not the batch
   lane's:
   `docs/bugs/physics-simulation-callback-segv-flaky-2026-08-25.md`. Every measurement loop on
   this lane must check `pidof` after launch and re-launch on death — or fix the crash first,
   because every silent death costs a relaunch, a heat-soak cycle, and battery toward the floor.
4. **Cooling stalls are real; matched-warm pairs are the fallback.** After a heavy run the phone
   plateaued at ~34 °C for 20+ minutes of idle, and an unrelated heat source (a browser left
   running on the device at 94 % CPU) can silently warm a "cooldown". When the start temp cannot
   be reached, two arms back-to-back at the same elevated temperature still support a *relative*
   delta — that is how the 1200×540 pair was taken — but absolute claims need the cool start.

## Solution

**Two axes, because they fail for different reasons and have different owners.**

- **Overhead** — what the framework costs on a scene that is nearly empty. Owned by the engine.
  Measured on the starter template, which every platform can run.
- **Parity** — what the framework costs *relative to the browser on the same device*, on a real
  scene. Owned jointly: a gap is engine work; no gap on a slow number means the scene is too heavy
  and the fix is content.

A parity ratio is the load-bearing idea here. It cancels the hardware out, so one number means the
same thing on a Pixel 8, a laptop and whatever ships next year.

```mermaid
flowchart TD
    P0["Phase 0 — calibrate<br/>Chrome on the Pixel, bayview"] --> R{"native ÷ web<br/>on the same device"}
    R -->|"< 0.9"| E["engine work:<br/>close the gap"]
    R -->|"≥ 0.9, fps still low"| C["content work:<br/>the scene is too heavy"]
    E --> G["gates land per lane"]
    C --> G
    G --> L["loop until every target green"]
```

## The targets

Four tiers. A lane is **red** below Floor, **amber** between Floor and Target, **green** at or
above Target. The loop's job is to take every lane to green and keep it there.

Tiers 1–3 are measured on a cool phone and answer *"is this faster"*. Tier 4 is measured on a
phone nobody is cooling and answers *"is this shippable"*. A green in the first three and a red in
the fourth is a game that demos well and cannot be played, so none of them substitutes for
another.

### Tier 1 — overhead, on the starter template

The framework's own cost, on a scene with nothing interesting in it. No excuse applies here: a
miss is engine work.

| platform | Floor | **Target** | measured today |
| --- | --- | --- | --- |
| browser, desktop Linux (WebGPU/Vulkan) | 60 fps | **matches display refresh** | unmeasured |
| browser, Android Chrome | 30 fps | **58 fps** | unmeasured |
| native, desktop Linux | 60 fps | **matches display refresh** | unmeasured |
| native, Android (Pixel 8) | 55 fps | **58 fps** | **59.99** ✅ |
| native, iOS | — | — | no lane; named unverified |

Phase ceilings at p95, all platforms, starter template:
`hostGap ≤ 4 ms`, `update ≤ 2 ms`, `residual ≤ 0.5 ms`, `overlay ≤ 1 ms`.

### Tier 2 — parity, on a real scene

Run the **same scene** twice on the **same device**: once in that platform's browser, once on the
native host. `parity = nativeFps ÷ webFps`.

| measure | Floor | **Target** |
| --- | --- | --- |
| `parity` (fps) | 0.85 | **0.95** |
| `parity` (render phase p95, inverted) | 0.80 | **0.95** |

**0.95, not 1.0, and not higher.** The native host and the browser do not schedule identically —
the browser owns its own compositor and vsync, the host owns a present tick — so demanding exact
equality would make the gate fail on noise rather than on regressions. Ratios above 1.0 are
allowed and interesting; record them, never clamp them.

A parity run whose two halves were not taken on the same device, within the same thermal window,
against the same build of the scene is **not a parity run** and must be discarded.

### Tier 3 — shippability, on the game a player holds

The absolute floor a real game must clear on the reference phone before it is called finished.

| scene class | Floor | **Target** |
| --- | --- | --- |
| light — the starter, a menu, a title | 55 fps | **58 fps** |
| medium — one arena, a few characters | 30 fps | **58 fps** |
| heavy — bayview: a town, 5v5, ~800 renderables | **30 fps** | **58 fps** |

**bayview is the hard case on purpose.** It is 17.3 fps pre-fix. Getting it to 30 is this PRD's
headline, and to 58 is the stretch.

### Tier 4 — sustained, on a phone nobody is cooling

Every tier above is measured on a cool device, because a comparison against a varying thermal
state measures the weather rather than the code. That is right for *"is my change faster"* and it
is **not enough to ship on**, because a player has no fan. A game that holds 58 fps for ninety
seconds and then throttles to 25 is broken, and Tiers 1–3 would call it green forever.

So one lane deliberately does not cool the phone. It starts cool, runs long, and reports what the
player actually gets.

| measure | Floor | **Target** |
| --- | --- | --- |
| run length | 10 min continuous, no cooling, no charger | **10 min** |
| fps in the **last** minute ÷ fps in the first | 0.75 | **0.90** |
| absolute fps in the last minute, heavy scene | 25 fps | **50 fps** |
| peak battery temperature | ≤ 45 °C | **≤ 40 °C** |
| peak thermal status | ≤ 2 (MODERATE) | **≤ 1 (LIGHT)** |
| whole-device current, steady state | — | **report it, do not gate it yet** |

**This is the tier bayview currently fails and the others would hide.** Measured 2026-08-24
(`docs/verification/runtime-perf-state.md`): the phone heat-soaked
35.4 → **43.2 °C into thermal status 2**, the GPU rail `S2S_VDD_G3D` went 2.2 mW idle to
**423.7 mW**, and whole-device draw went −217 mA to −611 mA with peaks at −1327 mA. Past status 2
every other measurement on the device becomes unreliable, which is the second reason this tier
matters: it is the lane that tells you the rest of the lanes are still trustworthy.

A Tier 4 run is the one run that is **never** discarded for being thermally confounded — being
thermally confounded is the thing it measures. It is reported in full, always.

Sustained runs are expensive: they cost ten minutes of phone time plus the cooling before them,
and they drain the battery toward the preflight floor. Run one per lever that lands, not one per
change.

### Thermal and power, on every device run

These bound Tiers 1–3, where frame rate measured on a hot phone is not a measurement. **They do
not apply to Tier 4**, whose whole subject is what happens as the phone heats:

| measure | limit |
| --- | --- |
| battery temperature at start | ≤ 35 °C |
| thermal status at start | 0 (NONE) |
| thermal status at any sample | ≤ 1 (LIGHT) |
| temperature rise across the run | ≤ 6 °C |
| charging | **not charging** — use Wi-Fi ADB |
| battery level | ≥ 50% (`device-preflight.mjs`) |

A run flagged `thermallyConfounded` reports its numbers in full and **withdraws the comparison**,
never the measurement.

## How each target is measured

The loop must use these exact commands. A number produced any other way does not close a row.

**Preflight, before any device run:**

```sh
node packages/playtest/dist/runner/cli.js doctor --device <serial> --text
node packages/runtime-native/scripts/device-preflight.mjs <serial>
```

**Browser, desktop:**

```sh
node packages/playtest/dist/runner/cli.js <scene>.playtest.json \
  --url http://127.0.0.1:<port> --server-command "<dev command>" \
  --browser-recipe webgpu --headed
```

`--browser-recipe webgpu` is mandatory and `--headed` is mandatory for any pixel-producing run:
headless Chromium serves WebGPU from SwiftShader, and the runner fails such a run
`TN_PLAYTEST_SOFTWARE_ADAPTER`. A run that does not name its adapter is not evidence.

**Browser, Android** — Chrome on the phone against the host's dev server, reached by reverse
tunnel. This lane does not exist yet and Phase 0 builds it:

```sh
adb -s <serial> reverse tcp:<port> tcp:<port>
adb -s <serial> shell am start -a android.intent.action.VIEW \
  -n com.android.chrome/com.google.android.apps.chrome.Main \
  -d "http://127.0.0.1:<port>"
```

**Native, Android:**

```sh
node packages/playtest/dist/runner/cli.js <scene>.playtest.json \
  --target android --package <id> --activity com.threenative.runtime.MystralActivity \
  --device <serial>
```

**The number itself** comes from `TN_FRAME_BUDGET`, which the loop owns and prints on every
platform. Read `fps`, `frame.p50`, `frame.p95` and `phases.*.p95` from a **steady-state window** —
never window 1, which contains the launch stall. Discard the first window, take the median of the
next three.

## Integration Ledger

| # | New thing | Live caller | Replaces | Old path removed? | Negative control |
|---|-----------|-------------|----------|-------------------|------------------|
| 1 | Android browser lane in the playtest runner (`--target browser --device <serial>`) | `packages/playtest/src/runner/` | hand-driven Chrome, which nobody has run | n/a — new | point it at a dead port → named failure, never a skip or a silent desktop fallback |
| 2 | `assert.parity` — two runs, one ratio, one verdict | scenario `assert` block; evaluated in `packages/playtest/src/evaluators/` | eyeballing two reports | n/a — new | feed it two runs from different devices → refuses with a named diagnostic |
| 3 | Per-platform performance gates in the shipped scenarios | `templates/*/playtests/*.playtest.json`, `sandbox/fps-framework/playtests/` | one `minFps: 24` on one example | replaced in place | raise a floor to `minFps: 1000` → runner exits 1, observed |
| 4 | This target table, generated into the templates' AGENTS.md | `packages/create-threenative/templates/*/AGENTS.md` | nothing — no game is told what to hit | n/a — new | a convention missing from the templates' AGENTS.md does not exist |

### Reachability

**How is this reached?** Every game built with the framework presents frames; the budget marker
already prints beside them on every platform. **User-facing?** A player feels 17 fps as broken and
58 fps as a game. **What does this replace?** Three sessions of re-deriving the same phone number
by hand, and a bar that lived in one person's head.

## Execution Phases

#### Phase 0 — calibrate: what does the browser do on this phone?

**This phase decides every target that follows. Do it first and do not skip it.**

- [x] Build the Android browser lane (ledger row 1), or drive Chrome by hand once and record it as
      a hand-driven run.
- [x] Same scene, same phone, same thermal window, twice: Chrome 151 on the Pixel 8, then the
      native APK. Both with `TN_FRAME_BUDGET` and `deviceMetrics`.
- [x] Compute `parity`. Write the answer into `docs/verification/prd-222-<date>.md` **before**
      touching any engine code.

Phase 0 result: **0.319 fps parity and 0.301 inverted render-p95 parity** on serial
`192.168.1.192:5555`, not thermally confounded. This routes the next measured lever to engine work.
The hand-driven browser fallback recorded pre/post device probes because the browser-device runner
lane does not yet produce `observations.deviceMetrics`; building that lane remains Phase 1 work.

The result splits the work and must be stated plainly:

- **parity < 0.85** → the host is behind the browser on identical hardware. Engine work, and
  Phase 0's own numbers name which phase (`render`, `hostGap`, `update`) owns the gap.
- **parity ≥ 0.85 with both numbers low** → the browser is no faster; bayview is simply too heavy
  for the phone. The work is content and draw-count, and "match web" is already true.
- **parity > 1.0** → native is ahead. Record it; it is the outcome the framework is for.

#### Phase 1 — the gates exist and are observed red

- [x] `assert.parity` (ledger row 2), red-first: two runs from different devices refuse by name.
      Landed 2026-09-03 (`assert.parity` + `evaluators/parity-evidence.ts`); the red-first proof
      is the spec run against the unmodified schema, and the different-device refusal is
      `TN_PLAYTEST_PARITY_DEVICE_MISMATCH` with the ratio still reported. Device identity rides
      `deviceMetrics.serial`; the scene identity of the pair is the operator's protocol, named as
      such rather than claimed. Evidence: `docs/verification/prd-222-phase1-2026-09-03.md`.
- [x] Tier 1 and Tier 3 floors land in the shipped scenarios; each observed red once by moving the
      floor above the measured value, and the failure pasted. All ten templates carry `minFps: 30`
      beside their ceilings; the red was observed on the platformer template (floor 2000 vs
      measured 1000 → exit 1, pasted in the record). **Lane caveat recorded there**: the browser
      lane runs uncapped (~1000 fps under SwiftShader/Xvfb), so the shipped floor is a safety net
      there and the device lane owns every presented-fps claim.
- [x] No lane is allowed to skip. A platform with no observer fails
      `TN_PLAYTEST_UNSUPPORTED_ON_TARGET` naming the working target — pre-existing mechanism,
      which `assert.parity` rides via the registry's `supportedOn`.

#### Phase 2 — take the lanes to Floor

Ordered by what Phase 0 names. Absent a Phase-0 surprise, the standing order is:

- [ ] bayview native Android to **30 fps** — the headline, and per finding 1 it is one bounded
      lever away: get `render.p95` from 34.8 ms under ~33 ms so every frame fits two vblank cells.
      The draw-submission lever has landed (`385fd50e`, device-measured 20.1 fps cool) — what
      remains is PRD-214's ranking: material/node evaluation first, shadow pass second.
- [ ] Every Tier 1 row to Floor.
- [ ] Every Tier 3 row to Floor.
- [ ] One Tier 4 sustained run per lever that lands — the cool number and the ten-minute number
      move independently, and a lever that buys frames while costing heat has not helped a player.

#### Phase 3 — take the lanes to Target, and hold them

- [ ] Each lane to its Target column.
- [ ] The gates run in the lane every later change re-runs, so a regression is red rather than
      anecdotal.
- [x] The table lands in the templates' AGENTS.md (ledger row 4). The shared target fragment and
      all seven template/mirror pairs passed a fresh Gauntlet critic after two red-green repairs;
      contract evidence is in commits `427a0527`, `3cec79f0`, and `47d83589`.

## Acceptance criteria

1. **Every platform has a number.** Each row of Tiers 1–4 is measured or explicitly named
   unverified with the reason. No row is blank.
2. **Parity is measured on the same device, not across devices.** Each parity claim names its
   serial, both builds, and its thermal verdict; a `thermallyConfounded` run is re-taken.
3. **Each gate was observed red before it was trusted green**, with the mutation named and both
   reports pasted.
4. **bayview clears 30 fps on the physical Pixel 8** in a thermally clean run — the Tier 3 heavy
   Floor.
5. **bayview survives ten minutes without a fan** — the Tier 4 Floor: it still renders 25 fps in
   the last minute, having retained 0.75 of its opening frame rate, and never passes thermal
   status 2. A cool-only green is not a shipped game.
6. **No result claims a platform it did not execute.** Emulator numbers are never a device claim;
   the emulator's software GL claims no performance at all and is functional-only.
7. **House gates stay green:** `pnpm typecheck && pnpm lint && pnpm test`, `pnpm budgets`,
   `pnpm sync:agents --check`.

## For the agent looping on this

- **Take Phase 0 first.** Every target after it is conditional on the calibration number, and
  optimizing before it is how three sessions got spent re-deriving the same 17 fps.
- **One lever at a time, measured before and after, on a cool phone.** Two levers in one run means
  neither is attributed.
- **Record refutations.** A lever that does nothing is a result and belongs in the verification
  file — resolution and fill rate are already refuted twice; do not spend a fourth run on them.
- **Cool for comparison, hot for shipping.** Both numbers are real and they answer different
  questions. Never let a cool green stand in for a sustained one, and never compare two runs that
  started at different temperatures.
- **The phone is the bottleneck of the loop, not the code.** It needs to cool between runs, and it
  has a battery floor. Batch the questions you ask it: instrument on the host, then take one
  capture that answers several rows.
- **Guard every device run against the physics SIGSEGV** (`docs/bugs/physics-simulation-callback-segv-flaky-2026-08-25.md`):
  check `pidof` ~45 s after launch and treat a dead process as a relaunch, never as data. Better,
  fix that crash first — it burns a launch, a heat cycle and battery every time it fires.
- **Never claim a gate you did not run.** "Unverified" is an acceptable answer and the only honest
  one for a row nobody measured.

**Named unverified at proposal time:** every Tier 1 row except native Android; every Tier 2 row;
every Tier 4 row (the 2026-08-24 heat numbers are a soak that
happened, not a run against these thresholds); iOS entirely (no lane, excluded by standing rule);
Windows and macOS desktop (no host). *Taken since filing:* bayview's post-batch-fix device number
— measured 2026-08-25, recorded in
`docs/bugs/render-projection-cannot-batch-differing-geometries-2026-08-25.md` and in the table and
findings above; the Phase 0 browser/native Pixel pair is recorded in
`docs/verification/runtime-perf-state.md`. What that scene still owes this PRD is its Tier 4
sustained run and green Phase 2/3 gates.
