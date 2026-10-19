---
prd_contract: v1
---

# PRD-259 — Fewer pixels must still look like the same game

**Status: DECLINED AT PHASE 0, 2026-08-30. No product code shipped.**
Repository `/home/joao/projects/threenative/threenative-engine`, remote
`https://github.com/ThreeNativeHQ/threenative.git`, branch `main`, baseline HEAD
`e8754ab24e8e227ab472690a3d8d7b6d2cd53550`. Binding charter:
[`docs/architecture/CHARTER.md`](../../architecture/CHARTER.md). Parent batch:
feature-mining.

Phase 0 closed on the first mandatory gate. On current main `fbfb3693`, both the 0.44-scale
bilinear control and catalog Three 0.185.1 `TAAUNode` passed the same browser WebGPU Bayview
playtest, but the TAAU capture was visibly softer across shutters, awnings, cables, distant
facades and the moving soldier. The earlier provenance-locked Android emulator comparison agreed:
TAAU added about 2.7–3.3 ms of render p50 over control, exceeding the rung's 2.35 ms saved-pixel
budget, while the challenger ghosted moving geometry and then stopped rendering on a repeated
`createView` error. The measured record is
[`docs/verification/prd-259-temporal-upscaling-phase-0-2026-08-30.md`](../../verification/prd-259-temporal-upscaling-phase-0-2026-08-30.md).

The kill condition fired before physical-device work. No renderer option, compatibility adapter,
generated render source or framework API survives this spike.

**Outcome if Phase 0 survives:** a real adaptive-resolution consumer renders below display
resolution and reconstructs a materially clearer output through ordinary upstream Three.js code,
unchanged on browser and native. ThreeNative owns only the platform compatibility, measurement and
history-reset seams the game cannot write portably. No `renderer.upscaling` option or framework look
preset is created.

**Complexity:** +2 three-arm visual/performance experiment, +2 temporal history and lifecycle proof,
+2 browser/native compatibility, +1 adaptive-resolution integration, +1 real-consumer gate
= **8 → HIGH mode. Mandatory automated checkpoint after every phase.**

---

## 0. Decision first — this is image-quality work, not the Bayview CPU fix

ThreeNative has already proved a real pixel-price term on physical Pixel 8: Bayview's scale ladder
measured `9.94 ms/Mpx`, monotonic with `R² 0.992`. Adaptive scaling therefore creates an honest
quality problem when it lowers the drawing buffer.

It has also proved that temporal upscaling does **not** solve Bayview's remaining frame miss. At
scale 0.32 / 0.266 Mpx the frame was 16.73 ms while the host waited only 0.29 ms for the GPU. The
fixed term was 13.79 ms, dominated by JavaScript render work plus host replay. This PRD may improve
what the reduced-resolution frame looks like; it may not be reported as removing that CPU term.

The current 0.44 → 0.32 Bayview pixel delta is 0.236 Mpx. At the measured slope it represents about
2.35 ms/frame of pixel work. Any temporal arm that costs at least that much has no performance case
for that rung, however attractive its implementation.

**Phase 0 may close this PRD as DECLINED with no product code.** Proceed only if one temporal arm:

1. runs unchanged on browser WebGPU and Android emulator native runtime;
2. visibly improves the fixed Bayview route over current bilinear presentation at scale 0.32 or
   0.44;
3. stays inside the pixel work saved by the selected lower-resolution rung; and
4. survives camera motion, moving thin geometry, disocclusion, teleport and lifecycle reset without
   persistent ghosting, black history or stale-frame presentation.

Android emulator evidence may close API, launch, screenshot and deterministic lifecycle gates. It
cannot close vendor-GPU performance, thermal or production acceptance. Physical Pixel 8 remains the
final timing gate.

---

## 1. Evidence and source read

| Source | Fact that constrains this PRD |
| --- | --- |
| `docs/PRDs/done/PRD-228-the-pixel-budget-is-the-engines.md` | ThreeNative already owns drawing-buffer scale and adaptive budgeting. Do not create a second scaler. |
| `docs/verification/runtime-perf-state.md` §1.3.5–1.3.6 | Physical Pixel 8 establishes the 9.94 ms/Mpx slope and Bayview scale ladder. |
| `docs/bugs/native-frame-is-cpu-bound-after-the-pixel-budget-2026-08-28.md` | Remaining Bayview target miss is CPU issue/draw replay, not an upscaler justification. |
| `packages/core/src/renderer.ts` | `resolutionScale`, GPU timestamps, frame reports and raw Three renderer already exist. |
| `packages/core/node_modules/three/examples/jsm/tsl/display/TAAUNode.js` | Catalog Three 0.185.1 already provides temporal AA upscaling from lower-resolution beauty/depth/velocity, requires MSAA off, owns output-sized history and uses renderer render-target APIs. |
| `pmndrs/upscaler` pinned `b5029b18baca50cb48e132bf77299c1349ae5428` | Challenger provides FSR-style temporal guides, jitter and reconstruction but reaches raw WGSL and private `renderer.backend.device` / render-target handles. MIT plus AMD FSR notice. |
| `packages/runtime-native/src/webgpu/bindings.cpp` | Required raw WebGPU method names exist, but name presence is not native execution proof. |
| `packages/runtime-native/conformance/registry.json` | Compute/storage/render-target coverage exists; temporal history and this addon are not current conformance rows. |

The pinned `pmndrs/upscaler` checkout passed 276/276 upstream tests, typecheck and build during the
feature-mining audit. That proves its own repository state, not ThreeNative native compatibility.

---

## 2. Scope and ownership

### The three Phase 0 arms

Use the same Bayview source, camera route, display size, resolution scale, adapter and steady window:

1. **Control:** current reduced-resolution presentation, no temporal reconstruction.
2. **Upstream-first:** catalog Three `TAAUNode`, with MSAA disabled as required upstream.
3. **Challenger:** `@pmndrs/upscaler`, only if the upstream arm is inadequate or fails native.

The upstream arm runs first because it uses public Three/TSL/render-target APIs. The challenger is
allowed because it may deliver better reconstruction, not because private backend access is
acceptable as a permanent contract.

### Ownership table

| Concern | Owner |
| --- | --- |
| Adaptive scale selection and frame-budget reporting | existing `@threenative/core` PRD-228 mechanism |
| Scene pass, velocity/depth production, temporal node composition and visual tuning | game-generated `src/render/` source |
| Camera route, material, lighting, MSAA choice, quality target and look | game |
| Native WebGPU/render-target/lifecycle compatibility | ThreeNative runtime/conformance |
| History reset on resize, camera teleport, scene exit, pause/resume and surface recreation | ordinary Three node when sufficient; platform seam only when native breaks it |
| Vendor GPU timing, thermal and production verdict | physical Android evidence |

---

## 3. Non-goals and hard refusals

- **No `renderer.upscaling`, quality preset enum or engine-owned visual default.** Upscaling changes
  the image and belongs in generated game render source.
- **No second adaptive scaler.** PRD-228 remains the sole drawing-buffer budget owner.
- **No Three.js fork or copied addon.** Prefer catalog `TAAUNode`; an external package remains an
  ordinary dependency unless an actual native platform seam requires a bounded adapter below Three.
- **No claim that this fixes Bayview's 13.79 ms CPU fixed term.** That bug keeps its current owner.
- **No emulator-to-phone performance promotion.** Emulator GPU timing is diagnostic only.
- **No static-screenshot-only acceptance.** Temporal defects require controlled motion and history
  disruption.
- **No WebGL-first fallback design.** The product target is current Three/WebGPU source. Unsupported
  paths fail clearly or use the existing non-temporal control.
- **No private Three backend contract in ThreeNative public API.** If the challenger requires one,
  the first outcome is an upstream/public-API issue or a declined arm, not a wrapper that blesses it.

---

## 4. Phase 0 — isolated emulator comparison

Create the spike outside the active dirty checkout or in a clean worktree rooted at the recorded
HEAD. Copy/reference the real Bayview consumer without editing its active files. Each arm must carry
a build marker in the packaged `assets/scripts/main.js` and report its exact Three/addon version.

### Required evidence

- Android API/ABI/AVD/GPU backend and `ro.kernel.qemu` recorded.
- APK install/launch proves `com.threenative.bayview`, not the conformance harness.
- Same camera transform path and fixed resolution scale for all arms.
- At least one settled still and one controlled-motion capture per arm.
- Frame p50/p95, render p50/p95 and GPU timestamp when available; emulator numbers labelled
  diagnostic.
- Static-detail crop, moving thin-geometry crop, disocclusion sequence, camera teleport and
  background/resume sequence.
- Console/logcat free of WebGPU validation errors, stale-surface errors and unhandled promises.
- Upstream TAAU arm's MSAA is observed off, not merely requested off.

### Fail-closed Phase 0 command shape

```sh
adb devices -l
adb shell getprop ro.build.version.sdk
adb shell getprop ro.product.cpu.abi
adb shell getprop ro.kernel.qemu
pnpm typecheck
pnpm build:android
adb install -r <arm.apk>
adb logcat -c
adb shell am start -W -n com.threenative.bayview/com.threenative.runtime.MystralActivity
adb exec-out screencap -p > <arm>.png
adb logcat -d > <arm>.logcat.txt
```

The actual repository scripts may replace these commands, but the output record must retain the
same identity, launch, screenshot, timing and log evidence.

---

## 5. Phase 1 — physical-device decision, only if Phase 0 survives

Run interleaved control/TAAU/challenger arms on physical Pixel 8 with the same thermal, display,
camera and frame-window discipline as PRD-228. Do not compare one hot arm to one cold arm.

Proceed to any durable game/template source only when:

- visual quality improves materially in the named crops and motion sequence;
- total frame p50/p95 does not regress beyond the measured pixel-work saving;
- history resets correctly across resize, teleport, pause/resume and surface replacement;
- the selected path uses unchanged ordinary game source on browser and native; and
- the game-owned integration is repeated enough to beat a documented generated-source threshold.

If TAAU wins, keep the solution as catalog Three source. If the challenger wins but depends on
private backend handles, record the win and leave it an ordinary dependency/compatibility issue;
do not promote private internals into the framework.

---

## 6. Integration ledger

Every `→impl` cell must resolve or be removed by a Phase 0 decline.

| # | New thing | Live caller | Replaces | Negative control |
| --- | --- | --- | --- | --- |
| 1 | Three-arm comparison harness | isolated Bayview copy/worktree `:→impl` | subjective addon selection | swap arm marker while retaining bundle → provenance gate fails |
| 2 | Catalog TAAU game composition | Bayview `src/render/upscaling.ts:→impl` if selected | bilinear reduced-resolution presentation | force history clear each frame → temporal quality gate red |
| 3 | Challenger composition | isolated arm only `:→impl` | TAAU only if measured winner | remove private backend handle → arm fails clearly, no silent control |
| 4 | Lifecycle/history proof | Android scenario `:→impl` | manual visual assumption | omit reset on resume/teleport → stale-history control red |
| 5 | Performance/quality record | `docs/verification/runtime-perf-state.md:→impl` | unsupported recommendation | delete named crop/motion evidence → report validator red |

---

## 7. Acceptance criteria

- [ ] Phase 0 either declines with evidence or packages and runs control plus catalog TAAU on Android
      emulator; challenger runs only when justified and is labelled separately.
- [ ] Every APK proves exact app id, source marker, Three version, arm and emulator identity.
- [ ] The same route, scale, display dimensions and settled window are used in all arms.
- [ ] TAAU runs with effective MSAA disabled and produces lower-resolution beauty/depth/velocity plus
      output-resolution history/resolve targets.
- [ ] Static, moving, disocclusion, teleport and lifecycle evidence exists; no still-only verdict.
- [ ] Emulator timing is labelled diagnostic and no physical-device performance claim is made from it.
- [ ] Physical Pixel 8 run is required before selecting a default or claiming frame-budget value.
- [ ] No ThreeNative public upscaling API, renderer option, Three fork or duplicated adaptive scaler is
      introduced.
- [ ] If durable code survives, it remains generated/ordinary game render source and the appearance
      can change completely without package edits.
- [ ] Runtime/core performance findings consolidate into `docs/verification/runtime-perf-state.md`.

---

## 8. Negative controls

| Gate | Mutation | Expected red |
| --- | --- | --- |
| Arm provenance | Package control bundle under TAAU filename | arm-marker/hash verification fails |
| Temporal contribution | Clear history every frame | temporal detail score/crop regresses toward control |
| Motion vectors | Zero velocity while camera/actor moves | ghosting/disocclusion sequence fails |
| Lifecycle | Suppress history reset after resume or teleport | stale frame/ghost remains above bounded frames |
| MSAA contract | Force effective sample count above one in TAAU arm | startup refuses or explicit compatibility assertion fails |
| Native compatibility | Remove one required texture-copy/render-target operation | native arm fails clearly; no silent control fallback |
| Performance honesty | Substitute emulator timing for Pixel timing | report validation rejects production verdict |

---

## 9. Borrow map

| Source | Take | Do not take |
| --- | --- | --- |
| Three 0.185.1 `examples/jsm/tsl/display/TAAUNode.js` | public TSL composition, lower-resolution pass, velocity/depth/history requirements, resize/reset semantics | example look, camera, materials, quality tuning |
| `pmndrs/upscaler` `UpscalePass.ts`, `Upscaler.ts`, temporal guide/math modules | comparison integration checklist, jitter-free velocity, explicit render/display resolutions, diagnostic timer shape | private backend handles as public contract, package API as ThreeNative vocabulary, copied AMD/FSR source without notices |
| PRD-228/runtime perf records | scale ladder, frame-window discipline, physical-device thermal/interleaving protocol | claim that image reconstruction removes CPU draw/replay cost |

---

## 10. Rollback and kill conditions

**Rollback:** remove the game-owned temporal composition and return to current reduced-resolution
presentation. PRD-228 adaptive scaling and all framework APIs remain unchanged.

**Kill when:** neither temporal arm visibly improves the named motion/still evidence; cost exceeds the
pixel work saved; native needs a Three fork or public private-backend wrapper; history cannot reset
reliably; only emulator timing is available for the final decision; or no repeated consumer crosses
the generated-source threshold.

## 11. Validation command for this planning-only filing

```sh
git diff --check -- docs/PRDs/feature-mining/PRD-259-fewer-pixels-must-still-look-like-the-same-game.md
pnpm check:docs
```

Expected: both commands exit zero. This filing changes planning documents only; it does not execute
the spike, modify Bayview, build an APK, commit, push or select an upscaler.
