# Why `fluid consumers` loses its WebGPU device on unrelated diffs

Read-mostly investigation, 2026-10-04. Lane: `fluid-consumers` in `.github/workflows/integration.yml`,
added by `c18a42bea` (#402). Failing runs: 37183659465 (`fluid consumers`, coupling variant),
37183344148 (`fluid consumers`, dam variant), plus #397, #396, #423 and
`fix/prd479-fluid-motion-regressions`. Nothing about the diff matters; the runs that go red are the
ones that go red.

## What a failing run looks like

From `artifacts/fluid-consumers/failure.json` (artifact 11295574957, run 37183344148):

| Signal | Value |
| --- | --- |
| adapter | `architecture: swiftshader`, `vendor: google` |
| `diagnostics` assertion | **pass** — no console *errors*, no network errors |
| only console entry | one **warning**: `A valid external Instance reference no longer exists.` |
| `steps`, `count`, `inBounds`, `meanCompression` | pass |
| `peakFrontX` (gte 1.0), `maxSpeed` (lte 1.0) | **fail** |
| `visual.0` | **fail**, and `TN_CAPTURE_BLANK` |

So the run does not hit a device-lost *cascade*: nothing errored. `TN_PLAYTEST_SOFTWARE_DEVICE_LOST`
is the repo's own label for the console cascade in
`packages/playtest/src/runner/runner-support.ts:171`, whose regex includes this exact string — the
warning is being read as a device loss, and that reading is what the lane then fails on.

Every one of the four captures is **byte-identical** (4257 bytes) and pure black — `gated.png`,
taken at tick 30, as much as `after.png`. The canvas presented nothing at any point in the run.
`resource.GameState.count >= 1600` passing proves the GPU *did* run and *did* land one readback, so
the device was alive early and dead later; `peakFrontX`/`maxSpeed` are exactly the values a frozen
first sample would report.

## The message itself

`A valid external Instance reference no longer exists.` is Dawn, in
`src/dawn/wire/client/Instance.cpp`:

```cpp
if ( completionType == EventCompletionType::Shutdown ) {
    mStatus = WGPURequestAdapterStatus_InstanceDropped;
    mMessage = "A valid external Instance reference no longer exists.";
```

`DeviceBase::DeviceLostEvent::Complete` carries the same string with
`DeviceLostReason::CallbackCancelled`. It means every callback still in flight was cancelled because
the wire instance went away: from then on `mapAsync` rejects (the timestamp-query pool, and
`GPUReadback`, whose `.catch` swallows the rejection and freezes `stats`), and Dawn stops presenting.

`docs/verification/prd278-followup-2026-08-30.md` (Defect A/B) already bisected this signature once:
three's `WebGPUBackend.init` keeps neither the adapter nor the instance, Chromium collects them, and
`mapAsync` starts failing. It also recorded the timing — "it did not fire in the ~10 s menu screen
the doctor samples; the collection needs longer than that."

## What is still dropped, today

The patch fixed the instance and left the adapter. In the installed patched build
(`node_modules/three/build/three.webgpu.js`, patched by `083710b3`):

```js
this.gpu = ( typeof navigator !== 'undefined' ) ? navigator.gpu : null;
const adapter = this.gpu !== null ? await this.gpu.requestAdapter( adapterOptions ) : null;
```

`this.gpu` exists; `this.adapter` appears nowhere in the file. And core asked for two more adapters
and held neither:

- `packages/core/src/renderer.ts:1005` `adapterTextureLimits()` — the limits for the device three is
  about to create. `const adapter = await gpu.requestAdapter()`, local.
- `packages/core/src/renderer.ts:948` `readWebGpuAdapterFacts()` — the identity the capture
  provenance and the software-adapter gate are read from. Local again.

Three dropped adapters per page, and after the fix in this branch, one (three's own).

## Why the lane and not its neighbours

| Job | Duration, run 37183344148 | Result |
| --- | --- | --- |
| `fluid collision` | 2m46s | success |
| `Linux native fluid correctness` | 5m36s | success |
| `fluid consumers` | 11m50s | failure |

Same Xvfb strategy, same `WEBGPU_BROWSER_ARGS`, same SwiftShader adapter, same solver. The
consumers lane is the only one that runs 820 fixed steps (30 + 90 + 300 + 400) instead of a short
proof, and the only one long enough for a collector to run. That is the whole reason the flake
tracks duration and not the diff.

## Not established

The retention fix in this branch addresses the dropped references, and it is the defect the repo's
own bisect named. Two things remain unproven, and the next attempt should not treat them as settled:

1. **The retained adapter half of three's side is still missing.** It needs the patch
   (`patches/three@0.185.1.patch` in three places, plus the `patchedDependencies` hash in
   `pnpm-lock.yaml` and the scaffold byte audit), which is why this branch does not touch it. If the
   lane stays red after this branch, that is the next thing to try — not a retry loop.
2. **A second mechanism is not excluded.** `packages/playtest/src/runner/runner-support.ts:240`
   asserts the other story: "SwiftShader's fallback adapter drops the wire Instance under a slow
   frame and Chromium restarts the GPU process behind it." That is a GPU-process teardown, and the
   engine submits frames as fast as `requestAnimationFrame` fires rather than as fast as the software
   adapter retires them, so the queue grows for the length of the run. Pacing a software adapter to
   one frame in flight would separate the two: if the lane still goes red with the adapters retained,
   pacing is the mechanism.
