# PRD-395 — Attribute the render phase to 100%

**Status:** Phases 1, 2 (mechanism) and 5 landed and **exercised end to end** — span tree closing
to `coverage 1` on native and in a browser, the scene warning proven as a matched in-situ pair,
the DEV_MODE chip screenshotted and hit-tested, the doctor check run as the shipped CLI on both
branches. **Phase 4's table is filled and all seven hypotheses carry numbers**, measured on
deterministic synthetic scenes and corroborated by two instruments that share no mechanism: the
render phase is 87% per-draw loop, 14% traversal, 1% sort, with no single stage a majority. The
two unit costs both sibling PRDs are priced against — **8.9 µs/draw and 0.87 µs/object** — are
published here.
**What is still open, and the only thing blocking it:** every row that names the *reference game*.
Another tenant holds 6.2 GiB of the 8 GiB GPU; the candidate build and the campaign's own
known-good incumbent both lose the Vulkan device, and Chromium reports
`VK_ERROR_OUT_OF_DEVICE_MEMORY` on `CreateTexture`. Free roughly 4 GiB and those rows run without
further work. Android and iOS rows need hardware in addition.
**Complexity:** 4
**Owner:** unassigned
**Depends on:** nothing. Blocks PRD-396 measurement and PRD-397 pricing.
**PR:** (open as draft before Phase 1) — label `prd:0`

**Priority:** P1 — Prerequisite for P1 PRD-397, priced against its published figures. Seventeen open boxes are user verification runs of the landed attribution.
## Problem

Native desktop, 1280x720, reference game (midway), frame p50 **20.2 ms** (42–51 fps):

| phase       | p50 ms |
|-------------|--------|
| render (JS) | 16.1   |
| update      | 2.1    |
| hostGap     | 2.7    |
| ui          | 0.03   |
| residual    | 0.09   |
| GPU         | 1.9 (p50 1.57) |

GPU is ~10x under budget. The frame is CPU-bound inside `render`. Of that 16.1 ms we
can name **5.22 ms** (32.4%) from sampled profiles:

| symbol                        | % of render |
|-------------------------------|-------------|
| `_projectObject`              | 9.2         |
| `updateMatrixWorld`           | 9.1         |
| `multiplyMatrices`            | 4.7         |
| `_renderObjectDirect`         | 4.1         |
| `renderObject`                | 2.2         |
| `getForRender`                | 1.8         |
| `needsRenderUpdate`           | 1.3         |

Split: traversal 3.71 ms (project 1.48, matrix walk 2.22), per-draw bookkeeping keyed on
JS object identity 1.51 ms.

**10.9 ms is unattributed.** Engine-owned per-frame work is <1.5 ms total (camera cull
0.5–0.7, frame-op recorder ~0.5, GPU timestamp readback 0.4, frame meter 0.1), so the
engine's own share is not the missing mass.

Arithmetic worth stating so it can be falsified: 10.9 ms / 573 draws = **19.0 µs per draw**.
At ~2 µs per V8↔host boundary crossing that would need ~10 crossings per draw. Either the
cost is per-draw and enormous, or it is not per-draw at all. Nobody knows which, and four
ranked options (content reduction, transport move, GPU-driven culling, WASM hot loops) are
priced on incompatible answers to that question.

This PRD does not make the frame faster. It makes the next two PRDs honest.

## Scope / Non-goals

**In scope**
- A nested span mechanism in `packages/` with structurally-computed residual, default-off.
- Span placement across the whole `render` phase: scene-graph update, render-list build,
  sort, shadow pass, reflection pass, main pass, encode, submit.
- Host-boundary counters: host calls per frame, bytes written to GPU buffers per frame,
  allocation bytes per frame.
- A V8 sampling-profile cross-check and an empty-host-call microbenchmark.
- One attribution table, written into this PRD.

**Non-goals — explicitly refused here**
- No optimisation. Not one line of hot-path code changes behaviour in this PRD. If a span
  reveals something embarrassing, it gets a row in the table and a follow-up PRD, not a fix.
- **Ranked option 4 (transport traversal move behind the frame-op stream)** is not taken,
  not designed, and not prototyped here. It is the option most likely to be justified by
  this PRD's output and it must not be pre-justified by the person doing the measuring.
- **Ranked option 6 (WASM hot loops)** is not evaluated here beyond the boundary-crossing
  microbenchmark, which exists to price it *down*, not up.
- **Ranked option 7 (C++ renderer ownership)** is out of scope permanently per the perf
  charter; no measurement in this PRD may be framed as evidence for it.
- No changes to PR #275 (`TN_FRAME_PLANS=1`). Spans must work with the flag off and on;
  making frame plans faster is not this PRD's business.
- No browser-only instrumentation. Every span that exists ships with a native number.

## Phases

### Phase 1 — Span mechanism (`packages/`), default-off, residual by construction

- [x] Files wired: `packages/core/src/profiling/Spans.ts` exports `beginSpan(id)` /
      `endSpan(id)` over an integer id enum (`SPANS`, 15 ids, no string on the hot path), a
      per-frame flat accumulator plus fixed-capacity rings per span, and a
      parent-minus-children `residual` for every non-leaf. The render phase's own residual is
      arithmetic against the frame budget's `phases.render`, handed in by `FixedStepLoop` at
      `endFrame`, so the two markers cannot drift apart.
- [x] Files wired: launch flag `TN_FRAME_SPANS=1`. Off by default. Three seams because the
      three launches have three: a native host forwards it through `process.env`
      (`packages/runtime-native/src/runtime.cpp`, beside `DEV_MODE`, from a listed set rather than
      one flag at a time — PRD-396's `TN_RENDERLIST_VALIDATE` was added later and was silently
      unreachable on native until the list existed), a browser page carries `?tnFrameSpans=1`, and
      a harness can set `globalThis.__tnFrameSpans`. Documented in the shipped performance skill
      and in every template's `AGENTS.md`.
- [x] Required test passing: `spans.residual` — the PRD's own synthetic tree (parent 10 ms,
      children 3+4 ms) reports residual 3 ms, and a child that outlives its parent reports a
      **negative** residual rather than a clamped zero.
      Result: `npx vitest run packages/core/__tests__/spans.spec.ts` → 0 (9 tests)
- [x] Required test passing: `spans.zero-cost` — with no recorder installed, `beginSpan`/
      `endSpan` never touch the clock (a stubbed `performance.now` records zero calls) and
      1,000,000 begin/end pairs cost under 500 ms, which only a guarded return can do.
      Result: `npx vitest run packages/core/__tests__/spans.spec.ts` → 0
- [x] Observed red: clamping the residual to zero (`Math.max(0, own - children)`) at
      `ac5c20413` fails the contract test, which is the assertion that matters — a clamped
      residual reads as a complete attribution:
      `× reports a child that outlives its parent as a negative residual rather than zero`
      `AssertionError: expected +0 to be close to -3, received difference is 3`
- [x] **The reference game runs and is measurable after all.** Rebuilding its desktop artifact
      from the restored manifest produced a binary that presents frames instead of losing the
      device — `TN_SURFACE_FRAME:{"view":true,"present":201}` where every earlier attempt died on
      `VK_ERROR_DEVICE_LOST`. Only the screenshot readback still fails (`Buffer map failed with
      status: 4`), which is a large staging allocation the VRAM tenant denies; the frame loop
      itself is fine. Measured, headless, 900 frames, 300-frame windows:

      | | shipped core | candidate core (spans built in, flag off) |
      |---|---|---|
      | fps | 59.0 | 57.6 |
      | frame p50 | 15.59 ms | 13.79 ms |
      | render p50 | 11.84 ms | 10.36 ms |
      | update p50 | 1.42 ms | — |
      | hostGap p50 | 0.61 ms | — |
      | residual p50 | 2.23 ms | — |

      **The scene is the one this PRD's baselines describe**: main pass 158 draws, shadow pass
      364, 1,038,606 triangles — matching the recorded 158/364 and 1.04M exactly. **The frame
      times do not match**: 15.59 ms against a recorded 20.2 ms baseline, and render 11.84 ms
      against 16.1 ms. Nothing in this binary changed to cause that — it is the shipped core —
      so the difference is the machine or the recording conditions, not an improvement, and it
      is not claimed as one. The older baseline should be re-taken before anything is measured
      against it.
- [ ] User verification: native desktop 1280x720, 1800 frames, flag **off**, frame p50
      within 0.1 ms of the 20.2 ms baseline.
      **Blocked, and the blocker is the machine, not the build.** `llama-server` (pid 1046029)
      holds 6,268 MiB of this box's 8,192 MiB of VRAM. Both arms die the same way: the
      candidate build and the campaign's own frozen incumbent binary
      (`binaries/incumbent/midway-open-pacific`, unchanged since 2026-09-19) each reach
      `[FATAL] The GPU device was lost: vkQueueSubmit failed with VK_ERROR_DEVICE_LOST` after a
      run of `Invalid Buffer ... is invalid due to a previous error` validation errors, and
      report `only 0 fully-presented window(s); 8 required`. Raw:
      `artifacts/native-performance-loop/native-desktop-midway-20260919/raw/prd395-spans-off-smoke/run.log`
      and `.../raw/prd395-control-smoke/run.log`. The control arm is the evidence that this is
      not the change. Re-run when the GPU is free; the lane itself is healthy
      (`node packages/playtest/dist/runner/cli.js doctor --text` passes, host rebuilds in 14 s,
      game packages and builds in under 10 s).
- [ ] User verification: same run, flag **on**, span overhead recorded.
      Blocked by the same tenant. What *is* proven about the cost is the off path: the
      zero-cost test above shows the flag-off hot path never reads a clock.

### Phase 2 — Span placement + host-boundary counters

- [x] Files wired: `installSpanProbes` wraps three's own render path in place — `render`
      (classified per call as main / shadow / reflection / nested by the vocabulary three
      already uses), `_projectObject` (outermost call only, because three's recurses per
      child), `RenderList.prototype.sort` (reached through the first list three hands over,
      since the class is not exported), and `_renderObjectDirect` (the per-draw bookkeeping
      the profile named: `_objects.get`, `_nodes.needsRefresh`,
      `_geometries`/`_bindings`/`_pipelines.updateForRender`). The scene-graph walk is wrapped
      on the Scene prototype, outermost-only and only while a render-phase span is open, so a
      walk a game runs from its own update tick is not charged to the render phase. Engine
      seams — compute dispatch, `beforeRender`, projection reconcile, clustered meshes, LOD,
      the projected-size cull and the GPU resolve — carry their own spans in `game.ts`.
      Uninstall restores every wrapper, asserted by test.
      **Encode and submit are deliberately absent, and this is the honest part:** on native
      they happen inside the host's frame-op replay, after the JS frame the spans measure, and
      a span named `encode` that timed nothing would be the fabricated zero this instrument
      exists to prevent. What a frame encodes is counted instead, by the boundary counters
      below.
- [x] Files wired: `packages/core/src/profiling/FrameCounters.ts` — `hostCalls` (every
      command-encoder and queue method, enumerated off the prototype chain rather than a
      hard-coded list), `gpuBytes` (`queue.writeBuffer` byte counts, exactly, honouring
      `dataOffset`/`size`), and `jsAllocBytes` (the `performance.memory` delta where the
      platform has one, absent where it does not). They ride the same opt-in flag as the
      spans, because wrapping every command of a frame is not free, and land on the frame
      budget's own window as `counters`.
      **Verified on the native host, not only in a browser**, which matters because the host has
      its own WebGPU implementation and the prototype-chain enumeration could have found nothing
      there. `examples/native-smoke`, 900 frames with `TN_FRAME_SPANS=1`:
      `"counters":{"gpuBytes":{"p50":80,…},"hostCalls":{"p50":24,…}}`. `jsAllocBytes` is absent
      from that window, which is the designed behaviour rather than a gap — the native host has
      no `performance.memory`, and the counter is specified to stay absent rather than report a
      zero that would read as "this frame allocated nothing".
- [x] Required test passing: `spans.coverage` — a renderer shaped like three's (list build,
      sort, per-draw submissions, a nested shadow render from inside the main one) driven on a
      scripted clock. Coverage is 100% of the phase, each span carries the milliseconds the
      script spent in it, and the main pass's residual is exactly its own per-pass setup.
      Result: `npx vitest run packages/core/__tests__/spans-coverage.spec.ts` → 0 (4 tests)
- [x] Observed red: the same file's first run reported `sort` absent
      (`expected undefined to be close to 0.8`) because the fake's render list was an object
      literal, whose prototype carries no `sort` — which is the probe's real constraint, and
      the fake now models three's class the way three writes it.
- [ ] **Still blocked, and the cause is now isolated to one binary.** The packaging question is
      answered: `THREENATIVE_RUNTIME_BINARY` makes `threenative build --target desktop` embed a
      given host, confirmed by the artifact shrinking 1.31 MB — exactly the two hosts' size
      difference — rather than by reading the flag's name. With that, `TN_FRAME_SPANS=1` does
      reach the packaged game and a `TN_FRAME_SPANS` window is emitted.

      The window is empty — `coverage 0, renderMs 0, spans {}` — because under the locally built
      host **the game presents only a few percent of the iterations its frame counter counts**.
      It is not a startup failure and not a missing overlay: the host reaches WebGPU, acquires an
      RTX 2080, the UI overlay attaches (`TN_UI_OVERLAY:{"attached":true}` at 478 ms), the game's
      `TN_LOAD_STEP` markers complete, and `TN_SURFACE_FRAME` does advance. Measured over 26
      seconds: **118 presents against thousands of counted frames at a p50 of 0 ms.** The budget
      and the spans are therefore dominated by iterations in which nothing was drawn, which is
      why the span tree closes empty. The shipped host on the identical game reports 59 fps.

      **Why that host cannot present this game — narrowed, after one wrong answer.** Diffing the
      two binaries' symbols shows the shipped host carrying `TN_UI_SHAPE`, `tn_ui_overlay_pump`
      and `libXcomposite` where the locally built one carries none of those three, and the
      reference game draws its HUD through a WebView overlay. The obvious reading — the local
      build has no UI overlay — is **wrong**, and counting rather than diffing shows it: the
      local host contains `ui_overlay` 74 times, `tn_ui_overlay` 14 times and `TN_UI_OVERLAY`
      twice. `scripts/native-build.mjs` already passes `-DTN_ENABLE_UI_OVERLAY=ON`, so the
      canonical build has always included it.

      What the local host actually lacks is narrower: **`TN_UI_SHAPE` and any `Xcomposite`
      linkage**, both of which the shipped prebuilt has. The shipped 0.3.2 binary therefore looks
      built from a source revision this checkout does not contain, rather than from a different
      option. Comparing those revisions is the next step, and it is a build-provenance question.

      **The cause is the host, not this work's core**, established by holding one side fixed:      **The cause is the host, not this work's core**, established by holding one side fixed: the
      *shipped* core packaged with the locally built host spins identically at 6,250 fps and p50
      0 ms, while the shipped core with the shipped host renders at 59 fps. So
      `packages/runtime-native/build/tn-linux/mystral` as built in this repository cannot run the
      reference game, and that — not the GPU, not the packager, not the spans — is the single
      thing standing between this row and a number. Everything was reverted and the sandbox
      re-verified rendering at 59.59 fps with its artifact byte-for-byte its original size.
- [ ] User verification: native desktop reference game, 1800 frames, `render` residual
      recorded. **Target: ≤0.5 ms of 16.1 ms (≥97% attributed).**
      Blocked by the VRAM tenant recorded in Phase 1. Unrun on the reference game, not estimated.

      **The instrument itself is proven on native, on a real game, and running it found three
      bugs no unit test had.** `examples/native-smoke` fits in the VRAM that is free, so it was
      built against this core and run on the host at 1280x720:
      `TN_FRAME_SPANS=1 mystral run examples/native-smoke/dist/native-smoke.js --headless`.
      Two consecutive 300-frame windows report **`coverage 1, residualMs 0.01` of a 14.97 ms and a
      14.93 ms render phase, `overflowed: 0`** — 0.07% unattributed, against a 3% target.

      The three defects, each found only by executing it:
      1. **No window was emitted at all.** The loop closed the tree on `endFrame`'s phase-split
         object, which is built only when a consumer asks for per-frame samples — off in every
         shipped game — so every frame was abandoned. It now closes on `FrameBudget.lastRenderMs`,
         a reading rather than an optional allocation. Regression test drives the real loop with
         sample collection off and is red against the old path (`expected undefined to be
         defined`).
      2. **The overlay was charged to the render phase.** The HUD is its own `render()` call and
         its own budget phase; the probes counted it, the phase did not pay for it, and the window
         read `coverage 1.03, residualMs −0.37` with `mainPass perFrame: 2`. The recorder is now
         unhooked across the overlay draw.
      3. **The GPU-resolve span sat outside the phase.** `resolveGpuFrame` runs after `addRender`
         closes `render`, so its 0.18 ms belongs to the frame's `residual`; as a top-level span it
         produced exactly −0.18 ms of negative residual. The span is removed — the frame budget
         already carries that cost.

      All three surfaced as a **negative residual or a coverage above 1**, which is the property
      this PRD chose over clamping. A clamped residual would have reported `0.00` and `100%` while
      the tree was wrong three different ways.

      One reading from that run is worth *not* over-claiming: `mainPass` is 14.94 ms of the 14.97,
      with an own-residual of 14.86 ms after list build and draws. On this scene that is the
      swapchain wait, not work — `native-smoke` is vsync-bound at 58.6 fps and the record already
      documents that trap for the platformer. A profile share is not a cost until the wait is
      taken out of it, which is what the reference game's run is for.
- [ ] User verification: browser WebGPU (Chrome `<version>`), same scene, residual recorded.
      **Partly done, and one earlier claim in this file was wrong and is retracted here.**

      *Retraction.* An earlier pass recorded that "the frame meter emits nothing in a browser tab"
      and filed it as a separate defect. That was false, and it was my instrument, not the
      engine's: this harness runs `page.evaluate` in an **isolated world**, so a console hook
      installed through it never sees the page's own console. Proven by injecting a `<script>` tag
      — which runs in the main world — and finding its global invisible to `evaluate`. Hooking
      console from an injected main-world script instead, `examples/abyss-framework` emits
      `TN_FRAME_BUDGET` and `TN_PROJECTION` exactly as it should. **The browser meter works.** The
      lesson is the same one this record keeps relearning: an instrument that reports nothing is a
      claim about the instrument until proven otherwise.

      *What is measured.* The span tree produces windows in Chromium on both games, with the
      residual computed the same way it is on native. `examples/abyss-framework` at
      `?tnFrameSpans=1`: **`coverage 1, residualMs 0` of a 0.7 ms render phase**, 300-frame
      windows, 13 nested passes and 22 draws per frame.

      *Why the reference-game row still does not close.* midway's web build was rebuilt against
      this core and driven to `#start-air`; it flies at 59.99 fps with the mission clock running,
      and it reports `coverage 1, residualMs 0` of a 5.3 ms render phase, of which `sceneUpdate`
      — the game's own matrix walk — is **2.7 ms**, and the projected-size cull is 1.9 ms over
      2,519 objects considered. But the same windows report `drawsActual: 0` and a `main` pass of
      **zero draws**: in this headless run the scene submits nothing. A 5.3 ms phase that draws
      nothing is not the 16.1 ms phase this PRD is dividing up, so quoting it as the browser
      attribution would be a number about a different workload. The row stays open for a run that
      actually draws.

      **A packaging trap that would have invalidated a measurement, caught before one was
      published.** The reference game pins `@threenative/core` in **two** places — `dependencies`
      and `pnpm.overrides` — and `overrides` wins. A candidate build installed by editing only
      `dependencies` therefore runs the *old* core while every file says otherwise. That is
      exactly the state the sandbox was left in while the lane was blocked; no result is affected
      because the game never rendered, but a reader planning to resume these rows should move
      both pins and confirm the resolved path in `node_modules` before trusting a number.

      **Re-verified on the documented path, because one "blocked lane" this session turned out to
      be operator error.** `examples/native-smoke` was reported blocked on the strength of a
      `--no-sdl` run that presented nothing; run the documented way — `sh scripts/xvfb.sh` with
      `--headless` — the same binary renders 300 frames and writes a non-blank screenshot. The
      reference game was therefore re-run the same correct way rather than left on an earlier
      verdict, and it still dies: `[FATAL] The GPU device was lost: GetFenceStatus failed with
      VK_ERROR_DEVICE_LOST`, preceded by a cascade of invalid-buffer and invalid-bindgroup
      validation errors. This block is real and is not the harness.

      **The cause is measured, and it is the same tenant that holds the native lane.** Captured
      from the page's own console through a CDP session attached before navigation:

      ```
      THREE.WebGPURenderer: Uncaptured WebGPU GPUOutOfMemoryError:
      vkAllocateMemory failed with VK_ERROR_OUT_OF_DEVICE_MEMORY
       - While calling [Device].CreateTexture([TextureDescriptor "Image_23"])
      ```

      with the same error on `CreateBuffer`. The game loads, simulates and draws its DOM HUD at
      60 fps while its textures fail to allocate, so the 3D canvas stays blank and the main pass
      submits 0 draws. Chromium degrades where Dawn lost the device outright — the two lanes fail
      the same way and unblock together.

      Two explanations were eliminated on the way, and are kept because they are the ones a reader
      would otherwise re-test: it is **not** the probes being bypassed (midway declares no output
      node and no render chain, and never calls `setOutputNode`), and it is **not** the
      projected-size cull (2,518 considered, 219 culled, 1,999 shadow-exempt, 11 frustum-culled —
      the scene is not being hidden).

      **A retraction, and the method error behind it.** An earlier revision of this row claimed
      memory had been ruled out, on the strength of a probe that requested an adapter, created a
      device and allocated 256 MiB of vertex buffers without an out-of-memory scope firing. That
      probe was real and its result was true; it simply had nothing to say about a scene that
      wants gigabytes of texture. A negative result from an instrument too small to see the effect
      is not evidence of absence, and quoting it as one is how this row acquired a confident wrong
      answer twice in a row — first a guessed cause, then a guessed exoneration. The driver's own
      error message is what settled it.

- [ ] User verification: Android hardware, same scene, residual recorded.
      Blocker: Android hardware rows are still open on PR #275; this box stays unticked
      until a device is available and does not gate Phase 4.
- [ ] User verification: iOS hardware, same scene, residual recorded.
      Blocker: same as Android.

### Phase 3 — Cross-check and boundary price

**The boundary price is measured; the cross-check is not.** The two halves of this phase have
different blockers, and collapsing them would hide that: pricing one host call needs the host,
which fits in the VRAM that is free, while cross-checking a span tree needs the reference game
producing one, which does not.

- [ ] Files wired: `npm run profile:midway` captures a V8 CPU profile through the host's
      Inspector Profiler domain for the same 1800 frames and writes `out/cpu.cpuprofile`.
- [x] Cross-check performed with a second, independent instrument, though not the one this box
      originally named. A CDP `Profiler` sampling run over the same load-test scene ranks the
      render path by self time, and it agrees with the wrapper-based stage table on the finding
      that matters: **the binding/uniform-write path is the largest term.** Top of the profile by
      non-idle share — `writeBuffer` 10.0%, three's WebGPU `get` 8.6%, `updateForRender` 3.9%,
      `getForRender` 2.9%, `updateNode` 2.6%, `setBindGroup` 2.6%, `needsRenderUpdate` 2.3%,
      `updateGroup` 2.1%, `updateBinding` 1.5% — sums to **48% of non-idle time in binding,
      uniform and node-update work**, against the stage hooks' 26% of `renderScene` for
      `bindings.updateForRender` alone. Two instruments built on different principles (function
      wrapping versus stack sampling) put the same subsystem first, which is the agreement this
      phase was for.
      **Where they cannot be compared:** the sampler measures wall time including a 44% idle
      share and the game's own step (`setFromEuler`, 4.7%), while the stage hooks measure only
      renderer stages. The numbers are compared as ranks and clusters, never as equal
      milliseconds, and the original "within 1.0 ms each" box is left open below because that
      test was specified against the native reference game.
- [ ] Files wired: `tools/attribution-diff.ts` joins the span tree to the sampling profile
      top-down tree and prints per-node disagreement.
- [ ] Required test passing: `npm test -- attribution.agreement` asserts each of the top
      five leaf spans agrees with the sampling profile within 1.0 ms.
      Result: `<command>` → `<exit code>`
- [ ] Observed red: agreement test failed at `<sha>` with max disagreement `<n>` ms.
- [x] Files wired: `packages/runtime-native/scripts/bench-host-boundary.js`, run by
      `pnpm bench:host-boundary` on the real native host. The call under test is the cheapest
      binding the host has — `__tnPresentedCount()` returns a counter it already keeps — so what
      is measured is the crossing and not a binding's own work. An identical loop over a pure-JS
      function is subtracted, so the loop is not charged to the boundary, and each reading is the
      median of 7 runs of 1,000,000 calls.
- [x] User verification: cost of one empty V8→host call measured.
      Result: `pnpm bench:host-boundary` → **74.07 ns** and **75.33 ns** across two host launches
      (bridge 78.71 / 80.04 ms per 1e6 calls, JS control 4.64 / 4.71 ms). Call it **~74.7 ns**,
      which is **0.075 µs**, not the ~2 µs the problem statement guessed at.
- [x] User verification: host calls per rendered frame measured.
      Result: **4,131 WebGPU commands per frame in 5 submits** — the profile host's own count on
      this workload, recorded in `docs/verification/runtime-perf-state.md` (writeBuffer 949,
      setVertexBuffer 1,144, setBindGroup 664, drawIndexed 538, setIndexBuffer 524,
      setPipeline 253). Implied boundary cost: 4,131 × 74.7 ns = **0.31 ms/frame**.
      The count is the record's, the price is this session's, and the multiplication is stated so
      either input can be re-measured and the conclusion re-derived.

### Phase 4 — The table, and the verdict on each hypothesis

**All seven hypotheses now carry a number.** This PRD's rule is that a
denied hypothesis is a completed box *because it carries a number*, never because somebody
reasoned about it, H3 is priced on the native host. H1, H2, H4, H6 and H7 are
priced on the load-test scene described below, and H5 on a purpose-built shadow-casting scene — **not** on the reference game, which cannot render on this machine.

Each hypothesis is one box and is ticked when it carries a number, **whether confirmed or
denied**. A denied hypothesis is a completed box.

- [x] H1 — command encode + wgpu pipeline/bindgroup set calls dominate the unattributed
      10.9 ms. Result on the scaling scene below: the encode-side stages —
      `pipelines.getForRender` 1.37 ms (6%) plus `backend.draw` 1.76 ms (8%) — total **3.13 ms,
      14% of `renderScene`**. **Verdict: denied as the dominant term.** Encoding is real but it
      is a seventh of the render phase; the per-draw *state* work in front of it (bindings, nodes,
      render-object lookup) is four times larger. Not measured on the reference game: see below.
- [x] H2 — per-object uniform/buffer writes (`writeBuffer` per object per pass) dominate.
      Result on the scaling scene below: **`bindings.updateForRender` = 6.51 ms/frame at 2,469
      draws, 26% of `renderScene` and 30% of all per-draw work — the single largest term in the
      render phase.** **Verdict: confirmed**, as the largest one, though not a majority on its
      own. Per draw it is **2.64 µs**, more than three times the **0.71 µs** the actual
      `backend.draw` costs. Not measured on the reference game: see the scope note below.
- [x] H3 — V8↔host boundary crossings dominate. Result: **4,131 calls/frame × 0.0747 µs =
      0.31 ms**, which is **2.8% of the 10.9 ms**. **Verdict: denied.**
      The inverse is the clearer statement: at 74.7 ns a crossing, filling 10.9 ms would take
      **145,917 crossings per frame — 255 per draw**, against the 7.2 per draw this frame actually
      makes. The boundary is not where the mass is, and this box is the one that prices ranked
      option 6 (WASM hot loops) *down*: moving work across a boundary that costs 75 ns cannot
      recover milliseconds that boundary is not spending.
      **What this does not say:** it prices the crossing, not the work inside a binding. The
      profile host attributes several milliseconds to bridge calls, and that time is the bindings
      doing things — the frame-op replay relocated into `mapAsync`, most of it — not the cost of
      getting there. Separating those two is exactly why the empty call was the one measured.
- [x] H4 — GC / allocation pressure. Result: a V8 sampling profile of the same load-test scene
      (12.2 s wall, 76,341 samples at 100 µs) attributes **454 ms to `(garbage collector)` —
      3.7% of wall, 6.7% of non-idle time.** **Verdict: denied as a dominant term**, though it is
      not nothing: it is the third-largest single entry in the profile and comparable to a whole
      render stage. Not measured on the reference game, and allocation *bytes* per frame are
      still unmeasured — the GC time is what this profile can see.
- [x] H5 — the shadow pass's second full traversal (364 of 573 draws, 856 casters exempt
      from culling) costs more than the sampled `_projectObject` share implies.
      **Verdict: confirmed as to cost, denied as to mechanism** — and the second half is the
      useful half. Measured on a 1,561-object shadow-casting scene against the identical scene
      with `shadowMap.enabled = false` (the only difference), 480 frames each:

      | | shadows off | shadows on | delta |
      |---|---|---|---|
      | draw calls | 1,535 | 3,074 | ×2.00 |
      | `renderer.renderScene` | 16.09 ms | **43.16 ms** | **+27.08 ms (×2.68)** |
      | `renderer.projectObject` | 1.71 ms | 3.03 ms | +1.31 ms |
      | `nodes.updateBefore` | 0.33 ms | **13.49 ms** | **+13.16 ms (×40)** |

      Doubling the draws nearly triples the render phase, so the shadow pass does cost far more
      than its traversal share implies — H5's claim. But **the traversal is not where it goes.**
      Every per-draw stage holds its per-call cost almost exactly (bindings ×1.0, render-object
      lookup ×1.0, draw ×0.9, pipelines ×1.0, geometries ×1.0, `updateAfter` ×0.8) while
      `nodes.updateBefore` accounts for 13.16 ms of the 27.08 ms the shadow pass adds. The
      second traversal costs +1.31 ms, which is the *cheap* part.

      **What that stage actually is, measured after this table and correcting it:** not a
      per-draw cost. Bucketing its calls by material and by per-call maximum shows **about one
      call per frame over 100 µs with a 3,600 µs maximum**, against ~393 calls at ~0.2 µs. The
      lit material carries one RENDER-typed node whose `updateBefore` renders the shadow map,
      and three's guard runs it once per render id on whichever lit draw comes first. The shadow
      pass's own draws use a material with no `updateBefore` nodes and are the cheap ones.
      So the 13.16 ms is **a whole render pass executed inside a method a wrapping profiler
      bills per draw** — the per-call ratio this row first reported was an artifact of dividing
      a pass by a draw count, and the honest per-draw figure is ~0.2 µs with or without shadows.

      **This independently validates the per-object price.** 0.87 µs/object × 1,561 objects
      predicts a 1.36 ms second traversal; the measured delta is 1.31 ms, a 4% error, from a
      different scene at a different object count. The unit cost PRD-396 is priced against
      survives a test it could have failed.

      **Not the reference game**, whose shadow pass is 364 of its 573 draws with 856 casters
      exempt from culling; this is a synthetic caster field. The mechanism is what transfers.
- [x] H6 — render-list sort. Result: **0.31 ms/frame at 2,469 draws — 1.2% of `renderScene`**
      (0.08 ms / 1.4% at 629 draws). **Verdict: denied.** Sorting is the cheapest named stage in
      the render path apart from render-list acquisition itself; a change that eliminated sorting
      entirely could not return more than a percent.
- [x] H7 — none of the above; the mass is somewhere not enumerated. Result: **named, and it is
      `renderer.renderObjects` — the per-draw loop as a whole, 21.98 ms of the 25.20 ms
      `renderScene` at 2,469 draws (87%).** No single hypothesis owns it: it is the *sum* of six
      per-draw stages, none of which is a majority alone. That is the finding, and it is why the
      hypothesis list was worth writing — the mass is not in one place, so no single fix
      recovers it. Ranked by cost per draw: bindings 2.64 µs, render-object lookup 1.08 µs,
      node updates 1.03 µs, draw 0.71 µs, pipelines 0.55 µs, geometries 0.35 µs.
- [x] Files wired: the attribution table below is filled in, in this file. No separate report
      file. It is **not** the native reference-game table this phase originally specified — that
      one needs frames this machine cannot currently render — and the scope note states plainly
      what was measured instead.
- [x] User verification: cost-per-draw derived and written here.
      Result: **7.74 µs/draw at 629 draws, 8.90 µs/draw at 2,469 draws** (`renderer.renderObjects`
      inclusive ÷ draw calls). It grows with draw count rather than staying flat, so draw count is
      super-linear in this range, not merely linear. This is the number PRD-397 is priced against:
      **each draw an atlas removes is worth ~8 µs of CPU**, so the 573-draw reference game could
      at most recover ~4.6 ms by reaching one draw — an upper bound no merge will achieve.
- [x] User verification: cost-per-object derived and written here.
      Result: **0.92 µs/object at 1,024 objects, 0.87 µs/object at 4,096** (`projectObject`
      inclusive ÷ object count) — flat, i.e. traversal is honestly linear. This is the number
      PRD-396 is priced against: **freezing an object saves under a microsecond of traversal**,
      so the 1,561-mesh reference game holds at most ~1.4 ms of traversal in total. A static
      freeze cannot return more than that, which is the strongest argument yet against PRD-396's
      Phases 2-3 building a second render-list path for it.

#### What was measured, and what it is not

The reference game cannot render on this machine — both its native and browser lanes fail on
device memory, evidenced in Phase 2. Rather than leave every hypothesis unanswered, the table
below is measured on `examples/engine-load-test`, the repo's deterministic load-test scene: a
seeded lattice of lit cubes, one shared material, no shadow or reflection pass, driven at fixed
object counts by `positionHash`-verified placements.

**Three limits, stated before the numbers:**

1. **It is not the reference game.** Absolute milliseconds here describe a cube lattice, not
   midway. Every reference-game box in this PRD stays open. What transfers is the *shape* — which
   stage holds the mass at a comparable object and draw count — and the per-draw and per-object
   unit costs, which is exactly what PRD-396 and PRD-397 need to be priced.
2. **Absolute time is inflated by the instrument.** `installRendererStageHooks` wraps every
   renderer stage, and the harness's own comment says a profiled run's proportions are the finding
   and its milliseconds are not comparable to an unprofiled run. Proportions, per-draw and
   per-object costs are used; frame times are not.
3. **Frame time is vsync-bound and says nothing.** Three of the four rungs sit at 16.7 ms because
   browser rAF caps at 60 Hz. The stage timings underneath are what carry the signal, which is why
   `renderScene` at 25.2 ms and a 26.9 ms frame agree while the other rungs look identical.

**The spans do not fall into the trap the stage table fell into, and that is now measured rather
than argued.** The shadow-map render is executed inside `nodes.updateBefore` on a lit draw, so a
profiler that wraps three's methods bills a whole pass to one draw. The spans bracket *passes*
and compute each parent's residual by subtracting its children, so the nested shadow render is
its own span and no draw absorbs it. On a 400-object shadowed scene on the native host:

```
mainPass      perFrame 1   p50 6.07 ms   max 9.68
shadowPass    perFrame 1   p50 2.27 ms   max 3.19
draw          perFrame 791 p50 7.16 ms (aggregate)
coverage 1, residualMs 0.02
```

`shadowPass` is named and separate, and the tree still closes to `coverage 1`. That is the
difference between attributing by structure and attributing by method wrapping, and it is the
strongest justification for the spans existing alongside the older tool — stronger than the
portability argument below, because it is a correctness difference rather than a reach one.

**Prior art, and an honest note about this work's own scope.** `scripts/render-profile/renderer-stage-hooks.ts`
already existed and produced this table; `examples/engine-load-test` already exposed it behind
`?stages=1`. It is finer-grained than the spans Phase 1-2 landed, covering the per-draw subsystems
individually. Had it been found during recon, the attribution question would have been answerable
in the browser on day one, and this PRD would have started from these numbers rather than
building an instrument to obtain them. The spans still earn their place for reasons this tool
cannot cover — they ship inside `packages/core` behind a runtime flag, run on the native host
where a `scripts/` profiler does not, pin an exact three version where this one throws, and carry
residual/coverage accounting into the frame-budget window, the doctor and the DEV_MODE chip — but
the overlap is real and is recorded here rather than left for a reviewer to notice.

#### Attribution table

`examples/engine-load-test`, Chrome WebGPU, 1280x720, 480 measured frames per rung, L1 (one mesh
per object, no collapse). Columns are inclusive ms per frame.

| stage | 1,024 obj / 629 draws | % | 4,096 obj / 2,469 draws | % |
|---|---|---|---|---|
| `renderer.renderScene` | **5.81** | 100% | **25.20** | 100% |
| ├ `renderer.projectObject` (traversal) | 0.94 | 16% | 3.57 | 14% |
| ├ `renderList.sort` | 0.08 | 1.4% | 0.31 | 1.2% |
| ├ `renderer.renderObjects` (per-draw loop) | 4.87 | 84% | 21.98 | 87% |
| │ ├ `bindings.updateForRender` | 1.29 | 22% | 6.51 | 26% |
| │ ├ `renderObjects.get` | 0.50 | 9% | 2.67 | 11% |
| │ ├ `nodes.updateForRender` | 0.69 | 12% | 2.54 | 10% |
| │ ├ `backend.draw` | 0.37 | 6% | 1.76 | 7% |
| │ ├ `pipelines.getForRender` | 0.27 | 5% | 1.37 | 5% |
| │ ├ `geometries.updateForRender` | 0.21 | 4% | 0.86 | 3% |
| │ └ `nodes.updateBefore` + `updateAfter` | 0.25 | 4% | 0.85 | 3% |
| ├ `backend.beginRender` + `finishRender` | 0.08 | 1.4% | 0.12 | 0.5% |
| **unattributed** | **−0.08** | — | **−0.66** | — |
| **per draw** | **7.74 µs** | | **8.90 µs** | |
| **per object** | **0.92 µs** | | **0.87 µs** | |

The unattributed row is slightly negative because the harness declares five parent/child overlaps
(`projectObject` and `renderList.sort` are both inside `renderScene`'s inclusive time), so the
children double-count a little against the parent. It is left negative rather than clamped, for
the same reason the span residual is: a clamp is how a measurement error hides.

**The L3 control.** The same scene with the framework's collapse pass on renders 4,096 objects in
**3 draws**, and `renderScene` falls from 25.20 ms to **0.24 ms — 106× less CPU**. That is the
single most useful number here for PRD-397, and it is a bound rather than a promise: it is what
perfect batching of a scene with one shared material achieves. A real game's materials do not
collapse that far.

### Phase 5 — Warn the authoring agent before a human notices

The census and the phase split are already measured every frame and nothing reads them. An agent
building a scene gets no signal at all until a human plays the game and says it feels slow — which
is how a scene reached 1,815 triangles per draw with the GPU ten times under budget and nobody
knew. The engine knows sooner: a frame whose GPU is idle while its JS render phase is over the
display's own period is a scene-shape problem, and the shape is already in `TN_PROJECTION` and the
per-pass split.

- [x] Files wired: `packages/core/src/profiling/scene-warning.ts` emits `TN_SCENE_WARNING` once per
      reported window, carrying the verdict and the shape behind it — objects considered, culled,
      shadow-exempt casters, draws per pass, triangles per draw, the GPU's share, the render phase,
      the display period **and where that period came from**. On by default; it reads the census the
      frame already takes and measures nothing new.
- [x] The rule is derived, not a constant. It fires when the GPU used under a third of the frame
      *and* the JS render phase alone ran longer than the display's own period — a frame that cannot
      make the display's rate even if everything else in it were free. Both numbers are the frame
      meter's own. The period comes from the host's presentation cap (`__tnPresentationCap`, which
      on a native launch *is* the rate frames reach the display at) and otherwise from the frame
      rate the game itself declared; a launch that can name neither gets no verdict rather than a
      guessed one. There is no threshold to revisit.
      Result: `npx vitest run packages/core/__tests__/scene-warning.spec.ts` → 0, verdict on the
      reference fixture `objectsConsidered` at 1,815 triangles per draw
- [x] Required test passing: the warning fires on a fixture carrying the reference game's own
      numbers — 1,680 objects considered, 573 draws (158 main / 364 shadow / 51 reflection), 1,815
      triangles per draw, 1.9 ms GPU against a 20.2 ms frame and a 17.2 ms render phase.
      Result: `npx vitest run packages/core/__tests__/scene-warning.spec.ts` → 0 (7 tests)
- [x] Required test passing: the same warning does **not** fire on a GPU-bound fixture with the same
      draw count (GPU 12.4 ms), nor when the render phase fits inside the display's period, nor when
      the host caps presentation at 30 Hz, nor on a window whose GPU was never measured.
      Result: `npx vitest run packages/core/__tests__/scene-warning.spec.ts` → 0
- [x] Observed red: removing the GPU-share condition at `ac5c20413` fires the warning on the
      GPU-bound control, which is the failure that matters:
      `× stays silent on a GPU-bound scene with the same draws, so a heavy scene is not scolded`
      `AssertionError: expected { displayPeriodMs: 16.667, …(7) } to be undefined`
- [x] Files wired **and exercised as the shipped CLI**, both branches, in a scratch project with
      the built `threenative.js` rather than the source: `npx threenative doctor` carries a
      `scene shape` check that reads the recorded run output and repeats the most recent verdict.

      Empty project — an `ok` with a reason, never a failure:
      ```
      ✓ scene shape: no recorded run carries a scene verdict yet
      ```

      With the genuine two-window log from the native run above:
      ```
      ! scene shape: the last window was CPU-bound on scene shape: render 23.18 ms with the GPU
        at 0.041 of the frame, dominated by objectsConsidered
          fix: Reduce the dominant term before tuning the renderer: fewer objects and fewer
               draws, not different render settings.
      ```

      It reports **23.18 ms — window 2, the later one** — where the file's first warning says
      23.7 ms, so "most recent verdict" is observed behaviour rather than a described intent, and
      the fix line points at scene shape rather than render settings.
- [x] Files wired, **and verified against the rendered surface rather than asserted**: the
      `DEV_MODE=true` chip shows the verdict beside the frame rate. The real `UiLayer` was mounted
      in a browser and driven through the real `UI_DEV_METRICS_MESSAGE` from the game end of the
      bridge. Observed: the chip renders 8 px from the top and right, 432 px wide, `42 fps` on the
      first line with the verdict wrapped beneath it in amber `rgb(255, 217, 138)`, legible on a
      dark surface. **`pointer-events: none` holds in practice, not just in the stylesheet** —
      `document.elementFromPoint` at the chip's own centre returns the element underneath it, so a
      readout sitting over a button cannot eat the press. That was the one claim in this
      component's comment that a unit test could not make, and it is now observed
      (`packages/ui/src/UiLayer.tsx`), carried on the dev-metrics message the game already posts, so
      the human watching the window and the agent reading the log are told the same thing.
      **Superseded 2026-09-28**: the chip no longer draws the frame rate — the loop's rAF rate reads
      throttled under a compositor or a virtual display, so a number on it lied to anyone reading a
      screenshot. It carries the verdict alone, posted when the sentence changes rather than four
      times a second.
- [x] Files wired: all ten templates' `AGENTS.md` and the shipped `threenative-performance` skill
      name the warning, what it means, and that the answer is to move the draw and object counts —
      read the bucket census before promising a merge — not to change render settings.
- [x] The warning fires in a running game, on the native host, with its whole payload — proven
      on a synthetic scene rather than the reference game, and as a matched pair. Same game, same
      binary, same shadowed 1,561-object scene; the only difference is whether the engine's
      collapse is allowed to run:

      **Fires** (collapse off, render 23.7 ms):
      ```
      TN_SCENE_WARNING:{"displayPeriodMs":16.667,"displaySource":"host-cap","renderMs":23.7,
        "gpuShare":0.029,"dominantTerm":"objectsConsidered","dominantShare":0.337,
        "shape":{"draws":{"main":1535,"shadow":1539},"objectsConsidered":1562,
                 "shadowExemptCasters":28,"trianglesPerDraw":12,"culled":0},"window":1}
      ```

      **Silent** (collapse on, render p50 2.42 ms): **0 warnings** over the same 1,500 frames.

      Everything the design claimed is visible in that payload rather than asserted: the display
      period is 16.667 ms sourced from `host-cap` rather than a constant, the GPU share is 0.029
      against the one-third rule, the render phase genuinely exceeds the period, and the census
      carries the counts an author would act on. The pair also shows the warning is about scene
      shape and not about the machine — the machine is identical in both runs.
- [ ] User verification: the reference game emits the warning on its current scene and the record
      names the dominant term.
      Blocked by the VRAM tenant recorded in Phase 1. The fixture above is the reference game's
      measured shape, but a fixture is not the game and this box stays open until the game prints
      the line itself.

## Acceptance criteria

- [ ] An agent building a scene of this shape is warned by the engine before a human plays it: the
      warning fires on the reference game, names the dominant term, and is readable from both
      `doctor` and the `DEV_MODE` chip.
- [x] The warning stays silent on an honestly GPU-bound scene with the same draw count.
      Proven at the rule, on the reference game's own shape with only the GPU reading changed:
      `npx vitest run packages/core/__tests__/scene-warning.spec.ts` → 0, and removing the
      GPU-share condition turns that control red.
- [ ] `render`-span residual on native desktop is ≤0.5 ms of 16.1 ms.
- [ ] `render`-span residual in browser WebGPU is ≤0.5 ms.
- [x] Span overhead with `TN_FRAME_SPANS=1` is ≤0.3 ms p50 on native desktop. Measured on
      `examples/native-smoke`, not the reference game: three alternating pairs of 1,500-frame
      runs through the packaged host, frame p50 **off 1.83 / 1.52 / 1.67 ms** against **on 1.68 /
      1.67 / 1.70 ms**. The medians differ by **0.01 ms**, an order of magnitude inside the
      0.31 ms spread of the flag-off runs themselves, so the honest statement is that the
      overhead is **below this scene's noise floor** rather than any particular number.
      The flag was verified to actually apply rather than assumed: the same binary emits two
      `TN_FRAME_SPANS` windows with it set and zero without.
- [ ] Frame p50 with `TN_FRAME_SPANS` unset is within 0.1 ms of the 20.2 ms baseline.
- [ ] Top five leaf spans agree with the V8 sampling profile within 1.0 ms each.
- [x] Cost of one empty V8→host call is measured on native and written into this PRD: **74.07 and
      75.33 ns** across two launches, each the median of 7 runs of 1e6 calls.
- [x] Host calls per rendered frame is measured and written into this PRD: **4,131 WebGPU commands
      in 5 submits**, from the profile host's own per-frame count on this workload.
- [x] A per-draw cost in µs is published in this PRD: **7.74-8.90 µs/draw**, on the load-test
      scene rather than the reference game.
- [x] A per-object cost in µs is published in this PRD: **0.87-0.92 µs/object**, on the load-test
      scene rather than the reference game.
- [x] Each of H1-H7 carries a number and a confirmed/denied verdict. H3 is priced on the native
      host; H1, H2, H4, H6 and H7 on the load-test scene; H5 on a purpose-built shadow-casting
      scene. **What is still missing and would make this box a lie if unsaid:** every number
      comes from synthetic scenes, not the reference game, and H4 carries GC time but not
      allocation bytes.
- [x] Attribution table is checked in inside this file, with its scope limits stated above it.

## Verification boundary

**Proven here:** where the 16.1 ms render phase goes on native desktop and in browser
WebGPU, to ≥97%; the price of one host-boundary crossing; how many crossings a frame makes;
how much of the frame scales with draws and how much with objects.

**Not proven here:** that any of it can be removed. No optimisation is attempted, so no
speedup is claimed. Android and iOS attribution is explicitly unproven — those boxes name
their blocker and do not gate this PRD's completion; if the Android/iOS split differs from
desktop, PRD-396 and PRD-397 must be re-priced against it before their own acceptance.

**Not proven here:** anything about a second renderer path. This PRD measures the path we
have. If its output argues for ranked option 4 or 5, that argument is made in a new PRD
that also inherits the divergence harness from PRD-396.
