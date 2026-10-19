# Current native runtime census — refreshed 2026-08-21

This is the current evidence record for the native runtime LOC census. It is separate from the
historical PRD-116 verification record. `pnpm census` generates the `Lines` column and the total
from the same walk `scripts/check-budgets.ts` runs; the budget gate fails closed on the *verdicts* —
every counted area must have an owner, a live proof or caller, a considered alternative, and a
KEEP/DELETE, and a new top-level entry in the runtime tree cannot pass without one — while line
drift is reported as a trigger, never as a hand-retyped sum to chase.

## Native LOC kill switch

The budgeted native source walk uses the same extensions and exclusions as
`scripts/check-budgets.ts`. Each row names its owner, live proof or caller, the plain alternative
considered, and a KEEP/DELETE verdict.

| Counted area | Lines | Owner | Live proof or caller | Alternative considered | Verdict |
| --- | ---: | --- | --- | --- | --- |
| `src/` | 58,747 | PRD-045, PRD-047, PRD-048, PRD-050, PRD-053, PRD-116, PRD-143, PRD-153, PRD-154, PRD-155, PRD-292 | `src/physics/native_bindings.cpp:586`; desktop V8 and native runtime commands | Move host shims into each game or delete the native host | **KEEP** — this is the owned native host and its physics boundary. |
| `conformance/` | 11,738 | PRD-053, PRD-054, PRD-055, PRD-076 | `conformance/run-conformance.mjs`; root `pnpm parity` | Replace cross-target registry/proofs with untested per-game scripts | **KEEP** — shared executable conformance evidence. |
| `tests/` | 59,665 | PRD-045, PRD-046, PRD-048, PRD-049, PRD-050, PRD-053, PRD-054, PRD-055, PRD-076, PRD-116, PRD-127, PRD-143, PRD-153, PRD-154, PRD-155, PRD-292 | `tests/physics_actuation_bindings_test.cpp:141`; runtime-native Vitest and native tests | Delete fail-closed tests to reduce the trigger | **KEEP** — removal would conceal regressions. |
| `__tests__/` | 1,166 | PRD-228 | `__tests__/host-gap-gpu-drain.spec.ts`; the runtime-native Vitest suite via `vitest.config.ts` | Fold it into `tests/`, where every other spec in this package lives | **KEEP** — it is one source-reading spec proving the GPU-drain profile stays diagnostic-only and never ships, and it is picked up by the same suite either way. Its one-file directory is an accident of where it landed, not a design; moving it into `tests/` is a tidy-up and not this row's argument. |
| `scripts/` | 31,308 | PRD-045, PRD-048, PRD-049, PRD-050, PRD-053, PRD-054, PRD-116, PRD-127, PRD-153, PRD-155, PRD-292 | `scripts/verify-desktop-physics.mjs:206-228`; build, platform, and device-condition verifiers | Make every game own packaging, device, and verifier orchestration | **KEEP** — no smaller shared alternative preserves the proof. |
| `scenarios/` | 109 | PRD-217 | `scenarios/starter-ui-overlay-desktop.playtest.json`; run by the hosted `native-platforms` desktop-core job through `scripts/verify-starter-ui-overlay.mjs` | Keep the starter-HUD input assertion inside the desktop-core job script instead of a standalone scenario file | **KEEP** — the scenario is the portable playtest that proves the starter HUD receives real input on the packed desktop runtime; the hosted desktop-core job is its caller, so the area is one owned proof rather than reusable game content. |
| `include/` | 6,203 | PRD-046, PRD-047, PRD-053, PRD-116, PRD-143, PRD-153, PRD-292 | `include/threenative/physics_native.h:131`; C ABI consumed at `src/physics/native_bindings.cpp:586` | Add per-game native headers or remove the native C boundary | **KEEP** — the coarse host ABI is the shared boundary. |
| `android/` | 1,888 | PRD-045, PRD-048, PRD-050, PRD-053, PRD-054, PRD-153 | Android host sources and `scripts/verify-android-physics-parity.mjs` | Require each game to rebuild Android lifecycle and transport | **KEEP** — required Android packaging and execution plumbing. |
| `native/` | 90,896 | PRD-046, PRD-049, PRD-116, PRD-143, PRD-292 | `native/physics/src/lib.rs:463`; `native/physics/tests/actuation.rs:324` | Use the web WASM/Rapier backend on native or move physics into games | **KEEP** — this is the native Rust implementation behind the shared API. |
| Root `CMakeLists.txt` | 2,860 | PRD-047, PRD-048, PRD-050 | `pnpm native:build`; explicit binding target build | Make every game own native dependency discovery and linking | **KEEP** — opt-in host build configuration. |
| `cmake/` | 328 | PRD-047, PRD-048, PRD-050 | Root CMake configuration includes these platform modules | Duplicate compiler/platform rules in each game | **KEEP** — shared build modules. |
| `CMakePresets.json` | 141 | PRD-047, PRD-048, PRD-050 | `tn-linux` preset used by the native build and binding target | Remove declared presets and use undocumented local flags | **KEEP** — reproducible host presets. |
| `ios/` | 598 | PRD-045, PRD-048, PRD-049, PRD-050, PRD-153 | `scripts/verify-ios-simulator.mjs` and iOS host sources | Make each game own iOS packaging and simulator lifecycle | **KEEP** — shared iOS packaging boundary; this lane made no iOS execution claim. |
| `package.json` | 109 | PRD-048, PRD-050, PRD-054, PRD-116 | `native:build`, `native:physics:parity`, and `native:verify:desktop` scripts | Hide opt-in native commands in per-game manifests | **KEEP** — package-level command contract. |
| `vitest.config.ts` | 10 | PRD-048, PRD-050 | Runtime-native Vitest command and parity producer | Drop native package test collection | **KEEP** — declares the native package test boundary. |
| `tools/` | 145 | PRD-077 | `conformance/desktop-touch.mjs` → `threenative-uinput-touch`, built by the `CMakeLists.txt` target of the same name | Write the injector in Node, or take an npm addon, or shell out to `python3` | **KEEP, and it cannot be smaller.** Creating a `uinput` device is a sequence of ioctls and Node exposes none, so the alternatives are a new native harness dependency rebuilt per Node version, or a Python toolchain this repository does not otherwise have. This owns only the ioctls and the device's lifetime — every event is encoded in JavaScript where a test can assert two `ABS_MT_SLOT` groups precede one `SYN_REPORT`. Linux-only by construction. |
| `shim-manifest.json` | 65 | PRD-215 | `scripts/check-native-shims.ts` from `pnpm budgets`; native host installs in `src/runtime.cpp` and `src/webgpu/bindings.cpp` | Keep the native-global contract as prose only in `AGENTS.md` | **KEEP** — machine-readable shim evidence is the enforced web/native boundary. |
| `js-engine-versions.json` | 38 | PRD-222 | `tests/js-engine-version-skew.test.mjs`; `scripts/download-deps.mjs` consumes the pinned engine versions | Leave engine/version compatibility as prose or duplicate pins across download scripts | **KEEP** — one fail-closed manifest prevents desktop, Android, and iOS engine pins from drifting silently. |
| `build-matrix.json` | 240 | PRD-235 | `scripts/check-build-matrix.ts` from `scripts/check-budgets.ts:467` via `pnpm budgets`; proven by `scripts/__tests__/check-build-matrix.spec.ts` | Leave "which build directory does this test executable live in" as prose in `AGENTS.md` and tribal knowledge | **KEEP** — the prose answer was already wrong once: a contract test that only links in `build/tn-linux` is invisible to anyone reading `CMakeLists.txt`. This is the machine-readable contract, and the gate cross-checks every preset, cache variable, and test executable it names against CMake, so either side drifting is a named failure. |
| `native-deps.lock.json` | 1,050 | PRD-059 | `scripts/download-deps.mjs` reads it before any acquisition; `tests/dependency-provenance.test.mjs` proves lock coverage | Leave dependency URLs/versions/hashes as inline mutable code in `download-deps.mjs` | **KEEP** — the reviewed immutable payload matrix is what makes reconstruction mean the same bytes; inline authority already served one 404. |
| **Total** | **267,304** |  | `pnpm budgets` current measurement |  | **No area rejected.** |

**Regenerated 2026-09-02 for PRD-292 recovery:** the native physics ABI, its contract test, and
the continuous-collision measurement harness changed the counted `src/`, `include/`, `tests/`,
`native/`, and `scripts/` rows. `pnpm census` refreshes the generated line counts below.

**Updated 2026-08-19 by [PRD-160](../PRDs/done/PRD-160-android-emulator-lane-repair-and-parity-adjudication.md): +58 lines, 78,289 → 78,347.**
`conformance/` gained 10 lines (6,331 → 6,341) for `androidWindowDump` and the docblock recording
why the foreground guard cannot read `dumpsys window windows` on Android 15; `tests/` gained 48
(9,468 → 9,516) for the regression test that carries both real API-35 dumps as fixtures. Both are
fail-closed evidence for a defect that had turned 66 conformance rows red, and the census check is
what caught the drift — which is the instrument PRD-161 repaired working on the next change after it.

**Regenerated 2026-08-21 by the technical-debt audit integration: totals unchanged at 78,347.**
The `Lines` column is now written by `pnpm census`, not retyped, and the physics evidence test no
longer pins this table's rows or vitest summary strings — that coupling put a hand-maintained
Markdown number between every native change and the native parity gate (the audit's §1–§2). The
gate now enforces what the census exists for: one judged verdict per counted area, with area-set
equality against the measured walk. Line drift shows up in `pnpm budgets` output as a trigger
naming the drifted rows and the regeneration command.

**Updated 2026-08-21 by [PRD-069](../PRDs/done/PRD-069-per-draw-cost.md): +59 lines, 78,347 → 78,406.**
`src/` gained 14 lines (38,822 → 38,836) for the `TN_ANDROID_JS_PROFILE` flag that reports each
frame's present on its first submit only, which removed a phantom ~2.6 ms/frame of native cost from
the Pixel 8 profile; `scripts/` gained 21 (12,158 → 12,179) so the measurement script accepts the
wireless adb transport the discharging-battery preflight requires and sizes the logcat ring large
enough that markers survive a full window; `tests/` gained 24 (9,516 → 9,540) for the fail-closed
regression tests covering both. All three are measurement-instrument repairs: without them the
per-draw-cost ladder reports numbers the device did not produce.

**Updated 2026-08-22 by [PRD-P2-7](../PRDs/done/PRD-P2-7-generated-shooter-input-proof.md) and the landed render-perf lane: +521 lines, 78,618 → 79,139.**
`tests/` gained 381 (9,711 → 10,092), of which 288 are P2-7's
`tests/generated-shooter-input.test.mjs` — the committed native-delivery-order proof for the
generated shooter scenario — and the remainder the perf lane's fail-closed regression tests;
`conformance/` gained 13 (6,341 → 6,354) for P2-7's versioned `generatedPlaytestProofs` registry
section; `src/` (+70, 38,857 → 38,927), `include/` (+24, 3,836 → 3,860) and `scripts/` (+33,
12,179 → 12,212) belong to the render-perf lane's landed commits (contained-frustum subjects,
present-once profile follow-ups). Regenerated after both lanes settled so one walk attributes both.

**Updated 2026-08-28 by PRD-235 Phase 1: +142 lines, 108,160 → 108,302.**
All 142 are the new counted area `build-matrix.json`, the machine-readable answer to which build
directory each native test executable lives in and why. It is enforced, not prose:
`scripts/check-build-matrix.ts` runs from `scripts/check-budgets.ts:467` on every `pnpm budgets`
and cross-checks each configuration's preset against `CMakePresets.json`, each cache variable
against a declared `option()`/`set(... CACHE ...)` in `CMakeLists.txt`, and each `runs` entry
against a real `add_executable` — and fails when a registered test executable is claimed by no
configuration. No native source changed in this commit.

The current measurement uses the same native extensions and exclusions as `scripts/check-budgets.ts`:
`third_party/`, `build/`, `.runtime/`, `artifacts/`, `.cxx/`, `.gradle/`, `.test-tmp/`, and
`target/` are excluded, as are global `node_modules/`, `dist/`, and `.git/` directories. The
generated Android bundle `android/app/src/main/assets/scripts/main.js` and its `.meta.json` are
also excluded. This tree has no tracked `third_party/` files and no generated Android bundle, so
the current `78,406` total contains **0 vendored-but-tracked dependency lines** and **0 excluded
generated-output lines**. One tracked generated input remains counted: the pre-compiled
`src/raytracing/shaders/rt_shaders_spirv.h` contributes 189 budget-counted lines (188 physical
newline separators plus its final non-empty line).

The 2026-08-16 device-preflight and Android report-condition repairs account for the current
`tests/` and `scripts/` rows; PRD-143 adds the shared native joint ABI and constraint backend.

PRD-152 adds 54 lines to `src/`, all of them in `src/webgpu/bindings.cpp`: the WebGPU texture-format
tables gained the integer, snorm and packed formats in both directions. They were absent, so a format
three.js named — `r32uint`, which is where `BatchedMesh` keeps its per-draw indirection — fell through
to a `BGRA8Unorm` default, every bind group built against it failed validation, and the draw using it
silently did not happen. There is no smaller form: a format table is one line per format, and the
alternative is a host that cannot render what the renderer asks for.
PRD-152 adds 54 lines to `src/`: the WebGPU texture-format tables in `src/webgpu/bindings.cpp` gained
the integer, snorm and packed formats, without which `r32uint` fell through to a BGRA8Unorm default
and every bind group built against it failed validation on the native host. The PRD-152 checkpoint
was 77,107 / 50,000; the current trigger after PRD-153 is recorded below. Physical
Android, iOS, and hardware evidence remains unverified.

PRD-153 adds 699 lines across `src/`, `tests/`, `scripts/`, `include/`, `android/` and `ios/` for
brand-resource packaging, launch inspection, and measured safe-area transport.

PRD-155 adds 338 lines across `src/`, `scripts/` and `tests/`: the present-once-per-frame fix and
the device-lane screenshot gate that can fail on what actually reached the screen.

PRD-154 adds 102 lines across `src/` and `tests/`: the host publishes its own runtime, OS, form
factor and touch capacity to the bundle instead of leaving a portable game to sniff browser globals
that the native host only stubs.

The measured native review trigger remains visible at **78,406 / 50,000** (**+28,406**). Physical
Android, iOS, and hardware evidence remains unverified.

## Current gate summaries

| Command | Result | Evidence |
| --- | --- | --- |
| `pnpm budgets` | PASS, exit `0` | Re-run 2026-08-21 after the technical-debt audit integration: 7 framework packages, 8 example workspaces, 12,936/15,000 framework LOC, 78,347/50,000 native runtime LOC, 13 direct PRD files, largest template 2,279 LOC; the native review trigger remains visible and no census drift is reported. |

- Root Vitest: 158 files, 1,480 passed, 0 skipped.
- Runtime-native Vitest: 48 files, 319 passed, 37 skipped; `native:physics:parity` executed in the
  same run — web parity spec 24/24 and the shipping Rust simulation against the web artifact.
- No physical-device result is claimed.
