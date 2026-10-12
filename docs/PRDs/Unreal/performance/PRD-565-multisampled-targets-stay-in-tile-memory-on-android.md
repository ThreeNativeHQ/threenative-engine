# PRD-565 — Multisampled targets stay in tile memory on the Android host

**Status:** NOT STARTED
**Priority:** P2 — All boxes are open: the native host allocates and stores every 4× MSAA attachment in memory; no measurement shows yet what a transient attachment saves on a Mali or Adreno phone.
**Complexity:** 3 (LOW) — 1–5 host files (1), crosses into the Dawn-on-Android build that PRD-329 owns (+2); risk override: none
**Owner:** João (device runs), agent (implementation)
**Depends on:** [PRD-329](../../performance/critical/PRD-329-the-native-gpu-frame-matches-chrome-at-matched-pixels.md) Phase 2 (the Dawn-on-Android build). This PRD feeds PRD-329 Phase 3's MSAA arm with one specific lever; it does not repeat that arm's `sampleCount 4` resolve-path pair.

## Context

A tile-based GPU (Mali, Adreno) renders each screen tile in on-chip memory. A 4× multisampled
colour or depth attachment that the frame resolves and never reads again does not need to exist in
main memory at all. If the API marks it transient, the driver keeps the samples on chip and never
writes them out. PRD-228 already noted that the Mali-G715 resolves MSAA in tile memory
(`docs/PRDs/done/PRD-228-the-pixel-budget-is-the-engines.md:147`).

The host does not mark anything transient today:

- No `TransientAttachment` usage, memoryless or lazily allocated texture exists in
  `packages/runtime-native/src` (searched `TransientAttachment`, `memoryless`, `lazily`).
- Android's product backend is wgpu-native (`packages/runtime-native/CMakeLists.txt:291-296`),
  pinned at `v25.0.2.2` (`third_party/wgpu-android/.threenative-wgpu.json`). Its headers have no
  transient usage flag (searched `third_party/wgpu-android/aarch64/include/webgpu/*.h`).
- The Dawn headers the host already builds against have the feature and the usage:
  `WGPUFeatureName_TransientAttachments` and `WGPUTextureUsage_TransientAttachment`
  (`third_party/dawn/dawn-headers/include/dawn/webgpu.h:562`, `:1225`). Dawn on Android is
  PRD-329's arm64 spike (`CMakeLists.txt:112-121`).

**What Unreal does (UE 5.8.3, ideas only, no code copied):**

- The mobile renderer sets `bMemorylessMSAA` when the scene renders in a single pass: no
  multi-pass, no editor composite, no separate view pass
  (`Engine/Source/Runtime/Renderer/Private/MobileShadingRenderer.cpp:744-745`).
- With more than one sample and `bMemorylessMSAA`, the scene's multisampled targets get the
  memoryless flag (`Engine/Source/Runtime/Renderer/Private/SceneTextures.cpp:805-810`).
- A depth target with the memoryless flag gets no store action
  (`Engine/Source/Runtime/Renderer/Private/MeshPassProcessor.cpp:2245`), and later passes skip any
  copy from a memoryless texture (`SceneTextures.cpp:1032`, `:1303-1346`).

## Solution

The decision is host mechanism, invisible to the game and to three:

1. When the device grants `TransientAttachments`, the host's `createTexture` binding adds
   `TransientAttachment` to a texture whose usage is exactly `RenderAttachment` and whose sample
   count is above 1. That texture is never sampled or copied, so nothing can read its contents.
2. A render pass that uses such a texture gets `storeOp: discard` for it. Its resolve target keeps
   `store`. The host rewrites the store op only for the transient texture.
3. A depth texture stays stored when any chain stage samples scene depth (AO, SSR, SSGI, velocity
   all do). The host can see that from the usage: a sampled depth texture has
   `TextureBinding` and is never made transient. Unreal's single-pass condition maps to the same
   rule.
4. Report `TN_TRANSIENT_ATTACHMENTS` once: granted or not, how many textures are transient, and the
   bytes they would otherwise occupy.

On wgpu-native, or with the feature not granted, nothing changes.

## Acceptance Criteria

- [ ] AC-1 [local]: The native desktop host on Dawn with the feature granted renders the starter with 4× MSAA, transient attachments on, no validation error, and a capture equal to the feature-off capture. proof: `pnpm native:verify:desktop` plus a feature-off/feature-on capture pair. — Evidence: pending.

## Blocked on

- The win itself (GPU time and memory bandwidth per frame on a Mali or Adreno phone, feature on against feature off, same session) needs a physical arm64 device and PRD-329's Dawn-on-Android APK. The x86_64 emulator neither runs the arm64 Dawn spike nor models tile memory. Only `emulator-5554` was attached on 2026-10-09. — unblocked by João attaching the Pixel 8 and PRD-329 Phase 2 producing the Dawn APK. A result under 0.5 ms and no memory gain records a decline under `## Decisions` and leaves the code off.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Transient MSAA attachment | three `WebGPUBackend` texture creation → host `createTexture` binding (`src/webgpu/bindings_resources.cpp`) | Ordinary allocation stays when the feature is absent | AC-1 |

## Execution Phases

#### Phase 1: Mark and discard
**Status:** NOT STARTED
**Files:** `packages/runtime-native/src/webgpu/context.cpp` (request the feature), `packages/runtime-native/src/webgpu/bindings_resources.cpp` (usage), the render-pass binding (store op); a host contract test
- [ ] With the feature granted, a multisampled render-only texture is created transient and its pass stores `discard`; a sampled depth texture and every texture without the feature stay unchanged. proof: a host contract-test executable over the binding, red-green.
- [ ] `TN_TRANSIENT_ATTACHMENTS` reports granted state, count and bytes. proof: the same contract test reads the line.

#### Phase 2: Prove on desktop Dawn
**Status:** NOT STARTED
**Files:** none beyond Phase 1
- [ ] AC-1's capture pair and validation-clean run. proof: `pnpm native:verify:desktop`, both captures recorded here.

## Decisions

- 2026-10-09 (João, via the Unreal review request): filed separately from PRD-329. PRD-329 is a four-phase critical PRD whose MSAA arm compares resolve paths; this lever is one host rule with its own on/off gate, and adding it there would break the three-phase cap (R5).
