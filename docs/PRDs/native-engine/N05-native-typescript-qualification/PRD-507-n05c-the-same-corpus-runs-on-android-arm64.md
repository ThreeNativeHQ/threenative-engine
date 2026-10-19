# PRD-507 — The same corpus runs on Android arm64 (N05c)

**Status:** PROPOSED — early spike for gate T; blocks nothing else (owner decision 2)
**Priority:** P2 — Early spike: the same corpus on Android arm64; 4 open boxes.
**Complexity:** 4 — cross-compilation, NDK linking and packaging for a third-party compiler runtime
**Owner:** João
**Work package:** N05 — [native-engine batch](../README.md) · [N05 index](README.md)
**Depends on:** [PRD-505](PRD-505-n05a-the-language-corpus-compiles-on-linux-x64.md); the `three-fixture` and callback cases from [PRD-506](PRD-506-n05b-three-imports-bind-natively-and-callbacks-are-reclaimed.md) join once they exist

## Context

§8.4 requires the corpus on Linux x64 **and** Android arm64 early: an LLVM target triple does not
establish a working runtime, linker, standard library, ABI or packaging path. §18 lists "device
path differs from desktop" as a stop risk. The repository already builds the native host for
Android through the NDK and Gradle (`packages/runtime-native/android/`, build tree
`packages/runtime-native/build/tn-android`) and packages 16 KB-aligned libraries
(`pnpm native:verify:android:artifact`). The compiler's GC runtime (Boehm, PRD-505 decision) must
link into that same shape.

## Solution

1. Cross-compile each corpus case for `aarch64-linux-android` with the pinned toolchain plus the
   repository's pinned NDK; link the compiler's runtime and GC statically into one `.so` per case.
2. Run each case two ways: as a standalone executable pushed with `adb` (fast loop), and loaded by
   a minimal Android activity from the existing host's packaging path (the real shape).
3. 16 KB page alignment is checked on every produced library with the existing verifier.
4. Same expected stdout files as Linux x64 — no Android-specific expectations.

## Out of scope

- Strict game APK packaging and artifact manifests — [PRD-530 (N17)](../PRD-530-n17-strict-native-typescript-game-packaging.md).
- Device performance claims — [PRD-533 (N20)](../PRD-533-n20-platform-qualification-performance-default-promotion.md).

## Execution Phases

#### Phase 1: Cross-compile and link
**Status:** NOT STARTED
**Files:** proposed `tools/native-typescript/targets/android-arm64.json`
- [ ] Every corpus case links for `aarch64-linux-android` with the pinned NDK and GC runtime. proof: `node tools/native-typescript/run-corpus.mjs --native --target aarch64-linux-android --build-only`
- [ ] Every produced library passes 16 KB alignment. proof: `node packages/runtime-native/scripts/check-android-16kb-alignment.mjs <corpus-out>/android`

#### Phase 2: Run on the emulator
**Status:** NOT STARTED
**Files:** proposed `tools/native-typescript/run-corpus.mjs` (adb runner)
- [ ] Every case's stdout and exit code on an arm64 Android emulator match the Linux reference. proof: `node tools/native-typescript/run-corpus.mjs --native --target aarch64-linux-android --adb <emulator-serial>`
- [ ] The `three-fixture` case runs inside the host's packaged activity, not only as a pushed executable. proof: `node tools/native-typescript/run-corpus.mjs --native --target aarch64-linux-android --case three-fixture --packaged`

## Blocked on

- Physical arm64 confirmation of the same run (§2.3 names physical Android hardware as a primary target) — João attaches the Pixel 8.
