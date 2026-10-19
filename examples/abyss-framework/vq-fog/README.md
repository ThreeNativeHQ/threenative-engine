# Bounded volumetric-fog fixture

This opt-in fixture uses the starter's generated `volumetricFog.ts` and `WorldEnvironment` directly. The default game and template picture are unchanged. The fixture starts with fog off, warms the ordinary directional shadow map, and uses the named keyboard variants below.

- F: bounded height fog, 48 steps, full resolution
- O / Z: off / zero density (both own zero fog targets)
- I: camera inside the bounds
- S / P: directional / point-light intensity off
- B: overlapping density bounds
- H: half-resolution fog with depth-discontinuity fallback
- W: remove the foreground wall so current depth changes
- C: dispose and rebuild the current graph
- R / T: resize the existing render target to 320×240 / restore 640×400
- L / K / J: scattering-only black-surface control, then directional / point light off
- N: black no-fog control (exact zero RGB in the 500×400 fog evaluation area)
- 1 / 2 / 3: scattering with the shadow map entirely away from the volume, then sun / point off
- 4 / 5: cut the camera inside / restore outside without replacing the fog controller
- 6 / 7: remove / reinsert the foreground wall without replacing the fog controller
- 8: exit and re-enter through the real scene owner, returning to off

The four scattering controls share a visible gradient calibration card outside the measured fog area, with an identical-pixel check, so a working black control still satisfies the runner's normal nonblank guard.

The medium replaces scene fog, aerial haze and god rays. The only local light admitted here is an unshadowed finite-range point source. No temporal history is retained. The source rejects orthographic, logarithmic and reversed-depth configurations rather than pretending they are qualified.

## Browser capture

Run from the repository root:

```sh
pnpm --filter @threenative/playtest build
pnpm --filter abyss-framework exec vite build --config vq-fog/vite.config.ts
node --import tsx scripts/verify-volumetric-fog.ts
```

The existing public runner provides headed Chromium, a private Xvfb, canvas captures and adapter provenance. The feature-specific hosted integration workflow invokes these commands on Ubuntu 24.04 and preserves PNGs, reports, observations and the tested source SHA under `artifacts/volumetric-fog/`. Software adapters qualify correctness only. A device-loss warning invalidates the result even if the runner reports a pass. The verifier checks zero-density identity, isolated directional/point scattering in a pinned room region with an exact-black foreground plate, actual teardown events over repeated graph replacement, and return-to-off pixel identity. It retains named light identities and source/adapter provenance. Foreground-wall/shaft appearance also requires inspecting the actual captures. Do not treat the source build or WGSL generation test as runtime proof.

## Native entry and lifecycle

`src/game.ts` is the same portable default-exported game for both runtimes; `package.json` names it for existing project-mode conformance:

```sh
pnpm parity --project examples/abyss-framework/vq-fog --target desktop
```

The reusable repeated-lifecycle scenario is `../playtests/vq-volumetric-fog.playtest.json`. Portable target/depth resize scenarios retain the same fog controller and require exact restored pixels. Allocation comparisons require unchanged texture counts over at least three observed completed render frames, not just elapsed time. These do not establish operating-system window resize behavior.

Run 37046042533 at source `640c103017d56e56abb56745eb875885c32aec06` passes all 29 browser and 29 Linux ARM64 native arms, both no-fog resize controls, and the actual GPU destination-pixel contract. Native resize follows 320×240 and restores 640×400 without replacing the controller, with exact restored pixels and settled allocation baseline. The PRD retains both earlier failure history and these real native PNGs, source/runtime/bundle identities and scoped measurements. Browser SwiftShader and native Mesa llvmpipe qualify software-rendered correctness; no hardware-performance or default-tier claim is made.


The same verifier can use an already-built Linux desktop host:

```sh
THREENATIVE_RUNTIME_BINARY=/absolute/path/to/mystral node --import tsx scripts/verify-volumetric-fog.ts
```

It bundles the same `src/game.ts`, uses the public desktop mailbox runner, and retains host/game hashes plus native screenshots under `artifacts/volumetric-fog-native/`. Native scenarios use resources/startup; unsupported browser diagnostics/visual assertion families are replaced by mandatory native host-console/readiness/provenance checks and the same external pixel gates. Native `renderer.setSize` changes the backing surface, so the small-target PNG is 320×240; the restored PNG remains 640×400. The integration workflow's native job reuses the normal ARM Linux host setup after browser proof passes. A separate `VQ_FOG_RESIZE_CONTROL=1` invocation isolates the same renderer/scene resize path with fog off and requires zero fog allocations. It writes `artifacts/volumetric-fog-native-resize-control/`. Both the diagnostic control and the unchanged original sequence are required by the native workflow. The external native guard now applies the same authored 5% whole-frame nonblank threshold using the existing playtest pixel metric; the native runner’s generic dark-frame exemption does not replace that assertion.


The verifier preserves the original seventeen arms and appends twelve qualification arms. Retained camera/occluder transitions must match freshly constructed reference pixels exactly, and repeated scene re-entry must restore the off image and renderer allocation baseline. Dedicated off/full/half cost arms wait for ninety actual observed render intervals and record a clean thirty-frame window from the existing `TN_FRAME_BUDGET` meter. Host frame/render durations are measured separately from GPU timing; an absent timestamp observation is not zero and software-adapter cost does not qualify a hardware tier. These added arms passed on both targets in run 37046042533. CPU frame/render, GPU-query and presented-interval distributions are separate; GPU samples are sparse and stale counts are explicit in provenance.

The subsequent latest-develop reconciliation retains these qualified component bytes but is awaiting exact-head hosted requalification; source equivalence alone is not a new runtime pass.
