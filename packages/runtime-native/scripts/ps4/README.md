# Deploy a game to PS4

One command takes a game project to a PS4. Run it from the repository root.

```sh
pnpm ps4 <game dir>                 # build, preview in the emulator, write the fake PKG
pnpm ps4 <game dir> --console <ip>  # the same, then upload the PKG to a jailbroken console
```

`<game dir>` is a game project with `src/game.ts` (a missing file fails in under a second).

## What the command does

1. `run-experiment.mjs deps` fetches the pinned OpenOrbis toolchain and the shadPS4 emulator.
2. `send-to-console.mjs --build-only` builds the PS4 Vulkan driver (`e2-build.sh`, only when its archives are missing), stages the prebuilts, configures the `tn-ps4` CMake tree, links the player SELF (`e5-build.sh`), bundles the game, and writes the fake PKG.
3. `run-experiment.mjs deploy` boots that same app folder in shadPS4 under a private Xvfb display. It passes when the player presents 300 frames and a captured frame shows drawn pixels. A static start screen passes. A black screen or a frame with only the clear color fails. `--no-preview` skips this step.
4. With `--console`, `send-to-console.mjs --prebuilt` uploads the PKG with `curl` to the console's GoldHEN FTP server (port 2121, folder `/data/pkg`). A failed preview stops the upload.

The command prints the PKG path. The one console-side step: Settings > Debug Settings > Game > Package Installer, install the package, then launch the game.

## Identity

A package installs under its `CONTENT_ID`. The `TITLE_ID` (`TNPS` plus five digits) and `CONTENT_ID` come from a hash of the game folder name, so two games with different folder names install side by side. Rename the folder to change the id.

## Options and environment

- `--out <dir>` sets the build folder (default `$TN_PS4_E5_DIR`, else `~/.cache/tmp-tn/prd784/e5`). Packages go to `<out>/pkg`.
- `--icon <png>` sets a 512x512 24-bit `sce_sys/icon0.png`. The default is the toolchain sample.
- `--jobs N` sets the build parallelism.
- `TN_PS4_E2_DIR` sets the driver build folder. `TN_PS4_SCREENSHOT_AT=40,50` sets the preview capture times in seconds (default 30,45). `TN_PS4_HOST_HZ=0` runs plain Xvfb without gamescope.

## Needs

- The built V8 and Dawn prebuilts from `e4-build.sh` and `e3-build.sh` (`ps4-deps.sh` names the recipe when they are missing).
- `curl`, `clang`, `ld.lld`, `cmake`, `ninja`, ImageMagick (`import`, `convert`), Xvfb, and Rust with the `x86_64-unknown-linux-musl` target.
- A jailbroken console with GoldHEN for `--console`. Only a local FTP server has been tested, not a real console.

## Self-checks

```sh
node packages/runtime-native/scripts/ps4/ps4.mjs --self-check
node packages/runtime-native/scripts/ps4/send-to-console.mjs --self-check
node packages/runtime-native/scripts/ps4/run-experiment.mjs --self-check
```
