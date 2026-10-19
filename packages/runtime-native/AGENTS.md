# AGENTS.md — @threenative/runtime-native

Read `/AGENTS.md` first. This file covers only what is different here. This package is the
native half of the "web and native are one codebase" rule stated there.

## Product contract

A native-first Three.js games runtime that ships no Chromium, and is not Electron or a Tauri app.
It is **a host, not a renderer**: upstream Three.js `WebGPURenderer` stays the primary
renderer, at exactly the workspace catalog version.

**The scene never enters a web view; the UI may.** As of PRD-217 a game can render `src/ui/`
through the platform's own browser-class renderer, so one `src/ui/` runs unchanged on web and native.
Linux runs WebKitGTK on a dedicated thread, takes snapshots into a latest-frame mailbox and blends
them into the game surface before presentation. Its SDL/X11 input route uses GDK events, preserving
native text editing and keyboard layouts. Windows, macOS, Android and iOS use a transparent child
WebView above the game surface. `ui.renderer: "web"` is the default; `ui.renderer: "native"` is the
opt-out and ships no overlay and no extra process. `TnUiOverlay` owns the input hit test; the
contract is in `include/mystral/platform/ui_overlay.h` and `@threenative/core/ui-layer`.

Run `pnpm test:ui-native` from the repository root for Linux WebKit focus, keyboard-layout and
editing regressions. It provisions its own Xvfb and requires Rust, WebKitGTK development files and
`setxkbmap`. This control check does not replace a packaged-game playtest or visible-cadence proof.

Runtime internals may keep Mystral names recognizable during the fork, but public contracts expose
ThreeNative names.

Targets: browser/upstream Three.js, Windows/macOS/Linux V8+Dawn, Android V8+wgpu-native,
iOS JSC+wgpu-native. The JavaScript runtime that owns `THREE.Scene` also owns the renderer —
never mirror the `Object3D` tree across threads. Heavy systems use native/GPU/thread
architectures and batched transfer surfaces.

**Android runs V8 by default as of 2026-08-16 (PRD-130), and `-PthreenativeJsEngine=quickjs` is the
documented rollback.** It was QuickJS while nothing had measured that choice. Measured, on a Pixel 8
at 16 384 moving cubes: QuickJS 101.24 ms per frame against V8's 8.34 ms, and the V8 figure is the
120 Hz vsync interval rather than its real cost, so 12× is a lower bound
(`docs/verification/prd-130-phase-6-2026-08-16.md`). iOS is the one platform still on an engine
without a JIT, by construction.

Three files state that default — `CMakeLists.txt`'s Android platform block,
`android/app/build.gradle.kts`, and the `tn-android` CMake preset — and a test fails if they
disagree. Selecting V8 requires `third_party/v8-android`, which `scripts/download-deps.mjs --android`
provisions with a pinned checksum; the shared STL (`libc++_shared.so`); a startup snapshot staged
**per ABI**, since the blobs differ and an ABI without one fails the build; and pointer-compression
defines that match the prebuilt library rather than the host's preference.

**The prebuilt path carries both engines** as of PRD-130 Phase 4: `android-<abi>-runtime-v8`,
`android-<abi>-v8`, `android-<abi>-libcxx` and `android-<abi>-v8-snapshot` beside the unqualified
QuickJS keys, which still mean QuickJS. The runtime binary is engine-qualified because it genuinely
differs — QuickJS is compiled into it and V8 is not — so one runtime for both engines would report
the wrong engine at runtime. A prebuilt directory populated for one engine and built for the other
fails naming both. **The release lane that publishes these has not run**: no tag was pushed, and this
repository has zero surviving releases across ten tags (PRD-078).

Priority order: correctness → compatibility → platform stability → threading → native systems
→ DX → profiling → optimization.

## Non-goals until evidence says otherwise

No custom C++ renderer, no deep Three.js fork, no native GLTF replacement for the JavaScript
`GLTFLoader` (the deprecated native GLTF files stay disabled, retained only as upstream
history), no mandatory ECS/React/editor/multiplayer, no optimization fast path before
profiling evidence, and no claim for a platform that has not executed.

## The host surface is a contract with the TypeScript side

Every global this runtime installs is something framework code is allowed to use, and
everything else is a native break waiting to happen. `document` and `window` are **Three.js
compatibility stubs** — `body.appendChild` is a no-op, `createElement('canvas')` returns a
fake. Widening that stub to make a web-only feature work is the wrong fix; the fix is in the
TypeScript package.

When you add a shim, say so in the owning gate doc so the other half of the repo can rely on
it. When you remove or narrow one, grep `packages/*/src` first.

The machine-readable inventory is [`shim-manifest.json`](./shim-manifest.json). It records each
global installed by the native host and every deliberate allowlist exception with its reason;
`pnpm budgets` runs the checker against `packages/{core,ui,playtest}/src` so this manifest is the
enforced contract, not a second prose-only list.

Native bundles enter through the project's declared `threenative.nativeEntry` (default
`src/game.ts`), which must default-export the game. `TN_NATIVE_ENTRY_MISSING` and
`TN_NATIVE_ENTRY_NO_DEFAULT` are entry-contract failures; `TN_NATIVE_WEB_ONLY_UI` means the
portable graph reached browser UI; `TN_NATIVE_WASM_ON_MOBILE` means iOS or Android QuickJS reached
WASM, or Rapier/Recast WASM reached Android V8. Do not weaken these guards. Every packager stages the configured asset root (`assets.output`, default `public/`) through
`selectManifestAssets` beside the game bundle, and a missing runtime asset must reject game startup rather than fall back to the network.

**Android V8 admits KTX2 and Meshopt; every other mobile codec stays refused.** The Android
engine is the one `THREENATIVE_GRADLE_ARGS` selects (`-PthreenativeJsEngine`, default `v8`), and
`scripts/bundle.mjs --decoders ktx2,meshopt` keeps those two real loaders (PRD-485, emulator only).
Draco stays a refusing stub on Android. Android QuickJS and iOS JSC have no WASM engine. The desktop build resolves and
hashes its exact package runtime before cooking; QuickJS, JSC and unknown engine probes take the
decoder-free compiler and bundle path. The existing desktop V8 decoder path stays unchanged.
`scripts/bundle.mjs --native-backend` selects the refusing stubs on desktop too. A compiled asset
that needs a missing decoder is refused before packaging with `TN_NATIVE_KTX2_UNSUPPORTED` or
`TN_NATIVE_MESH_COMPRESSION_UNSUPPORTED`, naming the asset and selected runtime. Authored KTX2,
embedded Basis textures and shared KTX2 images are all checked. Native cook-cache keys include
runtime identity and decoder capabilities. iOS artifact resolution and Android Draco qualification
remain open.

## Package boundaries

- `third_party/`, `build/`, `.runtime/` and `artifacts/` stay untracked; a tracked file under
  `third_party/` fails `pnpm budgets`.
- `scripts/download-deps.mjs` is the only supported dependency reconstruction path.
- Native compilation is opt-in via `pnpm native:build`. The default repository gate must not
  require CMake, an NDK, or Xcode.
- A native runtime tree anywhere but this package is a hard budget failure.

## Gates and evidence

`docs/G1-desktop-host.md` … `G5-profiling.md` are the evidence record. Update the affected
file whenever a native run changes a gate — a gate result that lives only in a commit message
does not exist.

```sh
pnpm native:build                             # download deps + compile
pnpm native:verify:desktop                    # 300 frames, markers, non-blank screenshot
node conformance/run-conformance.mjs          # same scene, browser reference vs native
```

`conformance/registry.json` is the versioned public test registry: a row that was not
selected by `--only-tests` is reported **blocked**, never passed and never omitted. Keep it
that way.

Report what ran, per platform, and never write mobile-ready while a row below is open.

- **Desktop** — green.
- **iOS simulator** — green on the hosted `macos-15` runner; `verify-ios-simulator.mjs` pins a
  `SimRuntime.iOS-*` device because before 2026-08-11 it silently selected an Apple Vision Pro.
- **Android on a physical phone** — executed: PRD-130's engine comparison and later render work were
  measured on hardware, not only on an emulator.
- **Android emulator** — a separate result from the phone, and the two have disagreed. A green on
  one does not carry to the other; say which you ran.
- **iOS on physical hardware** — outside CI qualification. If tested separately, report arm64
  Metal, signing, touch input, thermal and battery evidence as device-only results.
- **Android 16 KB pages** — green on the local 16 KB AVD as of 2026-09-11. Android 15+ can run with
  16 KB memory pages, where a 4 KB-aligned shared library cannot be loaded at all. Everything this
  repository controls is aligned — `libmystral-runtime.so` by a link option, `libSDL3.so` by the
  3.2.30 pin, and `libv8android.so` by the `kMinimumOSPageSize` source patch in
  `scripts/build-android-v8.mjs` (recipe 6), which `download-deps.mjs --android` provisions. A
  recipe-6 payload boots V8 11.0.226.16 and presents frames on `threenative_ps16k`.
  `-PthreenativeJsEngine=quickjs` ships no V8 at all.

## Device lanes, before you record one as unavailable

**Confirm which package you are about to launch.** A game's applicationId comes from its
`threenative.config.ts` (`app.id`), not from its directory name, and a device that has been used for
this work usually carries several ThreeNative installs — conformance harnesses, first-proof builds
and real games, each under its own package. Launching the wrong one does not fail: it renders a
plausible scene at a plausible frame rate and answers a question you did not ask. Read `app.id`, or
`aapt dump badging` the APK you just built, before `am start`; and after installing, verify the APK
actually carries your change (`strings` the packaged `.so` for a native marker, grep the staged
bundle for a JS one) rather than trusting that the build recompiled.

`adb` and the Android SDK are frequently installed but off `PATH`; export `ANDROID_HOME` and call
the SDK's `platform-tools/adb` directly before concluding a device lane cannot run here. Wi-Fi ADB
(`adb tcpip 5555`) is how a device stays **discharging** while you drive it, which the benchmark
preflight requires — a cable makes the run fail its own gate. Gradle and Kotlin want **JDK 17**;
newer JDKs abort with an `IllegalArgumentException` naming the version, which reads like a code
error and is not one. And confirm the app is in the foreground before `adb shell screencap`: a blind
capture returns whatever the owner has on screen.
