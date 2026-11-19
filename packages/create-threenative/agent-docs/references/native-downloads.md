# Native binaries arrive at the first native build

PRD-783. `pnpm install` downloads **no** native binary. The web engine already ships as Wasm inside
`@threenative/core`, so a web game installs and runs without fetching anything.

| Command | What it downloads |
| --- | --- |
| `pnpm dev`, `pnpm build`, `threenative build --target web`, `pnpm test` | nothing |
| `pnpm build --target desktop` (default engine) | the engine player, about 118 MiB, once per install |
| `pnpm build --target desktop` (`engine: "threejs"`) | the legacy runtime and its build tool helper, about 260 MiB, once per install |
| `pnpm build --target android` / `ios` | that platform's libraries, at package time |

Every download is checked against the SHA-256 and byte length recorded in the release's
`prebuilt-lock.json`. A verified download is reused with no network, so the second desktop build is
offline.

## When a download fails

The error names the asset, the installed version, the URL and the reason. Three fixes work:

1. Reconnect and rerun the same command — it resumes from nothing and re-verifies.
2. Point the build at a local binary: `THREENATIVE_ENGINE_PLAYER=/path/to/player` (default engine)
   or `THREENATIVE_RUNTIME_BINARY=/path/to/runtime` (`engine: "threejs"`).
3. Build the binary from an engine checkout:
   `pnpm --filter @threenative/runtime-native native:build`.

`TN_NATIVE_BINARY_UNAVAILABLE` is a network, HTTP or checksum failure.
`TN_NATIVE_BINARY_UNPUBLISHED` means the release carries no asset for that platform — a packaging
fact, not a broken machine.

## Fetch ahead, or bake an offline image

The downloader ships as a command, not as an install hook:

```sh
node node_modules/@threenative/runtime-native/scripts/install-prebuilt.mjs
```

`THREENATIVE_PREBUILT_MANIFEST` points at a local `prebuilt-lock.json` you already hold. Checksums
are still verified, and a manifest missing an asset still fails by name.

`npx threenative doctor` reports an absent download as `ok: not downloaded yet`; it fails only when
a download was attempted and recorded as failed.
