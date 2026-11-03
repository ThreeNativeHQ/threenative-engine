# Changelog

All notable changes to this project are documented in this file.

The history before 0.2.0 was not reconstructed from git.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The optional `@threenative/terrain` authoring addon validates and retains
  stable-key placement overrides through `validatePlacementOverrides` and
  `applyPlacementOverrides`. The example editor offers individual prop selection,
  ordinary Three.js gizmos, numeric transforms and measured grounding overrides.

- `create-threenative` ships an `optimizeModels()` Vite plugin, and every template
  wires it into `vite.config.ts`. At build time it regenerates each `public/assets/*.glb`
  from its source in `assets/models/` via gltf-transform whenever the source is newer
  (quantization + WebP + separate vertex layout; measured ~75–88 % smaller with mesh,
  bone and clip names preserved). Disable per project with
  `optimizeModels({ disabled: true })` or per invocation with `TN_NO_OPTIMIZE_MODELS=1`.
  Projects without an `assets/models/` directory are unaffected. Requires the template's
  new `@gltf-transform/cli` dev dependency only when a model is actually stale.
- `create-threenative` bumped to 0.2.3 for the above; templates pin 0.2.3.
- `TracerPool3D.spawn` accepts per-shot `widthScale`, `segmentLength` and `lifetime`
  overrides, so a game's shot-to-shot variation survives migration onto the pool.

### Breaking

- `@threenative/core`'s `AutoExposureNode` extends Three's `Node` instead of the `TempNode` that
  Three 0.187 deprecated (PRD-775), so its recorded signature changes. No game code names that
  base class: `exposure` still returns the same node with the same constructor arguments, and the
  `isTempNode` flag r187 no longer reads is gone (`isNode` answers instead).

- `@threenative/blender-bridge` (formerly `threenative-blender-mcp`) is now private and ships
  no MCP server. The `threenative-blender` server is gone from `.mcp.json` and every other host
  config, along with the `blender_status`, `blender_inspect`, `blender_convert`,
  `blender_recipes`, `blender_export_world` and `blender_run_python` tools. Blender conversion at
  build time is unchanged: `blenderImportPass` still converts `.fbx`, `.blend`, `.obj` and `.dae`
  through the same bridge, and the bpy recipes stay in `packages/blender-bridge/gpl/` to run with
  `blender --background --python`. Remove the stale `threenative-blender` entry from an existing
  project's MCP config; a fresh scaffold no longer writes it.

- `@threenative/core#sceneWarning` takes an optional fourth `gpuClass` argument and
  returns no verdict for `"software"`: a CPU rasteriser puts the GPU's work inside the
  render phase, so "the GPU is idle" is false there. Existing three-argument callers
  remain valid.

- `@threenative/playtest/runner#advanceFixedStep` now advances and settles each
  driven world frame individually, so browser HUD work runs between frames. Its
  optional fourth `settle` argument defaults to `true`; existing three-argument
  callers remain valid. Resource polling can pass `false` to keep its deadline.

- The unreleased terrain editor's `mountTerrainEditor` view factory receives
  `(host, controller)`. Its `IEditorView` implements `setDocument(document, revision)`
  so metadata edits can update the scene without dispatching terrain evaluation;
  `update(state)` can return resolved placements. Host-only callbacks remain valid.

- `@threenative/core`'s `renderer.projection` now also accepts
  `{ materialChecks: "spread" | "everyFrame" }` and not only a boolean (PRD-462). This widens the
  accepted values rather than removing one, so a game that passed `true` or `false` needs no
  change: `false` still declines the mirror and `true` still takes the default. The default is
  `materialChecks: "spread"`, which proves a bounded slice of the batched materials per frame
  instead of all of them; `materialChecks: "everyFrame"` is the check exactly as it shipped before
  the sweep existed, at about 1.1 µs a material per frame. Any other value throws at startup rather
  than falling back to a default nobody asked for.

## [0.3.3] - unreleased (release candidate)

The current cohort, prepared from `develop` at 0.3.3 (`create-threenative` 0.2.6). It is not yet
published, and no `runtime-native-v0.3.3` prebuilt release exists; publishing the cohort is
PRD-196.

### Added

- An installed starter runs real browser gameplay after a game-only edit (PRD-366).
- Desktop release mode builds a complete OS container, and its game brand is inspectable
  (PRD-365, PRD-375); the Android release artifact carries the game brand (PRD-375).
- Rigging and humanoid retargeting through the asset MCP (PRD-383).
- Automatic rendering-performance defaults, render-camera culling, adaptive water and reflection
  budgets, and a force-integrated flight model (PRD-382, PRD-384).
- A searchable site with engine comparisons and evidence-backed benchmarks.

### Changed

- The native performance line: launch diagnostics, frame attribution, off-thread audio and
  cheaper UI overlay snapshots (PRD-442).

## [0.3.2] - 2026-09-12

### Added

- `pnpm release:native` stages, creates and uploads the `runtime-native-v<version>` prebuilt
  payload; `pnpm release` publishes the npm cohort and then the payload (PRD-378).
- Android emits a signed release APK and AAB from the current submission SDK (PRD-212).

### Fixed

- The publish lane waits up to 15 minutes for npm propagation before verifying the cohort.
- The clean-consumer Android lane provisions the debug keystore the aligner re-signs with.

## [0.3.1] - 2026-09-12

### Added

- `pnpm release:prepare` — one safe local command prepares a cohort: it bumps the public
  packages, syncs template pins and derived surfaces, and changes nothing else.
- Core accounts for warm-up candidates and observed pipelines, and holds explicit warm-up first
  use.

### Fixed

- Promoted consumer distribution is gated, and PRD-196 release readiness is publish-safe.

## [0.3.0] - 2026-08-31

### Changed

- First public cohort on the 0.3.x line: `@threenative/core`, `@threenative/physics`,
  `@threenative/playtest`, `@threenative/runtime-native` and `@threenative/ui` at 0.3.0.
- `threenative-engine-mcp` joins the published set.
- Every published tarball carries its README (PRD-133).

## [0.2.0] - 2026-08-16

### Changed

- Moved every publishable package and every template pin to the 0.2.0 release line.

[unreleased]: https://github.com/ThreeNativeHQ/threenative/compare/main...HEAD
[0.2.0]: https://github.com/ThreeNativeHQ/threenative/releases/tag/0.2.0
