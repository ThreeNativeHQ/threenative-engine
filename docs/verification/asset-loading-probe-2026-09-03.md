# Asset loading probe — 2026-09-03

What executed, what did not, and the numbers PRD-496 is built on. Owner question: *"on wildwood we
had to parallelise asset loading because it was taking too long… maybe this should be on the engine
side?"*

## Corpus

Real assets copied out of `sandbox/wildwood/public/` (the game's own compiled manifest output):

- **16 textures**, 38.0 MB on disk, **125.8 MB decoded RGBA** — twelve 1024², three 2048², one
  5120×1024; a mix of `.png` and `.jpg`, chosen from the 1–25 MB band so the manifest's 51 MB
  outliers do not dominate.
- **10 models**, 4.0 MB, meshopt-compressed `.glb` from a Fab import.

Wildwood's manifest as a whole: **165 entries, 2,003 MB of output, 53 PNG, 35 JPG, 1 HDR, 1 WAV,
3 JSON, 72 GLB, and zero `.ktx2`**. Largest single entry 710 MB
(`fab/…/UnrealMaterialLibrary.glb`).

## Runtime arms — headless Chromium, localhost, 3 passes each, means

Harness: a static server plus a page driving the arms through Playwright, with a `requestAnimationFrame`
gap recorder for main-thread blocking. Not committed; it reads real bytes off disk and its arms are
reproduced in the numbers below.

| arm | total | worst frame gap | main-thread blocked |
| --- | ---: | ---: | ---: |
| T1 `TextureLoader`, load only — *what `await ctx.assets.texture()` resolves on* | 107 ms | 20 ms | 0 ms |
| T2 `TextureLoader` + the decode the game pays for anyway | 397 ms | 22 ms | 0 ms |
| T3 `createImageBitmap` — off-thread | **153 ms** | 17 ms | 0 ms |
| X1 textures one at a time, `TextureLoader` + decode | 436 ms | 17 ms | 0 ms |
| C1 every fetch at once (**what core does**) | 484 ms | **367 ms** | **351 ms** |
| C2 a pool of 6 | 164 ms | 51 ms | 35 ms |
| M1 one `GLTFLoader` per model (what core does) | 87 ms | 62 ms | 45 ms |
| M2 one shared `GLTFLoader` | 84 ms | 52 ms | 35 ms |
| M3 models one at a time | 85 ms | 20 ms | 0 ms |

Two things read straight off this table:

- **`await ctx.assets.texture()` resolves ~290 ms before the pixels exist** (T1 vs T2). That cost
  is not on the loading screen where it is budgeted; it lands at first GPU upload, during play.
- **Fan-out is not the lever.** X1 vs T2 is 436 → 397 ms, 9%, because main-thread decode serialises
  regardless of how many promises are in flight. M3 vs M1 is 85 → 87 ms — wildwood's model fan-out
  bought nothing at all.

## Runtime arms — throttled, 40 Mbps down / 20 ms latency (CDP `Network.emulateNetworkConditions`)

| arm, 16 textures / 38.0 MB | total | first texture ready |
| --- | ---: | ---: |
| unbounded + `TextureLoader` decode (**core today**) | 7,738 ms | 1,283 ms |
| unbounded + `createImageBitmap` | 7,725 ms | 1,288 ms |
| pool of 6 + `createImageBitmap` | 7,733 ms | 1,286 ms |

**13 ms apart.** Once the pipe is the bottleneck, neither pooling nor decode placement is
measurable. The loading screen is long because of bytes.

*Not measured:* a fully serial arm at 40 Mbps. The run's page was closed by the browser partway
through the third profile (repeated 126 MB decodes), and the 4G profile never ran. The three arms
above are from a complete profile; the serial arm and the 12 Mbps profile are **unverified**.

## Compression — what the pipeline already does with the same 38 MB

`texturePass` from `packages/assets/dist`, default codec choice, mip chains asserted intact:

**38.0 MB → 10.5 MB, 72% smaller.** At 40 Mbps that is 7.7 s → **2.1 s**.

Encode cost was 133 s for the 16 files single-threaded in this harness; the real compile step runs
a bounded worker pool (`min(4, cores − 1)`).

On the shipped template assets, measured through `compileAssets` with the bare default config:

| file | source | output | format |
| --- | ---: | ---: | --- |
| `native-proof.png` (16×16) | 150 B | 542 B | etc1s |
| `native-proof.glb` | 624 B | 1,324 B | meshopt + quantization |

**1.1 KB of growth in total** — which is the entire measured basis on which both templates pinned
`assets: { models: "none", textures: "none" }`, and therefore the entire basis on which every game
scaffolded from them shipped its web build uncompressed. The real reason that pin was load-bearing
is the Android target, not the file size: see PRD-496 §1.

*Note on a claimed comparison that is not one:* `texturePass({ codec })` has no effect —
`ITexturePassOptions` exposes `maxSize`, `overrides` and `quality`, and a codec can only be forced
through a glob override. Two runs intended as etc1s-vs-uastc produced byte-identical totals
because both used the automatic choice. Only the automatic-choice number above is real.

## Static findings

1. `packages/core/src/assets.ts` reached for `createImageBitmap` **only when `Image` is
   undefined** — node and the native host. Every browser texture went through `TextureLoader`.
   Meanwhile three's own `GLTFLoader.js:2600–2606` picks `ImageBitmapLoader` whenever
   `createImageBitmap` exists, so the same file decoded off-thread inside a model and on the main
   thread when a game loaded it directly.
2. `ctx.startup.progress` (`packages/core/src/game.ts`) read `settled / requested` — a **file
   count**. Manifest entries already carry `bytes`; the denominator existed and was unread.
3. `createAssetLoader` has **no concurrency bound**: every `assets.*()` call fetches immediately.
4. **No batch API.** Wildwood hand-wrote ~180 lines in `src/scenes/Valley.ts`: a 70-line
   `AssetLease` lifetime wrapper, a critical/detail tier split, six `Promise.all`/`allSettled`
   sites, manual progress accounting, `DetailAssetError` attribution, and stale-generation
   cancellation. Across the sandbox, 14 games make asset calls and 4 hand-roll parallel loading.
5. The compile step said **nothing** when a pass was switched off.
6. Build concurrency defaults to `min(4, cores − 1)` — 4 of 24 cores on this machine.
7. Content-addressed outputs carry no `Cache-Control: immutable` anywhere.

## What PRD-496 changed, and the red observed for each

| change | negative control | observed |
| --- | --- | --- |
| `texture()` decodes off-thread, orientation per backend | restore the `typeof Image === "undefined"` guard | 3 failed / 39 passed of 42 |
| `progress.requestedBytes` / `settledBytes`, and `startup.progress` prefers them | make `bytesOf` always return 0 | `should weight progress by the bytes the manifest records` failed |
| `compileAssets({ platform })` drops passes a platform cannot decode | pin `decodesCompression = true` | the android/web split test failed; the scaffold mobile gate failed **only after rebuilding `packages/assets/dist`** — see the trap below |
| `TN_ASSETS_COMPRESSION_SKIPPED` with a `config`/`platform` reason | skip the loop unconditionally, then drop the `active` guard | one test failed in each direction |
| templates name no `assets` key | put `"none"` back into sailing | `sailing should not switch a compile pass off` failed |

### Trap worth keeping: a cross-package spec reads `dist`, not `src`

`packages/create-threenative/__tests__/scaffold.spec.ts` imports `@threenative/assets`, which
resolves to `packages/assets/dist`. A control applied to `packages/assets/src` therefore **passed
silently** — the first run of that negative control was a false green, and only
`pnpm --filter @threenative/assets build` made it red. Any control on a cross-package seam has to
rebuild the dependency before it can be believed.

## Gates

| gate | result |
| --- | --- |
| `pnpm typecheck` | pass |
| `pnpm lint` | 3 errors, all `noExcessiveCognitiveComplexity` in `examples/quarry/`; untouched by this change and red on the base commit `af372744` |
| root `vitest run` | 3,656 passed, 2 skipped, 1 failed of 3,659 — `determinism.spec.ts` "byte-identical at concurrency 1 and 4", which passes in isolation (known root-suite contention flake) |
| `pnpm budgets` | ok |
| `pnpm sync:agents` | 19 mirrors, in sync |
| `pnpm test` (whole workspace) | **not green, and not from this change.** `packages/runtime-native` fails 6 tests, every one `… is not built. Run: cmake --build build/tn-linux --target …`. A fresh worktree carries no native build and nothing here touches C++. **Unverified.** |
| `pnpm test:templates` | **not run** — needs a GPU lane. Unverified. |
| a device or `--target android` build | **not run.** The Android behaviour is proved by the compile step's manifest output, not on hardware. Unverified. |
