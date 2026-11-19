# @threenative/runtime-native

## What it is

`@threenative/runtime-native` is the optional ThreeNative host for running the same portable game
entry on desktop (Windows, macOS, Linux) and Android. iOS is not a supported target yet. Native compilation is opt-in: installing this package does
not require CMake, an NDK, or Xcode. It is a host, not a second renderer or scene API; upstream
Three.js and the game's `src/game.ts` remain the portable runtime contract.

## Install

Add the optional native host when you want native builds:

```sh
pnpm add @threenative/runtime-native
```

## Example

The `minimal` template ships the native build command:

```sh
pnpm create threenative my-game --template minimal
cd my-game
pnpm install
pnpm build:desktop
```

The template's `threenative.config.ts` uses `nativeEntry: "src/game.ts"`; native builds read that
portable entry and bundle it as the game's single native module.

## Where the native binaries come from

An installed copy of this package contains no C++ and no build system, and **installing it downloads
nothing**. The first native build fetches what that build needs and verifies it against the SHA-256
recorded in the release's `prebuilt-lock.json`:

| Command | Downloads |
| --- | --- |
| `build --target web`, `dev`, `test` | nothing — the Wasm engine is a file in this npm package (`build/web/`), so it arrives with the registry tarball |
| `build --target desktop` (default engine) | the engine player, about 118 MiB, once per install |
| `build --target desktop` (`engine: "threejs"`) | the legacy runtime and its build tool helper, about 260 MiB, once per install |
| `build --target android` / `ios` | that platform's libraries, at package time |

A verified download is reused with no network, so a second build is offline. Only an Android SDK
and a JDK are needed for Android, and nothing is compiled on your machine.

To fetch ahead of a build (an offline image, a slow link), run the downloader by hand — it is no
longer an install hook:

```sh
node node_modules/@threenative/runtime-native/scripts/install-prebuilt.mjs
```

When a download fails, the error names the asset, the version, the URL and three fixes. Offline,
set `THREENATIVE_ENGINE_PLAYER` (default engine) or `THREENATIVE_RUNTIME_BINARY` (`engine: "threejs"`)
to a local binary.

Two environment variables change where those artifacts come from.

### `THREENATIVE_PREBUILT_MANIFEST`

Points at a local `prebuilt-lock.json` instead of the release URL. Use it to build against
artifacts you already have, or offline. Checksums are still verified, and a manifest missing an
asset still fails by name — it redirects the lookup, it does not relax it.

### `THREENATIVE_RUNTIME_SOURCE` — needs a full engine checkout, not an installed package

Points the packager at a **source checkout** of `packages/runtime-native` from the ThreeNative
repository, so it compiles rather than downloading. It cannot be pointed at an installed copy of
this package, and pointing it at one will not work: the packager only takes the source path when it
finds both `CMakeLists.txt` and a staged `third_party/sdl3-android/SDL3-3.2.8.aar`, and a published
tarball ships neither. The `third_party/` tree is populated by `node scripts/download-deps.mjs`
inside that checkout.

If you have no engine checkout, the prebuilt path above is your path — `THREENATIVE_RUNTIME_SOURCE`
is not a way around a failing download.

## Desktop release containers and player prerequisites

`build --target desktop` produces the raw host executable by default. `--mode release` wraps the
compiled executable, the built `ui/` bundle and the shared libraries that executable actually loads
into one relocatable container for the host OS:

```sh
pnpm exec threenative build --target desktop --mode release
```

- **Linux** — a `tar.gz` with the executable, `ui/`, non-system libraries under `lib/`, and a
  `.desktop` entry plus icon under `share/`.
- **macOS** — a `<Name>.app` inside a ZIP, with `Contents/MacOS/<exe>`, `Contents/Resources` and an
  `Info.plist` carrying the game's id, name, version and build.
- **Windows** — a portable ZIP and a `*-setup.exe` installer, both carrying `<Name>.exe` (icon and
  version embedded), `ui/` and non-system DLLs. Setup installs per user, creates a Start Menu
  shortcut and registers an uninstaller in Windows Settings. Upgrades remove obsolete owned files;
  uninstall preserves unrelated files. Uninstall the existing copy before choosing another directory.

Each container carries `threenative-container.json`: the app identity, the executable, every
bundled dependency with a SHA-256, and every system library recorded as a player prerequisite. All
of it resolves relative to the container root, so a container can be unpacked and moved anywhere; a
resource that is missing or whose bytes changed is refused. Release containers are unsigned unless
signing is configured. Signed macOS apps seal their manifest and executable with the application
signature; verification checks that signature as well as the resource hashes.

### Player prerequisites

The container does not ship the platform's WebView or windowing stack. The player machine provides:

| OS | Prerequisite | Install |
| --- | --- | --- |
| Linux | WebKitGTK 4.1 and GTK 3 | Debian/Ubuntu: `sudo apt-get install -y libwebkit2gtk-4.1-0 libgtk-3-0`; Fedora: `sudo dnf install webkit2gtk4.1 gtk3`; Arch: `sudo pacman -S webkit2gtk-4.1 gtk3` |
| Windows | Microsoft Edge WebView2 Evergreen Runtime, when WebUI is selected | Setup checks for it and installs it if missing (internet required); portable ZIP users install it from <https://developer.microsoft.com/microsoft-edge/webview2/> |
| macOS | System WebKit | included with macOS |

The verifier inspects an unpacked container and resolves its integrity records first. On Linux it
also resolves every shared library the executable loads and refuses to launch when a recorded
prerequisite is missing, naming the library with its install step rather than a bare loader error.
On Windows the installer checks WebView2 before installing the game; the portable ZIP verifier does
not check it. macOS includes the system WebKit used by the overlay.

```sh
node node_modules/@threenative/runtime-native/scripts/verify-starter-desktop.mjs --container <unpacked-directory>
```

### Packaging prerequisites (the developer's machine)

`--mode release` shells out to OS tools to build the container and stamp the game's identity into
it. They are needed on the machine that packages the game, never on the player's:

| OS | Tool | Needed for | Install |
| --- | --- | --- | --- |
| Linux | `tar` | the `tar.gz` container | included with the distribution |
| macOS | `zip` | the `.zip` container | included with macOS |
| macOS | `sips`, `iconutil` | converting `app.icon` into the `.icns` the `.app` bundle carries | included with macOS |
| Windows | `zip` | the `.zip` container | `choco install zip` |
| Windows | NSIS 3 (`makensis`) | the `*-setup.exe` installer | `choco install nsis --version=3.11.0`; the packager also finds the standard Program Files installation |
| Windows | `rcedit` | embedding `app.icon` and the version strings into the executable's PE resources | <https://github.com/electron/rcedit/releases>, with `rcedit.exe` on `PATH` |
| Windows | `dumpbin` | listing the DLLs the executable imports, so the container records them and stays relocatable | ships with Visual Studio; run the release build from a Developer Command Prompt |

A missing tool refuses the release with `TN_DESKTOP_ARCHIVE_TOOL_MISSING` or
`TN_DESKTOP_RESOURCE_TOOL_MISSING` naming the tool, rather than shipping a container without the
identity it claims. NSIS failures report `TN_WINDOWS_INSTALLER_FAILED`. The icon tools are required
only when `app.icon` is configured. Windows WebUI packaging downloads Microsoft's signed WebView2
bootstrapper and verifies its Authenticode signature before embedding it; this build needs internet.

### Standard distribution recipe

1. Build: `pnpm exec threenative build --target desktop --mode release`.
2. Verify the extracted container from the installed project:
   `node node_modules/@threenative/runtime-native/scripts/verify-starter-desktop.mjs --container <unpacked-directory> --config <project>/.threenative/build/config.json`.
   `--config` points the verifier at the resolved consumer config the build already wrote, and the
   container's launcher name, embedded icon and declared loading sequence are then inspected before
   anything launches — on Windows by reading the executable's own `RT_GROUP_ICON`/`RT_ICON` and
   `RT_VERSION` resources, not the manifest beside it. Without `--config` the gate says
   `brand NOT inspected` rather than implying the identity was checked.
3. Configure signing before building where required (below), then distribute the installer or archive.

Run your game's input and gameplay assertions against the extracted executable on Linux, macOS or
Windows with the installed runner:

```sh
node node_modules/@threenative/playtest/dist/runner/cli.js playtests/production-readiness.playtest.json --target desktop --executable <unpacked-executable> --project . --host-arg --windowed
```

For macOS, the executable is inside `<game>.app/Contents/MacOS/`. These verification commands need
Node; launching the packaged game itself does not. CI also runs React pause/resume and movement
assertions against the relocated macOS release and the installed Windows release.

On Windows, test the actual installer with a scenario from your game:

```sh
node node_modules/@threenative/runtime-native/scripts/verify-windows-installer.mjs --installer dist-native/my-game-setup.exe --project . --scenario scenarios/production-readiness.playtest.json
```

This command installs into a temporary directory containing spaces, checks the installed manifest,
runs the existing playtest runner against that exact executable, and uninstalls it. Signed builds
also require `signtool` to verify the setup, game and uninstaller signatures. Every packaged file
must be removed. Runtime-created files are preserved and their paths and retained directory are
printed; directory links are listed without traversal. Failures also retain the temporary directory
and print its path. In this repository, use `pnpm native:verify:windows:installer`
with the same arguments. Add `--require-signed` to reject an unsigned release explicitly.

### Measure visible React UI latency

From this engine checkout on Linux, use an installed game's dependencies and a built native host:

```sh
pnpm native:verify:ui --project /absolute/path/to/game --runtime packages/runtime-native/build/tn-linux/mystral
```

The command builds a small 60 FPS React fixture with the installed CLI's release command, extracts
the final archive into a new location, checks its integrity, and captures its visible state IDs at
240 Hz using Xvfb and FFmpeg. It requires p95 publication-to-visible latency at most 50 ms, at least
50 visible updates in each measured active second, and two idle wake-ups within 67 ms. Capture
delivery delay is included. An attached overlay or fast React commits alone cannot pass this check.
The desktop capture backend qualifies Linux/X11 only; it does not measure a physical monitor's refresh rate.

For Android, select an online 60 Hz emulator or device and provide the same release signing
environment used by `threenative build --target android --mode release`:

```sh
pnpm native:verify:ui --target android --project /absolute/path/to/game --device <serial>
```

This builds, verifies and installs the final signed APK, checks its installed SHA-256, and records
27 seconds through Android's `screenrecord`. Exact visible state IDs are matched to its Winscope v2
timestamps and checked against decoded frame timestamps. The same 50 ms latency and visible-update
bounds apply. This measures captured SurfaceFlinger composition, not physical scanout. At Android's
60 Hz capture rate, unobserved IDs can be sampling misses; they are reported separately from UI drops.
Missing metadata, invalid pixels or inadequate capture cadence fail the command. `--allow-source-build`
explicitly permits the installed builder's source fallback when required native prebuilts are absent.

Results, raw observations, a screenshot and the final archive are retained under
`artifacts/ui-cadence/<timestamp>/`. Use `--artifacts <empty-directory>` to choose the location;
nonempty directories are refused so a failed rerun cannot inherit a passing result. Successful runs
remove their temporary fixture project; failures retain it and print its path. To repeat a packaged
fixture, use `--executable <extracted-fixture-executable>` on desktop, or
`--target android --apk <packaged-fixture.apk> --device <serial>` on Android. These inputs must be the
command's cadence fixture, not an arbitrary game. Both backends require FFmpeg; Android also requires
`ffprobe` and ADB, and Linux requires Xvfb. Allow about 40 seconds on Linux or 60 seconds on Android
after dependencies and the release artifact build.

### Signing and store/depot handoff

A release container is complete but unsigned. Non-secret inputs come from the build environment,
while the private key and the notarytool password stay in the OS keychain and are never written into
the container. Setting `THREENATIVE_DESKTOP_SIGN=1`, or providing an identity, certificate, store subject or
notary profile, requests signing; with none of them, release stays unsigned. A variable set to
an empty or blank value counts as absent, so an unset CI secret leaves an unsigned container
rather than failing the release.

| Variable | Meaning |
| --- | --- |
| `THREENATIVE_DESKTOP_SIGN` | `1`/`true` requests a signed release; macOS/Windows without the matching inputs fail as PENDING. |
| `THREENATIVE_DESKTOP_CODESIGN_IDENTITY` | macOS `codesign` Developer ID identity. |
| `THREENATIVE_DESKTOP_NOTARY_PROFILE` | macOS `notarytool` keychain profile; enables notarization and stapling. |
| `THREENATIVE_DESKTOP_SIGN_CERTIFICATE` | Windows code-signing certificate (`.pfx`), password-less. |
| `THREENATIVE_DESKTOP_SIGN_SUBJECT` | Windows certificate-store subject name; the private key stays in the store. |
| `THREENATIVE_DESKTOP_TIMESTAMP_URL` | Windows Authenticode timestamp server. |

Windows `signtool` signs and verifies the game, setup and embedded uninstaller. Prefer
`THREENATIVE_DESKTOP_SIGN_SUBJECT`: it signs with `/n`, so the private key never leaves the store.
`THREENATIVE_DESKTOP_SIGN_CERTIFICATE` uses `/f` and is passed no password, so it only works for a
password-less `.pfx`. Setting both is refused rather than silently resolved.

**There is deliberately no password variable.** Since the CA/Browser Forum tightened its code-signing
requirements in 2023, a publicly trusted code-signing key has to be generated and held on certified
hardware — a token, an HSM, or a cloud signing service — so a certificate authority does not hand
over a `.pfx` for you to protect with a password in the first place. Adding `/p` would carry a
secret through the build environment to serve a case that modern issuance does not produce. The
store subject is the supported route; the `/f` form remains for a self-signed or internally issued
password-less file.

Two things about `/n` that decide whether a build machine can sign at all. It searches the
**`CurrentUser\My`** store only — a certificate imported into `LocalMachine` is not found, and
signtool reports `No certificates were found that met all the given criteria`. And the subject is
matched as a **substring**, so a value that hits several certificates lets signtool pick among them;
give a subject specific enough to match one. The machine store (`/sm`) and cloud or HSM signing
(`/csp` with `/kc`, or `/dlib` for Azure Trusted Signing and similar) are not reachable through this
contract. macOS `codesign` signs and verifies the
bundle, `notarytool` notarizes the archive and `stapler` staples the ticket; a notarization Apple did
not accept is refused, and an evidence record whose artifact hash is not the produced artifact is
rejected. Linux has no Authenticode or notarization, so it proceeds unsigned with integrity metadata
only and is handed to the package/depot step as-is. A signing failure refuses the release and leaves
no archive, and the manifest records `signed` so an unsigned preparation is never mistaken for a
signed one. These toolchains run only on their own OS: the repository's Linux tests exercise them
through fixture transport, so a real signed or notarized artifact must be produced and verified on a
Windows or macOS host.

## Release builds and signing

`build --target android` produces a debug APK by default. Release output is an explicit request:

```sh
pnpm exec threenative build --target android --mode release --format apk   # signed APK
pnpm exec threenative build --target android --mode release --format aab   # Play app bundle
```

A release is signed with **your** key. There is no debug-key fallback: when signing is not
configured the packager refuses the release rather than shipping an unsigned or debug-signed
artifact. Supply the key as the four Gradle project properties below, from the game's build
environment. Paths are resolved relative to the project; nothing is written into the engine.

| Environment variable | Meaning |
| --- | --- |
| `ORG_GRADLE_PROJECT_threenativeKeystore` | Path to the keystore (`.jks`/`.keystore`). |
| `ORG_GRADLE_PROJECT_threenativeKeystoreAlias` | Key alias inside the keystore. |
| `ORG_GRADLE_PROJECT_threenativeKeystorePassword` | Keystore password. |
| `ORG_GRADLE_PROJECT_threenativeKeyPassword` | Key password. |

Passwords reach signing subprocesses through environment variables, including APK realignment;
they are never placed in command arguments or packaging output. The final APK is verified with `apksigner`, and its packaged `targetSdkVersion`
and non-debuggable state are read back with `aapt`; a release AAB is verified with `jarsigner -strict`.
Missing signatures and unsigned entries fail; Android's self-signed upload certificates are accepted. A
signature, target level or debuggable check that cannot be satisfied fails the build. Native symbols
are stripped from the artifact by the Android Gradle plugin and are produced separately for symbol
archives.

The Android build uses AGP 8.11.1 and Gradle 8.13 for API 36 and 16 KB bundle packaging.
Verify an APK's native libraries and archive offsets from the repository with
`pnpm native:verify:android:artifact /path/to/game.apk`. For an AAB, the same command generates
and inspects a universal APK using Google's [bundletool](https://github.com/google/bundletool/releases):

```sh
pnpm native:verify:android:artifact /path/to/game.aab --bundletool /path/to/bundletool-all.jar
```

Inside an installed game, replace `pnpm native:verify:android:artifact` with
`node node_modules/@threenative/runtime-native/scripts/check-android-16kb-alignment.mjs`.
The AAB stays unchanged; bundletool uses its standard debug key for the temporary inspection APK.
This checks every packaged ABI's ELF alignment and APK offsets; it does not replace installing and
playing the signed release on a 16 KB Android emulator or device.

## Links

- [Repository](https://github.com/ThreeNativeHQ/threenative)
- [MIT License](https://github.com/ThreeNativeHQ/threenative/blob/main/LICENSE)
- Start a project with `pnpm create threenative my-game`.
