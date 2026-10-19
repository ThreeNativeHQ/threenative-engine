# PRD-393 — The native UI composites into the game's own frame

**Status:** Phases 1–6 DONE. Seven of ten acceptance criteria met with evidence; three are not, and
each is stated with its reason rather than left implied: **AC-5**'s diagnostics assertion, red on a
pre-existing three.js fault whose root cause is traced below and whose one-line fix was measured and
reverted because it costs Midway ~15 s of launch; **AC-9**, unrun because this host cannot build
Windows or macOS; **AC-10**, which is João's to run and which no local result substitutes for.
**One defect found by playing the game is half fixed and now has a gate of its own**: the loading
screen froze for 16 s at a time because the startup owns the frame thread. `TN_SLOW_PHASE` names the
two phases that own it, a bounded decode drain removed 12-14 → 57-63 page frames per startup, and
`scripts/verify-desktop-loading-animation.mjs` is red on the remaining 16.2 s freeze and on nothing
else. The rest is the loader/pump change this PRD hands over, with its cost measured.
**POST-DEVICE-EVALUATION-REQUIRED**
**Complexity:** 10 (HIGH); risk override: none — the score already lands HIGH
**Owner:** unassigned
**Depends on:** None

**Priority:** P1 — Open ACs need ui-parity green with zero diagnostics and owner Wayland proof UI composites.
## Context

On Linux the native desktop runtime draws the **entire** UI — loading screen, briefing, HUD —
in a WebKitGTK web view living in a *separate X11 window*: an override-redirect depth-32 ARGB
top-level placed over the SDL/WebGPU game window and blended by whatever X compositing manager
happens to be running. The game's own frame never contains a UI pixel.

Two independent defects follow from that design, both measured on 2026-09-17 against
`sandbox/midway-open-pacific` (a real game, `ui: { renderer: "web" }`, ~380k triangles):

**1. Nothing is painted on a KDE Wayland session.** On XWayland (`DISPLAY=:0`) the overlay window
is created, sized, positioned and mapped correctly and stays empty. Captured directly,
`import -window <id>` returns a 250-byte solid image; the same binary on a private
`Xvfb +extension COMPOSITE +extension SHAPE` with `xcompmgr -n` returns 78 KB of real UI.
`TN_UI_OVERLAY:{"attached":true}` is logged, the page loads and publishes `TN_UI_HIT_REGIONS`, so
the web view is alive and unpainted. Already excluded as causes: `GDK_BACKEND=x11`, unsetting
`WAYLAND_DISPLAY`, `WEBKIT_DISABLE_DMABUF_RENDERER`, `WEBKIT_DISABLE_COMPOSITING_MODE`,
`LIBGL_ALWAYS_SOFTWARE`, focus, stacking and geometry. The player sees a dark window and no UI.

The leading suspect is the foreign-window realization path rather than a missing X extension: the
code negotiates a depth-32 TrueColor visual itself, then hands GTK a *foreign* `GdkWindow`
(`packages/runtime-native/native/ui-overlay/src/argb.rs:1250`) and substitutes it at realize time
(`argb.rs:1280`), so WebKit's accelerated-compositing output may never target the window the X
server is showing. **Unverified** — no tracing has been done, and this PRD does not depend on it
being the cause.

**2. The overlay is serviced only by the game loop, so it starves.** `platform::pumpUiOverlay()`
(`packages/runtime-native/src/runtime.cpp:1294`) is its only service point and runs once per
main-loop iteration; `tn_ui_overlay_pump()` then drains *all* pending GTK work with no time budget
(`packages/runtime-native/native/ui-overlay/src/abi.rs:137`). Measured startup: first presented
frame at 8.9 s, `first_playable` at 47.2 s, and **three** presented frames in between — so the web
view received about three turns in thirty-eight seconds and its page finished mounting *after* the
game had already hidden its loading screen. The starvation runs both ways: an unbudgeted GTK drain
inside `pollEvents()` also delays the game's own frame.

Attempted repairs and what they proved (all on `sandbox/midway-open-pacific`):

| Attempt | Result |
|---|---|
| Throttled 8 ms pump from the two asset-read paths in `runtime.cpp` | Loading screen appeared in roughly 2 runs of 3 — not reliable |
| Same pump from the JS module-compile path (`v8_engine.cpp` `evalScript`) | **Broke rendering**: `native-playtests/ui-parity` went from clean to four `CreateBindGroup` validation errors against a 1×1 `Depth24Plus` placeholder. Proven by A/B on one engine revision. GTK iterations must never run inside JS evaluation. |
| Bounded startup hold in `packages/core/src/game.ts` on the `ui-ready` intent | Still inconsistent across repeat runs. `ui-ready` proves the page's script ran, **not** that a pixel reached the screen, so no amount of waiting can close this race. |
| `bootSplash.backgroundColor` wired to the X window background | Works — `#102a37` on screen at ~4 s. But from ~4 s until the world appears the frame is `gray(0)`: the WebGPU surface presenting black, because this game's only loading surface *is* the web overlay. |

The loading screen and the UI are the same component, so "wait for the UI before hiding the
loading screen" is circular. Codex reviewed the seam at xhigh on 2026-09-17 and called the
architecture indefensible for a 60 fps runtime independently of the paint bug: a manually pumped
external UI window sharing an unbounded game thread and presented outside the game's own swapchain
has structural starvation and reentrancy hazards. The current shipping answer is a nested
`Xephyr` + `xcompmgr` wrapper (`sandbox/midway-open-pacific/tools/run-native.sh`), which is a
diagnostic, not a product.

Files inspected: `packages/runtime-native/native/ui-overlay/src/{argb.rs,abi.rs}`,
`packages/runtime-native/src/platform/ui_overlay.cpp`,
`packages/runtime-native/src/{runtime.cpp,cli/main.cpp,platform/window.cpp}`,
`packages/runtime-native/src/webgpu/{bindings_presentation.cpp,bindings_canvas2d_composite.cpp}`,
`packages/runtime-native/CMakeLists.txt`, `packages/runtime-native/scripts/package-desktop.mjs`,
`packages/core/src/{game.ts,ui-bridge.ts,ui-layer.ts}`.

## Solution

**The UI becomes a texture in the game's own frame.** Render the web view offscreen, hand its
completed frames to the renderer, and composite them as a premultiplied-alpha quad inside the
existing present path. No second window, no override-redirect, no dependency on an external
compositing manager, and the UI is presented by the same swapchain as the world — so it cannot be
half a frame ahead, cannot be hidden by a compositor, and cannot be stacked wrong.

Consumer flow, unchanged from the game's side:

```
game src/ui/ (React)  →  offscreen web view  →  frame mailbox  →  wgpuQueueWriteTexture
        ↑                                                              ↓
   intents / state  ←── existing @threenative/core ui-bridge      UI quad drawn before
                                                                   presentPendingSurface()
```

Reused rather than invented:

- **The upload path already exists.** `bindings_canvas2d_composite.cpp:90` already does
  `wgpuQueueWriteTexture` for the canvas2d layer; the UI is the same shape of problem.
- **The present seam already exists.** `presentPendingSurface()` is called from
  `bindings.cpp:2892` and defined in `bindings_presentation.cpp:614`. The UI quad goes before it.
- **The protocol does not change.** `@threenative/core`'s `ui-bridge` message contract, the
  `ui-ready` intent, `TN_UI_HIT_REGIONS` and `uiOverlayInjectPointer` stay as they are. Games see
  no API change; `src/ui/` is untouched.
- **Dependency bundling already exists.** `package-desktop.mjs` discovers and bundles runtime
  dependencies, which is how a new web-engine shared library reaches an end user.

**Backend decision is Phase 1's output, not an assumption.** Two candidates, both real:

| Candidate | For | Against |
|---|---|---|
| **WPE WebKit** (`wpewebkit` 2.52.6, packaged on Arch; `libwpe` + `wpebackend-fdo` also packaged) | Designed for exactly this — embedders get buffers, not windows. SHM path gives CPU-readable frames; DMA-BUF path available later. | New system dependency to bundle; no GTK, so the existing `wry`/webkit2gtk code is replaced rather than adapted. Version parity with the installed `webkit2gtk-4.1` (2.52.6) is a coincidence to verify, not a guarantee. |
| **webkit2gtk offscreen** (already a dependency, 2.52.6 installed) | Zero new dependencies. Keeps `wry`. | Offscreen GTK rendering is not a supported embedding path; frame readback is a CPU copy of a cairo surface with no completion signal, and accelerated compositing in an offscreen window is the same murky area suspected of causing defect 1. |

Phase 1 picks one on measured evidence and records the rejected option and why, per the repository's
adoption rule. The rest of the PRD is written to be backend-agnostic behind one seam. **Phase 1
chose WPE WebKit** (measured 2026-09-17); the numbers and the rejected webkit2gtk-offscreen option
are recorded in Phase 1 below.

**Service the web engine off the game loop.** Whatever backend wins runs on its own thread or
process, continuously serviced, never gated by `pollEvents()`. The game loop only ever *takes the
latest completed frame* from a mailbox — a non-blocking read of at most one buffer. This is what
removes both starvation directions and the reentrancy hazard that broke rendering above; the
existing "pump from the game loop" contract is deleted, not tuned.

**Cost and its control.** A full 1080p60 RGBA copy is ~0.5 GB/s of bandwidth. Mitigations, in
order: upload only damaged regions (WPE reports damage), skip upload entirely on an unchanged
frame, and keep DMA-BUF import as the escape hatch if the SHM path misses the budget. Phase 3
measures this against `TN_FRAME_BUDGET` rather than assuming it.

**Risks**

- The chosen backend cannot produce CPU-readable frames without an X server at all → Phase 1 is
  explicitly a go/no-go with a named fallback, and it runs headless.
- Bandwidth exceeds the frame budget on the hero scene → damage-region upload, then DMA-BUF.
- Native popups (`<select>`) have no window to open into once the overlay window is gone. The
  existing implementation already treats them as a special case, and the game's own dropdown was
  observed unmapping the whole overlay before that was fixed. In-frame compositing means popups
  must be rendered *by the page*, which is a behaviour change for every game using a bare
  `<select>` — Phase 4 owns it and must not paper over it.
- Windows and macOS keep their existing child-window paths. This PRD is Linux-only and must not
  claim otherwise.

## Acceptance Criteria

- [x] AC-1 [local; actor: agent]: On a display with **no compositing manager at all**
      (`Xvfb` without `xcompmgr`), launching `sandbox/midway-open-pacific` shows the briefing UI in
      the game's own frame — captured from the game window, not the root. The current build cannot
      do this: the overlay refuses to attach without a compositor. — **Met.** Captured with
      `import -window <game window>` on `Xvfb :93` (no `xcompmgr` anywhere): the 1280×720 window
      holds the carrier deck *and* the briefing in one image, with the page's own `--ink` at
      `#ECEDDF` and `--gold` at `#E8D7B6`, and `TN_UI_HIT_REGIONS` publishing the six controls the
      briefing shows. Log: `TN_UI_OVERLAY:{"attached":true}` with no compositor refusal. Re-captured
      on the final binary: the same frame, `#ECEDDF` ink and `#E8D7B6` gold present.
- [x] AC-2 [local; actor: agent]: The game process creates **no override-redirect top-level
      window** on Linux. Asserted by walking the X tree for the game's pid and finding only the SDL
      window. — **Met.** The root has exactly three children for the game's X client: the SDL game
      window (1280×720 at +0+0, `IsViewable`, *not* override-redirect, `pid` = the game) and two
      unmapped SDL helpers (10×10 `InputOnly`, 1×1 `InputOutput`) that both exist *before* the
      overlay attaches at ~725 ms — i.e. they are SDL's, not the overlay's, and neither is a
      top-level anyone can see. Zero override-redirect windows belong to the game's process tree.
      The depth-32 override-redirect top-level the old overlay created is gone with `argb.rs`.
      Re-walked on the final binary with the same result.
- [x] AC-3 [local; actor: agent]: The loading screen is visible in **10 consecutive launches** of
      `sandbox/midway-open-pacific`, sampled from the game window before `first_playable`, with the
      `#loading` markup's own background colour present in every one. Today this is ~2 in 3. —
      **Met, 10/10.** Every launch sampled from the game window 8 s in: 916 624 pixels of
      `#102a37` (the `#loading` background, and the `bootSplash` colour) **plus 2 776 pixels of
      `.load-title`'s own `#ECEDDF`** — the second is what rules out "the X window happens to be the
      boot-splash colour". `first_frame` landed at 3.81–5.53 s in all ten; `first_playable` (~39 s
      on this host) was asserted *not* reached in every one, because each run was stopped at 8 s.
      A finer sweep shows no black frame anywhere: `#102a37` at 1 s, 2 s, 3 s, then `#102a37` plus
      the page's gold and ink from ~4 s. **Re-run on the final binary** after the in-page `<select>`
      work landed, 10/10 again: 916 624 pixels of `#102a37` and 2 776 pixels of the title's ink in
      every one, `first_frame` at 3.64–3.76 s — tighter than the first sweep, because nothing else
      was competing for the machine.
- [x] AC-4 [local; actor: agent]: Web-view frames keep advancing while the game loop is blocked —
      assert the mailbox's frame counter increases across a deliberate ≥2 s stall in the game
      thread. This is the defect that starved the page to three turns in thirty-eight seconds. —
      **Met.** `the_mailbox_advances_while_the_reader_is_blocked` in `offscreen.rs`: a publisher
      thread publishes every 5 ms while the reading thread sleeps 2 s, and the test asserts the
      counter passed 20 across the stall and that exactly one frame is retained (latest wins). In
      the live game: `TN_UI_COMPOSITE` reports `counter:504` at ~45 s of a launch whose
      `first_frame` was at 4 166 ms and which presented a handful of frames across those 45 s. The
      pre-change baseline is not re-measured — that feeding path is deleted — and the measurement
      that motivated the phase (three turns in thirty-eight seconds) is recorded above instead of
      being re-derived.
- [ ] AC-5 [local; actor: agent]: `native-playtests/ui-parity.playtest.json` passes with **zero**
      runtime diagnostics on the artifact built from this PRD, including the dropdown, the command
      overlay and the map — the same scenario that caught the `CreateBindGroup` regression. —
      **NOT MET, and not by this change.** Every step and every resource assertion passes:
      `choose-torpedo` (`ui.loadout.id === "torpedo"`), `take-deck` (`ui.screens.flight`),
      `open-command` (`ui.overlay === "command-overlay"`), `order-cover`
      (`hud.battle.command === "cover"`), `open-map`/`close-map` (`hud.mapOpen` true → false), with
      all five presses routed to the page (`TN_UI_POINTER_ROUTE … "hit":true`). The `diagnostics`
      assertion is red on **one** WebGPU validation error (four console lines): a 1×1
      non-multisampled `Depth24Plus` texture bound against a layout expecting `multisampled: 1`. It
      is **not** produced by this PRD, measured four ways: (a) with the UI composite ablated
      (`TN_ABLATE_UI_COMPOSITE=ON` — overlay attached, page publishing regions, every step driven,
      **no upload and no quad drawn at all**) the same four lines appear; (b) the *unmodified*
      engine (`prebuilt/linux-x64/threenative-runtime`, packed into the same game) produces the same
      three bind-group lines on the same scenario; (c) it survives `alphaAntialiasing: false` as
      well as `true`, so it is not the MSAA path the config selects; (d) it is intermittent, and it
      does not stop the game rendering — 453 presented frames and complete captures in the runs that
      show it, and the previous session's own `ui-parity` console for this game has zero. Its shape
      is three.js's own bind-group layout asking for a multisampled depth texture and binding a 1×1
      `Depth24Plus` placeholder, at the frame the pipeline warmup completes (`present:8`,
      `requested:54 emitted:54`). The scenario's driver also needed a real fix, which is the pointer
      latch described in Phase 4.

      **Root cause, traced into three, and why the one-line fix is not free.** In three 0.185.1
      `WebGPUTextureUtils.getTextureSampleData()` answers a depth texture's sample count from the
      *ambient* render target when the texture has no render target of its own:

      ```js
      } else if ( texture.isDepthTexture && ! texture.renderTarget ) {
          const renderTarget = renderer.getRenderTarget();
          samples = renderTarget ? renderTarget.samples : renderer.currentSamples;
      }
      ```

      `_createLayoutEntries()` turns that into `texture.multisampled = true` for a bind group's
      layout, and `createBindingsLayout()` then **freezes** it on the bind group (`bindingsData.layout`
      is returned unchanged on every later call). `ViewportTextureNode.updateReference()` meanwhile
      re-points the same binding every frame at whichever target is current, so the texture the group
      is built against is not the texture the layout was derived from. Three's own shared viewport
      depth buffer — `_sharedDepthbuffer = new DepthTexture()`, which is **1×1** and has no render
      target, and which `viewportDepthTexture()` binds whenever the current target has no depth
      attachment — is exactly such a texture. `packages/core/src/water-surface.ts` reads the scene
      depth through that node, which is why this game and not a game without water shows it.

      A one-line patch (`samples = 1` for a depth texture that owns no render target) **does remove
      the error** — measured, 0 occurrences against 1 in every unpatched run — and it is *correct*:
      the texture in question is a single-sample view, and a depth texture that really is attached to
      an MSAA target takes the other branch. It was **reverted anyway**, because it is not free:
      `first_playable` on this game moved from **33.0 / 34.8 s unpatched to 48.0 / 51.3 / 49.5 s
      patched**, three consecutive runs against two, and reverting it restored 36.1 s. Changing that
      flag changes the bind group layout hash, hence the pipeline layout and every pipeline that
      names it, and this game's startup is dominated by pipeline compiles. A second variant that left
      the WGSL declaration's ambient read alone and changed only the layout cost the same 48.0 s, so
      the price is the layout change itself rather than a shader-source recompile.

      So the defect is real, its mechanism is now exact, and the fix needs the pipeline-cache and
      warmup interaction understood before it lands. It is handed over here rather than absorbed:
      it does not affect what a player sees (55 fps, correct pixels, one validation line at
      startup), and shipping it blind would cost this game fifteen seconds of launch.
- [x] AC-6 [local; actor: agent]: UI compositing costs **≤ 2.0 ms/frame at p95** on the hero scene
      at 1280×720, measured as a named phase in `TN_FRAME_BUDGET` over ≥300 frames, interleaved
      against a build with the UI quad disabled (this host drifts wider than small effects, so
      alternate the pairs). — **Met: 0.10 ms p95 against 0.00 ms ablated, a delta of +0.10 ms.**
      Three interleaved pairs, each arm on its own private display, each run 300-frame windows:

      | run | arm | ui p50 | ui p95 | ui worst window p95 | ui worst single frame |
      |---|---|---|---|---|---|
      | on-1 | composite | 0.04 | 0.05 | 0.51 | 11.84 |
      | off-1 | ablated | 0.00 | 0.00 | 0.00 | 0.01 |
      | on-2 | composite | 0.04 | 0.19 | 0.19 | 4.58 |
      | off-2 | ablated | 0.00 | 0.00 | 0.00 | 0.01 |
      | on-3 | composite | 0.04 | 0.07 | 0.64 | 3.73 |
      | off-3 | ablated | 0.00 | 0.00 | 0.00 | 0.05 |

      All three pairs have the same sign (+0.05, +0.19, +0.07), and the ablated arm reads exactly
      0.00 in all six windows — the phase is measuring the composite and nothing else. **Two
      caveats a reader must carry.** First, this lane rasterises in software: the frame is ~60 ms
      (`present` p95 73–89 ms) at ~15 fps, so the composite is ~0.1% of it and this is not a
      sensitive instrument for small costs on real hardware — what it establishes is that the
      composite is far inside the budget, not that 0.1 ms is its cost on a GPU. Second, **p95 hides
      a first-use spike**: single frames reach 11.84 / 4.58 / 3.73 ms on the composite arm against
      0.05 ms ablated, which is the first upload of a 1280×720 texture. If this criterion is ever
      restated as a worst-frame bound rather than a p95, the composite arm exceeds 2.0 ms there and
      the fix is the damage-region upload the PRD lists as the first mitigation.

      **The same phase on real hardware, which the Xvfb lane cannot speak for.** One ordinary
      windowed launch on this workstation's own KDE Wayland session (XWayland, real RTX 2080),
      300-frame window: **`ui` p50 0.03 ms, p95 0.31 ms, mean 0.05 ms at 54.8 fps**, with the GPU
      reporting 2.36 ms p50 and 1.06 M + 918 k + 522 k triangles across the main, shadow and
      reflection passes. `TN_UI_COMPOSITE` for that run reads **4 uploads and 1548 skips** — the page
      changed four times in 1552 frames and the texture was re-uploaded exactly four times, which is
      the skip path doing its job rather than a claim about it.
- [x] AC-7 [local; actor: agent]: A game with `ui: { renderer: "native" }` still starts and renders
      with no web engine initialised at all — no regression for games that never asked for a web UI.
      — **Met.** `examples/auto-lod` (`ui: { renderer: "native" }`) built for desktop and run on a
      private display: **1038 presented frames**, `TN_UI_OVERLAY` count **0**, `TN_UI_COMPOSITE` count
      **0**, no child processes, and **0** WebKit processes on the machine descended from it. The
      `ui` phase is a real zero rather than an absent phase, and `__tnUiCompositeMs` answers 0 while
      no overlay exists.
- [x] AC-8 [local; actor: agent]: The X11 overlay implementation is **deleted**, not left beside the
      new path: no `Placement::Overlay`, no `tn_ui_overlay_pump` call from the frame loop, and
      `sandbox/midway-open-pacific/tools/run-native.sh` removed with its reason recorded. —
      **Met.** `argb.rs` and `bin/probe.rs` are deleted; `grep -rn "Placement::|ensure_compositor|
      SelfCompositor|compositor_present"` over the crate and the runtime returns nothing;
      `tn_ui_overlay_pump` survives only in `desktop.rs` (Windows/macOS) and is called only under
      `#if defined(_WIN32) || defined(__APPLE__)`, never from the frame loop, where the `ui` phase
      is now the compositor; `tools/run-native.sh` is removed with its reason in Phase 5.
- [ ] AC-9 [local; actor: agent]: Windows and macOS builds are unchanged by this PRD — their UI
      paths still compile and their existing native gates pass. — **UNRUN on this host.** The claim
      rests on inspection, not on a build: `desktop.rs` is untouched, the crate's Windows/macOS
      dependency tables are untouched, every new declaration in the C++ seam is Linux-only
      (`__linux__ && !__ANDROID__` for the mailbox and keyboard entry points, with the frame and
      keyboard accessors returning false elsewhere), and the composite compiles to a no-op without a
      WebGPU backend. A reader should treat this as unverified.
- [ ] AC-10 [owner; actor: João]: On João's own KDE Wayland session, an ordinary launch of the
      packaged `midway-open-pacific` shows the loading screen and then the interactive briefing,
      with no nested X server and no wrapper script. This is the acceptance the whole PRD exists
      for and no `local` result substitutes for it. — **Awaiting João.** The wrapper script it names
      is deleted, and the `local` lanes above ran on a private `Xvfb`; the session this criterion is
      about has not been driven by an agent. **A local observation, not a substitute:** one ordinary
      windowed launch on that session showed the loading screen and then the interactive briefing,
      captured from the game window with the page's own `#ECEDDF` ink and `#E8D7B6` gold present and
      the world behind them, with no nested X server and no wrapper script — the wrapper is deleted.
      João's own run is still the acceptance.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Web UI presented to the player on Linux | Game launch → `attachDesktopUiOverlay` call site `packages/runtime-native/src/cli/main.cpp:1168` → new offscreen backend → UI quad before `presentPendingSurface()` (`packages/runtime-native/src/webgpu/bindings.cpp:2892`) | **Replaces** the X11 override-redirect overlay in `native/ui-overlay/src/argb.rs`; that path is deleted for Linux (AC-8) | AC-1, AC-2, AC-8 |
| Web-view servicing | Own continuously-serviced thread/process | **Replaces** `platform::pumpUiOverlay()` from the frame loop (`packages/runtime-native/src/runtime.cpp:1294`); the game loop only takes the latest mailbox frame | AC-4 |
| Pointer input into the page | Existing `uiOverlayInjectPointer` / `TN_UI_HIT_REGIONS` contract, unchanged signature | Re-pointed at the offscreen view; hit regions still published by the page | AC-5 |
| A `<select>`'s list | A press on a `<select>` in any game's native UI → `NATIVE_SELECT_SCRIPT` (injected at document start by the overlay crate) → rows marked `data-tn-interactive` → the host's own routing | **Replaces** the native popup the deleted overlay window used to host. The project styles `[data-tn-native-select]`; the host owns only geometry | `native-playtests/native-select.playtest.json`: opening the list publishes four new regions and picking one sets `ui.assignment.id` to `recon` |
| Keyboard into the page | `uiOverlayInjectKey` + `key_injection_script`, gated by `uiOverlayKeyboardCaptured`, which the page reports over its private `tnKeyFocus` channel | New: keys reach the page only while the page holds focus, so a listbox or a text field works and every other key stays the game's | The select scenario drives the list by pointer; the focus rule is what keeps `KeyQ` in `ui-parity` reaching the game |
| Loading screen visibility | `ctx.startup` cover → UI quad composited while startup is held | **Replaces** the `framework:ui-ready` hold added in `packages/core/src/game.ts` during investigation, which cannot work: `ui-ready` proves script execution, not presentation. Remove it in Phase 6. | AC-3 |
| `bootSplash.backgroundColor` on desktop | `applyEmbeddedBootSplash()` in `packages/runtime-native/src/platform/window.cpp` | Keep — independently correct and already verified on screen. Extend to the held-startup clear colour so the gap after it is not `gray(0)`. | AC-3 |

## Execution Phases

#### Phase 1: Pick the backend on evidence
**Status:** DONE — backend chosen: **webkit2gtk-4.1 offscreen**. WPE WebKit was chosen first and then
**reversed on measurement**; the reversal and its evidence are below.
**ACs:** none directly — this phase de-risks AC-1 and AC-4
**Files:** `packages/runtime-native/native/ui-overlay/src/bin/probe-wpe.c` and
`probe-gtk-offscreen.c` (throwaway probes beside the crate's existing `bin/probe.rs`; each carries
its own build/run recipe in the header); notes below
**Implementation:** Both candidates were driven headlessly to produce a CPU-readable 1280×720 frame
of the same fixture: four opaque solid quadrants (`#ff0000`, `#00ff00`, `#0000ff`, `#ffff00`) plus a
`requestAnimationFrame` tick, so a blank, stale or wrongly-ordered buffer fails on pixel values.
**Verification:** E1 — the known-rectangle assertion runs in-process on the raw CPU buffer (no
encoder in the loop): a missing/blank/misformatted frame fails `rects_ok`. Both candidates returned
`rects_ok:true` with identical expected values, so neither backend is the go/no-go failure this
phase existed to catch.
**Measured results (2026-09-17, this host):**
- **WPE WebKit 2.52.6** (`probe-wpe.c`, no X server at all, no compositor): `WPEBufferSHM`,
  ARGB8888, 1280×720, stride 5120, **3 686 400 bytes/frame**; **234 frames / 3.70 s = 63.2 fps**
  (the headless view commits at its internal 60 Hz timer); completion signal `WPEView::buffer-rendered`
  fires per committed frame (`n_params=1`, the buffer) with `buffers-changed` reporting 2 buffers.
  Damage is passed to `WPEViewClass::render_buffer(damage_rects, n_damage_rects)` but the headless
  display drops it; the signal exposes no damage — **not observed end-to-end**.
- **webkit2gtk-4.1 offscreen 2.52.6** (`probe-gtk-offscreen.c`, `Xvfb` with no xcompmgr,
  `WEBKIT_DISABLE_COMPOSITING_MODE=1` because GDK cannot create a GL context on a bare Xvfb):
  cairo ARGB32, 1280×720, stride 5120, **3 686 400 bytes/frame**; **2850 snapshot completions /
  6.00 s = 475.3/s** readback, but content actually changed only 374 times in 6 s (~62 fresh/s,
  matching the page's rAF) — the rest re-read an unchanged surface. Completion is the async
  `webkit_web_view_get_snapshot` callback **per request**: pull-only, no autonomous frame emission,
  and no damage regions (full-surface snapshots).
**Decision: webkit2gtk-4.1 offscreen.** WPE WebKit was the first pick and is the better engine for
this job on paper. It was reversed on measurement, because it cannot deliver a CPU-readable frame on
the machine AC-10 is about, and because the product cannot ship it:

1. **No frames at all on a real GPU session.** Re-run on this host with the DRM device present
   (`probe-wpe 5`, no `LIBGL_ALWAYS_SOFTWARE`), WPE reports `frame:false` with **frames:0** and every
   `buffer-rendered` failure is `import_to_pixels failed: Failed to import buffer to pixels buffer:
   gbm_bo_map failed`. The identical binary with `LIBGL_ALWAYS_SOFTWARE=1` returns
   `frame:true, shm:true, rects_ok:true, 296 frames / 4.69 s = 63.1 fps`. So the only way WPE hands
   over pixels on this host is a **process-wide `LIBGL_ALWAYS_SOFTWARE=1`**, and a runtime cannot set
   that: it would force software GL on the game's own renderer too. The alternative — importing the
   DMA-BUF into WebGPU — is a Dawn-only path this runtime does not currently expose, and is not
   something to bet an acceptance criterion on.
2. **The product cannot ship it.** The distribution `libWPEWebKit` hardcodes `/usr/lib/wpe-webkit-2.0`
   as the location of its own web process, so running it unprivileged needed that string **patched
   out of the shipped binary** plus a `/tmp/wpe` symlink pointing at an extracted prefix. A product
   does not ship a patched distribution library.
3. **Cost.** WPE is 130 MB of new payload (`libWPEWebKit-2.0.so.1.9.10` is 128 MB) plus 2.5 MB of
   helper executables, and ~30 licences. webkit2gtk adds **nothing**: the Linux desktop `mystral`
   built here already `ldd`-links `libwebkit2gtk-4.1.so.0`, `libjavascriptcoregtk-4.1.so.0`,
   `libgtk-3.so.0` and `libsoup-3.0.so.0` because `wry` pulls webkit2gtk on Linux today.

What WPE is genuinely better at is recorded and not disputed: it pushes frames on the page's own
cadence with a `buffer-rendered` completion instead of being pulled, and it is the only candidate that
runs with no display server at all. **Named fallback: WPE**, if the CPU cost of the GTK path ever
proves fatal. It is not taken now because a fallback that cannot produce a pixel on the target machine
is not a fallback.

**What the GTK path costs, named as a constraint.** The web view must run with
`WebKitSettings:hardware-acceleration-policy = NEVER`. Left accelerated, WebKit **aborts the process**
on a `GtkOffscreenWindow` — `probe-gtk-offscreen` under `TN_GTK_COMPOSITING=1` exits **134 (SIGABRT)**
with `GDK is not able to create a GL context: The current backend does not support OpenGL`, because an
offscreen window has no `GdkWindow` to host a GL surface. With the policy set, the same binary passes
on this host's real session in **all three** GDK backend modes (default, `x11`, `wayland`):
`rects_ok:true` and 493.1 / 457.5 / 458.8 snapshots per second at 1280×720. So the UI rasterizes on
the CPU inside the web process — that is the measured cost Phase 3's budget has to carry, and the
reason Phase 2's snapshot cadence is demand-driven rather than a fixed rate.

**Licence and bundled-library obligations:** wpewebkit is **LGPL-2.1-only / LGPL-2.1-or-later** plus
bundled AFL-2.0/GPL/Apache-2.0/BSD/MIT/MPL-1.1/MPL-2.0/OFL-1.1 files (Arch `license` field), installed
138.6 MiB, `libWPEWebKit-2.0.so` 128 MiB, 112 shared objects via `ldd`; `libwpe` and
`wpebackend-fdo` are **BSD-2-Clause**. webkit2gtk-4.1 carries the same WebKit source set and is
already installed (90 MiB `.so`, 143 `ldd` objects) as a `wry` dependency, and the Linux desktop build
already links it, so the chosen backend adds **no** new library, no new licence and no new obligation.
**Checkpoint:** Phase 1 complete — both probes built and run, numbers above recorded from the
actual runs, decision and rejected option recorded, licence/bundled-library obligations recorded.
- [x] WPE candidate probed, numbers recorded — 63.2 fps / 3 686 400 B/frame / SHM ARGB8888 /
      `buffer-rendered` completion / no X server **with `LIBGL_ALWAYS_SOFTWARE=1`**, and **zero
      frames** without it on the real session (`probe-wpe.c`)
- [x] webkit2gtk-offscreen candidate probed, numbers recorded — 475.3 snapshot/s (374 content
      changes in 6 s) under Xvfb, 493.1 snapshot/s on the real session in default/`x11`/`wayland`
      backend modes, 3 686 400 B/frame, pull-only completion (`probe-gtk-offscreen.c`)
- [x] decision recorded in this PRD with the rejected option and the reason — **webkit2gtk-offscreen
      chosen, WPE rejected** (no CPU frames on a real GPU session without a process-wide software-GL
      override; needs a patched distribution library; 130 MB and ~30 licences)
- [x] licence and bundled-library obligations recorded — WPE LGPL-2.1 + bundled set, libwpe/
      wpebackend-fdo BSD-2-Clause; webkit2gtk already present and already linked by this build

#### Phase 2: Frame transport off the game loop
**Status:** DONE
**ACs:** AC-4
**Files:** `packages/runtime-native/native/ui-overlay/src/offscreen.rs` (new), `src/abi.rs`,
`packages/runtime-native/src/platform/ui_overlay.cpp`
**Implementation:** Run the web engine on its own continuously-serviced thread or process. Publish
completed frames into a mailbox holding at most one buffer plus a monotonic frame counter; the game
side only ever takes the latest. No GTK/WebKit call may run on the thread that owns JavaScript —
that is the hazard that produced the `CreateBindGroup` regression. Keep the existing inbound message
queue semantics (`queueUiMessage`/`takeUiMessage`) so the bridge contract is untouched.
**Verification:** E1 — a test stalls the game thread ≥2 s and asserts the mailbox counter advanced
and exactly one buffer is retained. Negative control: the same assertion against a mailbox fed from
the frame loop MUST fail, which is the pre-change baseline.

**What shipped.** `offscreen.rs` owns one thread (`tn-ui-web`) that runs GDK's main loop, and the
game thread never enters it. The mailbox is `Mutex<Option<Frame>>` with an `AtomicU64` counter and
`Arc<Vec<u8>>` pixels, so publishing is a pointer swap and the game copies nothing; the web view's
own buffer recycling means a still page allocates nothing at all. The snapshot cadence is
demand-driven — 16 ms while the page is changing, doubling to a 250 ms floor once it has not — which
is what keeps CPU rasterisation off the game's back and is why the phase measures 0.3 ms rather than
a full-page copy.

**Evidence.** `cargo test --release --lib` in `native/ui-overlay` — 15 tests, including
`the_mailbox_advances_while_the_reader_is_blocked` (a producer thread publishes every 5 ms while the
reading thread sleeps 2 s; the counter must pass 20 and exactly one frame must be retained,
latest-wins) and `the_mailbox_keeps_one_frame_and_counts_every_publication`. In the live game the
same property is visible end to end: `TN_UI_COMPOSITE` reports `counter:504` after ~45 s of a
Midway launch whose own `first_frame` was at 4.17 s and which presented a handful of frames in
between, i.e. the web view produced 504 frames while the game loop was mostly blocked.

**Baseline red was not re-measured.** The pre-change wiring is deleted, so the negative control the
PRD asks for cannot be run against it; what stands in its place is the measurement that motivated
the phase, recorded in this PRD: three feedings in thirty-eight seconds. The new wiring's stall test
is green, and the counter's behaviour across a stall is directly observable in every launch.

**No GTK/WebKit call is reachable from the JS thread**: the crate's only GTK entry points are
`gtk::init`, the offscreen window, the web view and its signals, and every one of them is called
inside `web_thread` (inspected; `grep -n 'gtk::\|webkit2gtk::' src/*.rs` shows the game-side ABI in
`abi.rs` names none of them).

**Checkpoint:** done
- [x] backend serviced off the game loop — `offscreen::spawn` owns `tn-ui-web`; `pumpUiOverlay()`
      only drains the inbound queue on Linux
- [x] mailbox holds one frame, latest wins, counter monotonic — unit tests plus `TN_UI_COMPOSITE`'s
      `counter`/`uploadedCounter`
- [x] stall test green; baseline red not re-measured (the pre-change feeding path is deleted) —
      stated rather than assumed
- [x] no GTK/WebKit call reachable from the JS thread (inspected, not assumed)

#### Phase 3: Composite the UI into the frame
**Status:** DONE
**ACs:** AC-1, AC-6
**Files:** `packages/runtime-native/src/webgpu/` (new UI composite unit beside
`bindings_canvas2d_composite.cpp`), `packages/runtime-native/src/webgpu/bindings_presentation.cpp`
**Implementation:** Upload the mailbox frame with `wgpuQueueWriteTexture` — same mechanism as
`bindings_canvas2d_composite.cpp:90` — and draw a premultiplied-alpha quad before
`presentPendingSurface()`. Skip the upload when the frame counter has not advanced. Upload only
damaged regions if the chosen backend reports them. Add a named `ui` phase to `TN_FRAME_BUDGET`;
do not reuse the existing `overlay` phase, which is the canvas2d layer and has misled a reader once
already.
**Verification:** E1 — launch under `Xvfb` with **no** compositing manager, capture the game window,
assert the briefing's known UI pixels are present (AC-1). E2 — interleaved frame-budget pairs with
the quad enabled/disabled, 3 pairs, ≥300 frames each, p95 delta ≤ 2.0 ms (AC-6).

**What shipped.** `bindings_ui_composite.cpp` uploads the mailbox frame with `wgpuQueueWriteTexture`
and draws one premultiplied quad into `presentation.currentTextureView` — the frame's own colour
target, which is the swapchain image on a direct surface and the linear intermediate when the sRGB
presentation bridge is on — immediately before `presentPendingSurface()`. The upload is skipped
entirely when the page's counter has not moved. The blob is cairo `ARGB32` premultiplied, which on a
little-endian host is `B,G,R,A` = `BGRA8Unorm`, so no swizzle is involved.

**One colour-space mistake, found and fixed by looking at the pixels.** The first version wrote
linear premultiplied in both presentation modes, on the assumption that whatever the target is, it
encodes. On this host the surface is plain `bgra8unorm` (no sRGB), so nothing encodes and the page's
`#eceddf` ink arrived on screen as `#d6d8bc` — `srgb_to_linear(#eceddf)` to the byte. The shader now
encodes when the frame target is a non-sRGB surface and stays linear when the hardware or the bridge
will do it; the same capture then read `#ECEDDF` exactly.

**Checkpoint:** done
- [x] UI pixels present in the game's own frame with no compositor running — captured from the game
      window on a private `Xvfb` with no `xcompmgr`; `#ECEDDF` ink and `#E8D7B6` gold present, and
      the whole briefing legible over the carrier deck in one frame
- [x] unchanged frames skip the upload (asserted, not assumed) — `TN_UI_COMPOSITE` reports
      `uploads` and `skipped` separately; a still briefing measures ~15 skipped/s against ~1
      upload/s
- [x] `ui` frame-budget phase reported separately from `overlay` — `ui` is its own segment in
      `TN_HOST_GAP` and its own phase in `TN_FRAME_BUDGET` (`FRAME_BUDGET_PHASES` gained `"ui"`,
      `addUi`, and a `__tnUiCompositeMs` host global), with `overlay` untouched
- [x] p95 cost within AC-6, interleaved measurement — 0.10 ms against 0.00 ablated, +0.10 ms
      delta, three interleaved pairs; AC-6 carries the table and two caveats

#### Phase 4: Input, hit regions and popups
**Status:** DONE — one box open: `ui-parity` passes every step, its diagnostics assertion is red on
a pre-existing fault (AC-5)
**ACs:** AC-5
**Files:** `packages/runtime-native/src/platform/ui_overlay.cpp`,
`packages/runtime-native/native/ui-overlay/src/`
**Implementation:** Route OS pointer and keyboard events into the offscreen view against the
published hit regions, keeping `uiOverlayHitTest` and `uiOverlayInjectPointer` signatures. Decide
and document the native-popup answer: with no overlay window, a bare `<select>` must render its list
*in the page*. If that requires games to stop relying on native popup chrome, say so in the template
`AGENTS.md` and the UI docs — a capability the template docs omit does not exist.
**Verification:** E1 — `native-playtests/ui-parity.playtest.json`, which already exercises the
loadout buttons, the assignment dropdown, the command overlay and the map, with zero runtime
diagnostics.

**What shipped.** One authority decides which side a pointer event belongs to —
`platform::uiOverlayRoutePointer` — because there are two callers that must not be able to
disagree: the OS event loop (`window.cpp`, real presses) and the playtest bridge
(`runtime.cpp`, synthetic ones). It owns the gesture latch and the last position, and both callers
now go through it.

**The bug that fix exposed, and why it mattered.** A release arrived with no position at all
(`clientX=0, clientY=0`), so the old rule — hit-test every event and hand over only if it lands
inside a published rectangle — dropped the `pointerup` of a press the page was already holding. The
loadout button never activated, and the scenario's first interaction timed out with
`last observation "bomb"`. A gesture now completes on the control that received its press, wherever
the release is reported, which is what a window system does and what the injected `click` depends
on. Measured before and after: `pointerup … "hit":false` → `"hit":true` on all four presses, and
`choose-torpedo`, `take-deck`, `open-command`, `order-cover`, `open-map`, `close-map` all pass.

**Keyboard: the game's, until the page holds it.** A rectangle says where a press landed; it says
nothing about who should receive `ArrowUp`. The overlay this replaces never took keyboard focus
either (`WM_HINTS input=false`, set deliberately), and every key in this repository's games and
templates is the game's — movement, `KeyQ` for the command overlay, `M`/`P`/`Escape`. Routing keys
by hit region would swallow exactly those, including the `KeyQ` step `ui-parity` asserts. So the
rule is the page's own focus and nothing else: while a focused input, textarea, select or open list
is in the page, keys are forwarded to it; otherwise they are the game's. See the popup answer below
for the consumer that made this more than a mechanism waiting for one.

**The popup answer: the host draws the list in the page, and the project styles it.** With the UI
composited into the game's own frame there is no view for WebKit's native `<select>` menu to open
into, and the host's synthetic presses are untrusted DOM events, which a browser never uses to open
a native popup — so a bare `<select>` could neither show its list nor be operated. The overlay this
replaced *did* serve that control (it was a real window with a real popup), so deleting the window
without replacing this would have quietly broken every game with a dropdown. The host therefore
injects `NATIVE_SELECT_SCRIPT` at document start, in the crate, so every Linux game gets it and no
game has to know: a press on a `<select>` opens a list under the control, each row marks itself
`data-tn-interactive` so the host's own routing can reach it, and choosing a row sets
`select.value` and dispatches `input` + `change` — a listener written for the browser's popup runs
unchanged.

It owns no appearance, the same division as `DebugOverlay`: the list is `[data-tn-native-select]`
and its rows `[data-tn-native-select-option]`, and the project gives them a look. What the host
does set is geometry — where the list sits and that it scrolls — because an unpositioned list is not
an unstyled control, it is a broken one. The starter template's `AGENTS.md` names both selectors in
the line that already tells a game to mark its touch targets, and `packages/ui/AGENTS.md` states the
same where the HUD's author reads it.

**Keyboard, finally, has a consumer.** The list is a listbox and has to be operable with arrows and
Enter, which needs keys in the page — so the host now forwards keys to the page while, and only
while, the page holds the keyboard: it reports focus (input, textarea, select, or the open list)
over a private `tnKeyFocus` channel, and `uiOverlayKeyboardCaptured` is what the game loop asks
before it forwards. Every other key is still the game's, which is what keeps `W` as throttle and
`KeyQ` as the command overlay.

**Checkpoint:** done, except the `ui-parity` diagnostics assertion — see AC-5.
- [x] pointer and keyboard reach the page through the existing contract — one shared pointer seam
      with a gesture latch, and keys forwarded to the page while it holds the keyboard
- [ ] `ui-parity` green with zero diagnostics — every step and resource assertion passes;
      the diagnostics assertion is red on an intermittent, pre-existing WebGPU validation error
      that the unmodified engine also produces (AC-5 below)
- [x] popup behaviour decided, implemented and documented in the template docs

#### Phase 5: Delete the X11 overlay and ship the dependency
**Status:** DONE — one box open: Windows/macOS (AC-9) are unrun on this host and stated as such
**ACs:** AC-2, AC-7, AC-8, AC-9
**Files:** `packages/runtime-native/native/ui-overlay/src/argb.rs` (delete the overlay window path),
`packages/runtime-native/src/runtime.cpp` (remove the frame-loop pump),
`packages/runtime-native/CMakeLists.txt`, `packages/runtime-native/scripts/package-desktop.mjs`,
`sandbox/midway-open-pacific/tools/run-native.sh` (remove)
**Implementation:** Remove `Placement::Overlay`, the self-compositor, the compositing-manager probe
and the frame-loop pump. Bundle the chosen web engine's libraries through the existing dependency
discovery, or declare them prerequisites — whichever the licence and size analysis from Phase 1
supports. Leave the Windows and macOS child-window paths alone.
**Verification:** E1 — walk the X tree for the game's pid and assert only the SDL window exists
(AC-2). E2 — a `ui.renderer: "native"` fixture starts and renders with no web engine initialised
(AC-7). E3 — Windows and macOS builds compile and their existing native gates pass (AC-9). E4 —
`grep` proves the deleted symbols are gone, and no code path re-enables them (AC-8).

**What shipped.** `argb.rs` (1506 lines), `bin/probe.rs`, the `[[bin]]` target, and the crate's
`x11-dl`/`gdkx11`/`libloading` dependencies are gone; `Placement`, the self-compositor, the
compositing-manager probe and the frame-loop pump with them. `tn_ui_overlay_pump` survives only for
Windows and macOS, declared and called under `#if defined(_WIN32) || defined(__APPLE__)`, because
those two still attach a child view and still need their service point. `tools/run-native.sh` is
deleted from the sandbox game.

**No new dependency to ship.** Phase 1's analysis decided this: webkit2gtk-4.1 is already linked by
every Linux desktop build of this runtime, so the chosen backend adds no library, no licence and no
installer work. Nothing was added to `package-desktop.mjs`'s dependency discovery because nothing
new needs discovering.

**The wrapper's reason, recorded as AC-8 asks.** `sandbox/midway-open-pacific/tools/run-native.sh`
started a nested `Xephyr` display and an `xcompmgr` inside it before launching the game, because the
runtime's X11 overlay window was created, mapped and left empty on a KDE Wayland session and needed
a compositor it could drive. There is no overlay window any more and nothing for a compositor to
blend, so the wrapper has nothing left to do: `pnpm build:desktop` and
`dist-native/midway-open-pacific` is the launch.

**Checkpoint:** done for E1, E2 and E4; E3 is unrun and stated as such.
- [x] no override-redirect window in the X tree — 3 windows for the game's X client on a private
      `Xvfb`: the SDL game window (1280×720, viewable, not override-redirect) and two unmapped SDL
      helpers (a 10×10 `InputOnly`, a 1×1 `InputOutput`), both of which exist *before* the overlay
      attaches at ~725 ms and neither of which is a top-level anything can see. Zero override-redirect
      windows belong to the game's process tree.
- [x] `ui.renderer: "native"` unaffected, no web engine started — see AC-7
- [ ] Windows and macOS unchanged and green — **unrun**: this host cannot compile either target, so
      the claim is made on inspection only (their `desktop.rs` path is untouched, their dependency
      table is untouched, and every new Linux-only declaration is behind
      `__linux__ && !__ANDROID__`). A reader should treat this box as unverified.
- [x] overlay code deleted; `run-native.sh` removed with its reason recorded

#### Phase 6: The loading screen is deterministic
**Status:** DONE
**ACs:** AC-3
**Files:** `packages/core/src/game.ts`, `packages/runtime-native/src/platform/window.cpp`
**Implementation:** Remove the `framework:ui-ready` hold — it waits on script execution, not
presentation, and once the UI is in the frame the cover and the world share one swapchain, so the
race it was guarding cannot occur. Clear the held-startup frame to `bootSplash.backgroundColor`
instead of black, so the window is the game's own colour from creation until the UI's first frame
rather than `#102a37` for four seconds and then `gray(0)`.
**Verification:** E1 — 10 consecutive launches, each sampled from the game window before
`first_playable`, asserting the `#loading` background colour is present in all 10 (AC-3). A single
green run is explicitly not sufficient here: the defect being closed is a 1-in-3 race.

**The hold is gone, and the clear colour turned out not to be needed.** The `framework:ui-ready`
hold was an uncommitted investigation change, not something at HEAD; it is not in the tree and no
replacement was written, because once the UI is composited into the game's own frame the cover and
the world share one swapchain and the race it guarded cannot occur. `applyEmbeddedBootSplash()`
(committed) already paints the window with the game's own `bootSplash.backgroundColor` at creation,
and the black gap the ledger asked to close no longer exists to close: sampled every second from
launch, the window is `#102a37` at 1 s, 2 s and 3 s, and from ~4 s it is `#102a37` **plus the page's
own gold and ink** — the first presented frame already carries the loading screen. No black or grey
frame was observed at any sample. Extending the held-startup clear colour would have added code for
a gap that measurement says is not there, so it was not added.

**One gate moved backwards and is reported rather than hidden.** Regenerating the native coverage
report — which `pnpm budgets` requires whenever native sources change — shows `src/platform/` at
**72.05%** (879 of 1220 instrumented lines) against 82.13% before. The new input routing in
`platform/window.cpp` is not exercised by the ctest suite, because it needs a real window and real
events; what covers it is the playtest lane (`ui-parity`'s five presses, `native-select`'s two),
which is the same division the rest of the platform layer already lives with. No coverage threshold
failed — `pnpm budgets` is green.

**Checkpoint:** done
- [x] `framework:ui-ready` hold removed — it was never committed; the tree has no hold and no
      replacement
- [x] held-startup clear colour is the game's `bootSplash` colour, no black gap — measured: no
      black or grey frame at any sample, and the boot-splash colour is on screen from creation
- [x] 10/10 launches show the loading screen — 916 624 pixels of `#102a37` **and** 2 776 pixels of
      the loading title's own `--ink` in every one of ten consecutive launches, sampled 8 s in with
      `first_frame` at 3.81–5.53 s and `first_playable` not yet reached (it lands at ~39 s here, and
      every run was asserted not to have reached it)

## Two defects found by playing it, after the phases closed

Both were found by João running the game on his own session rather than by any gate in this PRD, and
both are recorded here rather than left in a transcript.

### The HUD stretched instead of re-laying out

`tn_ui_overlay_set_bounds` had **no caller at all**. The old overlay followed the game window through
X server events; an offscreen view has no window to follow, so nothing told the page it had changed
size, and the composite scaled the layout it was attached at across the new swapchain. Any resize —
or any window whose pixel size differs from the attach size — showed a stretched HUD.

Fixed in `platform/window.cpp`: `SDL_EVENT_WINDOW_RESIZED` and `SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED`
now call `uiOverlayResizeToWindow()`, which pushes the window's **pixel** size (the unit the page's
viewport and the swapchain share) through a new `platform::uiOverlaySetSize`. Verified by resizing a
running game from 1280×720 to 1600×900: the published hit regions move in normalized terms
(`x=0.860 → 0.888` for the flight-manual button), which only happens when the page re-lays out, and
the capture shows the briefing at its 1600×900 positions rather than a stretched 1280-wide one.

### The loading screen does not move — and the page is not the reason

Midway's loading screen is a `transform` sweep (`.load-line:after`) and on native it sits still.
The first measurement of this blamed WebKit and was **wrong**; it is corrected here because the
wrong version was written down as a capability regression and would have sent someone to rebuild
the backend for no reason.

**What was actually measured the first time.** A fixture page with one animation of each kind, the
CPU readback sampled at a **single pixel** per element. A solid block sliding past a fixed pixel
changes that pixel only a handful of times per sweep, so "CSS `transform`: 1 change in 5 s" was
the sampling, not the renderer. Scanning the element's whole row instead, on the same offscreen
GTK view and the same software compositing, over 6 s:

| Motion | Row changes in 6 s | Rate |
|---|---|---|
| `requestAnimationFrame` (JS clock) | 373 | 62/s |
| CSS `transform` animation | 373 | 62/s |
| JS `transform` | 53 | 9/s |
| JS `opacity` | 53 | 9/s |
| JS `left` | 53 | 9/s |

Nothing is throttled. The page renders at full rate, which also matches the engine's own numbers:
`TN_UI_SNAPSHOT` shows 12-15 ms round trips and the page's counter climbing while the loading
screen is up.

**The real cause: the UI is presented once per game frame, and the game's startup is one frame.**
`compositeUiLayer` is called from `endDawnFrame`; the loading screen therefore advances only when
the game renders. During startup the runtime loads the entire module graph synchronously inside a
single pump iteration — `ModuleSystem::loadEntry` recurses through `require` on one call stack, and
the awaited file callbacks are drained at the top of the pump, once per frame. Measured on Midway:
a `pump` marker fires **twice** in the first 30 s (0.58 s and 3.79 s), and the UI reports
`uploads: 1` for the whole run. Two presentations in 30 s is a still picture.

So the loading screen is starved, not frozen: the page has the frames, and nothing asks for them.

**And the startup itself is 30 s of one frame.** `TN_COLD_START` puts 109 modules in 31.7 s with
**0.07 s inside the JS engine** — so the time is not compilation, which is what the out-of-scope
note below assumed. What the gaps actually contain, measured with markers inside them:

- **Image decode is not the cost.** 326 decodes, 2.3 s in total, median 2 ms, slowest 108 ms.
- **Fetch is not the cost.** The assets are read from the embedded bundle; the reads are fast.
- **Canvas 2D rebuilt the system's font manager per canvas** — `SkFontMgr_New_FontConfig(nullptr,
  ...)` reads the fontconfig configuration and builds a FreeType scanner over the installed fonts,
  which is process state, not per-canvas state. Hoisting it to one `sharedFontMgr()` took the
  game's 65 canvases from **690 ms to 145 ms**. Real, correct, and **1.8% of the startup**: this is
  written down as a fix, not as the answer, because a first pass at this measurement wrongly
  attributed the multi-second gaps to it and the numbers do not support that.
- **What is left is the startup's own awaited asset work, serialized inside that one frame** — the
  gaps sit between a module's `execute_complete` and the last step of its await chain, and the
  frame loop is not running while they happen.

**The change this points at, not yet made:** the frame loop has to keep running while the startup
is in flight, the way a browser keeps compositing while a page's JavaScript awaits. That is a real
change to the loader/pump relationship and it is the next PRD's work, not a tweak to this one.

### Which pump phase ate the startup, and how much of it a drain budget buys

The paragraph above is a shape, not a number. `TN_SLOW_PHASE` now reports a single pump phase that
took 250 ms or more, with its name, its real duration and the launch clock — the frame meters could
not see any of this, because they close a window every 300 frames and a startup iterates the loop a
handful of times in forty seconds. On `sandbox/midway-open-pacific`, one 60 s launch:

| phase | ms | at launch ms |
|---|---|---|
| `fileCallbacks` | 840 | 1 736 |
| `fileCallbacks` | 844 | 3 224 |
| `imageDecodeDrain` | 486 | 2 380 |
| **`imageDecodeDrain`** | **11 760** | 15 038 |
| `animationFrames` | 2 517 | 19 342 |
| **`endDawnFrame`** | **16 048** | 35 390 |

Two phases own the freeze: one image-completion batch delivered in a single iteration, and one
frame whose replay uploads the game's 886 MB of textures. Between them the loop iterated ~14 times
in 40 s, so the page's 60 fps animation reached the screen 12-14 times.

**The decode half is fixed and measured.** `AsyncImageDecoder::drain()` now has a soft 2 ms delivery
budget and a bounded completed-decode backlog, the excess deferred to a later poll and overflow
reported as a deferred error rather than decoded on the frame thread (the same fix as
`fix/native-perf-followups-clean`'s `bb97df99c`). Page frames reaching the game's frame across the
startup went **from 12-14 to 57-63**, and the first seven seconds now update at ~10 fps.

**The rest is not the loop, and that is now measured rather than assumed.** `TN_SLOW_END_FRAME`
splits a slow frame boundary, and the game's longest freeze reads:

```
the loading screen froze for 16.2 s during the startup (from 13186 ms), against the 2.0 s this gate
allows: 59 page frame(s) reached the game's frame in the whole startup, of which 16.0 s was the
present waiting on the GPU queue and 0.1 s was the loop's own work
```

So the loop's own work inside the worst freeze is 0.1 s. The 16 s is `wgpuSurfacePresent`, and what
is inside that wait is settled, not assumed. Built with the diagnostic drain probe
(`-DTN_WEBGPU_GPU_DRAIN_PROFILE=ON`), the blocking device poll *after* the present finds **zero
outstanding GPU work** while the same frame reports 16.0 s in the present:

```
TN_SLOW_END_FRAME:{"totalMs":16100.1,"replayMs":0,"presentMs":16037.0,"gpuDrainMs":0,"otherMs":0.002}
```

The GPU is idle and the frame submitted nothing (`replayMs: 0`), so the present is waiting for a
**swapchain image the display has not handed back**. Nothing else fits: no single texture upload
exceeds 50 ms, the game's uploads do not go through `copyExternalImageToTexture` or `writeTexture`
at all on this path (the meters stayed silent), and `--no-vsync` does not shorten the wait — an
image is still an image in Immediate mode.

Why the display stops consuming: this lane is Xvfb with **xcompmgr**, a single-threaded software
compositor, and the startup takes every core it can reach, so the compositor is starved and releases
no images. That is the same defect the player sees from the other side — the loading screen cannot
move while a present is blocked — and it is why the loop-side CPU cost is the lever: a
GPU-composited session does not starve this way, but *any* session starves in proportion to how much
CPU the startup takes, and that number is the engine's to reduce.

**Post-startup the loop paces correctly**: `TN_PRESENTS_TICK` reaches 60 frames → 60 presents at
`capHz: 60`, one image on screen per frame, once the burst is over.

**Two things about this lane that a reader should not re-derive.** `playtest perf --executable`
cannot describe this game's steady state: its windows are 300 *frames*, and the startup runs ~15
frames in forty seconds, so windows 2 and 3 land inside the startup and report 1219 and 20000 fps
with sub-millisecond frames — the loop free-runs between presents the display declined, which is
what `paceToPresentationCap` is supposed to do. Measuring this game's in-game frame rate needs a
time-based window, which the lane does not offer yet. And the host this was measured on is the
remaining explanation for the display's 16 s, measured rather than suspected: 62 GiB of RAM, 43 GiB
used, **35 GiB of swap in use and 1.7 TB swapped out since boot**, `kswapd0` at ~100% during the
run. The game holds ~920 MB across 226 textures, and a startup that allocates that much on a host
already deep in swap makes the kernel reclaim — which stops the compositor consuming frames, which
is the 16 s in `wgpuSurfacePresent`. That is a property of this host, not of the engine or the game,
and it is why the same startup must be re-measured somewhere idle before anyone calls the freeze a
defect: on this host the loop is the smaller half of it, and the loop's half is what got smaller
today (12-14 → 58-74 page frames reaching the screen).

**Two engine-side costs found on the way and fixed.** `fillStyle` compiled a `std::regex` and
`makeFillPaint` re-parsed the style string on every painted rectangle — 20.6 µs for a rect that sets
`rgba(...)` against 2.3 µs for one that does not, on a game whose startup is ~1 M canvas operations
and whose V8 profile put 55% of samples in canvas bindings. The parsed colour now lives in the
context state and the numeric forms are scanned, not matched: 4.4 µs per such rect (4.7x), and the
decode phase of the same startup went 7.5 s → 3.1 s. A drain budget still cannot split a single
callback, which is why `TN_SLOW_DECODE_CALLBACK` exists to name one.

### The gate that can see it, since every other gate could not

`verify-desktop-loading.mjs` asks whether the loading screen is *there*, and a still loading screen
and a moving one are the same screenshot — which is how a frozen one reached a player through a
green board. `scripts/verify-desktop-loading-animation.mjs` asks the player's question instead:
**the screen never holds one picture for longer than `--max-freeze-ms`** across the startup, read
from the composite's own timeline, then `first_playable`, then the transition scenario, then no
crash. It launches the game bare, deliberately not through the playtest bridge, which advances the
app itself and would be driving the animation the gate exists to prove the game drives.

The freeze, and not a pixel diff, is the assertion, because the window capture on this lane is not
trustworthy: `import -window` reads the window's backing store, which lags the composited output —
consecutive captures of a demonstrably moving sweep came back identical (the loading screen's 2 px
gold bar tracked to three different positions across captures whose own pixel diff was 0-141 px). A
gate built on that would report the capture's staleness as the engine's. The composite's timeline
cannot: the uploaded texture *is* the quad the frame draws, and its marker only exists when the loop
reached the present.

Run against `sandbox/midway-open-pacific` today, it is red on the remaining half and on nothing else:

```
the loading screen froze for 16.2 s during the startup (from 18143 ms), against the 2.0 s this
gate allows: 57 page frame(s) reached the game's frame in the whole startup
```


## Out of scope

- The ~30 s `first_playable` on this game against 6.6 s on web. Real and worth its own PRD. The
  assumption that it was "the game's own module compiles" is now **disproved**: 109 modules cost
  0.07 s inside the JS engine, decode is 2.3 s across 326 images, and the one engine-side defect
  found (a fontconfig scan rebuilt per canvas) is worth 545 ms of it. What remains is the startup
  running inside a single frame with its awaited asset work serialized, which is a loader/pump
  change, not a UI-seam one. Phase 3's frame-budget numbers cover the *frame* cost of the seam,
  which is not this.
- Diagnosing why the X11 overlay is blank under kwin/XWayland. Deleting it settles the symptom, and
  the suspected foreign-`GdkWindow` realization path is recorded above for anyone who needs the
  answer for another reason.
- Android and iOS, which attach their own web views from their own hosts and are untouched.
