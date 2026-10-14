# PRD-565 — Multisampled targets stay in tile memory on the Android host

**Status:** PARTIAL
**Priority:** P2 — Host transient allocation groundwork is verified; automatic starter eligibility and desktop visual proof remain open, and Mali/Adreno savings remain unmeasured.
**Complexity:** 6 (HIGH) — 6–10 implementation files (2), renderer/host resource lifetime state (+2), crosses into PRD-329's Dawn-on-Android build (+2); risk override: changing valid persistent MSAA loads can lose rendered content
**Owner:** João (device runs), agent (implementation)
**Depends on:** [PRD-329](../../performance/critical/PRD-329-the-native-gpu-frame-matches-chrome-at-matched-pixels.md) Phase 2 for Android qualification only (the Dawn-on-Android build). Desktop Phases 1–2 proceed independently on shipped Dawn. This PRD feeds PRD-329 Phase 3's MSAA arm with one specific lever; it does not repeat that arm's `sampleCount 4` resolve-path pair.

## Context

A tile-based GPU (Mali, Adreno) renders each screen tile in on-chip memory. A 4× multisampled
colour or depth attachment that the frame resolves and never reads again does not need to exist in
main memory at all. If the API marks it transient, the driver keeps the samples on chip and never
writes them out. PRD-228 already noted that the Mali-G715 resolves MSAA in tile memory
(`docs/PRDs/done/PRD-228-the-pixel-budget-is-the-engines.md:147`).

At the planning baseline, the host did not mark anything transient:

- No `TransientAttachment` usage, memoryless or lazily allocated texture exists in
  `packages/runtime-native/src` (searched `TransientAttachment`, `memoryless`, `lazily`).
- Android's product backend is wgpu-native (`packages/runtime-native/CMakeLists.txt:291-296`),
  pinned at `v25.0.2.2` (`third_party/wgpu-android/.threenative-wgpu.json`). Its headers have no
  transient usage flag (searched `third_party/wgpu-android/aarch64/include/webgpu/*.h`).
- The Dawn headers the host already builds against have the feature and the usage:
  `WGPUFeatureName_TransientAttachments` and `WGPUTextureUsage_TransientAttachment`
  (`third_party/dawn/dawn-headers/include/dawn/webgpu.h:562`, `:1225`). Dawn on Android is
  PRD-329's arm64 spike (`CMakeLists.txt:112-121`).

The installed Three 0.185.1 source makes allocation-only inference insufficient. Paths below
are relative to that dependency's `src/renderers/webgpu/`, shipped through
`packages/core/patches/three@0.185.1.patch`:

- `utils/WebGPUTextureUtils.js:358-425` includes sampling/copy usages and inherits them for
  generic MSAA allocations; `:518` creates the canvas colour buffer with
  `RenderAttachment | CopySrc`. Neither is the originally proposed exact-render-only usage.
- `WebGPUBackend.js:902-946` chooses clear/load dynamically and stores colour and depth;
  `:469-497` caches attachments. `:2868-2875` resumes a pass with load after a framebuffer copy.
- Host `bindings_resources.cpp:1064-1076` allocates before the pass is known;
  `bindings_state.h:55-66,253` records texture shape/sample count and view handles, not future
  reads. A clear pass today cannot prove that tomorrow's pass will not load those samples.

Pinned Dawn already exposes the feature on Vulkan; this desktop work needs no version upgrade
(`scripts/download-deps.mjs:65,151`, commit `d14ae3d97ad74100e9f382efef5e9c0872ddbeb2`). Its
[transient attachment contract](https://github.com/google/dawn/blob/d14ae3d97ad74100e9f382efef5e9c0872ddbeb2/docs/dawn/features/transient_attachments.md)
forbids loading or storing transient contents. Resolving colour does not preserve the individual
MSAA samples or depth needed by a later load.

**What Unreal does (UE 5.8.3, ideas only, no code copied):**

- The mobile renderer sets `bMemorylessMSAA` when the scene renders in a single pass: no
  multi-pass, no editor composite, no separate view pass
  (`Engine/Source/Runtime/Renderer/Private/MobileShadingRenderer.cpp:744-745`).
- With more than one sample and `bMemorylessMSAA`, the multisampled scene colour target gets the
  memoryless flag (`Engine/Source/Runtime/Engine/Private/SceneTexturesConfig.cpp:171-173`). The
  multisampled scene depth target gets it too, except on mobile with a full depth prepass, because
  the base pass reads that depth again (`SceneTexturesConfig.cpp:178-186`). The depth-aux target
  follows the same condition (`Engine/Source/Runtime/Renderer/Private/SceneTextures.cpp:805-810`).
- The mobile renderer keeps scene depth in memory when post-processing, temporal AA, a depth
  prepass or HZB needs it (`MobileShadingRenderer.cpp:688-708`).
- A depth target with the memoryless flag gets no store action
  (`Engine/Source/Runtime/Renderer/Private/MeshPassProcessor.cpp:2245`), and later passes skip any
  copy from a memoryless texture (`SceneTextures.cpp:1032`, `:1303-1346`).

## Solution

The renderer proves lifetime; the host implements allocation. The game receives automatic MSAA
savings without a new setting or public lifetime API:

1. Through the existing Three patch, establish a private renderer/host contract for genuinely
   pass-local MSAA sources in the renderer-owned final presentation path. The renderer must prove
   clear-at-start, discard-at-end and no later read of the source, including framebuffer-copy
   restarts and later renders/frames. Persistent or uncertain lifetimes retain ordinary storage.
   If the existing source is persistent, provide a genuinely pass-local source in this path;
   recording zero eligible textures in the starter does not satisfy the outcome.
2. Request `TransientAttachments` only when Dawn advertises it, through the shared feature builder
   in `context.cpp`. Only a proven pass-local source with samples above 1 may use
   `RenderAttachment | TransientAttachment`. Do not strip usages from a sampled/copied texture or
   infer lifetime from usage, labels, autoClear, or the previous frame.
3. Track the private lifetime contract through the existing native texture/view registries and
   release paths. The transient source clears and discards; its resolve output remains stored.
   Sampled depth and persistent colour/depth retain their contents across two-pass loads,
   framebuffer-copy restarts and frames. Never reconstruct MSAA samples from resolved colour.
4. Reuse texture accounting (`bindings_resources.cpp:87-110`) and marker emission
   (`bindings_presentation.cpp:969-1000`) for one `TN_TRANSIENT_ATTACHMENTS` record: actual granted
   state, transient count and nominal bytes otherwise occupied. Those bytes are an estimate,
   not measured device-memory savings. Provide an explicit feature-off comparison control.
5. On wgpu-native or when the feature is not granted/disabled, preserve the existing renderer
   allocations, usages and load/store behavior. The required Opus 5.5 HIGH review rejected the
   naive output-quad substitution; the host groundwork below does not establish renderer lifetime
   eligibility or starter visual proof.

## Acceptance Criteria

- [ ] AC-1 [local]: The native desktop host on Dawn renders the starter with automatic transient 4× MSAA sources (count and nominal bytes above zero), preserving the feature-off image without validation errors. proof: `pnpm native:verify:desktop` plus two same-pose feature-off/on capture runs per arm and the owner-required visual judge. — Evidence: pending; no runtime or visual proof has run.

## Blocked on

- The win itself (GPU time and memory bandwidth per frame on a Mali or Adreno phone, feature on against feature off, same session) needs a physical arm64 device and PRD-329's Dawn-on-Android APK. The x86_64 emulator neither runs the arm64 Dawn spike nor models tile memory. Only `emulator-5554` was attached on 2026-10-09. — unblocked by João attaching the Pixel 8 and PRD-329 Phase 2 producing the Dawn APK. A result under 0.5 ms and no memory gain records a decline under `## Decisions` and leaves the code off.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Automatic pass-local MSAA source | Three final presentation allocation/pass path (`WebGPUTextureUtils.js:489-534`, `WebGPUBackend.js:461-511,902-946`), maintained in `packages/core/patches/three@0.185.1.patch` → host `bindings_resources.cpp:1064-1076` → `bindings_commands.cpp:1150-1160,1206-1213` | Replace storage only for renderer-proven ephemeral sources; preserve persistent/load, sampled-depth and feature-off consumers | Phase 1; AC-1 |
| Transient allocation observation | Shared Dawn feature request (`context.cpp:441-490`) → native texture/view registries (`bindings_state.h`) → existing texture accounting and presentation marker emission | Add granted/count/nominal-byte observation without claiming measured bandwidth or memory gain | Phase 1 telemetry box: registered real-binding executable, on/off/direct arms |

## Execution Phases

#### Phase 1: Prove lifetime, then mark and discard
**Status:** PARTIAL
**Files:** `packages/core/patches/three@0.185.1.patch` (private renderer lifetime wiring and actual pass-local sources); `packages/runtime-native/src/webgpu/{context.cpp,bindings_state.h,bindings_resources.cpp,bindings_commands.cpp,bindings_presentation.cpp}` (feature request, native metadata/lifecycle, allocation, store ops and telemetry); `packages/runtime-native/tests/` plus `CMakeLists.txt` and `scripts/verify-native-contracts.mjs` (contract executable/registration); `packages/core/__tests__/three-patch-upgrade.spec.ts` (patch contract); the existing native conformance scene/registry path (runtime regression consumer).
- [ ] The renderer/host contract automatically makes proven pass-local 4× sources transient while preserving all valid persistent loads. proof: a registered host contract-test executable through the real binding, red-green, covering clear→store→load across two passes and frames, framebuffer-copy restart, sampled depth, sampleCount 1, feature absent/off, and transient clear→resolve→discard with stored resolve pixels; the Three patch contract and a native conformance scenario exercise the renderer path. — Host groundwork verified below; renderer-owned eligibility, renderer conformance integration and a full renderer framebuffer-copy restart remain open. The binding fixture checks clear/store/load across passes and frames, resolve readback, copies between passes and sampled-depth load validation; it does not prove distinct per-sample or depth pixel preservation.
- [x] `TN_TRANSIENT_ATTACHMENTS` reports actual granted state, transient count and nominal bytes using existing accounting. proof: the same contract executable reads the line and verifies positive eligible count/bytes and zero transient count/bytes in feature-off mode. — Verified on desktop Dawn: registered `threenative-transient-attachments-test`, default / `--feature-off` / `--direct`, all exit 0. Granted arms report count 1 / nominalBytes 256; feature-off reports false / 0 / 0; destroying the texture twice leaves 0 / 0. This is a private binding fixture, not positive starter eligibility.

#### Phase 2: Prove on desktop Dawn
**Status:** NOT STARTED
**Files:** Phase 1's conformance fixture and registration; no separate evidence report.
- [ ] AC-1's starter capture comparison demonstrates automatic transient 4× sources on desktop Dawn with unchanged output. proof: `pnpm native:verify:desktop`, positive transient count/bytes, validation-clean logs, two captures per arm and the owner-required visual verdict recorded here. — Pending; independent of PRD-329's Android build/device qualification.

## Decisions

- 2026-10-12 (Unreal source review): the color and depth memoryless flags live in `SceneTexturesConfig.cpp`, not `SceneTextures.cpp` (that file sets it only for depth-aux). Unreal also keeps depth when anything reads it again. Added a box for the load-op rule, because a texture is created before the host knows how many passes will load it. The host must decide at creation or fall back. The Dawn rule on load and store ops is unverified here: the headers carry no text for it, so the contract test must record it.

- 2026-10-09 (João, via the Unreal review request): filed separately from PRD-329. PRD-329 is a four-phase critical PRD whose MSAA arm compares resolve paths; this lever is one host rule with its own on/off gate, and adding it there would break the three-phase cap (R5).
- 2026-10-10 (agent, source-backed plan correction): replace the unsafe host-only exact-RenderAttachment allocation rule with renderer-proven pass-local lifetime wiring. Installed Three 0.185.1's `WebGPUTextureUtils.js:358-425,518` usages miss that predicate; `WebGPUBackend.js:902-946,2868-2875` permits persistent loads and framebuffer-copy restarts. Host allocation at `bindings_resources.cpp:1064-1076` cannot know those future operations. A clear/discard observation or resolved image cannot recover discarded samples for a later load. Preserve the automatic starter MSAA savings goal, sampled depth, valid persistent rendering and feature-off behavior; desktop Phases 1–2 remain executable independently of PRD-329. All implementation/acceptance boxes remain open at 0%; renderer architecture implementation awaits the bounded Opus 5.5 HIGH review/global CLI slot.

- 2026-10-14 (implementation lane, reviewed architecture retained): commit verified host groundwork only. `context.cpp` requests Dawn's advertised feature through the shared builder; an unbounded vector prevents the old ten-name capacity from dropping a request. `TN_TRANSIENT_ATTACHMENTS=0` omits it at device creation. The private `_tnPassLocalMSAA` boolean permits only multisampled 2D, single-layer/single-mip render-only textures to gain the transient usage. Sampled depth, sampleCount 1 and unmarked resources keep their usages. Texture registry lifetime and existing nominal-byte accounting feed the presentation marker. Neither direct commands nor `bindings_frame_stream.cpp` rewrites load/store operations: native views retain Dawn's texture usage and Dawn validates both paths.
- 2026-10-14 (remaining renderer premise): `_renderOutput` disables autoClear, and `currentSamples` is 0 when output conversion requires the framebuffer target. A new MSAA output quad would manufacture work; clearing a transient output source would erase earlier scissored views. The cached intermediate framebuffer's MSAA contents can also be loaded by a later render or frame. No proof of its final sample read has been established. Renderer wiring, positive starter count, full copy-restart regression, distinct per-sample/depth preservation, capture pairs and the fresh visual judge remain open; no Three patch or game workaround was added.
- 2026-10-14 (red/green): `packages/runtime-native/build/tn-linux/threenative-transient-attachments-test` exited 1 before implementation: advertised transient feature was not requested. After implementation, `ctest --test-dir packages/runtime-native/build/tn-linux -R '^threenative-transient-attachments-test$' --output-on-failure` passed; the registered execution contract's default, `--feature-off`, and `--direct` invocations all passed. Dawn recorded transient load/discard and clear/store as rejected, clear/discard as accepted, and resolve readback survived. The fixture explicitly flushes packed replay inside error scopes; closing a scope before replay did not capture the subsequent validation error. Direct copy readback supplies explicit mip/offset/row fields rather than relying on optional-field defaults.
- 2026-10-14 (focused checks): `cmake --build packages/runtime-native/build/tn-linux --target mystral threenative-transient-attachments-test -j 4` passed. `pnpm exec vitest run packages/core/__tests__/three-patch-upgrade.spec.ts` passed 22 tests. From `packages/runtime-native`, `pnpm exec vitest run --config vitest.config.ts tests/webgpu-bindings-contract.test.mjs tests/native-contract-lane.test.mjs` passed 40 tests. Root Vitest excluded native `.test.mjs` files; passing the native config from root still selected the wrong directory, so the native checks ran from their owning package. `pnpm check:docs` passed (3089 links); `git diff --check` passed. Full `pnpm native:verify:desktop`, wgpu-native/mobile execution and starter capture/visual proof were not run in this lane.
- 2026-10-14 (existing renderer smoke, not transient eligibility): `sh scripts/xvfb.sh node packages/runtime-native/conformance/run-conformance.mjs --target web --only-tests 64-depth-precision,70-webgpu-renderer-init --out /tmp/prd565-web` generated headed browser references on the reported NVIDIA Turing adapter. `sh scripts/xvfb.sh node packages/runtime-native/conformance/run-conformance.mjs --target desktop --only-tests 64-depth-precision,70-webgpu-renderer-init --reference /tmp/prd565-web --out /tmp/prd565-conformance-final` passed both selected rows, no GPU validation errors; pixel mismatch ratios were 0 and 0.000236545 respectively. Both commands exit 2 because all 102 unselected rows are reported blocked; this is two passing rows, not a full conformance pass. An initial native-only run rendered both scenes but reported blocked until browser references were supplied. These temporary outputs are routine harness artifacts and are not a committed evidence report.
