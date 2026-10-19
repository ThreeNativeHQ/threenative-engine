# PRD-054 — write once, run anywhere: a parity gate that proves it

**Status: BLOCKED AT ACCEPTANCE CRITERION 1, 2026-08-10.** The unsandboxed aggregate rerun
produced browser `66 pass / 1 fail / 0 blocked`, Linux desktop `65 pass / 1 fail / 1 blocked`,
and Android `0 pass / 0 fail / 67 blocked`. The browser run observed `90-multitouch-input` as
red/failing; this evidence does not establish its root cause, so the row remains open/non-green.
Desktop `25-camera-parented-overlay` remained red with the observed GPU validation errors; desktop
multitouch remained blocked because native injection is unsupported. Android rows were blocked by
the lack of an online emulator/device. The separate Android multitouch supplemental reached APK
assembly and exposed a real missing `SDL3-3.2.8.aar` before APK creation. Criterion 1 remains open.

**Priority:** P1 — Tier 1 parity rows must run on web, desktop and emulator; one row fails against pinned wgpu.
The precondition handling was repaired on 2026-08-09. `--target desktop` now runs the
repository's own `download-deps.mjs` and `native-build.mjs` before it can fail a row, and a
host that cannot run them reports every desktop row `blocked` with the command output rather
than as an assertion failure. This run used the resulting Linux runtime successfully. The
Android row loop stopped at `TN_PARITY_ANDROID_DEVICE_BLOCKED: No online Android device found
(none listed).` Its separate supplemental pre-APK proof reached Gradle with JDK 17 and the
Android SDK, then failed because
`packages/runtime-native/third_party/sdl3-android/SDL3-3.2.8.aar` was absent. No SDK/NDK/toolchain
or sandbox blocker was observed. `tests/parity-contract.test.mjs` drives those decisions
directly instead of manufacturing a fake runtime. **A clean-machine run is still not executed
here**, so criterion 1 stays open.

Evidence:
`docs/verification/probe-real-game-cross-platform-2026-08-09.md` and
`docs/verification/prd-054-android-color-2026-08-09.md`.

**The goal this owns, stated as the product promise:** *any game written against this
framework or against vanilla Three.js runs on web, desktop and mobile without issues.
Everything that works on web works on desktop and mobile.*

**What this owns:** the machinery that makes that claim checkable — a parity matrix of what
a game actually uses, executed on every target, compared automatically, and failing closed
when a row was not run. It owns no gameplay and no look.

**What this does not own:** the native UI hole (PRD-055), multi-touch input (PRD-053), the
released-consumer distribution lane (PRD-048). Each is a specific parity failure with its own
PRD; this one is the gate that would have caught them.

**The framework must run on every target, stay within its budgets, and never own the look.**
`/AGENTS.md`: "a feature that works on web only is an unfinished feature."

## 1. Why the current gates cannot see the problem

On 2026-08-09 a real 1,950-line Three.js platformer was ported into a scaffolded project and
run on all three targets. Two framework defects and one product gap were found **by looking
at screenshots**, not by any gate:

- Android aborted with `signal 6` on the first frame of any `MeshToonMaterial` carrying a
  `gradientMap` under a punctual light, because the pinned wgpu-native's naga rejected the
  WGSL Three.js emits. Every gate in the repository was green while this was true.
- Those WebGPU validation errors were written to `std::cerr`, which goes nowhere on Android,
  so the abort produced no logcat line, no tombstone and no marker.
- Desktop and Android rendered the world with no HUD at all, because the DOM HUD is web-only.

The reason no gate caught any of it: `conformance/registry.json` has 49 rows, **13
implemented and 36 `planned`**, and the implemented ones are cube, texture, glTF, resize,
renderer-init and JS-host rows. Not one material row, not one light row. `pnpm test`,
`typecheck`, `lint` and every playtest scenario pass on grey boxes on a black screen, and
`native:verify:desktop` proves a spinning cube.

**The gap is not that parity is broken. It is that parity is unmeasured.**

## 2. What "without issues" has to mean to be testable

Three claims, in increasing strength. This PRD delivers the first two and defines the third.

1. **It runs.** The bundle loads, reaches first frame, survives 300 frames, and the process
   is still alive afterwards. Already true for the smoke example; not true for arbitrary
   games until PRD-054 Phase 2.
2. **It looks the same.** The same scene rendered on web, desktop and the Android emulator
   produces images within a stated tolerance of the browser reference. This is the row that
   would have caught the toon-material abort, the missing HUD, and the black screen.
3. **It plays the same.** The same scripted input produces the same state changes on every
   target. Deterministic given `defineGame({ seed })`; the playtest harness already drives a
   fixed-step clock and already supports `--target android|ios`.

## 3. The parity matrix

`conformance/registry.json` is the register of record and keeps its fail-closed rule: a row
not selected is reported **blocked**, never passed and never omitted. This PRD fills it in,
in the order a real game hits them.

**Tier 1 — what the probe game used, so what any game uses.** Every row here is a scene
under `conformance/scenes/`, rendered on all targets and image-compared:

| Rows | Why this tier |
| --- | --- |
| `10-mesh-basic-material`, `11-mesh-standard-material`, `12-pbr-material`, `13-texture-material`, `14-transparent-material` | the abort was a material row |
| **new** `15-mesh-toon-material-gradientmap` | the exact regression, named |
| `20-ambient-light`, `21-directional-light`, `22-hemisphere-light`, `23-point-light`, `24-spot-light` | the abort needed a punctual light |
| **new** `16-vertex-colors`, `17-shadow-map`, `18-fog`, `19-double-sided` | used by the probe game's level, sky and skirt |
| **new** `25-camera-parented-overlay` | the only way to draw a HUD on native today |
| **new** `26-orthographic-camera`, `27-instanced-mesh`, `28-shape-geometry`, `29-line-segments` | ordinary Three.js a game reaches for next |

**Tier 2 — the shims, where native diverges by construction:** `document`/`window` stubs,
`localStorage`, `fetch`, `Worker`, `OffscreenCanvas`, `createImageBitmap`, audio, timers,
`performance.now`, `requestAnimationFrame` cadence, pointer and keyboard events, viewport
size and orientation.

**Tier 3 — declared out of parity, with the reason written down.** Nothing may sit here
silently. Today that list is: React DOM and Tailwind HUD (PRD-055 may empty it), Rapier and
Recast WASM on mobile, and raw GLSL `ShaderMaterial` — which fails identically on web under
WebGPU and is therefore a Three.js fact, not a native break, but must be stated so a user
learns it from a doc instead of a black screen.

## 4. Self-verification — the commands, and what each proves

Every step must be runnable by an agent with no prior context, and must fail closed. **Mobile
is verified on the emulator first**: it is the only mobile surface that exists on every
machine, it needs no signing, and it is what CI can run. Physical hardware is a later row and
never a substitute.

### 4.0 Preconditions, checked and reported before anything runs

```sh
node --version                                   # 20+
java -version                                    # must be 17; JDK 26 fails with the bare message "26.0.2"
ls "$ANDROID_SDK_ROOT/platform-tools/adb"        # or THREENATIVE_ANDROID_SDK
ls packages/runtime-native/build/tn-linux/mystral  # or THREENATIVE_RUNTIME_BINARY
```

A missing precondition reports **blocked** for the rows that need it. It never silently skips
and never reports pass.

### 4.1 Web reference — the source of truth every other target is compared against

```sh
pnpm --filter @threenative/playtest build
sh scripts/xvfb.sh node conformance/browser-reference/capture.mjs \
  --registry conformance/registry.json --out artifacts/conformance/web
```

Headless Chromium cannot render WebGPU; the `xvfb` wrapper is not optional. A capture whose
canvas is uniform is a **failure**, not a pass — the harness already knows how to call a
screenshot blank and must call it here.

### 4.2 Desktop native

```sh
pnpm native:build                       # opt-in; downloads deps and compiles
pnpm native:verify:desktop              # 300 frames, markers, non-blank screenshot
node conformance/run-conformance.mjs --target desktop \
  --reference artifacts/conformance/web --out artifacts/conformance/desktop
```

### 4.3 Android — emulator, and this is the priority

```sh
# 1. Boot a known AVD, or create one. Never assume a device is attached.
"$ANDROID_SDK_ROOT/emulator/emulator" -avd threenative_api35 -no-window -no-audio -gpu swiftshader_indirect &
adb wait-for-device
adb shell 'while [ "$(getprop sys.boot_completed)" != 1 ]; do sleep 1; done'

# 2. Landscape, so the capture matches the surface the runtime configures.
adb shell settings put system accelerometer_rotation 0
adb shell settings put system user_rotation 1

# 3. Build, install, run, capture.
JAVA_HOME=/usr/lib/jvm/java-17-openjdk pnpm --filter @threenative/runtime-native \
  exec node scripts/verify-android-first-proof.mjs --device "$ANDROID_SERIAL"
node conformance/run-conformance.mjs --target android --device "$ANDROID_SERIAL" \
  --reference artifacts/conformance/web --out artifacts/conformance/android
```

Three device rules learned the hard way on 2026-08-09, all of which must be enforced by the
harness rather than remembered:

- **Verify the APK contains the bundle you built.** `android/app` regenerates its own JS
  asset from `examples/native-smoke`; a run here silently shipped the smoke example and
  looked like a pass. Extract `assets/scripts/main.js` from the assembled APK and compare its
  SHA-256 to the bundle before install. The existing gate does this; the conformance runner
  must too.
- **Assert liveness after the markers.** The toon abort arrived ~0.5 s *after*
  `TN_NATIVE_SMOKE_FIRST_FRAME`. A run that checks markers and exits reports a pass on a
  process that is already dead. Check `pidof` after a settle window, and again after the
  capture.
- **Treat an empty logcat as suspicious, not clean.** Until `0d0495c` a validation error
  produced no output at all. The runner must assert that the WebGPU error channel is alive —
  a startup line from `ThreeNativeWGPU` — before believing silence means health.

### 4.4 Comparison and the verdict

```sh
node conformance/metrics.mjs --reference artifacts/conformance/web \
  --candidate artifacts/conformance/android --tolerance registry
```

Per row: pixel mismatch ratio and perceptual ΔE against the registry tolerance, plus a
uniform-frame check that fails a blank or single-colour capture regardless of its diff score.
Output is one JSON verdict per target with `pass | fail | blocked` per row and no fourth
state.

### 4.5 Behaviour parity

```sh
node packages/playtest/dist/runner/cli.js playtests/parity.playtest.json --url … --browser-recipe webgpu
node packages/playtest/dist/runner/cli.js playtests/parity.playtest.json --target android --device "$ANDROID_SERIAL"
```

Same scenario, same seed, both targets; assert the same entity deltas and the same resource
values within tolerance. `--target android` already exists.

### 4.6 One command, for the agent that has no context

```sh
pnpm parity            # preconditions → web reference → desktop → android → compare → verdict
pnpm parity --target android   # one lane
```

Exit 0 all rows passed; 1 a row failed; 2 a row was blocked. **Blocked is not success.** The
summary prints every blocked row with the precondition that was missing, so "we did not run
it" can never read as "it works".

## 5. Phases

Progress boxes were added by PRD-445 Phase 3; the phases were prose before that.

### Phase 0 — make the regression a row

Add `15-mesh-toon-material-gradientmap` as an implemented scene with a web reference and an
emulator capture. It must fail against wgpu-native v24 and pass against v25, proving the gate
detects the exact defect that shipped green. Nothing else in this PRD proceeds until this row
can tell those two apart.

- [ ] `15-mesh-toon-material-gradientmap` scene implemented with a web reference and an emulator capture
- [ ] Row fails against wgpu-native v24.0.3.1 (pinned) and passes against v25.0.2.2 (pinned)

### Phase 1 — Tier 1 materials, lights and geometry rows

Web reference plus desktop plus emulator, with tolerances committed to the registry.

- [ ] Every Tier 1 row runs on web, desktop and the emulator
- [ ] Each row's tolerance is a reviewed number committed to the registry

### Phase 2 — arbitrary game entry

`pnpm parity --project <path>` runs the whole matrix against a user's scaffolded project rather
than the repo's scenes, so the probe done by hand on 2026-08-09 becomes a command.

- [ ] `pnpm parity --project <path>` runs the full matrix against a scaffolded project
- [ ] The 2026-08-09 hand probe is reproducible by command

### Phase 3 — Tier 2 shim rows

Each asserting the documented behaviour of a stub rather than an image.

- [ ] Every Tier 2 shim row asserts documented behaviour, not an image
- [ ] No shim row is a silent skip

### Phase 4 — CI

The emulator lane runs on every change to `packages/runtime-native` or a wgpu-native version
bump. A dependency bump that changes the WGSL a target accepts is exactly the class of change
this gate exists for.

- [ ] The emulator lane runs on every `packages/runtime-native` change and wgpu-native bump
- [ ] An AVD-less run reports `blocked` and exits non-zero

### Phase 5 — physical hardware

Changes nothing above and adds one more target column.

- [ ] The matrix runs on a named physical device and records it as its own column

## 6. Acceptance criteria

1. `pnpm parity` runs the full matrix on web, desktop and the Android emulator from a clean
   checkout, given only Node 20, JDK 17 and an Android SDK.
2. Row `15-mesh-toon-material-gradientmap` fails on wgpu-native v24.0.3.1 and passes on
   v25.0.2.2, demonstrated by pinning each.
3. A blank or uniform capture fails, on every target, regardless of diff score.
4. A row that could not run reports `blocked` and exits non-zero. No fourth state, no silent
   skip.
5. An APK whose embedded bundle does not match the built bundle fails before install.
6. A process that dies within the settle window after its markers fails, even though the
   markers appeared.
7. Every Tier 3 exclusion is listed in the registry with a reason and an owning PRD. An
   undocumented divergence is a gate failure.

## 7. What this deliberately does not do

No pixel-perfect equality: WebGPU backends differ legitimately in filtering and rounding, so
tolerance lives per row in the registry and is a reviewed number.

No claim about a platform that has not executed. iOS rows stay `blocked` until Apple hardware
exists here — the honest state, and one this gate is designed to keep visible rather than
quietly absent.

## Native LOC review trigger

The current budget report for this implementation is 60,433 native-runtime lines against the
50,000-line review trigger. The overage is accepted for the complete 66-row conformance
registry, same-source scenes, checksum-locked Android verification, native WebGPU callback
observation, event plumbing, and the two-version wgpu-native matrix because each piece records
executable evidence for the exact cross-backend regressions this PRD gates; the number is
disclosed rather than routed around.

Kill switch: delete a scene or version-matrix branch if it cannot distinguish its named
regression, delete project mode if it requires more source than running the scaffold's native
entry directly, and delete any report field that does not fail closed or change a release
decision. Physical-hardware rows remain blocked until executed and contribute no claimed pass.

## Budget justification

2026-08-10: PRD-054 owns the native parity registry, runner, metrics, version matrix, host
observation, and fail-closed tests in `conformance/`, `src/`, `scripts/`, `android/`, and
`tests/`. The current measurement and commit attribution are in
`docs/verification/native-loc-trigger-2026-08-10.md`. The kill switch keeps these areas because
they are the executable parity gate; deleting conformance, scripts, or tests would suppress
the very divergence this PRD exists to expose. The trigger is accepted and not raised.

## Criterion 1 aggregate rerun — 2026-08-10

The unsandboxed batch rerun is recorded in
[`docs/verification/prd-054-aggregate-rerun-2026-08-10.md`](../../../verification/prd-054-aggregate-rerun-2026-08-10.md).
`pnpm parity` exited `1` after writing all three reports. Browser recorded 66 passes and observed
`90-multitouch-input` as red/failing; this evidence does not establish its root cause, so the row
remains open/non-green. Linux desktop recorded 65 passes, a red `25-camera-parented-overlay` row,
and blocked `90-multitouch-input` because desktop native multitouch injection is unsupported.
Android recorded 0 passes, 0 failures, and 67 blocked rows with
`TN_PARITY_ANDROID_DEVICE_BLOCKED` because no online emulator/device was listed. The separate
Android multitouch supplemental reached the pre-APK Gradle step and failed because the SDL3
Android AAR was missing; it did not fail for an SDK/NDK/toolchain or sandbox reason. No Android
parity row executed. Criterion 1 remains open.
