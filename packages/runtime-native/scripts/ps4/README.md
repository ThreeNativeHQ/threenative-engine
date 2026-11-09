# Deploy a game to PS4

One command takes a game project to a PS4. Run it from the repository root.

```sh
pnpm ps4 <game dir> --usb <mount dir>  # build, preview, write the PKG, copy it to a USB stick and verify it
pnpm ps4 <game dir>                    # the same without a copy: prints the PKG path and the USB steps
pnpm ps4 <game dir> --console <ip>     # the same, then upload the PKG to a jailbroken console over FTP
```

`<game dir>` is a game project with `src/game.ts` (a missing file fails in under a second).

## What the command does

1. `run-experiment.mjs deps` fetches the pinned OpenOrbis toolchain and the shadPS4 emulator.
2. `send-to-console.mjs --build-only` builds the PS4 Vulkan driver (`e2-build.sh`, only when its archives are missing), stages the prebuilts, configures the `tn-ps4` CMake tree, links the player SELF (`e5-build.sh`), bundles the game, and writes the fake PKG.
3. `run-experiment.mjs deploy` boots that same app folder in shadPS4 under a private Xvfb display. It passes when the player presents 300 frames and a captured frame shows drawn pixels. A static start screen passes. A black screen or a frame with only the clear color fails. `--no-preview` skips this step.
4. With `--usb`, the PKG is copied to the stick. With `--console`, `send-to-console.mjs --prebuilt` uploads it with `curl` to the console's GoldHEN FTP server (port 2121, folder `/data/pkg`), then the console-side step is the same Package Installer. A failed preview stops both.

## The USB route (primary)

`--usb <mount dir>` runs after the preview passes. It copies the PKG to the root of the mount, compares sha256 of the copy with the original, runs `sync`, and prints the console steps. The mount dir must exist and be writable (checked before any build, so a wrong path fails in under a second). The PS4 reads only FAT32 and exFAT: the command reads the filesystem with `findmnt` and warns for anything else, and for a package over 4 GiB on FAT32.

On the console:

1. Plug the stick into a USB port.
2. Settings > Debug Settings > Game > Package Installer > USB, then pick the package file.
3. When the install ends, launch the game from the home screen.

Tested against a plain temp dir only (a loop-mounted FAT32 or exFAT image needs root here). A real stick on a real console is unverified.

## Identity

A package installs under its `CONTENT_ID`. The `TITLE_ID` (`TNPS` plus five digits) and `CONTENT_ID` come from a hash of the game folder name, so two games with different folder names install side by side. Rename the folder to change the id.

## Options and environment

- Models: the cook writes `EXT_meshopt_compression`, so the build stages meshopt sources (`download-deps.mjs --only meshopt`) and configures the tree with them, or stops with a message naming the missing sources.
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
