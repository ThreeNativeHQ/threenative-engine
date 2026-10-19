# ThreeNative Runtime — Android Build

## Prerequisites

1. **Android Studio** (or command-line SDK tools)
2. **Android NDK** r25 or later
3. **CMake** 3.22.1+
4. **ThreeNative runtime dependencies** downloaded

## Download Dependencies

```bash
# From the repository root
cd packages/runtime-native

# Download Android-specific dependencies
node scripts/download-deps.mjs --android

# Also need the shared header-only and JavaScript-engine dependencies
node scripts/download-deps.mjs --only stb
node scripts/download-deps.mjs --only quickjs
```

This downloads:
- `wgpu-android` - WebGPU implementation (aarch64, x86_64)
- `sdl3-android` - SDL3 Android development package

## Build with Android Studio

1. Open the `android/` folder in Android Studio
2. Let Gradle sync (will download Android SDK components)
3. Build > Make Project

## Build from Command Line

```bash
# From the repository root. The gate discovers adb, Android SDK, and JDK 17.
node packages/runtime-native/scripts/verify-android-first-proof.mjs
```

The gate performs the complete first-proof sequence:

1. Builds the debug APK from the public-API `examples/native-smoke` bundle at catalog Three.js 0.185.1.
2. Installs and launches `com.threenative.game/com.threenative.runtime.MystralActivity` on the only online device.
3. Captures app logcat to `artifacts/android/first-proof-logcat.txt`.
4. Requires ordered ready, first-frame, and 300-frame markers plus a live 3-second stability window.
5. Rejects JS/WebGPU failures and always captures a screenshot with dimensions and SHA-256.

When more than one device is online, select one explicitly:

```bash
node packages/runtime-native/scripts/verify-android-first-proof.mjs --device emulator-5554
```

The gate checks `THREENATIVE_ADB`, `THREENATIVE_ANDROID_SDK`, and
`THREENATIVE_JAVA_HOME` before standard SDK/JDK locations. The default screenshot is
`artifacts/android/first-proof.png`; override its path with:

```bash
node packages/runtime-native/scripts/verify-android-first-proof.mjs \
  --screenshot artifacts/android/first-proof.png
```

For a manual Gradle-only build:

```bash
cd android

# Debug build
bash ./gradlew assembleDebug

# Release build
bash ./gradlew assembleRelease

# Install on connected device
bash ./gradlew installDebug
```

## Architecture Support

| ABI | Description | Notes |
|-----|-------------|-------|
| `arm64-v8a` | ARM64 (most devices) | Primary target |
| `x86_64` | Intel/AMD 64-bit | Emulator support |

## Project Structure

```mermaid
flowchart TD
    android["android/"]
    app["app/"]
    appGradle["build.gradle.kts<br/>App build config with NDK/CMake settings"]
    proguard["proguard-rules.pro<br/>ProGuard config"]
    srcMain["src/main/"]
    manifest["AndroidManifest.xml"]
    java["java/com/mystral/engine/"]
    activity["MystralActivity.java<br/>SDL Activity subclass"]
    res["res/"]
    values["values/"]
    strings["strings.xml"]
    themes["themes.xml"]
    rootGradle["build.gradle.kts<br/>Root build file"]
    properties["gradle.properties<br/>Gradle/NDK settings"]
    settings["settings.gradle.kts<br/>Project settings"]

    android --> app
    app --> appGradle
    app --> proguard
    app --> srcMain
    srcMain --> manifest
    srcMain --> java --> activity
    srcMain --> res --> values
    values --> strings
    values --> themes
    android --> rootGradle
    android --> properties
    android --> settings
```

## How It Works

1. **SDLActivity** handles the Android lifecycle and creates a native window
2. **wgpu-native** creates a Vulkan surface from the ANativeWindow
3. **QuickJS** runs the JavaScript game code
4. **SDL3** provides input (touch, gamepad) and audio

## Loading Scripts

Scripts can be loaded from:
- **Assets**: `asset://scripts/main.js`
- **Internal storage**: `/data/data/com.threenative.game/files/game.js`
- **External URL**: `https://example.com/game.js` (requires INTERNET permission)

## Debugging

```bash
# View native logs
adb logcat -s Mystral SDL

# View all logs from app
adb logcat --pid=$(adb shell pidof com.threenative.game)
```

A native crash on Android leaves a tombstone in `adb shell dumpsys dropbox --print
data_app_native_crash`, because the host installs no signal handlers there (PRD-210). The APK
carries a stripped `libmystral-runtime.so`, so the tombstone names functions but not lines. A debug
build keeps the unstripped copy beside it. Pass that directory to `ndk-stack`:

```bash
adb logcat -d | "$ANDROID_HOME"/ndk/<version>/ndk-stack \
  -sym app/build/intermediates/merged_native_libs/debug/mergeDebugNativeLibs/out/lib/<abi>
```

Run the gate's emulator-free unit coverage with:

```bash
pnpm --filter @threenative/runtime-native exec vitest run --config vitest.config.ts \
  tests/android-first-proof-gate.test.mjs tests/runtime-next-contract.test.mjs
```

## Known Issues

1. **Vulkan 1.1 required** - Devices must support Vulkan 1.1 (Android 7.0+)
2. **No Canvas 2D yet** - Skia Android builds not integrated
3. **HTTP uses curl** - Should migrate to Java HttpURLConnection for better Android integration
