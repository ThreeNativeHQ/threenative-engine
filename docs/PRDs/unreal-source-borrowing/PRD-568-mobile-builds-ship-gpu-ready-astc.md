# PRD-568 — Mobile builds ship GPU-ready ASTC, so no phone transcodes or uploads RGBA8

**Status:** PARTIAL
**Priority:** P2 — Standalone mobile ASTC cooking is implemented; embedded/lightmap cooking, admission and native proof remain open.
**Complexity:** 4 (MEDIUM) — 1–5 implementation files (`packages/assets` texture pass, `create-threenative` build gate, the asset loader route) (+1); the cook output crosses into the native package (+2); one new output variant (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-VQ-01](../done/PRD-VQ-01-native-asset-capabilities.md) (owns runtime-aware decoder admission; this PRD adds a format that needs no decoder)

## Context

The cook writes Basis KTX2, UASTC or ETC1S, chosen per texture by the quality ladder (`packages/assets/src/passes/model-textures.ts:426-430`). At load time three transcodes each file to whatever the GPU takes (`TRANSCODE_TARGETS`, `texture.ts:68-71`: UASTC to `astc4x4` or `bc7`, ETC1S to `bc1` or `etc2`). That transcoder is WASM.

`resolveRuntimeAssetCapabilities` (`packages/create-threenative/src/build.ts:1091-1124`) decides which native runtimes may ship KTX2. Since `afee25e90` (2026-10-09), Android V8, the default engine (`build.ts:1073-1081`), admits KTX2 and transcodes it at load through WASM. Android QuickJS and iOS JSC have no WASM, so any KTX2 there is refused with `TN_NATIVE_KTX2_UNSUPPORTED` (`build.ts:228-230`). Those builds ship PNG or JPEG, which decode to RGBA8: 4 bytes per pixel in VRAM, against 1 byte per pixel for ASTC 4×4 (`texture.ts:25`). `packages/runtime-native/AGENTS.md` still states that no mobile compressed-decoder path is qualified.

Two costs follow on phones:

- On QuickJS and JSC, every texture uses 4× the VRAM and bandwidth of ASTC.
- On V8, every texture pays a WASM transcode during launch. PRD-360 counts launch time against an eight-second target.

**What Unreal does.** Clean-room summary, no code copied:

- UE 5.8.3: `Engine/Config/BaseEngine.ini:3309-3314` (`[/Script/AndroidRuntimeSettings.AndroidRuntimeSettings]`). An Android build cooks several GPU formats (ETC2, DXT, ASTC) into the package and ranks them: ASTC 0.9, DXT 0.6, ETC2 0.2. At runtime the device takes the best format it supports. No runtime transcoder is involved.
- UE 5.8.3: `Engine/Config/BaseEngine.ini:3355-3359` (`[/Script/UnrealEd.CookerSettings]`). The default ASTC block size is chosen for size (6×6), with 4×4 for high-quality textures.

A done PRD made the opposite trade on purpose. [PRD-349](../done/PRD-349-the-cook-is-on-by-default.md) chose one transcodable Basis file over per-platform cooking, and [PRD-448](../done/PRD-448-cross-platform-asset-cooking-and-device-budgets.md) declined automatic native ASTC "now", leaving native decoder work separate. This PRD does not reopen either one. It adds a cook-time transcode for mobile targets only. Web and desktop keep Basis.

**Why a decoder is not needed.** Three's `KTX2Loader` (three 0.185.1, `examples/jsm/loaders/KTX2Loader.js:484-489`) sends a KTX2 whose `vkFormat` is defined straight to `createRawTexture` and never initialises the transcoder. Zstd supercompression would bring WASM back (`createRawTexture` loads a `ZSTDDecoder`), so the mobile output is written without supercompression.

## Solution

1. **Cook (packages/assets, mechanism).** For `--target android|ios`, the texture pass transcodes each cooked Basis texture once, at build time in Node, to ASTC 4×4 blocks. It writes a KTX2 with the matching `vkFormat` (sRGB for colour, UNORM for data), the full mip chain and no supercompression. The installed Basis transcoder supports direct ASTC 4×4 output for both codecs. V8 currently selects BC1/ETC2 for ETC1S, so this mobile output does not claim byte identity with that runtime selection. The manifest records the format.
2. **Admission (create-threenative).** The build gate separates Basis KTX2, which needs a decoder, from raw-block KTX2, which needs none. Raw ASTC is admitted on every mobile runtime. Basis KTX2 keeps today's refusal on QuickJS and JSC.
3. **Device check (fail closed).** At startup, a game whose package holds ASTC on an adapter without `texture-compression-astc` stops with a named error that names the first texture. No silent RGBA8 fallback is shipped.
4. **Block size.** Only 4×4, because ETC1S and UASTC transcode to 4×4 and to no larger block. Unreal's 6×6 size default would need a new encoder and is out of scope.

**Risks:**

- **Package size.** Raw ASTC 4×4 is 8 bits per pixel before the APK's deflate. ETC1S Basis is far smaller. Phase 2 records the bytes and the APK size.
- **Quality.** The existing PRD-351 ladder measures the Basis candidate before the offline transcode. ASTC rendering and final visual quality remain unverified until the native and visual proof lanes run.
- **Emulator.** ASTC support on an emulator may differ from hardware (as recorded in PRD-097). The emulator proves the path. Only a device proves VRAM.

## Decisions

- **2026-10-10, implementation lane:** reuse the installed Three Basis transcoder directly, with no extra encoder or dependency. The local two-colour 8×8 ETC1S probe reported `isETC1S=true`, `cTFASTC_4x4_RGBA=10` and successful full-mip ASTC lengths `[64,16,16,16]` (exit 0). `packages/assets/__tests__/image-quality.spec.ts` retains that invocation as an asserted ETC1S/UASTC test, comparing every output mip to the shipped transcoder. This proves block production, not rendering, VQ-01 completion or visual quality.

## Acceptance Criteria

- [ ] AC-1 [local]: An Android QuickJS build of the VQ-01 fixture ships ASTC KTX2 instead of PNG, packages without `TN_NATIVE_KTX2_UNSUPPORTED`, and renders both authored checker colours on the emulator. proof: `sh scripts/vq01-android-proof.sh <artifact-dir> emulator-5554` with `THREENATIVE_GRADLE_ARGS=-PthreenativeJsEngine=quickjs` — Evidence: pending.
- [ ] AC-2 [local]: The same fixture on Android V8 loads every texture without a transcoder call, and its first-frame load time is no worse than the Basis build in 3 interleaved launches. proof: the same runner with V8, comparing `TN_STALL_SEGMENTS` — Evidence: pending.

## Blocked on

- **Physical-device VRAM figure (Pixel 8).** The resident texture bytes on hardware, against the PNG build — unblocked by João attaching the device.
- **iOS JSC.** Same path on iOS — unblocked by the iOS lane (`BLOCKED/requires-ios-ecossystem`).

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Mobile ASTC cook | `npx threenative build --target android` runs the texture pass | PNG/JPEG on QuickJS/JSC; runtime Basis transcode on V8 | AC-1, AC-2 |
| Decoder-free KTX2 admission | The same build's native packaging gate (`build.ts:228`) | Blanket KTX2 refusal without a decoder | AC-1 |
| ASTC adapter check | Game startup on the native host | Nothing: a missing format failed at draw time | Phase 2 box |

## Execution Phases

#### Phase 1: Cook and admit raw ASTC
**Status:** PARTIAL
**Files:** `packages/assets/src/image-quality.ts`, `packages/assets/src/compile.ts`, `packages/assets/src/passes/texture.ts`, `packages/assets/src/passes/model-textures.ts`, `packages/assets/src/passes/lightmap.ts`, `packages/assets/__tests__/`, `packages/create-threenative/src/build.ts`, `packages/create-threenative/__tests__/native-ktx2.spec.ts`
- [ ] A mobile-target cook writes ASTC 4×4 KTX2 with the right `vkFormat`, full mips and no supercompression; web and desktop output is byte-identical to before. proof: red-green `pnpm exec vitest run packages/assets/__tests__`
  Partial: standalone Android/iOS output now transcodes the selected Basis result to raw ASTC, preserving the quality ladder, caps, codec opt-outs and target cache identity. Embedded/shared model textures and generated lightmaps remain open; this complete cook box stays unticked. Focused proof (2026-10-10): `pnpm exec vitest run packages/assets/__tests__/image-quality.spec.ts packages/assets/__tests__/texture-pass.spec.ts packages/assets/__tests__/compile.spec.ts -t 'transcodes every|rejects invalid or incomplete|cooks raw ASTC|should cook decoder-free ASTC|should let a caller that probed|should emit a full mip chain|should leave sources verbatim|should refuse a source whose|keeps a texture a|should reject corrupt image' --silent` — 12 passed, 73 skipped, exit 0 (22.85 s); helper tests first failed because the ASTC function was absent, then passed. `pnpm --filter @threenative/assets typecheck`, focused Biome checks and `git diff --check` passed. The full assets suite, native bundling, emulator, timing, GPU and visual judge were not run.
- [ ] The packaging gate admits raw-block KTX2 on QuickJS and still refuses Basis KTX2 there. proof: red-green `pnpm exec vitest run packages/create-threenative/__tests__/native-ktx2.spec.ts`

#### Phase 2: Load and check on the host
**Status:** NOT STARTED
**Files:** `packages/runtime-native/scripts/bundle.mjs` (generates the decoder-free raw KTX2 route in `native-bundle.mjs`), `packages/core/src/assets.ts` (route raw ASTC through `createRawTexture`; adapter check), `packages/core/__tests__/`
**Verification:** AC-1 and AC-2 close this phase.
- [ ] A package with ASTC on an adapter without `texture-compression-astc` fails at startup with a named error. proof: red-green `pnpm exec vitest run packages/core/__tests__/assets.spec.ts`
- [ ] The texture bytes and APK size of the ASTC build against the PNG build are recorded here. proof: the AC-1 runner's artifact listing

**Current lane:** `.worktrees/prd568`, branch `feat/prd568-mobile-astc`, owner `/root/prd568_support`, base `origin/develop` at `2d212479255cf725f64343dc72aa2eafe9b7b92d`; retained for active implementation/review. No push, merge or cleanup yet.
