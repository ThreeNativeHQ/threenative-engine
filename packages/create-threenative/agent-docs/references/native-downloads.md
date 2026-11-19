# Native binaries arrive at the first native build

PRD-783. `pnpm install` downloads **no** native binary and runs no install script. The web engine
ships as Wasm in the `@threenative/runtime-native` npm package, which the templates already depend
on, so a web game installs from the registry and runs without fetching anything — and a project
that drops that dependency fails the web build with `TN_WASM_ENGINE_MISSING`.

| Command | What it downloads |
| --- | --- |
| `pnpm dev`, `pnpm build`, `threenative build --target web`, `pnpm test` | nothing (the Wasm engine is already in `node_modules`, not downloaded) |
| `pnpm build --target desktop` (default engine) | the engine player, about 118 MiB, once per install |
| `pnpm build --target desktop` (`engine: "threejs"`) | the legacy runtime and its build tool helper, about 260 MiB, once per install |
| `pnpm build --target android` / `ios` | that platform's libraries, at package time |

Every download is checked against the SHA-256 and byte length recorded in the release's
`prebuilt-lock.json`. A verified download is reused with no network, so the second desktop build is
offline.

## When a download fails

The error names the asset, the installed version, the URL and the reason. Three fixes work:

1. Reconnect and rerun the same command — it verifies again from the start.
2. Point the build at a local binary: `THREENATIVE_ENGINE_PLAYER=/path/to/player` (default engine)
   or `THREENATIVE_RUNTIME_BINARY=/path/to/runtime` (`engine: "threejs"`).
3. Build the binary from an engine checkout. The engine player and the legacy host are different
   binaries with different recipes:
   - every desktop build needs its dependencies and the native physics archive first, from
     `packages/runtime-native`: `node scripts/download-deps.mjs` and
     `node scripts/build-native-physics.mjs --desktop`. A fresh checkout stops at CMake without
     them, because every desktop preset enables native physics.
   - engine player (default), Linux with a `ui.renderer: "web"` HUD: additionally run
     `node scripts/build-native-ui-overlay.mjs` first (CMake refuses the overlay flag without that
     library), then `cmake --preset <platform> -B build/tn-engine-ui
     -DTN_ENGINE_ONLY=ON -DTN_ENGINE_PLAYER=ON -DTN_ENGINE_PLAYER_UI_OVERLAY=ON`, then
     `cmake --build build/tn-engine-ui --target tn-native-engine-player-v8`.
   - engine player (default), any other platform or a `"native"` HUD: the same command without
     `-DTN_ENGINE_PLAYER_UI_OVERLAY=ON` — it is a Linux-only option, and a web HUD elsewhere needs
     `engine: "threejs"`. A checkout with `build/tn-engine-ui/tn-native-engine-player-v8`
     is picked up with no variable set.
   - legacy host (`engine: "threejs"`): `pnpm --filter @threenative/runtime-native native:build`,
     then set `THREENATIVE_RUNTIME_BINARY`.
   macOS publishes no desktop asset at all, so there the checkout build is the only route.
   The overlay option is Linux-only and the released Windows and macOS players are built without
   it: a `ui.renderer: "web"` desktop build on either is refused at `TN_ENGINE_PLAYER_UI_UNSUPPORTED`
   before the download, so set `ui.renderer: "native"` (draw the HUD in the game) or
   `engine: "threejs"` (the legacy host renders the web UI) there.

`TN_NATIVE_BINARY_UNAVAILABLE` is a network, HTTP or checksum failure.
`TN_NATIVE_BINARY_UNPUBLISHED` means the release carries no asset for that platform or this
version — a packaging fact, not a broken machine, and it reads the same online or offline.

## Fetch ahead, or bake an offline image

The downloader ships as a command, not as an install hook:

```sh
node node_modules/@threenative/runtime-native/scripts/install-prebuilt.mjs
```

`THREENATIVE_PREBUILT_MANIFEST` points at a local `prebuilt-lock.json` you already hold. Checksums
are still verified, and a manifest missing an asset still fails by name.

`npx threenative doctor` reports an absent download as `ok: not downloaded yet`; it fails only when
a download was attempted and recorded as failed.
