# Cook profiles — one asset tree, a different representation per artifact

Companion to the commented `buildProfiles` example in this project's `threenative.config.ts`. A
profile is **not** a second asset pipeline: it is one compiler, run with different
resource-processing options, so the phone build can ship smaller bytes out of the same sources you
already committed. With no `buildProfiles` block every build behaves exactly as it always has —
this is opt-in and the ordinary `assets` block still means what it means.

```ts
buildProfiles: {
  defaults: { android: "compact" },        // a target's default profile
  profiles: {
    compact: {
      assets: { textures: { maxSize: 1024 }, models: { textures: { maxSize: 1024 } } },
      artifactBudget: { packagedAssetBytes: { limit: 18_000_000, severity: "error" } },
      performanceBudget: { maxDrawCalls: 300, maxFrameMsP95: 16.7 },
    },
  },
},
```

## Which profile a build cooks

1. `threenative build --target android --profile compact` — **the flag wins.**
2. `buildProfiles.defaults.android` — the target's own default.
3. Neither — the `assets` block is used exactly as declared.

Every build that selects a profile announces it before it cooks, so a log never leaves you guessing
which representation produced the bytes:

```
threenative build: profile compact (flag) for web
threenative build: profile compact (default) for android
```

An unknown name fails the build by name (`TN_CONFIG_PROFILE_UNKNOWN`, listing the profiles this
project declares) **before any asset is encoded**, rather than shipping the wrong representation.
Every declared profile is validated, not only the selected one, so a broken budget cannot lie in
wait for the day someone names that profile.

## What an overlay may change

`profiles.<name>.assets` may change `audio`, `budget`, `lod`, `models`, `targets` and `textures`
— the *processing* options. It may **not** restate `source`, `output` or `exclude`: the directory
tree being compiled, where it is written, and what is left out are one answer for the whole
project, because two profiles disagreeing about the source tree is a build that cooks half a game.
Those keys are refused.

The cap is `maxSize` on the longest edge, preserving aspect and 4x4 alignment, and never
upscaling — a 512² source under `maxSize: 1024` ships byte-identical. `assets.models.textures.maxSize`
caps the images carried *inside* a `.glb`, and the two caps key apart: capping one never renames or
re-encodes the other.

**A cap and a `codec: "none"` override cannot both be true**, and the build says so
(`TN_CONFIG_PROFILE_CONFLICT`): that override returns the authored bytes before resizing, so the
cap would silently do nothing. Drop the override or take the cap out of the profile.

## Native is decoder-free, and the cap still holds

Android and iOS ship no WASM, so no KTX2 transcoder and no Meshopt/Draco decoder exists in the
bundle — a phone cannot decode them, so the cook never produces them. A cap on such a target is
applied by **resizing the image during the compile** and shipping a PNG, not by writing a KTX2
nobody could read. The dimension you asked for is the dimension the file decodes to, alpha kept, and
the source on disk is never modified. Meshopt output is omitted for the same reason.

That is also why `assets.budget`'s `uncooked` ceiling is exempt on a mobile target without
decoders: those bytes are deliberately left raw, not accidentally uncooked. Read the two numbers
separately — see `agent-docs/mobile-memory-budget.md` for what a decoded image actually costs a
phone.

## Byte budgets, and what the two numbers are

`artifactBudget` is a ceiling on **what the build produced**, measured on the staged artifact
before it is published:

- `artifactBytes` — the produced artifact: a file, or the recursive sum of a directory, `.app`
  bundle or outDir. It is everything the player downloads or installs, code included.
- `packagedAssetBytes` — the sum of the **asset files that survived the packaging selector**: the
  manifest-declared closure that was actually staged. This is the number to write when the question
  is "did the cook do its job".

Each is `{ limit, severity }`. `"error"` refuses the build and leaves the previous artifact exactly
where it was — the new one is published only when every gate has passed; `"warn"` prints and
publishes. Neither is a judgement about the look: a profile can ship a smaller image, and what that
image looks like is still yours.

## Frame budgets are not measured by the build

`performanceBudget` takes the harness's own `assert.performance` fields — `minFps`, `maxFrameMsP95`,
`maxDrawCalls`, `maxTriangles`, `maxPassDrawCalls`, `maxPassTriangles`, `maxPhaseMsP95` (phases
`hostGap`, `update`, `render`, `overlay`, `residual`; passes `main`, `shadow`, `reflection`,
`nested`). The build cannot measure any of it — those numbers only exist once a runtime drew frames
— so a performance budget never refuses a build and never passes one. It is published into the
build report and enforced by the next run.

## `--build-report` carries the budget with the bytes

Every build publishes `<artifact>.build-report.json` **atomically beside the artifact it wrote**:
`schemaVersion`, `target`, `profile`, the artifact's `sha256`, the manifest's `sha256`, the two
measured byte counts, and the `performanceBudget` (or `null`). A report that exists is a build that
finished.

```sh
npx threenative-playtest playtests/survives.playtest.json --url http://127.0.0.1:5173 \
  --build-report dist.build-report.json --artifact dist --browser-recipe webgpu
```

The runner re-hashes the artifact under test and refuses the run when it is not the one the report
describes (`TN_PLAYTEST_BUILD_REPORT_STALE`, naming both digests) — a budget measured on other bytes
bounds nothing. It also refuses a report for a different target, a malformed report, and a budget
the target cannot observe. Otherwise the budget merges **per key** into the scenario's
`assert.performance`, and the scenario's own value wins where it declares one. `--artifact` is
required on browser and Android because nothing else says which build the run exercises; `--target
desktop` and `--target ios` already name it.

## Appearance is still yours

A profile changes representation, not look: which bytes reach the disk, and the ceilings that hold
the build to them. Materials, shaders, lighting, tone mapping, post and framing are your
`src/render/` code and stay there — the same `1024²` texture under a different sampler, a different
mip bias and a different exposure is three different looks from one profile. If a profile makes the
game look wrong, fix the appearance in your own source; do not reach for a byte ceiling to hide it.

To see what a cook actually chose, read the manifest's `via` for the assets your scenario loads, or
`ctx.assets.resolved` in the running game, which reports each logical path's URL and the `via` that
resolved it (`manifest` or the no-manifest `source` fallback).
