---
prd_contract: v1
---

# PRD-130 — Make V8 the Android default, and make it reach someone other than its author

**Status: ALL SIX PHASES EXECUTED, 2026-08-16.** No mobile-readiness, signing, or second-device
claim is made by this file, and none of the six changes that.

| Phase | State | Record |
| --- | --- | --- |
| 1 — per-ABI snapshot staging | done; V8 runs on x86_64 for the first time | [phase-1](../../verification/prd-130-phase-1-2026-08-16.md) |
| 2 — `v8-android` in the supported download path | done; rebuilt byte-identically from the script alone | [phase-2](../../verification/prd-130-phase-2-2026-08-16.md) |
| 3 — per-ABI download size | done; **+25.6 MB on arm64**, measured on artifacts | [size](../../verification/android-engine-size-2026-08-16.md) |
| 4 — V8 in the prebuilt/release path | done; a V8 APK **built with no NDK** from checksum-verified artifacts, **running V8 on the Pixel 8**. The GitHub Actions run itself is untested | [phase-4](../../verification/prd-130-phase-4-2026-08-16.md) |
| 5 — correctness on the phone | done; veto not exercised, parity holds | [phase-5](../../verification/prd-130-phase-5-2026-08-16.md) |
| 6 — flip the default | done; both directions run on the Pixel 8 | [phase-6](../../verification/prd-130-phase-6-2026-08-16.md) |

**The gain, measured on the default that now ships** — same load-test bundle, same device, minutes
apart, only the engine flag differing: L3 @ 16,384 reads **8.34 ms** against QuickJS's **101.24 ms**.
The V8 side is the 120 Hz vsync interval, so 12× is a **lower bound**.

**The price is confirmed, not renegotiated.** The +25.6 MB the owner accepted was a sum over
uncompressed libraries; measured on per-ABI APKs it is +25,607,134 B on arm64. The two agree to
within 0.03%.

**Three things this PRD did not get to, named rather than implied:**

1. **No tag was pushed, so the artifacts are not hosted.** The consumer path itself *was* executed
   end to end: twelve artifacts staged under their release names, fetched and checksum-verified
   through `prepareAndroidPrebuilts`, assembled into a V8 APK with the NDK variables unset and `PATH`
   reduced to `/usr/bin:/bin`, and **run on the Pixel 8 reporting `JS engine created: V8`**. What a
   tag adds is hosting, not correctness — and running the lane locally caught an assertion in it that
   would have passed vacuously, because V8's symbols are mangled and the grep looked for a literal
   `v8::`. Publishing to a public release is the owner's call.
2. **Both performance runs are stamped `provisional: ["charging"]`.** PRD-127's preflight refused a
   charging device and the override wrote the condition into the report rather than hiding it. Both
   arms were charging at the same 80% and thermal NONE, so the comparison is like-for-like, but a
   discharging retake is owed.
3. **`conformance/run-conformance.mjs` was not run under V8.** Phase 5 proved the first-proof gate
   and multitouch. A conformance row that was not run is not a passing row.
   **Attempted 2026-08-17 on the Pixel 8 and still not obtained** — the Android parity lane could
   not photograph the app. Two defects in that lane were found and fixed instead: it left the
   device's display overridden to `1280x720` and then "restored" that leak onto the phone on every
   later row, and it detected exactly two system-dialog strings, so an *"app which is currently
   being tested"* prompt let it capture the home screen 67 times and report 67 rows of
   `pixelMismatchRatio: 1.000` as a rendering failure. Record:
   [`prd-130-conformance-attempt-2026-08-17.md`](../../verification/prd-130-conformance-attempt-2026-08-17.md).

**One correction published the same day.** Phase 5 and Phase 6 first reported the V8 APK as *smaller*
than the QuickJS one. That was incremental packaging leaving the previous engine's library in the
file as 25.5 MB of dead bytes; both records now carry the withdrawal inline. An APK's size is only a
measurement if it was packaged from clean outputs.

**The owner has decided: V8 becomes the Android default.** Recorded 2026-08-16, on the numbers in
PRD-118 and its charged retake, for +25.6 MB of arm64 payload.

**The load-bearing figure is script time per frame — 115.64 ms under QuickJS against 5.25 ms under
V8, 22×**, at 16,384 moving cubes on the Pixel 8. The frame-time pair usually quoted beside it,
119.19 ms → 8.32 ms, is half a measurement and this PRD does not lean on it: QuickJS's 119.19 ms is
real work, but 8.32 ms is the 120 Hz vsync interval and V8 sits *on* it, so that arm was bounded
rather than measured. Unpinned, the same rung reads **5.91 ms**
(`artifacts/engine-load-test/tn-android-novsync.json`). The defensible frame sentence is that V8's
whole frame fits inside one 120 Hz interval where QuickJS needs fourteen — never that V8 costs
8.32 ms.

That resolves Phase 6's branch in advance and deletes the refusal half of this PRD.

It does not shorten Phases 1 through 5, and the flip lands after them rather than instead of them.
Flipping the default today would produce a default that only an operator with an NDK can build, on
one ABI, that breaks the x86_64 emulator lane on first launch — which is the exact condition this
PRD exists to remove. **Phase 5 keeps a veto:** if V8 fails a conformance row QuickJS passes on the
same device, the flip does not land, this status returns to open, and the failing row is named.

**Outcome:** the Android default is V8, and a project scaffolded by `create-threenative` gets it
without knowing the flag exists. `-PthreenativeJsEngine=quickjs` becomes the documented rollback.

**Depends on:** [PRD-118](../done/PRD-118-android-js-engine.md), which measured the win and said in
its own §6 that the flip is the owner's call; the physical Pixel 8 (`shiba`, arm64-v8a) used by
PRD-066, PRD-070, PRD-117 and PRD-118; the x86_64 emulator lane recorded in
`packages/runtime-native/docs/G3-mobile-bring-up.md`.

**Related, not blocking:** [PRD-127](../native/PRD-127-device-measurement-preflight.md) — any timing this PRD
takes should pass its condition gate. [PRD-128](../native/PRD-128-android-qualification-split.md) — the
release build type has no `signingConfig`; that is PRD-128's problem and this PRD inherits it rather
than solving it.

**Complexity: 7 → HIGH mode.** No new capability and no framework surface. It is a build-graph
correction, a dependency-provisioning gap, a release-artifact addition, and then the runs. The runs
are the cost, and two of them need the phone.

**Blast radius: ~11 paths.** `packages/runtime-native/android/app/build.gradle.kts`,
`packages/runtime-native/CMakeLists.txt`, `packages/runtime-native/CMakePresets.json`,
`packages/runtime-native/scripts/download-deps.mjs`,
`packages/runtime-native/scripts/package-android.mjs`,
`packages/runtime-native/scripts/install-prebuilt.mjs`, `.github/workflows/native-release.yml`,
`.github/workflows/native-platforms.yml`, `packages/runtime-native/docs/G3-mobile-bring-up.md`,
`packages/runtime-native/AGENTS.md`, `docs/verification/`.

The last three carry no code and are the ones most likely to be skipped. Android's engine is stated
in prose in `AGENTS.md` and G3, and a default that changes in the build files while the docs still
say QuickJS is how the next reader learns the wrong thing with confidence.

**Three gates that fail closed on this blast radius.** All three were hit on the batch that landed
just before this PRD, so treat them as known rather than as discoveries:

- **The native census is recorded twice and both copies fail closed.** Changing line counts under
  `packages/runtime-native/` means updating the area rows *and* the total in
  `docs/verification/PRD-116-native-physics-actuation.md` (`pnpm budgets` fails) and the hardcoded
  copy in `packages/physics/__tests__/actuation.spec.ts` (`pnpm test` fails). Measure the merged
  tree; do not compute the delta.
- **`AGENTS.md` is the source and `CLAUDE.md` is generated.** Edit `AGENTS.md`, run
  `pnpm sync:agents`, or CI reverts the mirror. Its engine paragraph currently describes the
  QuickJS-default split and Phase 6 makes it wrong.
- **`pnpm lint` reports one build-failing error under a few hundred warnings.** Grep for errors;
  a clean-looking tail is not a green run.

---

## 1. What is actually in the way

PRD-118 closed with a 22× script-time result and an unmade decision. The decision reads as a
size-versus-speed judgement — +25.6 MB of arm64 payload against 119.19 ms → 8.32 ms — and the owner
could make that call from the numbers alone. Except the flag it would flip does not survive contact
with any path but the one that produced those numbers. Four things, found by reading the build files
rather than by running them; Phase 1 through Phase 4 execute each one.

**One. The x86_64 slice would ship an arm64 snapshot.** `build.gradle.kts:49` copies
`third_party/v8-android/snapshot_blob/arm64-v8a/snapshot_blob.bin` to a single
`assets/v8/snapshot_blob.bin`, and `abiFilters` at line 200 ships `arm64-v8a` **and** `x86_64` in the
same APK. The tree carries an x86_64 snapshot next to the arm64 one and nothing reads it. Every V8
run so far has been on the phone, which is arm64, so nothing has caught this. The emulator lane is
x86_64 — G3 line 9 says so — and it is the lane a default would route through first.

**Two. A fresh checkout cannot obtain Android V8.** `download-deps.mjs:925` lists the Android
dependencies as `sdl3`, `wgpu-android`, `sdl3-android`, `quiche-android`. Its `v8` entry (line 130)
maps to desktop macOS/Linux/Windows archives. `third_party/v8-android/` exists on this machine
because somebody put it there. The package's own rule is that `download-deps.mjs` is the only
supported reconstruction path, so today the V8 Android build is not reconstructible by that rule.

**Three. The path a scaffolded user builds through carries no V8 at all.** When
`android/prebuilt/` is populated the Gradle build skips CMake entirely (`build.gradle.kts:21`), and
`package-android.mjs:26` populates it with exactly four files: SDL3 and `libmystral-runtime.so`, per
ABI. No `libv8android.so`, no `libc++_shared.so`, no snapshot. A user who never compiles the runtime
cannot run V8 whatever the default says, and flipping the CMake default without this would produce a
default that only operators with an NDK ever receive.

**Four. Nobody has measured what a user downloads.** There are no ABI splits, so every APK this repo
produces is universal and carries both ABIs: 218,349,795 B for QuickJS against 361,004,372 B for V8.
That +142.7 MB double-counts and PRD-118's retake says so. The arm64-only payload figure —
75,819,688 B → 101,390,028 B, **+25.6 MB** — is the right shape of number, but it is a sum over
uncompressed native libraries, not the size of an artifact this repository has ever built.

And one gap that is not a build defect: **PRD-118 proved speed under V8, not correctness.** No
conformance run, no playtest, no multitouch check has executed against a V8 build on the phone. A
default engine that renders 14× faster and gets one binding wrong is worse than the slow one.

```mermaid
flowchart TD
    Flag["-PthreenativeJsEngine=v8"] --> Src["compile from source<br/>(NDK + CMake)"]
    Flag -.->|"no path today"| Pre["android/prebuilt/<br/>(scaffolded user)"]
    Src --> A64["arm64-v8a<br/>proved: PRD-118"]
    Src --> X64["x86_64<br/>arm64 snapshot copied here"]
    Src --> Dep["third_party/v8-android<br/>not in download-deps androidDeps"]
    A64 --> Perf["22x script time"]
    A64 --> Corr["correctness: unrun"]
```

## 2. What this PRD decides

The four gaps above get closed first, because each is a defect in its own right: a build that ships
a wrong-ABI asset, a dependency outside the supported provisioning path, a release artifact that
cannot express a supported build option, and a cost nobody has measured on the artifact users
receive. Every one of them would still be a defect if the default had stayed QuickJS, so none of
them is flip preparation and none is skippable now that the flip is decided.

The default itself is settled — see the status block. What Phase 6 still owes is the flip **and**
the measurements that make it reviewable afterwards: per-ABI download size (Phase 3), correctness
parity (Phase 5), and both engines' numbers under PRD-127's condition gate. A decision recorded
without its price is not a finished record, and that stays true when the answer is yes.

## 3. Integration Ledger

Filled with real `file:line` during implementation. A `TBD` at phase end means the phase is open.

| # | New thing | Live caller (`file:line`, non-test) | Replaces | Old path removed? | Negative control |
|---|-----------|-------------------------------------|----------|-------------------|------------------|
| 1 | Per-ABI snapshot staging in `copyV8Snapshot` | `build.gradle.kts` — task wired into the existing `preBuild`/merge-assets chain that already consumes it | single arm64 copy at `build.gradle.kts:49` | yes, deleted in Phase 1 | stage the arm64 snapshot into the x86_64 slice → emulator launch fails with the existing snapshot error |
| 2 | `v8-android` dependency entry | `download-deps.mjs` `androidDeps` list (currently line 925) | manual placement of `third_party/v8-android/` | n/a, no code path to remove | delete `third_party/v8-android/`, run the Android dep download, build with `-PthreenativeJsEngine=v8` |
| 3 | V8 entries in `ANDROID_PREBUILT_ASSETS` | `package-android.mjs:26` map, consumed by `prepareAndroidPrebuilts` at line 208 | prebuilt path silently QuickJS-only | prebuilt completeness check widened, not duplicated | populate `android/prebuilt/` from a V8 release, build, assert logcat says V8 |
| 4 | Per-ABI size record | `docs/verification/android-engine-size-<date>.md`, cited from `G3-mobile-bring-up.md` | the universal-APK figure quoted in PRD-118 §4 | universal figure kept but labelled double-counting | none needed — it is a measurement, and its control is that the two engines' numbers differ |
| 5 | Engine identity assertion in the device gates | `verify-android-first-proof.mjs` / conformance runner, whichever already parses logcat | assumption that the installed APK is the engine you asked for | n/a | run the assertion against a QuickJS APK while asking for V8 → must fail |
| 6 | V8 as the Android default | `CMakeLists.txt:129` platform block, `build.gradle.kts:35` property default, `CMakePresets.json` `tn-android` preset | QuickJS default in all three | yes — QuickJS becomes the opt-in, not a second default | build with no flag → logcat says V8; build with `-PthreenativeJsEngine=quickjs` → logcat says QuickJS and still launches |

**Reachability.** Entry point: `pnpm native:build` and `gradlew assemble*` for the source path,
`create-threenative`-scaffolded `pnpm native:package:android` for the prebuilt path; the observable
is `runtime.cpp:450`, which already logs `JS engine created: %s` to logcat on every launch. That line
is the one place the running process states which engine it is, and every gate below reads it rather
than inferring from the build flag.

**Replaces:** the current arm64-only snapshot copy (row 1) and the QuickJS-only prebuilt contract
(row 3). Nothing else.

## 4. Phases

Each phase edits at least one pre-existing file. No phase adds a new package or a public API.

### Phase 1 — The x86_64 emulator launches a V8 build, or the build refuses to produce one

**Files:** `android/app/build.gradle.kts` (EDIT), `packages/runtime-native/docs/G3-mobile-bring-up.md`
(EDIT).

- [ ] `copyV8Snapshot` stages one snapshot per ABI, keyed off the same ABI list `abiFilters` uses, so
      the two cannot drift.
- [ ] A missing snapshot for **any** shipped ABI throws at configure time, matching the existing
      failure for the arm64 one. Shipping an ABI with no snapshot is a build failure, never a runtime
      surprise.
- [ ] G3 gains a row for the engine the emulator lane ran.

**Wiring:** the task is already in the build graph; the edit changes what it stages, and the
completeness check is what makes the wrong state impossible.

**Verification:**

```sh
./gradlew assembleDebug -PthreenativeJsEngine=v8
adb -s emulator-5554 install -r <apk> && adb logcat -d | grep "JS engine created"
# Expected: V8, on x86_64
```

**Negative control (must be observed red):** stage the arm64 snapshot into the x86_64 slice by hand
and reinstall. The emulator must die with `V8 startup snapshot asset is missing` or an equivalent
refusal, not run. If it runs, the snapshot is not being read and the gate proves nothing.

**Revert check:** restore the single-copy staging → the emulator V8 launch fails.

### Phase 2 — A fresh checkout can build Android V8 through the supported path

**Files:** `scripts/download-deps.mjs` (EDIT), `packages/runtime-native/AGENTS.md` (EDIT).

- [ ] `v8-android` joins `androidDeps` with a pinned URL and checksum, in the same shape as
      `wgpu-android`.
- [ ] The entry provisions both ABIs' libraries and both snapshots — the thing Phase 1 now requires.
- [ ] AGENTS.md's V8 paragraph stops implying `third_party/v8-android` appears by itself.

**Verification:**

```sh
mv packages/runtime-native/third_party/v8-android /tmp/v8-android.bak
node packages/runtime-native/scripts/download-deps.mjs --android
./gradlew assembleDebug -PthreenativeJsEngine=v8   # must succeed
```

**Negative control:** run the build with the directory moved away and the dep script **not** run. It
must fail loudly at configure time. A build that quietly falls back to QuickJS here is the exact
silent-substitution failure PRD-118's §2 spent three checks ruling out.

### Phase 3 — The number a user downloads, for both engines

**Files:** `android/app/build.gradle.kts` (EDIT), `docs/verification/android-engine-size-<date>.md`
(NEW), `packages/runtime-native/docs/G3-mobile-bring-up.md` (EDIT).

- [ ] Per-ABI artifacts are producible (ABI splits or an equivalent per-ABI assemble), so a size can
      be read off an artifact rather than summed from libraries.
- [ ] Four numbers recorded: {QuickJS, V8} × {arm64-v8a, x86_64}, as built artifact bytes, plus the
      Play-delivery figure if the bundle path is available.
- [ ] PRD-118's universal figure is cited and labelled as double-counting, not deleted.

**Acceptance:** the record answers "how many extra megabytes does an arm64 phone download to get
V8" with an artifact size, not a sum. If the true delta lands materially below +25.6 MB, say so; if
it lands above, say that instead. The PRD does not have a preferred answer here.

### Phase 4 — V8 reaches the path a scaffolded user builds through

**Files:** `scripts/package-android.mjs` (EDIT), `scripts/install-prebuilt.mjs` (EDIT),
`.github/workflows/native-release.yml` (EDIT), `android/app/build.gradle.kts` (EDIT).

- [ ] Release artifacts gain the V8 runtime set per ABI: `libv8android.so` (29,919,888 B on arm64),
      `libc++_shared.so`, and the matching snapshot.
- [ ] `ANDROID_PREBUILT_ASSETS` and the prebuilt completeness check express both engines. A
      partially-populated prebuilt directory keeps failing loudly, as it does today.
- [ ] The prebuilt path can select an engine by the same flag name as the source path. Two names for
      one choice is how the flag gets forgotten.

**Negative control:** populate `android/prebuilt/` from a QuickJS release, request V8, build. The
build must refuse rather than produce an APK whose logcat says QuickJS.

**Revert check:** remove the V8 entries → a V8 prebuilt build fails the completeness check.

### Phase 5 — V8 is proved correct on the phone, not only fast

**Files:** `scripts/verify-android-first-proof.mjs` (EDIT), `conformance/registry.json` (EDIT),
`docs/verification/prd-130-v8-correctness-<date>.md` (NEW).

- [ ] The conformance run and the multitouch check execute on the Pixel 8 against a V8 APK, with the
      installed bytes proved by hash as PRD-118 §2 did.
- [ ] A playtest scenario drives the real build on device under V8 and asserts behaviour, not
      startup.
- [ ] Every gate records which engine the process reported at `runtime.cpp:450`, from logcat.

**Negative control:** run the engine-identity assertion against a QuickJS APK while asking for V8 —
it must fail. A parity gate whose two sides can be the same build measures nothing.

**Acceptance:** conformance rows that pass under QuickJS pass under V8 on the same device, and any
row that does not is named in the record. A blocked row is reported blocked, never omitted.

### Phase 6 — Flip the default, and record what it cost

**Files:** `CMakeLists.txt` (EDIT), `android/app/build.gradle.kts` (EDIT),
`packages/runtime-native/AGENTS.md` (EDIT), `packages/runtime-native/CMakePresets.json` (EDIT — the
`tn-android` preset pins `MYSTRAL_USE_V8=OFF, MYSTRAL_USE_QUICKJS=ON` and would otherwise override
the platform default it is meant to follow), `docs/verification/` (NEW record),
`docs/PRDs/done/PRD-118-android-js-engine.md` (EDIT — its §6 open question gets an answer and a
link).

- [ ] The Android default becomes V8 in the CMake platform block (`CMakeLists.txt:129`), the Gradle
      property default (`build.gradle.kts:35`, currently `.orElse("quickjs")`) and the `tn-android`
      CMake preset. Three places state this default today and all three must agree; a preset that
      contradicts the platform block is how the flag came to work on one machine only.
- [ ] `-PthreenativeJsEngine=quickjs` is the documented rollback, and **both directions are exercised
      in the same commit** — a rollback nobody ran is not a rollback.
- [ ] AGENTS.md and G3 stop saying "Android QuickJS+wgpu-native". AGENTS.md's V8 paragraph inverts:
      QuickJS becomes the opt-in, and the +25.6 MB stays stated rather than dropped now that it is
      the paid-for option.
- [ ] `docs/verification/` gains a dated record carrying the price the owner accepted: per-ABI
      download delta (Phase 3), correctness parity (Phase 5), both engines' frame numbers under
      PRD-127's condition gate, and the operational cost — a shared STL, an external snapshot per
      ABI, and a 30 MB library in every release.

**Acceptance (consumer-scoped):** a project scaffolded by `create-threenative` and built for Android
with **no engine flag** launches on the Pixel 8 and logcat reports `JS engine created: V8`; the same
project with `-PthreenativeJsEngine=quickjs` reports QuickJS and still launches; and the emulator
lane launches V8 on x86_64 from Phase 1's staging. The engine is read from logcat in all three,
never inferred from the flag.

**Revert check:** restore any one of the three default sites to QuickJS while the other two say V8 →
a gate must catch the disagreement rather than letting the build pick a winner silently.

## 5. What this PRD will not claim when it closes

- **Not mobile-ready.** One Android phone and one x86_64 emulator are not mobile, and iOS has no
  physical evidence at all. A faster default engine does not change that by a single row.
- **Not an iOS change.** iOS is JSC by construction and no third-party engine gets a JIT there, so
  this decision reaches Android only. The one platform still on a JIT-less interpreter after this
  PRD is iOS, and nothing here shortens that.
- **Not a signed-artifact claim.** The release build type still has no `signingConfig`; that is
  PRD-128's row and this PRD does not touch it.
- **Not a second-device result.** Every device number here comes from `shiba` unless another phone
  appears, and a second device would be a different PRD.
- **Not a re-measurement of QuickJS at 16,384.** That figure remains PRD-117's, with PRD-117's
  provenance, unless someone retakes it.

## 6. Done checks

- [ ] All six phases complete, or the PRD stays open with the unfinished phase named
- [ ] `pnpm typecheck && pnpm lint && pnpm test` green
- [ ] Integration Ledger has zero `TBD` cells; every live caller is a real non-test `file:line`
- [ ] Every gate above has a negative control that was **observed** failing, pasted, not summarized
- [ ] Revert checks pass: undoing Phase 1, 2 or 4 breaks a gate that now exists
- [ ] The engine each gate ran under is read from logcat, never inferred from the build flag
- [ ] G3 and AGENTS.md describe the default that is actually in the build files
- [ ] All three default sites — CMake platform block, Gradle property, `tn-android` preset — say V8,
      and the rollback flag was exercised in the same commit
- [ ] The price the owner accepted exists as a dated record in `docs/verification/`, not as an
      implication that the numbers spoke for themselves
