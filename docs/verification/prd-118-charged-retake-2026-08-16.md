# PRD-118 charged retake — the V8 Android result, taken above the battery bar

2026-08-16. This file records one hardware run and what it settles.
[PRD-118](../PRDs/done/PRD-118-android-js-engine.md) held a 22× script-time result it would not accept,
because the run that produced it sat at 21–25% battery against its own `≥50%` criterion. The retake
below was taken at **72%**, without `--allow-low-battery`, on the same phone and the same APK.

Both arms were re-run. The second one was not required by any criterion and is the more interesting
of the two — see §3.

## 1. Device and conditions

| | |
| --- | --- |
| Device | Pixel 8 `shiba`, serial `37251FDJH0037Z`, arm64-v8a |
| Battery | **72%** at start, 72% at end |
| Charging | USB attached; `dumpsys battery` reported `status: 4` (not charging) at the V8 run's start and `status: 2` (charging) after it |
| Thermal | `dumpsys thermalservice` → `Thermal Status: 0` (NONE) before and after both runs |
| Temperature | 34.1 °C before, 33.2 °C after the V8 run |
| Display | 1280×720 @ 120 Hz, vsync on, as the arm reports it |

The device never left `Thermal Status: 0` and never lost a percent of charge across both runs, so
neither number is a throttled one.

**One condition was not held: the phone was on USB throughout**, because USB is the adb transport.
[PRD-127](../PRDs/native/PRD-127-device-measurement-preflight.md) proposes `requireDischarging`
as a bar; this run does not meet a bar that does not exist yet, and it is recorded here rather than
left to be inferred. Charging state is the one condition below that a future gate would still refuse.

## 2. The APK under test was the V8 one, and this is how that is known

PRD-118's second criterion exists because the build path and the packaging path are separate, and a
run that silently shipped the prebuilt QuickJS `.so` would report no change and look like a result.
Three checks, none of them an assumption:

1. **The archive carries the engine.** `artifacts/engine-load-test/tn-android-v8.apk` contains
   `lib/arm64-v8a/libv8android.so` (29,919,888 bytes) and `assets/v8/snapshot_blob.bin`;
   `tn-android-quickjs.apk` contains neither.
2. **The runtime links against it.** `lib/arm64-v8a/libmystral-runtime.so` extracted from that APK
   has **95 undefined `v8::` symbols** and **zero** `JS_NewRuntime` / `JS_Eval` — it imports V8 and
   does not carry QuickJS.
3. **The installed bytes are those bytes.** `sha256` of the local APK and of the on-device
   `base.apk` agree: `5e0f45aa865d29149e910e88bfd8967c3cf9e9c184c3f8fc86cb33a3b6ff5e23`.

## 3. The result, and what the retake actually settled

```sh
pnpm bench:engines --arm tn-android --out tn-android-v8-charged      # exit 0
pnpm bench:engines --arm tn-android --out tn-android-quickjs-charged # exit 0
```

Neither run passed `--allow-low-battery`. `assertDeviceReady` observed 72% and allowed both.

### V8, charged

| mode | N | p50 ms | p95 ms | draws | tris | visible |
| --- | --- | --- | --- | --- | --- | --- |
| L2 | 4096 | 8.30 | 10.23 | 3 | 49,155 | 4,096 |
| L2 | 16384 | 8.31 | 10.99 | 3 | 196,611 | 16,384 |
| L3 | 4096 | 8.30 | 9.30 | 3 | 49,155 | 4,096 |
| **L3** | **16384** | **8.32** | **8.87** | 3 | 196,611 | 16,384 |

**PRD-118's acceptance criterion is met: L3 @ 16,384 reads 8.32 ms p50 against the 39.27 ms Godot
4.7.1 produced on this device on 2026-08-14.** Artifact:
`artifacts/engine-load-test/tn-android-v8-charged.json`.

### The battery bar cost this project nothing measurable

| Arm | Rung | Provisional (21–25%) | Charged (72%) | Δ |
| --- | --- | --- | --- | --- |
| V8 | L3 @ 16,384 | 8.33 ms | **8.32 ms** | −0.01 ms |
| QuickJS | L3 @ 4,096 | 20.02 ms | **20.03 ms** | +0.01 ms |

The V8 row proves little on its own, because at 120 Hz vsync 8.33 ms *is* the frame interval — that
arm is pinned to the display and would read the same however the device felt. **The QuickJS row is
the one that carries information.** 20 ms is nowhere near a 8.33 ms frame interval, so that arm was
free to move, and it moved by 0.05%.

This is [PRD-127 §9's](../PRDs/native/PRD-127-device-measurement-preflight.md) first kill
switch firing, on evidence rather than on prediction: *if the charged retake reproduces the result
within run-to-run variance, the 50% bar cost the project a fortnight of provisional labelling for no
measurable effect.* It did, on both arms, on a rung that was not display-bound.

**What that does and does not license.** It is one device, two rungs, one charge pairing — enough to
say the 50% bar did not change *these* numbers, not enough to say battery level never matters on
Android. PRD-127's gate should still ship; a declared condition that three of four device lanes never
check is a defect whichever way this number falls. What this argues for is attaching the observed
charge to every number so the question is answerable, rather than picking a threshold and labelling
everything below it provisional and unusable.

### Read the 8.32 ms correctly

Unchanged from PRD-118 §Caveat 1, and it survives the retake because the retake did not move it. The
host presents `fifo vsync=true` at 120 Hz, so 8.33 ms is the frame interval and ThreeNative sits on
it at every rung across a 4× load range. The defensible claim is that **its work fits inside one
120 Hz frame** while Godot needs 39.27 ms. The vsync-off diagnostic
(`tn-android-novsync.json`, 2026-08-15) puts the unpinned figure at 5.91 ms p50 for the same rung,
which is where the real headroom shows.

The two arms ran at different refresh rates and the comparison scorer would refuse that pairing
outright. The conclusion survives anyway: Godot's 39.27 ms is above its own 60 Hz floor and therefore
real cost, and even at 60 Hz ThreeNative would read no worse than 16.67 ms.

## 4. APK size, recorded whatever it is

| | QuickJS | V8 | Δ |
| --- | --- | --- | --- |
| Universal APK (arm64-v8a + x86_64) | 218,349,795 B (209 MiB) | 361,004,372 B (345 MiB) | **+142.7 MB (+65%)** |
| arm64 native payload, uncompressed | 75,819,688 B (72.3 MiB) | 101,390,028 B (96.7 MiB) | **+25.6 MB (+34%)** |

The universal figure double-counts: both ABIs ship in these benchmark archives. The arm64 row is the
one a shipped split APK would pay — `libv8android.so` adds 29.9 MB and `libc++_shared.so` 1.8 MB,
offset by `libmystral-runtime.so` shrinking 6.2 MB once QuickJS is no longer compiled into it.

**+25.6 MB on a phone build is a real cost and this file does not argue it away.** Whether to pay it
is the owner's decision; PRD-118 §6 says so and this run does not change that. The default Android
build is still QuickJS and takes `-PthreenativeJsEngine=v8` to become otherwise.

## 5. What this does not claim

- **Not mobile-ready.** One Android phone is not mobile. This licenses Android-on-this-device
  sentences and nothing about iOS, which has no physical evidence at all.
- **Not a discharging-state measurement.** See §1.
- **Not a QuickJS number at 16,384.** The QuickJS benchmark archive on hand runs a single rung
  (L3 @ 4,096) and the retake reproduced exactly that rung. PRD-118's 119.19 ms figure at 16,384 is
  PRD-117's, still carries its own provenance, and was not retaken here.
- **Not a decision to make V8 the Android default.** The default is unchanged.
