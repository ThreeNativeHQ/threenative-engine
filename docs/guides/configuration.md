# Configure and ship your game

Set your game's name, icon, display and renderer options, then build and check a desktop release.

## Project config

`threenative.config.ts` exports an `IThreeNativeConfig`, so your editor completes and type-checks
it. The game reads renderer and display settings through `render: config.renderer` and
`display: config.display`. These are the main fields from the generated file:

```ts
import type { IThreeNativeConfig } from "@threenative/core";

const config: IThreeNativeConfig = {
  app: {
    id: "com.example.myGame", name: "My Game",
    version: "1.0.0", build: 1, icon: "public/icon.png",
  },
  display: {
    orientation: "landscape", fullscreen: true,
    keepScreenOn: true, maxFps: 60,
  },
  window: {
    title: "My Game", width: 1280, height: 720, resizable: true,
  },
  bootSplash: { backgroundColor: "#0d1b2a" },
  nativeEntry: "src/game.ts",
  ui: { renderer: "native" }, // in-scene HUD, like the minimal template
  renderer: {
    preferWebGPU: true, resolutionScale: "auto", alphaAntialiasing: true,
  },
};
export default config;
```

`maxFps` defaults to 60, and `resolutionScale` defaults to `"auto"`: the engine scales the 3D
drawing buffer to hold that frame rate. A number in (0, 1] pins the scale instead. `ui.renderer`
is `"native"` for an in-scene HUD or `"web"` for a web UI overlay.

## Branding

| Setting or file | What it changes | Where to check |
| --- | --- | --- |
| `app.id`, `app.name`, `app.version`, `app.build` | App identity and version. | The installed app and package info. |
| `app.icon`, `app.icons`, `public/` | App icons and the browser favicon. | Launcher, file manager and browser tab. |
| `window` | Desktop window title and starting size. | The running desktop game. |
| `display` | Orientation, frame-rate cap and screen behavior. | The target device. |
| `bootSplash` | The launch background color. | The first frames of a native launch. |
| `src/render/loading.ts` | The in-game loading screen. | A launch with uncached assets. |
| `nativeEntry`, `ui` | The shared game entry and UI type. | The web or native build. |

`app.id` is a reverse-DNS identity, such as `com.example.myGame`. The scaffold's `public/icon.png`
is the engine default. Replace it before you ship.

## Doctor

Run doctor with the target and mode you plan to build. It checks the project and required tools
and names what to fix. It never edits your files.

```sh
pnpm exec threenative doctor --text --target web
pnpm exec threenative doctor --text --target desktop --mode release
pnpm typecheck
pnpm build:web
```

Doctor also reports whether each MCP server starts, whether Blender is installed and whether a
model conversion is on record. Keep all `@threenative` packages at the versions the template
generated. Doctor flags mismatches.

## Desktop release

Release mode packages the executable, the UI and required non-system libraries for your operating
system. Set up platform signing, then extract or install the package in a separate directory.

```sh
pnpm exec threenative build --target desktop --mode release

# Replace the placeholder with the extracted release directory.
node node_modules/@threenative/runtime-native/scripts/verify-starter-desktop.mjs \
  --container <unpacked-directory> \
  --config .threenative/build/config.json
```

The verifier checks the packaged files. With `--config`, it also compares the app name, embedded
icon and loading sequence against your config. It refuses a package that still carries the engine's
default icon.

ThreeNative targets web, Windows, macOS, Linux and Android. iOS is not a supported target yet. See
[Native runtime](native-runtime.md) for platform tools and UI requirements.

## Release checklist

Run the same checks for every release candidate and keep the results with the build.

1. Run `pnpm typecheck`, doctor for the target and the build command.
2. Extract or install the package outside the project, in a path that contains spaces.
3. Check the app name, icon, packaged files, platform libraries and signing.
4. Run playtests for movement, loading, pause and resume, and error handling.
5. Record package versions, platform, device, renderer and source revision with the result.

## Source

- [minimal template config](../../packages/create-threenative/templates/minimal/threenative.config.ts)
- [config.ts](../../packages/core/src/config.ts)
- [create-threenative README](../../packages/create-threenative/README.md)
- [runtime-native README](../../packages/runtime-native/README.md)
