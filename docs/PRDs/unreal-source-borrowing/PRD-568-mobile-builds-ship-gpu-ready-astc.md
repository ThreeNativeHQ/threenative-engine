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
- **2026-10-10, mobile caller contract:** the starter scaffold test now requires at least one emitted ASTC KTX2 before validating every KTX2's raw ASTC format and full mip chain, while retaining Meshopt refusal. `pnpm exec vitest run packages/create-threenative/__tests__/scaffold.spec.ts -t "keeps the starter's shipped assets mobile-shippable" --silent` passed (1 passed, 65 skipped, exit 0, 6.12 s); focused Biome and `git diff --check` passed. The earlier full assets suite failed (551 passed, 2 failed, 6 skipped, exit 1, 294.32 s), with an unexpected worker exit whose code/signal was not reported: `bake-receipt.spec.ts:301` resolved instead of rejecting undeclared `stray.bin`, and `worker-pool.spec.ts:44` produced empty output instead of `empty-chain-exited`. Isolating the bake-receipt case on the same Node 20.19.6 repeated the failure (1 failed, 17 skipped, exit 1, 616 ms). Work on these failures stopped pending Opus diagnosis; their cause remains unknown, and the worker-pool case has not been isolated. All phase and acceptance boxes remain open at 0%; no native or visual claim is added.
- **2026-10-10, receipt guard regression:** the engine guard used only `mtimeMs + 1 >= runStart`, so a newly copied undeclared file retaining an old timestamp could escape it. The existing stray-writer test now also preserves an old timestamp with `utimes`. On local Node 20.19.6, `pnpm exec vitest run packages/assets/__tests__/bake-receipt.spec.ts -t 'preserved old timestamp: true' --silent` failed before the fix (1 failed, 18 skipped, exit 1, 10.00 s: resolved instead of rejecting), then passed (1 passed, 18 skipped, exit 0, 4.40 s). The compiler now snapshots output paths before its first write, rejects every new undeclared path regardless of timestamp, retains existing modification-time and receipt/journal exemptions, and propagates output-walk errors except `ENOENT`. `pnpm exec vitest run packages/assets/__tests__/bake-receipt.spec.ts --silent` passed all 19 tests (exit 0, 59.98 s), including authored-static, cache, auxiliary, stale-output and failed-bake ownership cases. Assets typecheck, focused Biome, focused doc links (12 passed, exit 0, 1.15 s) and `git diff --check` passed. At this receipt-only checkpoint, the full assets suite was still at its earlier failed result; it had not been rerun. The worker-pool failure and unexpected worker exit remain undiagnosed, with no established exit signal, OOM or timer cause. No filesystem/kernel timing claim is made.
- **2026-10-10, open ASTC limits:** `maxBytes` currently gates the Basis candidate's bytes, not the emitted raw ASTC bytes; the quality floor measures the Basis decode, not the shipped ASTC decode. Mobile explicit `runtimeDecoders` overrides and `codec: "none"` behavior remain unverified. The initial 12 focused tests do not establish preservation of final ASTC size caps, shipped quality or those override contracts; these claims remain open alongside embedded/shared textures, lightmaps, admission, native and visual proof.
- **2026-10-10, worker-exit diagnostics:** only the disabled-pass compiler test's child collector changed: it now waits for stdio `close`, records code/signal, whether its own timer fired, PID and monotonic elapsed time, and includes that data plus child startup/import/compile markers in assertion failure messages. Spawn errors reject and clear the timer. The existing 5 s child-kill and 10 s test budgets remain unchanged. On the original Debian laptop with Node 20.19.6 (status: 58 °C/load 0.28 before isolation; 57 °C/load 0.14 before the nearest file), one `pnpm exec vitest run packages/assets/__tests__/worker-pool.spec.ts -t "exits the real compiler with all passes disabled and no workers" --silent` passed (1 passed, 5 skipped, exit 0, 509 ms), then one `pnpm exec vitest run packages/assets/__tests__/worker-pool.spec.ts --silent` passed (6 passed, exit 0, 1.62 s). The first case asserted code 0, no signal and no timer firing in both runs. Assets typecheck (including tests), focused Biome and `git diff --check` passed. Neither run reproduced the earlier empty-output failure, so its cause and the separate unexpected Vitest worker exit remain unproven; other child collectors were not changed. This diagnostic component performed no full assets suite, timeout relaxation, build or ASTC source change. All phase and acceptance boxes remain open at 0%, including the final ASTC size, quality and override limits above.

  Full assets follow-up at committed source `90383cb3de930f0cc2a848728c482d45405a2614`: one `pnpm exec vitest run packages/assets/__tests__ --silent` on the original Debian laptop/Node 20.19.6 passed (39 files passed, 1 file skipped; 566 tests passed, 6 skipped; exit 0, 255.29 s). Existing test parallelism and budgets were unchanged; a 900 s supervisor deadline bounded the job, and inherited `NODE_OPTIONS` were preserved while appending `--report-on-fatalerror` and an ignored report directory. No unexpected Vitest worker exit or fatal-error report occurred; the instrumented compiler-child case passed its code-0/no-signal/no-own-timeout assertions. Saved before/after resources and cgroup memory events show `oom`/`oom_kill`/`oom_group_kill` stayed at 0. Read-only kernel captures were unavailable (`dmesg`: operation not permitted); no OOM or original-failure cause is inferred. Laptop status was 62 °C/load 0.51 before the job and 74 °C/load 49.24 after completion. Logs remain in ignored `artifacts/prd568-bootstrap/assets-rerun/` and the adjacent supervisor/status logs. This supersedes the earlier failed full-suite result; it does not establish the cause of that worker exit or qualify final ASTC byte caps, shipped quality, mobile overrides/codec-none, complete cook coverage, admission, native or visual behavior. All phase and acceptance boxes remain open at 0%.

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
  Partial: standalone Android/iOS output now transcodes the selected Basis result to raw ASTC, retaining the Basis selection flow and target cache identity; final ASTC size caps, shipped quality and mobile override contracts remain open (see Decisions). Embedded/shared model textures and generated lightmaps remain open; this complete cook box stays unticked. Focused proof (2026-10-10): `pnpm exec vitest run packages/assets/__tests__/image-quality.spec.ts packages/assets/__tests__/texture-pass.spec.ts packages/assets/__tests__/compile.spec.ts -t 'transcodes every|rejects invalid or incomplete|cooks raw ASTC|should cook decoder-free ASTC|should let a caller that probed|should emit a full mip chain|should leave sources verbatim|should refuse a source whose|keeps a texture a|should reject corrupt image' --silent` — 12 passed, 73 skipped, exit 0 (22.85 s); helper tests first failed because the ASTC function was absent, then passed. `pnpm --filter @threenative/assets typecheck`, focused Biome checks and `git diff --check` passed. The initial focused proof did not run the full assets suite; the subsequent failure, receipt fix and successful full-suite rerun are recorded in Decisions. Native bundling, emulator, timing, GPU and visual judge remain unrun.
- [ ] The packaging gate admits raw-block KTX2 on QuickJS and still refuses Basis KTX2 there. proof: red-green `pnpm exec vitest run packages/create-threenative/__tests__/native-ktx2.spec.ts`

#### Phase 2: Load and check on the host
**Status:** NOT STARTED
**Files:** `packages/runtime-native/scripts/bundle.mjs` (generates the decoder-free raw KTX2 route in `native-bundle.mjs`), `packages/core/src/assets.ts` (route raw ASTC through `createRawTexture`; adapter check), `packages/core/__tests__/`
**Verification:** AC-1 and AC-2 close this phase.
- [ ] A package with ASTC on an adapter without `texture-compression-astc` fails at startup with a named error. proof: red-green `pnpm exec vitest run packages/core/__tests__/assets.spec.ts`
- [ ] The texture bytes and APK size of the ASTC build against the PNG build are recorded here. proof: the AC-1 runner's artifact listing

**Current lane:** `.worktrees/prd568`, branch `feat/prd568-mobile-astc`, owner `/root/prd568_support`, base `origin/develop` at `2d212479255cf725f64343dc72aa2eafe9b7b92d`; retained for active implementation/review. No push, merge or cleanup yet.
