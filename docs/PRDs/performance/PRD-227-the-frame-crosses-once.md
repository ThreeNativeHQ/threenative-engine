---
prd_contract: v1
---

# PRD-227 — the frame crosses once

**Status:** IN PROGRESS — **P1 accepted and landed. P2 executed and falsified. Phase 4 executed,
rejected by the owner, and reverted.** Phase 3 device acceptance, the hosted JSC execution lane,
and the web gate remain open. Filed 2026-08-27 from the measured budget in
[PATH-TO-60FPS](../../verification/runtime-perf-state.md). This is the implementation PRD that
PRD-226's ablation ladder was built to justify. PRD-226 stays live and owns the instrument; this one
owns the fix.

**Priority:** P1 — Open boxes need QuickJS and JSC lanes plus Pixel 8 doctor records; two changes land together.
**The decisive measurement has now been taken, and it changes the PRD's subject.** Change 1 landed,
Bayview's appearance was restored, and the device reads **20.02 fps — unchanged** — while per-frame
work fell from 43–48 ms to 25.27 ms. **The frame rate is not work-bound.** It is pinned to a
constant 50 ms present cadence that does not respond to workload at all.
See [Resume here](#resume-here-2026-08-27) and
[prd-227-cadence-lock-2026-08-27](../../verification/runtime-perf-state.md).

**Goal: Bayview at 60 fps or better in the native host on a physical Pixel 8.** 30 fps is not a
pass. The panel is 120 Hz, so the whole frame must fit in **16.67 ms**; it costs **43–48 ms** today.

**Complexity:** +2 for a per-frame protocol between JavaScript and C++, +1 for the object-model
change across three engines, +1 for the device acceptance lane = **HIGH mode**.

## The problem, measured

The host crosses the JavaScript↔C++ seam **5,713 times per frame** with **15,005 marshalled
arguments**. The cost of the seam itself is **22.3 ms of the Pixel 8's 37.7 ms frame**:

| Term | ms/frame (device) | Fate |
| --- | ---: | --- |
| actual JavaScript running three.js | 10.1 | stays |
| V8 machinery (22.9 V8 total − 10.1 JS) | 12.8 | **removed** |
| `libmystral` bridge dispatch + backend | 8.1 | **mostly removed** |
| `libc`/scudo allocator churn | 4.3 | **mostly removed** |
| Mali driver | 2.3 | stays |
| **total** | **37.7** | F13 states 37.2 |

Chrome runs the same scene at **59.99 fps on the same phone** with the same three.js. The JavaScript
is not the problem; the seam around it is.

## Solution (decision recorded here)

**Two changes that land together.** Neither works alone, and both have already been tried in partial
form and measured ~zero — which is what the model predicts and why this PRD refuses to ship half.

### Change 1 — the frame crosses once, not 5,713 times

Three.js records the frame's WebGPU command stream in JavaScript; C++ replays and submits it in a
single crossing. **The op stream already exists** behind `TN_WEBGPU_BATCHED_PASS`, but covers only
the render-pass encoder subset and is default OFF. It must cover **every per-frame command**,
`queue.writeBuffer` included — 428 calls/frame, the highest-frequency single crossing.

Removes: per-crossing dispatch in `libmystral`, the API-scaffolding half of the V8 machinery
(`LookupIterator`/`Object::Get`, `GlobalHandles::Create`, `Isolate`/`Context` re-entry,
`Value::IsExternal`), and the `bridgeOverheadNs` marshalling term.

### Change 2 — wrapper objects get fixed shapes

Every WebGPU wrapper is a property bag assembled from C++ with `Reflect.set`, read back by name
through `Object::Get`, with a `v8::Persistent` per crossed callback argument. Replace with
`ObjectTemplate` + internal fields; borrow callback arguments for the duration of the native call.
Callback results still receive an owned handle when they cross back into JavaScript.

Removes: the megamorphic stub cache and name-dictionary lookups — **3.9 ms/frame on device** — that
three.js pays because we hand it a new object shape every frame and its inline caches go
megamorphic, plus most of the 4.3 ms of scudo churn.

### Pre-registered arithmetic, per PRD-226's binding rule

Published here **before implementation**, with call counts from `TN_BRIDGE_BY_NAME` on the measured
scene:

| Change | Predicted device saving | Threshold |
| --- | ---: | --- |
| Change 1 | **13.4 ms/frame** | ≥2 ms ✓ |
| Change 2 | **8.9 ms/frame** | ≥2 ms ✓ |
| Together | 22.3 ms of 37.7 → **15.4 ms ⇒ 65 fps** | ≥60 fps |

**Margin is 1.3 ms. Sixty fps is achievable, not comfortable.**

#### Correction, 2026-08-27 — the pre-registered arithmetic is void as written

P2's falsification removes Change 2 from the model, and with it the assumption that the **3.9 ms**
megamorphic + name-dictionary tax is ours to remove. It is owned by Three.js's node-material shader
graph, which the framework does not fork, and **Chrome pays the same tax on the same scene while
reaching 59.99 fps on this phone**. That term was therefore never removable and the 22.3 ms budget
double-counted it.

| Term | Original model | After P2 |
| --- | ---: | ---: |
| predicted saving | 22.3 ms | **Change 1 only — unmeasured on device** |
| predicted frame | 15.4 ms ⇒ 65 fps | **not derivable until Phase 3 measures Change 1 alone** |
| margin | 1.3 ms | **gone** |

No replacement number is written here. The next number in this PRD must be **measured on the
device**, not modelled — the model has now mispredicted twice (F12, P2). Do not re-derive a target
from desktop figures: the desktop lane renders 0.92 Mpix against the device's 2.59 Mpix.

Rejected alternatives, on the record: a sixth micro-lever of any kind (PRD-226's graveyard has five,
all measured flat); a backend change (A1 and A2 closed it by two independent routes — the backend is
8.5% of the frame); more `simpleperf` symbol work (three readings of one profile gave three
different owners).

## Integration Ledger

| # | Changed thing | Live caller | Replaces | Negative control |
| --- | --- | --- | --- | --- |
| 1 | Op stream covering every per-frame command | runtime WebGPU bindings, all games | 5,713 per-call crossings | disable the stream → `bridgeNs` returns to ~9 ms in the profiled lane; conformance replay test fails |
| 2 | `queue.writeBuffer` recorded into the stream | uniform/attribute upload path | 428 direct crossings/frame | staging + stream both off → upload probe red |
| 3 | `ObjectTemplate` + internal fields for WebGPU wrappers | every wrapper handed to three.js | `Reflect.set` property bags read by name | shape-identity test: two wrappers of one class must share a hidden class; revert → red |
| 4 | No `v8::Persistent` per crossed callback argument | native callback inputs | per-argument Persistent + weak ref | handle-lifetime test fails on premature collection |
| 5 | `platform::presentUncapped()` — an Android channel for the uncapped present mode | both `configureSurface` call sites in `runtime.cpp` | desktop-only `--no-vsync`, no device channel at all | set the property to `0` and the host reports `presentMode` `fifo`; to `1` and it reports `immediate`/`mailbox`, from `nativeHost.presentMode` |

## Execution Phases

### Phase 1 — Change 1, and the cheapest chance to be wrong

**Falsification gate P1. Run this before any of Phase 2 exists.**

- [x] Op stream extended to every per-frame command, `queue.writeBuffer` included; recorded in JS,
      replayed and submitted from C++ in one crossing per frame.
- [x] Desktop profiled lane (Xvfb, **not `:0`** — voided at `d42d1a3d`), same-session control pair,
      F15 warm-up rule, load stamped, binaries sha256'd.
- [x] **Prediction, pre-registered:** `bridgeNs` collapses **9.15 → under 1.5 ms**; `work` falls
      **23.9 → ≤17 ms**.
- [x] **Falsification evaluated and not triggered:** `bridgeNs` and `work` both crossed their
      thresholds. If `bridgeNs` had collapsed but `work` had not, the seam's cost would be
      somewhere other than where this PRD puts it, and Change 2's premise dies with it. **Stop and
      re-derive; do not proceed to Phase 2.**
- [x] Red-green with its mutation named: the executable's disabled-stream control fails, and
      disabling the stream at its request-device entry point returns `bridgeNs` to the direct-call
      control; paste both.

**P1 result — accepted** (`cb64c892`, [prd-227-p1-2026-08-27](../../verification/runtime-perf-state.md)).
Desktop Xvfb pair, same session:

| Arm | work | bridge | overhead | command |
| --- | ---: | ---: | ---: | ---: |
| direct-call control | 23.19 ms | 9.31 ms | 3.87 ms | 1.84 ms |
| packed-stream candidate | **14.32 ms** | **0.81 ms** | 0.19 ms | 2.32 ms |
| change | −8.87 ms | −8.50 ms | −3.67 ms | +0.48 ms |

Retained en route: reusable 1 MiB JS arena (drain 0.069 → 0.003 ms), upload view `.slice()` removed.
**Reverted, both measured negative and both on the record so they are not retried:** frame-local
render-pass slots in place of the hash map (19.02 → 19.80 ms), and a typed-u32 recorder probe.

### Phase 2 — Change 2, fixed-shape wrappers

- [x] `ObjectTemplate` + internal fields per WebGPU class; native handles resolved from internal
      fields, never by name lookup.
- [x] No `v8::Persistent` per crossed callback argument; arguments are borrowed for the native
      call and wrapper lifetime is re-derived from the receiver.
- [ ] Cross-engine: QuickJS and JSC lanes **exercised, not compile-checked**. Name the lane that ran;
      "compiled only" is not verification. An engine without the capability keeps the legacy path
      behind an explicit gate.
- [x] **Falsification gate P2 executed — FAIL:** fresh symbolized `simpleperf` measured
      megamorphic stub cache + name dictionary at **11.84%**, not under 3%. Source-resolved V8 IC
      logging names Three.js's node-material shader graph, not native wrapper shapes, as the
      dominant steady-state population.

**P2 disposition — falsified, closed to further attempts**
([prd-227-p2-2026-08-27](../../verification/runtime-perf-state.md), `f0639772`, `54b7354c`):

| Arm | stub cache | dictionary | combined |
| --- | ---: | ---: | ---: |
| historical baseline, identically re-reported | 7.2459% | 3.1777% | **10.4236%** |
| fixed wrappers + borrowed callback values | 10.4918% | 5.0922% | **15.5840%** |
| + class-specific frame resource ids | 8.6238% | 4.4019% | 13.0257% |
| + typed uploads bounded to ≤3 maps per site | 8.2299% | 3.6058% | **11.8356%** |

The gate was ≤3%. The final arm is **1.41 points worse than doing nothing** and 8.84 above the gate.
139,373 `LoadIC`/`KeyedLoadIC` records source-resolve the owner to `three/src/nodes/core/Node.js`
(`getNodeType`, `build`, `getUpdateType`, `getHash`) and `NodeBuilder.getDataFromNode`. **No native
WebGPU wrapper site appears among the dominant steady-state records.**

**The code stays; the claim does not.** The `ObjectTemplate` change is correct, contract-proven and
independently revertible, and its two recorder specializations each reduced the pre-registered owner
monotonically. It has **not earned a device-performance claim**. Optimising Three.js renderer
internals inside the host would violate the ownership rule — Three.js remains the renderer,
`runtime-native` owns the platform seam — so **no third speculative shape edit is authorised.**

### Phase 3 — device acceptance

- [ ] Pixel 8 with `doctor --device` recorded at both ends, fresh install, cold launch, live windows
      only (`update.mean ≥ 3 ms`), window 1 discarded, three captures. The user explicitly waived
      the charging/thermal prerequisite for this session; charger and thermal state remain reported
      beside every result and the 60 fps bar is unchanged.
- [ ] **Every fps claim cross-checked against SurfaceFlinger** on the game's exact `(BLAST)` layer:
      `dumpsys SurfaceFlinger --latency` when it emits presentation rows, otherwise the current
      AOSP `--timestats -clear/-enable/-dump/-disable` path with its `averageFPS` and
      `present2present` histogram. `dumpsys gfxinfo` is **not** a valid meter here — it reports the
      Skia view pipeline and reads ~5× flattering.
- [ ] Web does not regress: `pnpm visuals` clean, desktop Chrome `render.p50` unchanged.

**Phase 3 is the decisive open step, and its exact arm is now defined.** Change 1 is landed in the
engine and Change 2 is falsified, so the only arm that answers this PRD is **engine commits only,
against Bayview at its restored appearance** (`7e4f912` in
`/home/joao/projects/threenative/sandbox/fps-framework`). That build has never been measured on the
device. Every device number recorded so far is either pre-Change-1 or contaminated by the Phase 4
visual downgrade.

**Appearance is part of the acceptance, not separate from it.** An fps number produced by a build
that does not look like Bayview is not a Phase 3 capture, whatever it reads.

### Phase 4 — the named fallback — EXECUTED, REJECTED, REVERTED

Stated in advance so it would not be invented under pressure. It was then executed under time
pressure anyway, and the owner rejected it.

**What ran:** Bayview's procedural TSL town materials replaced with flat `MeshBasicMaterial`,
shadows removed, a presentation cap and a render-budget experiment added.

**What it measured: 61.31 fps active movement, 63.77 fps SurfaceFlinger** — the only time this
project has read 60 on the device. It is **not a pass** on two independent counts: the build was
visibly white and flat, losing the texture and material detail that make Bayview look like Bayview;
and it produced **one capture, not the required three**.

**Reverted in full** at `7e4f912` (`revert(bayview): remove performance visual downgrade`) —
materials, shadows, presentation cap, budget plumbing and its scenario. `pnpm typecheck` green after.

**Owner ruling, 2026-08-28, binding on this PRD and its successors:**

> *"Unless the performance bug is on the game code, do not touch it, unless to experiment."*

Game code is **experiment-only**. A change to Bayview may be built to test a hypothesis and must be
reverted before the result is reported; it may become a shipped change only when profiling shows the
**game** owns the cost. The evidence points the other way — the seam and V8 machinery own the frame,
and Chrome runs this same game at 59.99 fps — so Phase 4 is **closed as a route to acceptance** and
survives only as a diagnostic. What its 61.31 fps actually establishes is an upper-bound sanity
check: the device *can* present this scene at 60, so the remaining cost is not the panel or the
driver.

## Resume here (2026-08-27)

> **START HERE:** [HANDOVER-hostgap-2026-08-27](../../verification/runtime-perf-state.md) —
> the executable version of this section, with the one task, the exact code sites, and the commands.
> **Do not take "execute PRD-227" as a task.** Both of its named changes are finished; an agent told
> to execute it invents lever ten.

**The decisive test has now run.** Full record:
[prd-227-cadence-lock-2026-08-27](../../verification/runtime-perf-state.md).

### What it found — the frame rate is not work-bound

| | before Change 1 | after Change 1 |
| --- | ---: | ---: |
| device fps | 20.39 | **20.02** |
| per-frame work | 43–48 ms | **25.27 ms** |

Work fell ~40%; fps did not move. A resolution A/B settles it: **2.25× fewer pixels
(1080×2400 → 720×1600) also did not move fps** (20.02 → 19.89). The phases only redistributed —
`hostGap` 25.25 → 14.18 ms while `render` *rose* 16.81 → 24.76 ms, total pinned at ~48–50 ms.
**A render phase that gets slower when given less to do is a blocking wait, not work.**

SurfaceFlinger quantises hard on the game's own `(BLAST)` layer:
`present2present: 33ms=52  50ms=592  66ms=39`, `averageFPS = 19.974`.

### And the display is 60 Hz, not 120

`activeMode={… vsyncRate=60.00 Hz …}`. The panel supports 120 and the host never asks for it. Every
prior document — including [prd-226-device-meter-audited](../../verification/runtime-perf-state.md)
— computed quantisation on an 8.333 ms period the display was not using. **At 60 Hz the cells are
16.67 / 33.33 / 50.00 ms.** We sit on the 3-period cell doing 25.27 ms of work — work that already
fits in two periods with 8 ms to spare. **Landing the cell we have already earned is worth 30 fps
with no further optimisation.**

### The next lever — two candidates, both in the host

1. **Present mode — the channel now exists.** `--no-vsync` had been desktop-CLI-only, so the one
   question the device could not be asked was whether its rate is set by the work or by the FIFO
   cadence. `platform::presentUncapped()` reads `debug.threenative.present_uncapped` (Android) or
   `THREENATIVE_PRESENT_UNCAPPED` (everywhere), in the same shape as `surfaceRevalidationDisabled()`,
   and both `configureSurface` call sites now honour it. Diagnostic, default off, and an uncapped
   present tears — never ship it enabled.

   ```sh
   adb shell setprop debug.threenative.present_uncapped 1   # uncapped arm
   adb shell setprop debug.threenative.present_uncapped 0   # control, same binary
   ```

   **Executed the same session — REFUTED.** The host logged `Present mode: mailbox (vsync=false)`,
   so the mode genuinely changed, and the frame rate did not:

   | Arm | host reports | fps | frame.p50 | hostGap.p50 | presented.p50 |
   | --- | --- | ---: | ---: | ---: | ---: |
   | `0` | `fifo (vsync=true)` | **19.92** | 26.61 ms | 21.30 ms | 48.64 ms |
   | `1` | `mailbox (vsync=false)` | **19.77** | 25.94 ms | 25.13 ms | 50.16 ms |

   Mailbox never blocks on vblank, so a frame still arriving every ~50 ms is not being *held* — the
   50 ms is real elapsed time. **The FIFO cadence is not the limiter**, and the hope that a pacing
   fix would land the 33 ms cell for free dies with it. The channel stays: it is the negative
   control that made this answerable at all, and it cost one property read.
2. **The composited web UI layer — also REFUTED.** `ui.renderer` flipped `"web"` → `"native"` (the
   documented opt-out, no overlay and no extra process), rebuilt, measured, reverted:
   **20.67 fps against 19.92.** 0.75 fps on a bar that needs 40 more.

### What five arms have in common — this is the actual finding

| Arm | what it changed | fps |
| --- | --- | ---: |
| pre-Change-1 baseline | — | 20.39 |
| Change 1 landed | ~40% less per-frame work | 20.02 |
| 720×1600 | 2.25× fewer pixels | 19.89 |
| `present_uncapped=1` | FIFO → mailbox, no vblank wait | 19.77 |
| `ui.renderer: "native"` | no composited WebView layer | 20.67 |

**Nothing moves it, and `hostGap` sits at 21–25 ms in every arm** — invariant to CPU work, pixel
count, present mode and the overlay. An invariant like that is not a workload. It is a **fixed
wait**, and it is half the frame.

### The next change is an instrument, not a lever

`hostGap` is one undifferentiated number: *"present wait plus whatever the host did between
callbacks."* No profile can attribute it, because `simpleperf` sorts by DSO and symbol while this
cost is defined by **frame phase** — 25 ms spread across event pumping, message-loop and microtask
draining, swapchain acquire, fence waits, audio and IO scatters into exactly the buckets already
reported and never surfaces as one owner.

**Split `hostGap` into named sub-phases in the host loop and re-measure.** Time these two first,
because both would be invariant in exactly this way:

1. **Swapchain acquire / GPU fence.** A blocking `getCurrentTexture` or an implicit wait on
   submitted work serialises CPU and GPU into one 50 ms interval and ignores present mode.
   Counter-evidence to weigh: at 720×1600 the GPU had 2.25× less to do and the total did not fall.
2. **The host's own loop pacing.** `substeps.p50` is **3** in every arm — the fixed-step update
   catches up three times per rendered frame. Whether that is symptom or cause has never been
   separated.

**Do not write a tenth lever before this instrument exists.** The graveyard holds nine.

Also worth one line regardless: **ask for the 120 Hz mode** (`Surface.setFrameRate` /
`preferredDisplayModeId`). The host currently never does.

### Refuted this session, cheaply — do not re-spend on these

- **Resolution / fill rate.** Measured, not assumed: 2.25× fewer pixels, fps unchanged.
- **GC / V8 heap tuning.** Desktop `--trace-gc`, steady state: median gap 319 ms, median cost
  0.54 ms, **0.2% of wall clock**. V8's heap is genuinely never configured (`ResourceConstraints`
  appears nowhere; `CreateParams` sets only `array_buffer_allocator`) — and on this evidence that
  costs nothing. The 4–6 ms scavenges in the log are load-time only.

### The previous session's tail

Codex `01a044cc` (12:57–18:08 local) ended mid-flight while *"rebuilding Bayview from restored game
source with only the engine commits."* It **did** finish that build and install it at 18:08:27; it
never measured it. That APK is what this record measured.

### The one thing to do first — superseded

The instruction below said to run the engine-only device arm. **It has been run** (see above); read
"The next lever" instead. The capture protocol in it stays binding for Phase 3 acceptance.

### State of the two trees

| Tree | Path | HEAD | Note |
| --- | --- | --- | --- |
| engine | `threenative-engine` | `19e96811` on `main` | Change 1 landed; Change 2 landed but claimless |
| game | `sandbox/fps-framework` (Bayview) | `7e4f912` | appearance restored; Phase 4 hack fully reverted |

**Do not sweep the engine tree's uncommitted files.** `packages/core/src/picking.ts` (modified) and
the untracked `packages/core/__tests__/projection-hot-path.spec.ts`,
`packages/core/__tests__/scratch-zz-decompose.spec.ts` and `packages/core/scratch-raycast-ab.mjs`
are **not PRD-227 work** and were not produced by that session's PRD lane. Leave them for their
owner.

### The one thing to do first

Rebuild Bayview from `7e4f912` against the engine at `19e96811` — **engine commits only, no game
edits** — install fresh on the physical Pixel 8, and capture Phase 3 properly:

1. `doctor --device <serial>` at both ends; record serial, temperature, battery, charger state.
2. Three captures, cold launch, window 1 discarded, live windows only (`update.mean ≥ 3 ms`).
3. Cross-check **every** fps claim against SurfaceFlinger on the game's own `(BLAST)` layer.
   `dumpsys gfxinfo` is invalid here and reads ~5× flattering.
4. Write `docs/verification/prd-227-phase3-<date>.md` whatever the number is. A miss is a result.

The owner waived the charging/thermal prerequisite for this lane; state the values beside each
result anyway. **The 60 fps bar is unchanged — 30 fps is a milestone, never a pass.**

### What is closed — do not reopen without new evidence

- **Change 2 / wrapper shapes.** Falsified; owner is Three.js's node graph. No third shape edit.
- **The backend.** A1 (Dawn↔wgpu) and A2 (null backend) closed it twice; it is 8.5% of the frame.
- **Binding tables per class** (PRD-224). Bounded at ≈0.3 ms before it is written.
- **Micro-levers generally.** PRD-226's graveyard holds five, all measured flat, plus P2 and the two
  reverted P1 experiments. **Seven failed levers. Measure before you build the eighth.**
- **Phase 4 / Bayview's own draw counts** as a route to acceptance — see the owner ruling above.

### The gap worth attacking if Phase 3 misses

**Nobody has ever profiled the Chrome arm on the device.** Chrome's 59.99 fps on this Pixel is
quoted in four documents and has never been attributed; every one of the ~15 ablation arms is
native-only. Before writing an eighth lever, capture Chrome's own frame breakdown on the same phone
and same scene, and diff it term by term against the native profile. That converts *"the seam costs
22.3 ms"* — a number that has now mispredicted twice — into *"the seam costs X ms more than Chrome's
equivalent path"*, which is the quantity that actually has to reach zero. It is the control this
ladder never ran.

### Smaller open items, all real

- **Hosted JSC lane.** Compile blockers are closed (`4816d09d` supported prototype API,
  `110270e5` C++17 compatibility, `19e96811` launch diagnostics preserved). Runtime launch still
  fails with a **generic simulator code 4**; the session was improving the verifier to capture the
  real crash reason rather than guess. Resume there. Until it executes, cross-engine coverage is
  **compile-checked only, which this PRD explicitly does not accept as verification.**
- **Web gate.** `pnpm visuals` clean and desktop Chrome `render.p50` unchanged — not yet run against
  the landed Change 1.
- **Device stability.** One physical SIGSEGV after ~1,100 frames in V8's optimizing compiler
  (`IdentityMapBase::Clear` / `OptimizingCompileDispatcher`), unattributed to any single commit.
  Open, tracked here, not blocking Phase 3.

## Verification

Record `docs/verification/prd-227-<phase>-<date>.md`, one file per run session.

1. P1's before/after with `bridgeNs`, `bridgeOverheadNs`, `commandNs` and `work` per frame, from the
   same-session control pair.
2. P2's symbolized profile, before and after, with the stub-cache and dictionary shares named.
3. Phase 3's device captures with serial, temperature at both ends, battery level, charger state,
   fresh-install flag, **and the SurfaceFlinger present-interval distribution beside our own fps**.
4. Every arm's binary sha256 and the machine load it ran under. Arms run under load are labelled or
   discarded, never silently kept.
5. Anything not run is named as not run. "Unverified" is an acceptable answer.

## Acceptance Criteria

- [ ] **Bayview ≥ 60 fps median on a physical Pixel 8**, three captures,
      SurfaceFlinger-confirmed, **at its restored appearance** — the run must render the procedural
      TSL town materials and shadows, not a stand-in. Charger and thermal state are recorded under
      the explicit session waiver above. This is the bar; 30 fps is a milestone to report, never a
      pass. *(2026-08-27: 61.31 fps active / 63.77 SurfaceFlinger was observed once, on the reverted
      flat-material build, from one capture. It is recorded as a diagnostic upper bound and is
      **not** a pass on this criterion.)*
- [x] The frame issues **one crossing per frame** for command submission, asserted by an executable.
      (Mutation: disable the stream drain → the executable rejects the direct-call control.)
- [x] Two wrappers of the same WebGPU class share one hidden class, asserted by an executable.
      (Mutation: revert to `Reflect.set` assembly → shape-identity test fails.)
- [x] Both changes are independently revertible, each with a negative control that fails on revert.
- [x] No ablation or measurement flag ships: `scripts/__tests__/ablation-flags-never-ship.spec.ts`
      green.
- [ ] Cross-engine coverage is **named**, not implied. *(V8 and QuickJS executed —
      `threenative-command-encoder-class-table-test` passed on both, and
      `threenative-handle-lifetime-test` ran 100,000 crossings on each with `outstanding=0`. **JSC
      is unexecuted**: it compiles, but hosted simulator launch fails with a generic code 4. Compiled
      is not executed.)*
- [ ] Web unchanged: `pnpm visuals` clean.
