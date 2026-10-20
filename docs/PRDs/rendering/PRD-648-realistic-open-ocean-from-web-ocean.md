# PRD-648 - A realistic open ocean without a second water stack

**Status:** PROPOSED - draft proposal only; no implementation or runtime qualification yet.
**Priority:** P2 - Improve open-ocean appearance while preserving the installed water mechanisms and sailing behavior.
**Owner:** ThreeNative maintainers
**Depends on:** Existing SpectralOcean, WaterSurface3D and source-bundle installation contracts. [PRD-491](../open-world/PRD-491-water-and-atmosphere-run-native.md) owns missing native conformance for those mechanisms and gates native qualification, not initial source work.
**Reference:** [Noniv/web-ocean](https://github.com/Noniv/web-ocean/tree/a07c7fd522ef0a897601c114f927a49d93d95520), pinned at `a07c7fd522ef0a897601c114f927a49d93d95520` on 2026-10-17.

## Decision and user-visible outcome

Offer a reusable, opt-in realistic-ocean composition as editable game source, using the existing FFT, water capture and lifecycle. A game can adopt it without owning another renderer, render loop or platform-specific implementation. Its agent can rewrite every material, foam, wave, lighting and quality choice in the generated source.

**Extend first; do not blanket-replace.** This is an appearance and missing-algorithm improvement, not a new ocean framework. Keep the current sailing ocean, analytic waves, Clearwater, coastal water and buoyancy available. A later change to the sailing default needs the promotion evidence below; this PRD does not authorize that switch. Do not replace shallow/coastal water with an open-ocean demo that has no shoreline model.

The charter rule in plain words: the framework supplies plumbing; anything choosing the screenshot belongs in editable `src/render/` source. Do not introduce `@threenative/ocean`, hide the look in core, or amend the charter to accommodate the reference.

## Existing owners, not missing systems

Source inventory checked against `origin/develop` at `bae2dd9e6967c07ea42b0f8a44f5d2bd51cec4f6`:

| Capability | Existing owner | Preserve |
| --- | --- | --- |
| Cascaded GPU spectrum and inverse FFT | `packages/core/src/ocean/spectral.ts`; [PRD-246](../done/PRD-246-two-oceans-two-contracts.md) | Seeded Phillips default, disjoint wavelength bands, displacement/fold output, fixed/render cadence and bounded readback. `sampleHeight()` can be unavailable, then reports `staleFrames`; it is not an exact current-frame physics query. |
| Exact analytic CPU/TSL waves | `packages/core/src/wave-field.ts` | Separate contract, not an inferior spectral fallback to delete. |
| Reflection, refraction and depth capture | `packages/core/src/water-surface.ts`; [PRD-484](../done/PRD-484-instanced-lod-and-mirror-by-default.md) | Foreground rejection, thickness in metres, selective affordable reflections and renderer-state restoration. |
| Sailing appearance | `packages/create-threenative/templates/sailing/src/render/ocean.ts` | Two 128-square cascades at 190 m / 37 m, ship-following mesh, crest foam, wake, reflection and CPU-height age compensation. |
| Local disturbance and buoyancy | `packages/core/src/ripple-field.ts`, `packages/physics/src/Buoyancy3D.ts` | Existing interaction and fixed-step forces; no parallel buoyancy solver. |
| Opt-in editable water source distribution | `packages/create-threenative/template-assets/clearwater/`; [Clearwater](../done/PRD-clearwater-shallow-water.md) | Existing source-bundle delivery pattern and refusal to overwrite edited files; no default-template changes. |
| Native water/atmosphere substrate qualification | [PRD-491](../open-world/PRD-491-water-and-atmosphere-run-native.md) | Register and execute existing mechanisms there; do not create a duplicate parity project. |
| Coastal/shore visual acceptance | [PRD-580](../open-world/PRD-580-strata-starter-kit-art-bar.md), `examples/strata-terrain-preview/src/render/ocean.ts` | Shore foam and terrain-aware water remain that work's responsibility. |

## What to take from the reference

`web-ocean` is a private standalone application, not an embeddable Three.js package. Its `js/main.js` requests a device, owns a canvas, constructs raw WGSL pipelines and starts its own frame loop. Adapt the algorithms to Three.js WebGPU/TSL; do not install the application as a runtime dependency or embed its HTML.

| Candidate improvement | Pinned upstream source | Integration constraint |
| --- | --- | --- |
| Fetch-limited JONSWAP wind sea, directional spreading, independently directed swell and capillary dispersion | `js/wgsl/sim.js`, spectrum initialization/evolution | Reuse the installed inverse FFT and query contract. If the existing public inputs cannot express the spectrum, add the smallest backward-compatible initialization seam, with game-owned spectrum parameters and unchanged Phillips behavior. Do not build a second FFT. |
| Fine-scale wave detail and continuous distance transitions | `js/main.js:39,309-330,490-529`, `js/wgsl/ocean.js:63-88` | Upstream uses six 256-square cascades and CDLOD. Those are reference settings, not mandatory defaults. First use the existing mesh/cascade path; adopt additional bands or quadtree morphing only when they improve matched captures within a frozen quality budget. |
| Slope-moment filtering and anisotropic sun glitter | `js/wgsl/ocean.js:125-198` | Editable TSL material source. Match lighting and exposure when judging, so brighter postprocessing cannot masquerade as better water. |
| Persistent, advected crest foam | `js/wgsl/sim.js:345-404`, `js/wgsl/ocean.js:212-250` | Camera-following history with decay and stable world coordinates, integrated with the same displacement field. This is whitecap foam, not surf or boat interaction. Preserve the existing wake/ripple path. |
| Backlit crest glow, water body scatter and horizon treatment | `js/wgsl/ocean.js:200-210,262-271`, `js/wgsl/sky.js` | Appearance approximations, not volumetric transmission. Consume the game's sun, environment and atmosphere; do not replace its sky, fog, exposure, bloom or tonemapping behind its back. |

The reference's sky reflection is a procedural sky cube, not scene-object reflection. Preserve ThreeNative's scene reflection/refraction rather than regress to sky-only water. Its single-camera GPU height probe is not a production buoyancy API.

MIT, Copyright (c) 2026 Maksymilian Dendura: retain the full upstream notice with any substantially adapted source and in the shipped source bundle. Do not rely on shader comments surviving bundling. No upstream runtime image assets were identified; the README JPEGs are reference images, not game textures to bundle blindly.

## Proposed integration shape

- Add an optional bundle alongside Clearwater under `packages/create-threenative/template-assets/realistic-ocean/` (proposed path, not an installed capability yet). Reuse the source-copy delivery pattern, existing package publication and overwrite protections. Add no new public CLI vocabulary or dependency-bearing package without a real dependency boundary.
- Put the composition/factory and context wiring outside `src/render/`. Inject the existing SpectralOcean/WaterSurface3D resources into ordinary Three.js render source; template render files must not import `@threenative/*`.
- Keep spectrum shaping, foam appearance, geometry, sun-glitter parameters and quality choices editable. Only a proven missing, look-neutral lifecycle/compute/readback seam belongs in core. One scene time source, one compute dispatch schedule and one owner per resource.
- Support explicit update/reset/follow/dispose and scene removal, deterministic reset, resize and failed-initialization cleanup. Auxiliary captures restore the engine renderer state. Do not request another device/canvas or read GPU data synchronously per frame.
- Preserve units, seed behavior and the distinction between display motion, fixed-step buoyancy and delayed GPU samples. Advected foam must reset coherently after teleport; missing/stale samples remain visible in diagnostics, never silently promoted to exact heights.
- Existing capability entries, conformance registry and playtest runner remain authoritative. Extend them only if implementation changes their owned surface; do not maintain parallel inventories or a feature-specific CI workflow.

## Execution Phases

### Phase 1: Reuse the mechanisms and ship editable source

**Status:** DONE
**Files:** Existing `packages/core/src/ocean/` and its unit tests only if a spectrum seam is necessary; proposed `packages/create-threenative/template-assets/realistic-ocean/` and its source-install tests.

- [x] P1.1: The installed FFT accepts the game-owned sea-state inputs needed for the reference techniques, without changing the legacy Phillips/query contract or adding a parallel simulation. proof: focused SpectralOcean unit tests for deterministic initialization, finite/band-limited output, invalid parameters, unavailable/stale height samples and unchanged default behavior. **Result:** `ISpectralOceanOptions.energy(kx, kz)` and `capillaryWavenumber` are optional seams; `ocean-spectral.spec.ts` 45 passed (new: determinism, Hermitian, band limit kept, invalid curve/capillary refused, Phillips default byte-identical).
- [x] P1.2: The optional bundle installs editable source without overwriting game edits, and its resource/update lifecycle composes with an existing scene. proof: source-bundle installation and lifecycle tests covering install collision, failed initialization, reset, resize, repeated create/dispose and exactly-once compute dispatch. **Result:** `realistic-ocean-install.spec.ts` (5: install, no overwrite, symlink refusal, dangling links, late-collision preflight), `realistic-ocean-graph.spec.ts` (12: exactly-once registration, one compute call per step, reset clears foam, idempotent dispose, scene-removal dispose, 6x create/dispose leaves nothing, init failure releases, non-WebGPU refused, no height before a copy lands) and `realistic-ocean-spectrum.spec.ts` (17) pass. First GPU smoke on Intel gen-12lp found a real defect (9 storage buffers in the fragment stage, limit 8) fixed in `9d2a50b9e`; after it 0 console/GPU errors in 8 captures per arm. A packed `create-threenative` tarball installs the bundle (MIT notice included) into a fresh sailing scaffold, and a second install refuses to overwrite. Not covered: resize (the sea has no render target of its own).

Before visual tuning, freeze the representative hardware, viewport, sea states, camera poses, simulation bands/resolution, live-resource ceiling and frame-time ceilings in the existing playtest configuration. Proposed desktop target: 1920 x 1080 at a 60 Hz frame budget, subject to an explicit recorded change if the selected reference-quality tier cannot fit. No baseline or performance result is claimed in this proposal.

### Phase 2: Prove the visible improvement in a real scene

**Status:** IN PROGRESS (P2.2 and P2.3 done; P2.1 open)
**Files:** Bundle render source, existing sailing consumer/proof lane and its playtest scenarios. Keep the shipping default unchanged.

- [ ] P2.1: A reference-quality opt-in scene visibly improves wave-scale range, filtered sun glitter, whitecaps and backlit crests over the incumbent ocean at low, oblique and elevated views. proof: headed WebGPU playtest captures with adapter identity and pinned seed/time/pose/exposure, two runs per arm, plus an independent visual judge returning IMPROVEMENT on the stated ocean criteria. Also inspect matched upstream views to avoid treating a slightly better incumbent as reference fidelity. **Result (open):** Three fresh read-only judge rounds on 4 poses x 2 runs x 3 arms (headed Intel gen-12lp, `adapter.info` recorded). Round 1 overall IMPROVEMENT with oblique NEUTRAL and no whitecaps (sea state, foam and colour tuned). Round 3 (final): IMPROVEMENT at all four poses, overall IMPROVEMENT. Per criterion: wave-scale range partly met, glitter partly met (broken into distance-scaled glints, no coherent widening column), whitecaps partly met, **backlit crests not met** (a faint teal tint only), artifacts partly met (a dark patch along the right horizon at the low pose). Left open because two stated criteria are not met. Time is not pinned: the captures sit 6 s after ready and the elapsed HUD varied 7.2 to 8.5 s. Images: orphan branch `prd-648-screenshots`.
- [x] P2.2: The ocean composes with the game's existing sky, fog, exposure, opaque/depth-tested objects, reflection/refraction and postprocessing; foam remains stable through camera travel, teleport and reset. proof: existing playtest harness scenarios with above/below-surface markers and a recorded camera traversal; no new blank-frame, foreground-bleed or double-tonemap artifacts. **Result:** `scripts/realistic-ocean-playtests/composition.playtest.json` (63 m of travel with a turn, no console or network errors, `oceanSteps` 1681, tone mean 112/p99 218/clip 0.05%, incumbent 129/221/0.04%) and `restart.playtest.json` (two `goto("sailing")` restarts, each a ship teleport plus a full scene teardown and re-entry; no errors, `oceanSteps` and `seaHeight` still advance, tone mean 154/p99 241/black 0) pass on the candidate and on the incumbent, headed Intel gen-12lp. Composition with the scene's own sky, fog, exposure, tone mapping, depth-tested hull, island and buoys, and the planar mirror is judged from the same frames (no bleed or blank reported by three judge rounds). `reset()` clearing the foam is a unit test. Not asserted separately: above/below-surface marker pairs and a double-tonemap measurement beyond the tone bounds.
- [x] P2.3: The opt-in sailing consumer retains hull-to-surface agreement, wake/ripple interaction and the existing no-airborne-hull behavior. proof: sailing movement/float scenarios plus fixed-step height/query-age assertions against the same displacement field used for drawing. **Result:** On the realistic consumer, the existing sailing scenarios `float`, `float-after-the-run-ends`, `survives`, `sails`, `win`, `fail`, `touch-controls` and `performance` pass (24/24 runs with `composition`, headed Intel gen-12lp, `--browser-recipe webgpu`). `floatGap` stays inside ±0.08 m and `readbackStaleFrames` is observed against the same `SpectralOcean` displacement the water draws. `live/render-motion` fails its frame-count floors on this lane for the incumbent too (233 vs 600 rendered frames), so it proves nothing either way here.

Do not count an upstream screenshot, a nonblank canvas, a pixel diff or passing units as the visual verdict. Keep comparison labels unambiguous. Report the actual GPU/CPU adapter; software rendering is not production GPU performance evidence.

### Phase 3: Bound the cost and qualify native desktop

**Status:** IN PROGRESS (P3.1 partly measured; P3.2 not run)
**Files:** Existing playtest/performance lanes and native conformance owners, plus source/consumer fixes identified by them.

- [ ] P3.1: The chosen quality tier meets its frozen steady-state CPU/GPU p50/p95 ceilings and live-resource bound without hiding startup, warmup or readback cost. proof: existing playtest/performance capture on the same device, viewport and camera path for incumbent/candidate, with configuration, GPU bytes and repeated teardown counts reported. Compare identical candidate Three.js work with/without framework plumbing before attributing overhead to the framework. **Result (open):** Same device and scenario (`performance.playtest.json`, 1920x1080, 4 interleaved runs per arm, 1024 frames each, headed Intel gen-12lp). Frame time p50 median 11.55 ms candidate vs 10.15 ms incumbent, p95 16.75 vs 14.45 ms (ceiling 33), CPU render phase mean 7.14 vs 6.06 ms, min FPS 87 vs 99 (floor 30), 62 draw calls and 75,505 triangles for both (ceilings 140 and 138,000). The bundle adds about 1.7 MB of GPU storage by arithmetic (6 derivative buffers of 128x128 vec4 plus 2 foam grids), not by a measurement. Teardown: 6 create/dispose cycles leave nothing in a unit test, and two full scene restarts pass in `restart.playtest.json`. Not measured: GPU time (no timestamp query run), measured GPU bytes, and a with/without-framework comparison. The ceilings used are the existing playtest's, not new GPU p50/p95 ones, so the box stays open.
- [ ] P3.2: The identical opted-in game source renders and advances the new ocean correctly on the real native-desktop runtime. proof: registered desktop conformance and the same consumer's `--target desktop` playtest, including nonblank captures, foam evolution, resource cleanup and bounded stale-height reporting. Reuse PRD-491's substrate qualification rather than claiming it from TypeScript compilation. **Result (open):** Not run, blocked on the lane. `threenative build --target desktop` on the packed consumer failed with `Prebuilt release manifest fetch failed for 'linux-x64' at .../runtime-native-v0.3.6/prebuilt-lock.json: HTTP 404`, and the only local host binary (`packages/runtime-native/build/tn-linux-wgpu/mystral`, 27 Aug) predates the owned engine. A native proof needs a local `pnpm native:build` cohort, and whether the TSL material (noise, `fwidth`, uniform arrays, derivative compute buffers) compiles on the owned engine is unknown. Not claimed.

## Acceptance Criteria

- [ ] AC-1: A fresh external consumer installed from the packed package can adopt, edit and remove the optional ocean without changing default sailing, analytic-wave, Clearwater or coastal behavior. proof: existing source-bundle/scaffolder regression suites and the fresh consumer browser/native-desktop playtests; all phase proofs above green on the final candidate, with the shipped MIT notice checked. **Result (open):** Adopt, edit and remove proven on a fresh packed consumer (`scripts/realistic-ocean-consumer.ts --prove-remove` restores the scaffold's `src/` byte for byte; `scripts/__tests__/realistic-ocean-consumer.spec.ts` 4 passed) and the default sailing scaffold is unchanged. The native-desktop half is not run, so the box stays open.

## Replacement gate and rollback

This draft chooses **opt-in addition, not automatic replacement**. A later explicit default-promotion change may replace the sailing appearance implementation only after matched visual improvement, the frozen timing/resource budget, scene composition, buoyancy correspondence and supported-target proof all pass. Keep the existing implementation while these gates are open. Clearwater, analytic waves, RippleField and Buoyancy3D are not replacement targets.

If the reference look requires a second renderer, hidden package-owned styling, synchronous frame readback, or cannot meet the chosen consumer budget, stop that approach and retain the incumbent. Do not weaken the charter, quality assertions or performance ceilings to declare success. Unintegrated feature work can be removed without changing game defaults.

## Non-goals

No shoreline/surf solver, underwater-camera system, volumetric transmission, volumetric clouds, general fluid simulation, replacement physics or promise of pixel-identical upstream reproduction. No six-cascade default imposed on every game. No default changes to coastal/terrain appearance, a new recipe system, separate render loop or bespoke feature CI. These are open-ocean improvements; PRD-580 retains coastal acceptance.

## Blocked on

- PRD-491's missing native water/atmosphere substrate conformance gates final native qualification. Initial source and browser work can proceed, but desktop readiness must not be asserted until those paths actually execute.
- Android and iOS quality/performance claims require their own executed device/emulator lanes. They are unverified here and are not waived by a desktop pass. No mobile default promotion is in scope.
- Switching any shipping template default needs a later explicit owner-approved promotion change after the evidence is available; this does not block the opt-in work.

## Decisions

- 2026-10-17: Interpret the requested draft PR as a source-backed integration proposal, not an implemented ocean. All product phase boxes remain open. The existing FFT, optical capture, query-age and buoyancy owners make a new ocean framework unnecessary.
- 2026-10-17: Mine the pinned MIT implementation's algorithms and visual target rather than transplant its raw-WebGPU application. Adapted source retains attribution. The upstream README's RTX 5070 Ti 6-8 ms GPU claim has not been reproduced and is not a ThreeNative budget or result.
