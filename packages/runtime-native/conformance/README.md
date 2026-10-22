# ThreeNative conformance harness

This directory is the same-source browser/native compatibility harness for upstream Three.js WebGPU.

- `registry.json` is the versioned public test registry. All required M3 IDs are present from the PRD, even when a case is still `planned`.
- `scenes/shared/first-proof-game.js` is the first proof source. It contains no runtime conditional branches; host adapters provide the canvas/dimensions.
- `browser-reference/` and `native-runner/` are thin adapters around the same scene sources.
- `run-conformance.mjs` writes a machine-readable report with pixel/perceptual metric slots,
  render completion, GPU validation error slots, and per-test tolerance metadata. Row 30 also
  records fail-closed bright-glyph pixel counts and raster bounds.

Use `--only-tests id,id` for bounded real execution. Implemented rows not selected by that
command are reported blocked, never passed or omitted. ImageMagick Q16/Q16-HDRI absolute
error is normalized by its quantum range; an unknown quantum depth fails metric computation.

`--engine threenative` runs the selected rows on the owned C++ engine instead of upstream three: the
Wasm engine in Chromium for `--target web`, the V8 engine player for `--target desktop`. On web, `--reference
<dir>` compares the capture with an upstream three capture of the same row. The default lanes (no flag)
run upstream three, and the desktop one runs the legacy `mystral` host, so their results are not proof
for the owned engine.

Run a scaffolded project's portable native entry with:

```sh
pnpm parity --project /absolute/path/to/project
```

Project mode reads `threenative.nativeEntry` (default `src/game.ts`), bundles that one source
for browser, desktop, and Android, and stages the project's `public/` assets on every target.
It does not substitute registry scenes for the game. The Android lane verifies the SHA-256 of
`assets/scripts/main.js` inside the APK before install. Missing or outside-project entries fail
with a `TN_PARITY_*` error.

Every Android row uses a fresh app install and waits for PackageManager to reclaim the prior
large debug code path. This prevents a complete 66-row lane from exhausting emulator storage
through deferred `install -r` replacement cleanup.

The CI lane runs the complete registry. Planned rows stay in its report as blocked and keep
the lane non-green until implemented; they are never omitted to manufacture a pass.
`--target android-hardware --device SERIAL` adds the physical-hardware column; an absent
device or an emulator serial is blocked and exits 2.

Non-project `--target android` (including the Android child of `all`) also runs the standalone
native-smoke multitouch positive/negative proof after visual rows finish. Its result is stored
under `report.supplemental.androidMultitouch`; a failure forces exit 1 without discarding the
visual results. Project mode does not substitute native-smoke input behavior for the project.

`--target ios` validates and bundles the registry, then uses a signed iOS simulator/device adapter
when one is available. On Linux, or on macOS without that adapter, each row is recorded as
`skipped-with-reason`; the report never treats an unexecuted iOS lane as a pass.

The runner does not synthesize a desktop toolchain. If no runtime binary exists, it reports
`TN_PARITY_DESKTOP_RUNTIME_MISSING`: Node 20, JDK 17, and an Android SDK do not provide CMake,
a C++ compiler, or platform development libraries. This is the precise remaining blocker to
PRD-054 acceptance criterion 1 from a literal clean machine.
