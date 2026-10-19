# Build for desktop and Android

Run the same `src/game.ts` on Windows, macOS, Linux and Android, then package and verify a release
players can install.

## Platform support

`@threenative/runtime-native` is a native host for your game entry. It draws the Three.js scene
with its own renderer, not inside a WebView. ThreeNative is alpha and all packages are `0.x`. Keep
the `@threenative` package versions in step with each other.

| Platform | Renderer | Status |
| --- | --- | --- |
| Web | WebGPU, WebGL2 fallback | Supported |
| Windows, macOS, Linux | Native host | Supported |
| Android | Native host | Supported |
| iOS | None | Not supported |

## Build for desktop

The `minimal` template sets `nativeEntry: "src/game.ts"` in `threenative.config.ts` and ships a
desktop build script. Native builds bundle that entry as the game's single native module.

```sh
pnpm create threenative my-game --template minimal
cd my-game
pnpm install
pnpm exec threenative doctor --text --target desktop
pnpm build:desktop
```

Doctor reports the missing tools for the target you name. You can keep developing in the browser
and add native tools later. Build and test on each desktop OS you ship.

## Build for Android

```sh
pnpm exec threenative doctor --text --target android
pnpm build:android
```

The build downloads prebuilt runtime files for your installed package version. It reads them from
the release's `prebuilt-lock.json` and checks each SHA-256. You need the Android SDK and a JDK. You
do not need an NDK or CMake.

If you work offline or keep the files locally, set `THREENATIVE_PREBUILT_MANIFEST` to a local
`prebuilt-lock.json`. The checksum checks still run.

`build:android` makes a debug APK. A release build needs your signing key and refuses to fall back
to a debug key:

```sh
pnpm exec threenative build --target android --mode release --format apk
pnpm exec threenative build --target android --mode release --format aab
```

Supply the key through `ORG_GRADLE_PROJECT_threenativeKeystore`,
`ORG_GRADLE_PROJECT_threenativeKeystoreAlias`, `ORG_GRADLE_PROJECT_threenativeKeystorePassword` and
`ORG_GRADLE_PROJECT_threenativeKeyPassword`.

Check textures and sound on the device. Android has no Basis transcoder or Meshopt decoder. See
[Assets](assets.md) and [Audio](audio.md) for the formats it loads.

## Choose the UI renderer

`ui.renderer` in `threenative.config.ts` picks how menus and HUD draw on native targets.

| Setting | Template | How the UI draws |
| --- | --- | --- |
| `ui: { renderer: "native" }` | `minimal` | In the 3D scene. No `src/ui/`. |
| `ui: { renderer: "web" }` | `starter` | `src/ui/` in a WebUI overlay above the native renderer. |
| `ui: { renderer: "native-css" }` | — | `src/ui/` in the game's own JS realm, painted by a native CSS engine. Desktop only, experimental. |

`"native-css"` is opt-in and experimental, and **Linux desktop only in this release** — the build
admits no other platform. It runs the same React tree with the same Tailwind/CSS — no WebView and
no second process — and takes its stylesheet from the same Vite build as `"web"`, so
`src/ui/main.tsx` is still the web bootstrap and still imports your stylesheet; the game's native
entry mounts the tree with `createCssUiRoot().render(<App />)` from `@threenative/core/react-css`.
Android and iOS refuse the value by name (`TN_UI_RENDERER_UNSUPPORTED`) rather than falling back
to a web view.
What it paints, what it does not, and what fails the build is in
[native-css-support.md](native-css-support.md).

Three limits come with it. The host must be **built from source** with `TN_ENABLE_CSS_UI=1`: the
published prebuilt host has no CSS backend, and desktop packaging refuses one by name
(`TN_CSS_UI_HOST_MISSING`). Text uses the **system fonts** only — no bundled webfont. And it ships
**stylesheets only**: a stylesheet whose `url()` names a font or an image rather than a `data:` URI
or a `#fragment` is refused (`TN_CSS_UI_ASSET_UNSUPPORTED`), because the native engine has no asset
pipeline to resolve it through.

The WebUI overlay talks to the game through state updates and action messages. Test keyboard
focus, touch, pause and resume in the UI mode you ship.

## Package a desktop release

```sh
pnpm exec threenative build --target desktop --mode release
```

Release mode wraps the executable, the `ui/` bundle and the non-system libraries it loads into one
relocatable container:

| OS | Output |
| --- | --- |
| Linux | `tar.gz` with `lib/` and a `.desktop` entry |
| macOS | `<Name>.app` inside a ZIP |
| Windows | Portable ZIP and a `*-setup.exe` installer |

Each container carries `threenative-container.json`, which lists every file with its SHA-256.
Packaging on Windows needs `zip`, NSIS 3, `rcedit` and `dumpbin`. A missing tool stops the build
with `TN_DESKTOP_ARCHIVE_TOOL_MISSING` or `TN_DESKTOP_RESOURCE_TOOL_MISSING`.

The container does not ship the web view or windowing stack. The player's machine provides them:

| OS | Player prerequisite |
| --- | --- |
| Linux | WebKitGTK 4.1 and GTK 3 |
| Windows | WebView2 Evergreen Runtime, when WebUI is selected. The installer adds it if missing. |
| macOS | System WebKit, included with macOS |

Extract the container, then verify it:

```sh
node node_modules/@threenative/runtime-native/scripts/verify-starter-desktop.mjs \
  --container <unpacked-directory> \
  --config .threenative/build/config.json
```

The verifier checks file integrity. On Linux it also checks that the player prerequisites resolve.
With `--config` it compares the app name, icon and loading sequence against your project. It
refuses a container that still carries the engine's default icon.

Desktop containers are unsigned unless you configure signing, for example with
`THREENATIVE_DESKTOP_SIGN=1` and the matching identity variables. See
[RELEASE-SIGNING.md](../RELEASE-SIGNING.md). Run your [playtests](playtesting.md) against the
extracted build before you ship.

## Build the runtime from source

If you change the native runtime itself, set `THREENATIVE_RUNTIME_SOURCE` to
`packages/runtime-native` in a full engine checkout. The packager needs `CMakeLists.txt` and the dependencies that
`node scripts/download-deps.mjs` stages in that checkout. An installed npm package has neither.
This variable does not fix a failing download. For that, check the installed version, the manifest
and the network error.

## Source

- [runtime-native README](../../packages/runtime-native/README.md)
- [minimal template config](../../packages/create-threenative/templates/minimal/threenative.config.ts)
- [create-threenative README](../../packages/create-threenative/README.md)
