# Roadmap — get ThreeNative to a production-ready beta

> **Open limitations live in [`CURRENT-CHALLENGES.md`](../CURRENT-CHALLENGES.md).** This document
> is a strategy record; it is not the place to look for what is currently broken or unproven.

**Goal of v1:** a beta a stranger can install, build a game with, and ship — on web first, on device
where the evidence allows. Everything here is done, partly done, or not done; nothing is aspirational
prose. **Legend:** ✅ done · ⚠️ partly done · ❌ not done.

**Reconciled 2026-08-31.** The charter binds and wins wherever this file disagrees with it.

## Two numbers this file does not own

1. **The score.** *"Would I use this instead of vanilla Three.js?"* is answered in
   [VALUE-PROPOSITION.md](VALUE-PROPOSITION.md), which owns the five axes, their instruments and the
   measured total outright. It stood at **72/100** on 2026-08-30. Two copies of a score is two scores,
   so this file keeps none.
2. **The alpha bar.** It is **generated, not transcribed** — run `pnpm alpha:bar`, and
   `docs/PRDs/alpha-readiness/README.md` (since removed) holds the table the last
   run wrote. Row A7 exists to fail when someone retypes it here, so this file cites the command and
   the current shape only: **A1 is the single failing row, and A6 is deferred behind it.** Five of
   seven pass.

The whole of Track A below exists to turn A1 green, because A1 is *"a stranger can install it from
the public registry"* and nothing else on the bar can be experienced by anyone until it is.

## Track A — ship 0.3.0

**This is the only work between the engine and its first user, and it is a chain: no step can be
skipped or reordered.** npm serves **0.2.x**; this workspace is **0.3.0**, so every measurement in
`VALUE-PROPOSITION.md` is taken on source a stranger cannot `npm install`, and two packages
(`@threenative/assets`, `threenative-engine-mcp`) have never been published at all.

**The publish machinery is not the gap.** `.github/workflows/npm-release.yml` names all eight
publishable packages in a generated set, `pnpm publish:check` fails the release if a non-private
package is missing from it, and `scripts/release.ts` publishes them in dependency order as one
consistent set. The lane has simply never fired.

| # | Step | State on 2026-08-31 |
|---|---|---|
| 1 | **One green CI run on `main`** | ⚠️ closer than it has ever been. CI had **never** been green for any commit. The cause was one line: `TN_ENGINE_MCP_BUNDLE: build threenative-engine-mcp before core` — core's build bundles `threenative-engine-mcp` but its manifest never declared it, so `workspaceBuildOrder`'s topological sort had no edge and fell back to alphabetical. A clean checkout could not build this repo at all; developer machines hid it behind a warm `dist/`. Fixed in `ae23653f`, which took typecheck, build, test-playtest and benchmark from red to green in run `33350164891`. Still red: `lint` (a manifest format diff, fixed after that run), `budgets`, `test-browser`, `golden-path` |
| 2 | **`golden-path` stops racing boot time** | ⚠️ fixed in `e22139c5`, awaiting the CI run that proves it. The subject is **not** the `stomp` scenarios an earlier hand-over named — `setup.place[]` + `frozen: true` is already in both, and `Patrol.update` already honours `PLAYTEST_FROZEN_MARKER`. It is `starter-seed`, and the shape is the same: `Play.ts` set `levelX` at `ctx.after(0.25s)` so the playtest could watch the `-99` sentinel change, which makes the assertion a race with how long boot took. Same commit, two machines: `firstTick 6` here and it passes, `firstTick 47` in CI run `33350164891` and it fails closed as `TN_PLAYTEST_ASSERTION_TRIVIAL`. The seed is now set with the level and the scenario asserts the range invariant, so neither sentinel depends on *when* the runner samples. **The class is worth more than the instance:** any assertion whose truth depends on boot speed will pass here and fail in CI |
| 3 | **A native release exists** | ❌ `native-release.yml` refuses to build without a successful CI push run on `main`, so step 1 gates it. `pnpm publish:check` reports the consequence directly: no `prebuilt-lock.json` at `runtime-native-v0.3.0` |
| 4 | **`v0.3.0` is tagged and pushed** | ❌ **no `v*` tag has ever been pushed.** `gh run list --workflow npm-release.yml` is empty and `gh release list` is empty |
| 5 | **Eight packages publish; A2 is re-taken** | ❌ A2 currently passes against `create-threenative@0.2.2`, whose templates predate the menu-screen flow — it is certifying an older scaffold than the one that ships. Re-take its evidence against the published 0.3.0 |
| 6 | **A6 — one stranger uses it** | ❌ deferred, not deleted. It depends on A1: nobody can use what is not published. Filing an `alpha-bar` evidence block for A6 in `docs/verification/` grades it normally and ends the deferral |

Beyond the chain, two findings from the parity lane are unowned and cheap:
`androidDependencyBlocker()` hardcodes `SDL3-3.2.8.aar` while `third_party` holds `3.2.30`, which
blocked all 74 Android conformance rows in a fraction of a second — the fifth hand-written copy of
that version string in the tree. **Fixed since 2026-09-29**: the constant is `3.2.30`
(`packages/runtime-native/scripts/package-android.mjs:268`) and the aar is on disk, so the Android
rows now execute and fail one step later, on the missing V8 payload receipt
([tier-1-2026-09-29](../verification/tier-1-2026-09-29.md)).

## The beta bar — what "production ready" has to mean

**Proposed here, not charter-binding.** Rows 1–2 are held, not finished: they stay green or the
change does not land. Rows 3–5 are the beta blockers.

| # | Beta requirement | State |
|---|---|---|
| 1 | `pnpm typecheck && pnpm lint && pnpm test` green, budgets green, no cap raised | ✅ held on every landed change |
| 2 | Seven templates scaffold, build, and pass their playtests from a clean machine | ✅ `pnpm test:templates`, scaffold-smoke in CI |
| 3 | The Phase 2 capability gate passes: a post-adoption capability vanilla Three.js cannot match, on an instrument that does not hand the control arm that capability, with a same-subject negative control observed red | ⚠️ open, **red with attribution**. The capability shipped — a browser-recorded replay reached `stateHash = 1884960806` on web and on the desktop host, and the negative control was observed red. The gate is red on the *instrument* condition: plain Three.js has no desktop runtime, so running its native leg meant lending it the framework's bundler and host, which voids the run. Exclusivity is settled in neither direction ([phase-2-2026-08-20](../verification/phase-2-2026-08-20.md)) |
| 4 | Web/native parity is *checkable*, not asserted | ⚠️ **Tier 1 not reached, and the 2026-09-29 ledger names both reasons.** `pnpm parity:ledger` passes on [tier-1-2026-09-29](../verification/tier-1-2026-09-29.md): browser `90/1/2`, desktop `82/8/3`, Android emulator `0/90/3` — **executed per row for the first time**, every failure one build precondition (a missing `third_party/v8-android/build-receipt.json`), not a merit. **The desktop lane is redder than any previous ledger because the rows are new, not because the engine regressed**: the realism-effects block (`c03b92914`) landed one day after the 2026-08-29 ledger, and 7 of its rows plus `probe-volume-sample` fail on desktop today. `25-camera-parented-overlay` now passes. The performance dimension is measured on one identified host and **NOT REACHED**: web 59.97 fps mean against ≥60 (the X11 display path the playtest forces ceilings at 59.966, and the platformer reaches it without dropping a frame), native 58.08 fps / p95 18.06 ms against "no slower than web", from a named pacer deficit. Desktop cannot exit `0` while the multitouch row is excluded ([PRD-077](../PRDs/BLOCKED/requires-evdev-delivery/PRD-077-desktop-multitouch-injector.md)) |
| 5 | A user with no C++ toolchain ships a native game from published artifacts | ❌ **there are no published artifacts.** Ten release tags produced zero surviving releases; the lane deletes its own release when the consumer proof fails ([PRD-078](../PRDs/done/PRD-078-toolchain-free-consumer-proof.md)). Track A step 4 is its precondition. What would ship is measured in [tier-1-2026-09-29](../verification/tier-1-2026-09-29.md): the native desktop arm presents 58.08 fps against web's 59.97 on one host — a pacer deficit to close, not an absence of a runtime |

## Track B — 0.4, where the engine stops looking like a demo

**Do not start Track B work that is not already filed until Track A ships.** A feature nobody can
install is not a feature. The exception is a correctness defect under an already-shipped capability,
which is maintenance and outranks new work — item 1 below is exactly that.

The UE5-class research lives in [`docs/PRDs/open-world/`](../PRDs/open-world/),
and its ranking must be read through
[00-REPO-GROUNDING.md](../PRDs/Unreal/research/00-REPO-GROUNDING.md), which applies the charter
filter and re-estimates every effort number against this tree. Two things that document settles and
the research could not know: `packages/core/src/render/chain.ts` **already is** the tiered,
self-reporting post spine that four of the research's top features assume must be built; and
`packages/runtime-native/src/raytracing/` holds **5,476 lines** of DXR/Vulkan/Metal hardware ray
tracing, gated off by PRD-198 behind one named seam.

| # | Item | Why it ranks here |
|---|---|---|
| 1 | **PRD-269 — motion vectors for skinned and instanced geometry** | `RenderChain` already runs `ssgi`, `ssr`, `denoise`, `temporalReproject`, `taa`, `traa` and `motionBlur`. All seven are temporal, and on skinned or instanced content their velocity input is wrong. This is a correctness bug under seven shipped stages, not a new feature — and it is the precondition for any upscaler |
| 2 | **Execute the filed lighting batch** (PRD-266…270, now in [`rendering/`](../PRDs/rendering/) and [`useful-defaults/`](../PRDs/useful-defaults/)) | Filed 2026-08-29, all five still `PROPOSED`. PRD-270 — *no lighting node ships web-only* — is the charter's portability rule made into a gate. Executing a filed batch beats opening a new one |
| 3 | **Virtual Shadow Maps** | The largest true greenfield gap: templates use ordinary `shadowMap`, and there is no cascade or page table anywhere in `packages/`. Pure mechanism, no charter tension, and it inherits page-table and dirty-tracking machinery from the virtual geometry that landed 2026-08-30 |
| 4 | **One native conformance case for `SpectralOcean`** | `PRD-246` is DONE **web only, with named gaps**, and *a feature that works on web only is unfinished*. This is a standing charter violation, not a feature gap, and it is the cheapest row in this table |
| 5 | **PRD-198's buffer-to-texture copy-out interop** | Unblocks 5,476 already-written lines and changes the shape of dynamic GI, many-light rendering and any reference renderer at once. Scope it as an interop seam, not as a renderer |

**Rejected, with the reason, so they are not re-proposed:** a code-first ECS and a timeline editor are
closed with evidence, whatever the research scores them; layered materials and the post stack decide
how things look and therefore ship as generated `src/render/` source at any size; world partition and
the crowd render path are blocked on *consumers*, not algorithms, so no amount of engineering buys
them.

## Native reliability tiers — owner decision, 2026-08-10

| Tier | Bar | Licenses the sentence |
|---|---|---|
| **Tier 1** — the shipping bar | Renders-the-same, controls and UI green on browser + Linux desktop + Android emulator; performance and soak green on web + native desktop | *"Runs on browser WebGPU, desktop Linux/macOS/Windows, and the Android emulator; iOS builds and packages."* **Nothing else** |
| **Tier 2** — deferred, not dropped | Physical Android and iOS: real GPU drivers, arm64, frame-rate parity, device soak, signed distribution | mobile readiness — **unclaimable until executed on hardware** |

**Tier 2 reopen trigger:** the first external user who installs the framework and asks for a device
build — an *adopting developer*, which is a different experiment from the five-minute stranger test
and needs its own PRD. The stranger test's single definition is
[`STRANGER-TEST-PROTOCOL.md`](../product/STRANGER-TEST-PROTOCOL.md), it measures a *player*, and
closing it does not by itself reopen Tier 2. A physical Android device arriving early reopens the
Android half alone.

**"No Apple machine" was never true of CI.** The free hosted `macos-15` runner executes, so
simulator-class iOS rows are not hardware-blocked; PRD-065 keeps that honest. Re-read every row filed
under that reason against [`BLOCKED/README.md`](../PRDs/BLOCKED/README.md) — a row needing only a
simulator may be runnable today; a row needing a *physical* device is not.

Tier 1 stages the charter's ships-to-device criterion and its device matrix; it repeals neither. The
tension is row 9 in [CONFLICTS.md](CONFLICTS.md).

## Native lane — done and left

| Native item | State |
|---|---|
| Runtime absorbed as `packages/runtime-native`; render + lifecycle | ✅ |
| Desktop: 300 frames + screenshot on Linux, macOS, Windows | ✅ hosted run `31313092745` |
| Android emulator: framework-version parity, device playtest with fail-closed controls | ✅ measured; ⚠️ the current lane is blocked by the stale SDL3 pin, not by the device |
| Native physics through the bulk C ABI, parity and negative controls | ✅ Android; ⚠️ iOS simulator green once, red on rerun |
| Native build tells the truth: declared entry, no silent drops, assets staged | ✅ Linux + emulator; iOS launches and runs |
| Web CLI parity + all 25 packed-template scenarios | ✅ |
| Hardware ray tracing on DXR / Vulkan / Metal | ⚠️ **image tracing is gated; Vulkan ray batches run.** `isSupported()` returns `false` and `traceRays()` throws `TN_NATIVE_RAYTRACING_UNAVAILABLE` until buffer-to-texture copy-out interop exists ([PRD-198](../verification/prd-198-raytracing-gated-2026-08-25.md)). `mystralRT.traceRayBatch()` traces rays into a caller-owned typed array through Vulkan ray query on a host built with `TN_ENABLE_RAYTRACING=ON` ([PRD-645](../PRDs/done/PRD-645-a-desktop-gpu-with-ray-tracing-traces-gi-rays-in-hardware.md), RTX 2080 only; DXR and Metal report `rayBatch: false`). `mystralRT.traceRayBatchGpu()` does the same between two `GPUBuffer`s through shared Vulkan images. Neither path met the 2x gate against the software trace, so no code in `packages/core` consumes either path |
| iOS simulator | ⚠️ executed on a genuine iOS runtime since 2026-08-11; the next run of the same lane failed, so it is flaky, not proved. Every artifact before PRD-065 Phase 0 was a **visionOS** simulator. Simulator ≠ device either way |
| Toolchain-free distribution | ⚠️ desktop passes; nothing published |
| Physical mobile / Apple hardware: real drivers, arm64, frame-rate parity, signing, thermals | ❌ not executed. The hosted `macos-15` runner never substitutes for a device |
| Navmesh pathfinding on native | ❌ never — browser-only by decision (PRD-052) |

**No row above licenses a "mobile works" claim while ❌ and ⚠️ rows stand.** Emulator and simulator
results never become physical-driver, arm64-performance or phone frame-rate evidence.

## Phases — history, not a queue

Kept because the gates are this file's subject; the work they describe is finished or superseded by
the two tracks above.

- **✅ Gate 0 — measure before investing.** Round 2 ran to completion on `exploration`; proofs tied
  1/1 and the framework scored higher blind (4/5 vs 3/5). The product is real.
- **✅ Phase 1 — win the two unmeasured axes.** Four genres paired on sealed specs: proofs equal in
  every genre, framework blind polish strictly higher in two, authored LOC delta non-positive in two,
  budgets green with no cap raised ([phase-1-2026-08-08](../verification/phase-1-2026-08-08.md)).
- **⚠️ Phase 2 — consumer-scoped capability evidence.** The replacement gate was adopted 2026-08-19
  and executed 2026-08-20, red on the instrument condition. It is beta row 3 above and lives there
  now.
- **⚠️ Phase 3 — the platform question.** Does not formally start until Phase 2 is green, but the
  native lane executed most of it on emulated and simulated targets. Neither spike was answered on
  physical hardware.

## Not on the roadmap

A foundation model · a Blender replacement · visual scripting · a multiplayer backend · console
export · a plugin marketplace · a second renderer with feature parity · a universal app-store game
player · blank-prompt generation without templates · support for every Three.js example · **a hosted
Studio or Cloud tier before a stranger has played a ThreeNative game for five minutes** — the
project's decisive test, defined in
[`STRANGER-TEST-PROTOCOL.md`](../product/STRANGER-TEST-PROTOCOL.md).

**Where the Blender line falls.** ThreeNative drives Blender as a separate process. It never
reimplements modelling, sculpting, shading, rigging or rendering, ships no geometry-authoring UI in
`packages/`, and adds no `bpy` feature. When Blender is absent the framework says so and does
less; it never substitutes. `threenative-blender-mcp` is that boundary in code: it resolves a
binary the user installed, spawns it headlessly, and contains no Blender —
[PRD-346](../PRDs/done/PRD-346-a-downloaded-fbx-becomes-a-running-threenative-character.md).

Closed with evidence and not reopened in a feature: an IR, a scene format, an editor, a preset or
genre system, a code-first ECS, a bespoke CLI vocabulary. Each can absorb the entire company.
