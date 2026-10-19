---
prd_contract: v1
---

# PRD-226 — the native frame budget is attributed by ablation, then closed

**Status:** OPEN — **the ladder produced its answer, filed as
[PRD-227 — the frame crosses once](PRD-227-the-frame-crosses-once.md)**
([evidence](../../verification/runtime-perf-state.md)). PRD-226 keeps the instrument, the method
rules and the graveyard; PRD-227 owns the fix. Arm A4's job — an independent second route to the
backend term — was closed without building it: the A2 ablation says 1.95 ms and the `commandNs`
instrument says 2.037 ms, **0.09 ms apart**.

**Priority:** P1 — The native frame budget stays unattributed until the ablation ladder is built.
**Phase 1's gate is met: the budget is measured and published**
([record](../../verification/runtime-perf-state.md)).

```
native backend command recording + the GPU work it causes   1.95 ms   (17%)
native JavaScript + bridge                                  9.26 ms   (83%)
Chrome, all of it                                           4.05 ms
```

Native's JavaScript-and-bridge term alone is **2.3× Chrome's entire render phase**. Of the 7.16 ms
excess over Chrome, at most 1.95 ms can be backend and GPU — and Chrome pays part of that too — so
**at least 5.2 ms, 73% of the excess, is on the JavaScript and bridge side.** Five levers were spent
on the 17%. The remaining question is the split of the 9.26 ms between JavaScript and the bridge,
which is **arm A3**, and it selects which Phase 5 option is taken. **A4 is still owed** as the
independent second route to the backend term; until it runs, the sum holds by construction rather
than by cross-check.

Filed 2026-08-27; **arm A1 also closed one of the three outcomes**
([record](../../verification/runtime-perf-state.md)): Dawn 11.85 ms against wgpu-native
11.51 ms `render.p50` on the same scene, interleaved, unprofiled — **flat**. The backend is not the
owner, so the Phase 5 backend option is struck. Filed after PRD-224's measurement refuted the fifth
consecutive lever. Supersedes the lever queue in [the PRD-222 fix plan](../../verification/runtime-perf-state.md);
does not supersede PRD-222, which owns the target.

**Goal, restated by the owner 2026-08-27: 60 fps or better on native. 30 fps is not acceptable.**
The 30 fps "floor" that earlier records treat as the acceptance bar is demoted to a progress
milestone; it is not a passing result.

The panel is **120 Hz**, so presented frame rate is quantised to 120/n. Sixty fps means the whole
frame fits in **16.67 ms**. It currently costs **43–48 ms**
([meter audit](../../verification/runtime-perf-state.md)), so the target is a
**~3× reduction — 28–33 ms per frame to remove.** Chrome already does the same scene at 60 fps on
the same phone, so the number is reachable; it is not reachable by a lever.

**Complexity:** +2 for new build-flag surface across the backend seam, +1 for a harness that must be
provably self-consistent, +1 for a device lane on every claim = **HIGH mode**.

## Why the previous five levers failed, and why this PRD is shaped differently

| Lever | Predicted | Delivered | Why the prediction was wrong |
| --- | --- | --- | --- |
| A — render-pass wrapper pool | fewer megamorphic ICs | flat, removed | targeted 0.647 ms of a 22 ms frame |
| C — projection/upload tuning | ≥2 ms | −0.31 ms | inside the meter's spread |
| F10 — swapchain frame latency 3 | device fps | flat on device | desktop-only effect |
| F12 — batched pass encoding | crossings own the frame | +5% | per-crossing tax is ~1 µs; crossings were ~2 ms of 40 |
| F14 / PRD-224 — per-call binding install | ≥2 ms | **0.02 ms** | ~6 calls/frame × 70 µs ≈ 0.3 ms |

Every one of them was inferred from a **sampling profile** and none of them was **priced against the
scene's actual call counts before it was built**. Three separate profile readings (F8, F12, F13) each
named a different owner, and each was overturned by the next measurement. The method is the defect.

**The frame is 22–24 ms on desktop and 33.6 ms on the phone against Chrome's 7.6 ms and 5.8 ms, on
the same machines, running the same three.js over the same scene on the same GPU.** After five
levers, **none of that excess is attributed**. This PRD refuses to propose a sixth lever. It builds
an instrument that decomposes the frame by **construction rather than by sampling**, publishes the
budget, and only then spends implementation effort — on the term the budget names.

## Solution (decision recorded here)

**An ablation ladder.** Each arm removes one layer from the real frame and measures what is left.
Terms obtained by subtraction must sum back to the control, and one term is obtained twice by
independent routes, so a mis-wired arm reports itself instead of producing a plausible wrong answer.

| Arm | What it is | Term it yields |
| --- | --- | --- |
| **A0** control | HEAD, unchanged | `T0` |
| ~~**A1** backend swap~~ | ~~the same scene on **Dawn** instead of wgpu-native~~ | **DONE 2026-08-27 — flat (11.85 ms Dawn against 11.51 ms wgpu-native).** Chrome *is* Dawn; swapping in Chrome's own backend on the same scene changes nothing. The Rust backend is not the defect |
| ~~**A2** null backend~~ | ~~every backend call returns immediately **after** argument parsing~~ | **DONE 2026-08-27 — `T0 − A2` = 1.95 ms of 11.21 ms (17%).** Backend recording plus the GPU work it causes is a sixth of the frame |
| **A3** null bridge | binding entry points return immediately, no wrapper objects, no handles | `A2 − A3` = bridge; `A3` = JS execution |
| **A4** no JS | one recorded frame's command stream replayed from C++, zero JS per frame (`TN_WEBGPU_BATCHED_PASS` already records the op stream) | backend + driver, **independently** |
| ~~**A5** Chrome~~ | ~~the same scene, same machine~~ | **DONE 2026-08-27 — 4.05 ms**, real NVIDIA Turing adapter, matching scene weight. Native's JS+bridge term alone is 2.3× this |

**Self-consistency gate:** `A3 + (A2−A3) + (T0−A2)` must equal `T0` within **15%**, and `A4` must
agree with `T0 − A2` within **20%**. If either fails, the ladder is wrong and **no optimisation may
land** — the harness gets fixed first. This is what makes the result an attribution rather than a
fourth opinion.

**Pre-registration rule, binding on every lever this PRD or any successor proposes.** Before a line
is written, the proposal states in the verification record:

```
predicted ms/frame = (calls per frame on the measured scene) × (measured ns/call − Chrome ns/call)
```

with the call count taken from `TN_BRIDGE_BY_NAME` on the scene being optimised, not assumed. A
lever predicting **< 2 ms/frame is refused**. Applied retroactively this rule refuses Lever A,
Lever C, F10 and PRD-224 Phase 3 before any of them costs a night.

Rejected alternative, on the record: another round of `simpleperf` symbol work. Three readings of the
same profile produced three different owners; more resolution on the same instrument is not the
missing thing.

## Integration Ledger

| # | Changed thing | Live caller | Replaces | Negative control |
| --- | --- | --- | --- | --- |
| 1 | Ablation build flags (`TN_ABLATE_BACKEND`, `TN_ABLATE_BRIDGE`) | ablation harness only; default OFF in every shipped build | ad-hoc source mutations rebuilt by hand per A/B | packaging test asserts no shipped preset defines them; a build with either flag ON fails the release gate |
| 2 | `scripts/ablation-ladder.mjs` — runs the arms, parses, applies the sum gate | this PRD's verification record | hand-parsed one-off logs per lever | feed it a deliberately mis-wired arm → sum gate fails, exit 1 |
| 3 | The published frame budget | every future performance PRD | five levers' worth of inference | any lever whose pre-registered arithmetic predicts <2 ms/frame is refused at review |

## Execution Phases

### Phase 0 — the harness, proven able to fail

**Files (3):** `packages/runtime-native/src/webgpu/bindings.cpp` (flag guards),
`packages/runtime-native/CMakeLists.txt`, `scripts/ablation-ladder.mjs` (NEW).

- [ ] `TN_ABLATE_BACKEND` and `TN_ABLATE_BRIDGE` compile-time flags, both default OFF, both
      asserted absent from every shipped preset by an executable.
- [ ] `scripts/ablation-ladder.mjs` runs an arm N times, parses `TN_ANDROID_JS_NATIVE` with the
      recorded protocol (dedupe by `(frame,bindingNs,calls,threadCpuNs)`; ≥3 markers and >100
      indexed draws per frame; `work = threadCpu − present`; median of the last three quarters),
      and applies the 15%/20% gates.
- [ ] **Red-green with its mutation named:** point the ladder at an arm whose null-backend flag is
      compiled out, so `A2` returns the control's cost. The sum gate must report the inconsistency
      and exit 1. Paste the red, then the green. A harness that cannot fail proves nothing.
- [ ] Quiet-machine rule written into the runner: it refuses to record while 1-minute load exceeds
      a stated threshold, and stamps `sha256` of the binary it ran. Both PRD-224 lanes were
      polluted by unrelated load on 2026-08-27.
- [ ] **Warm-up rule, measured by A1 and binding on every arm: discard the first two whole runs of a
      session, not merely window 1 of each run.** A1 measured run 1 at 26.05 ms against 11.4–12.0 ms
      for every run after, same binary and bundle, with machine load ruled out. Keeping run 1 is what
      produced the ±100% spreads that made Levers A and C undecidable. Warmed, this lane's within-arm
      spread is 0.6 ms and it resolves a ~1 ms lever.
- [ ] **`fps` is banned as an arm meter on desktop, `:0` included.** A1's arms both sat at 59.6–59.8
      fps, vsync-capped, while `render.p50` differed. F11 recorded this for Xvfb; it holds on `:0`.
- [ ] **No cross-session absolute comparison.** The recorded 22.2 ms desktop baseline does not
      reproduce: the same host revision priced ~2.3× cheaper on 2026-08-27, and the game bundle was
      rebuilt by another lane (`update.mean` 1.5 ms against a baseline-era 4.0–4.9). Every arm in a
      budget must come from one session on one bundle.

### Phase 1 — publish the budget (this is the gate)

- [x] A0, A1, A2 and A5 measured on desktop, six interleaved runs each for the paired native arms.
      **A3 and A4 remain.**
- [ ] Sum gate green, both routes to backend+driver agreeing. **Not yet: A4 is the second route and
      has not run, so `T0 − A2` currently holds by construction, not by cross-check.**
- [x] The budget published: [record](../../verification/runtime-perf-state.md).
      Backend+GPU 1.95 ms, JS+bridge 9.26 ms, Chrome 4.05 ms, each with its run spread. The
      JS/bridge split awaits A3.
- [x] **Stop rule satisfied for the backend question**: A1 and A2 both ran before anything was
      optimised, and both struck the hypothesis they tested. The stop rule stays in force for the
      JS/bridge question until A3 reports.

### Phase 2 — confirm the top term on the phone

Desktop and device render.p50 track each other in total (22.2 ms against 22.9 ms), but no term of
the budget has ever been shown to track. One arm proves it before a night is spent on the wrong
platform's bottleneck.

- [ ] The top term's arm, and the control, built as profiled arm64 APKs and captured on a cool,
      **discharging** Pixel 8 (`doctor --device` first; charger waiver recorded or absent).
- [ ] Paired, back-to-back, live windows only (`update.mean ≥ 3 ms`), window 1 discarded.
- [ ] If the top term does not dominate on device, the device's own ladder is run before any fix.

### Phase 3 — close the top term

- [ ] Pre-registered arithmetic published **before** implementation, per the rule above.
- [ ] One commit, independently revertible, with a negative control that fails when it is reverted.
- [ ] Desktop ladder re-run: the term must fall by at least the predicted amount, and the other
      terms must not rise to absorb it.
- [ ] Device pair re-run. **Only the device may make an fps claim.**

### Phase 4 — loop, with an exit

- [ ] Repeat Phases 2–3 on the next term until Bayview clears **60 fps** on device. Report the
      30 fps crossing when it happens, but do not stop there.
- [ ] **Exit condition:** three consecutive terms closed for less than 2 ms of total device movement
      means the budget is wrong, not the levers. Return to Phase 1 and re-derive it; do not
      continue.

### Phase 5 — the architectural options, named now so they are not invented under pressure

Gated on Phase 1's budget; whichever the budget names, and none of them otherwise.

- [ ] **If JS execution owns it** — the embedded V8 runs the same three.js the same machine's Chrome
      runs. Then the lever is V8's build configuration (tiering, builtins, pointer compression,
      snapshot), not the bindings, and the first experiment is a pure-JS three.js-shaped benchmark
      in the host against Chrome on the same machine. Note that this PRD's own control already
      shows a plain property read is *faster* in the host than in Chrome, so this outcome would
      mean the gap is in compiled-code quality, not in the interpreter.
- [ ] **If the bridge owns it** — stop crossing per WebGPU call. Three.js records the frame's
      command stream once and C++ submits it; the op stream already exists behind
      `TN_WEBGPU_BATCHED_PASS`. F12 measured this at +5% for the encoder subset alone, so it is only
      justified if the budget shows the bridge term is large across *all* classes.
- [x] ~~**If the backend owns it**~~ — **STRUCK 2026-08-27.** A1 ran: Dawn 11.85 ms against
      wgpu-native 11.51 ms on the same scene, interleaved and unprofiled. Chrome's own backend is not
      faster here, so the backend is not the owner and no upstream wgpu work or Android backend swap
      is justified by this evidence.

## Verification

Record `docs/verification/prd-226-frame-budget-<date>.md`, one file per run session, naming what
executed and what did not.

1. Phase 0's harness red (mis-wired arm → sum gate exit 1) and green, both pasted.
2. The budget table, every arm's three run medians shown individually, never averaged across runs.
3. Binary `sha256` and load average stamped for every arm; arms measured under load are labelled or
   discarded, not silently kept.
4. Device captures name serial, temperature at start and end, battery level, charger state, and
   whether the install was fresh or an upgrade.
5. Any arm that could not be built or run is named as not run. "Unverified" is an acceptable answer.

## Acceptance Criteria

- [ ] The ablation harness fails on a mis-wired arm. (Mutation: compile out `TN_ABLATE_BACKEND` in
      the A2 arm → sum gate reports the inconsistency, exit 1.)
- [ ] A published frame budget whose terms sum to the control within 15%, with backend+driver
      derived twice by independent routes agreeing within 20%.
- [ ] No optimisation commit under this PRD predates that budget.
- [ ] Every lever carries pre-registered `calls/frame × Δns/call` arithmetic predicting ≥2 ms/frame,
      published before implementation.
- [ ] **Bayview ≥ 60 fps median on a cool, discharging physical Pixel 8**, live windows only, three
      captures, paired against the arm it replaces. **This is the acceptance bar.** 30 fps is a
      progress milestone worth reporting, never a pass.
- [ ] Every device fps claim is cross-checked against `dumpsys SurfaceFlinger --latency` on the
      game's `(BLAST)` layer, which is independent of our own instrumentation. `dumpsys gfxinfo` is
      **not** a valid meter here — it reports the Skia view pipeline, not the game's SurfaceView,
      and reads ~5× flattering.
- [ ] Web does not regress: `pnpm visuals` clean and desktop Chrome render.p50 unchanged.
- [ ] Ablation flags are absent from every shipped preset, asserted by an executable.
