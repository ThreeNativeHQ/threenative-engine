---
prd_contract: v1
---

# PRD-539 — A lower internal raster reconstructs into a stable full-resolution frame

**Status:** NOT STARTED — successor to [PRD-455](../../done/PRD-455-temporal-reconstruction-from-dynamic-resolution.md); no reconstructor has cleared the quality gate (2026-10-07).  
**Priority:** P1 — Carried over unchanged from PRD-455, whose own note ranked it the highest-value rendering project; the owner may lower it.  
**Complexity:** 8 → HIGH. Five candidates failed the same gate on hardware; the next one is a new design, not a parameter change.  
**Numbering:** filed in #398 as PRD-537; #464 took that number for the far-hills PRD first, so this PRD is PRD-539 (2026-10-08).  
**Depends on:** PRD-455 (opt-in provider, lifecycle, fixture and 31-arm corpus) and PRD-269 (motion history).

## Problem

PRD-455 shipped full-resolution temporal AA as opt-in generated source and the corpus that judges reconstruction. Every low-resolution candidate then failed the unchanged gate on nvidia/turing hardware WebGPU:

| Evidence (2026-10-07) | Result |
| --- | --- |
| Full-res edge, moving camera | `.05849` against no-AA `.05029`, needs `<.04778` |
| Full-res edge, static camera | `.04847` against `.05245`, a 7.6% gain, still `.0007` short |
| Low-input edge | `.08062` against spatial `.07745`, needs `<.04687` (static: `.08132` against `.06930`) |
| Reveal stale after +1 frame | motion `1.77%`, quality `4.89%`, needs `<=1%` |
| Variance-clip gamma `[0.75,1.25]`, `[1,1.5]` | edge `.05822`, `.05803`; no check moves |

Localization: accumulation works when the camera is static, and sub-pixel camera drift costs about `.010` of edge error through reprojection and resampling. Clipping, the reactive mask and the raw4 current-footprint candidate are not the lever. A 426×240 input does not recover native-resolution edge accuracy in this metric.

## Unreal TSR levers not yet tried (UE 5.8.3, read 2026-10-09)

Unreal's TSR attacks the same failure. Only the levers outside this PRD's "do not repeat" list are
named here. Catmull–Rom history sampling is not a new lever: TSR also uses it
(`UE 5.8.3: Engine/Shaders/Private/TemporalSuperResolution/TSRUpdateHistory.usf:952-975`), and
PRD-455 already compared it. Paths are under `Engine/Source/Runtime/Renderer/Private/PostProcess/TemporalSuperResolution.cpp`
unless named otherwise. Order is by fit to the measured localization above.

1. **History stored above output resolution.** `r.TSR.History.ScreenPercentage` (`:54-60`) keeps the
   history at 100–200% of the *output* resolution. The default is 100. The scalability groups set 200 at the Epic and Cinematic tiers
   (`UE 5.8.3: Engine/Config/BaseScalability.ini:89` and `:100`).
   The stated reason is sampling-theorem headroom: details survive repeated reprojection without the
   resampling blur that each bilinear or bicubic fetch adds. A resolve pass
   (`TSRResolveHistory.usf`) filters the history down to output. This targets the `.010` drift loss
   directly. The cost is 4× history memory and bandwidth, which Unreal offsets by storing history
   as R11G11B10 (`:63-73`, default 1).
2. **Velocity-clamped history weight.** When an output pixel moves at 1 px/frame or more, the
   history's accumulated sample count is clamped to 4 (`r.TSR.Velocity.WeightClampingSampleCount`
   and `...PixelSpeed`, `:310-330`). The default history cap is 16 (`:45-50`). The clamp applies to history pixels, so it is less visible at lever 1's 200% history
   (`:309-321`). Test levers 1 and 2 together. This trades a little
   stability for less successive-convolution blur during motion. That is the moving-camera edge
   check, which is worse than no-AA today.
3. **Spatial anti-aliasing of rejected input.** Where history is rejected, TSR runs a built-in
   spatial anti-aliaser on the low-resolution input (`r.TSR.RejectionAntiAliasingQuality`, cvar default 3, set to 0 at the lowest tier and to 1 or 2 above it by
   `UE 5.8.3: Engine/Config/BaseScalability.ini:59-104`, `:233-246`; `Engine/Shaders/Private/TemporalSuperResolution/TSRSpatialAntiAliasing.usf`).
   This targets the low-input edge and reveal checks. The low-input arm currently loses to plain
   spatial upscale.
4. **Flicker-aware shading rejection.** TSR measures luma flicker over a period of about 2 frames,
   and relaxes history rejection on pixels that flicker, so the history ghosts inside a luma bound instead of resetting
   (`r.TSR.ShadingRejection.Flickering`, cvar default 1, off at the Low and Medium tiers, `:137-200`, period default 2 frames at `:188`;
   `TSRMeasureFlickeringLuma.usf`; the moire error in `UE 5.8.3: Engine/Shaders/Private/TemporalSuperResolution/TSRRejectShading.usf:466-500`). This is not variance-clip widening,
   which is already falsified.
5. **Not recommended as a default:** thin-geometry detection (`r.TSR.ThinGeometryDetection`, `:332`)
   and the reprojection field (`r.TSR.ReprojectionField`, `:290`) are **off** in the cvar defaults.
   The reprojection field is on at the High tier and above through scalability (`BaseScalability.ini:82`), and thin-geometry detection turns on
   with Nanite foliage. Try them only after 1–4.

Each candidate is one arm in the unchanged gate, never a threshold change.

## Outcome

One reconstructor that, at a sub-1.0 internal raster, produces a stable display-resolution image during motion, lowers measured GPU/render time, and degrades safely when history cannot be trusted. If it cannot beat full resolution after its own cost, it stays opt-in.

### Phase 1 — A reconstructor that clears the unchanged quality gate

- [ ] One-variable control for the `.010` drift loss: the same reconstructor with history at 200% against 100% of output resolution, everything else equal, reports moving- and static-camera edge error for both arms. proof: `sh scripts/xvfb.sh node --import tsx scripts/verify-temporal-motion.ts` run once per arm on hardware WebGPU.

- [ ] Thin fences, foliage, sub-pixel edges, a moving character and an instanced object stay within the pinned temporal thresholds against a full-resolution reference, and the temporal arm beats the spatial arm on the named stability metric. proof: an automated frame-sequence report records edge flicker, rejected-history ratio and image delta for full-res, low-res spatial upscale and temporal reconstruction; `sh scripts/xvfb.sh node --import tsx scripts/verify-temporal-motion.ts` exits 0 on hardware WebGPU with the original thresholds (`edge <.04778` full-res, `<.04687` low-input).
- [ ] Newly revealed surfaces do not inherit stale colour, and disabling disocclusion rejection fails the check. proof: the same command, `revealRecovery` and `qualityRevealRecovery` true (`<=1%` stale after one frame).

### Phase 2 — Keep it only if it buys frame time

- [ ] On a GPU-bound representative game, sub-1.0 rendering plus reconstruction lowers GPU/render p95 versus full resolution while meeting the Phase 1 thresholds. proof: paired fixed-route browser WebGPU and desktop-native table of internal pixels, reconstruction cost, GPU/render p50/p95 and visual metrics (no FPS-only verdict).
- [ ] Automatic resolution moves between at least three scales in one run without history corruption, allocation growth or a reconstruction cost spike larger than the saved raster cost. proof: scripted scaler route recording transitions, history resets, render-target allocation count and per-stage cost; repeated cycles end at the initial allocation baseline.

## Decisions

- The thresholds and the 31-arm corpus carry over unchanged; a candidate that needs them relaxed is rejected, not merged.
- Candidates already falsified (do not repeat): reactive mask, raw4 current-footprint weighting, variance-clip widening, and a rejection-fraction metric (it is velocity-blind; see PRD-269).
- CI: `verify-temporal-motion.ts` is not in CI today (its hardware Vulkan flags lose the device on the GPU-less runner, and four checks fail by design). Phase 1 includes returning it to the `temporal` integration job, with the unmet checks fail-closed once they pass.
- Ghosting margin to keep honest: the pinned moving-edge ratios (`<=.75`, `>=1.25x`) sit against measured `.629`/`.651` and `1.485`/`1.435` (hardware/CI).
- First step for the owner of this PRD: explain the `.010` camera-drift loss (history resampling) with a one-variable control before designing the next reconstructor.
- 2026-10-09 (João, via the Unreal source review): that one-variable control is history resolution, 200% against 100% (Unreal TSR lever 1 above). Its box is now the first box of Phase 1. Levers 2–4 follow in the listed order as gate arms. No existing box changed.
- 2026-10-12 (Unreal source review): corrected lever 4. Flicker detection relaxes history rejection to ghost within a luma bound, it does not add rejection. Also corrected the tier defaults for levers 1, 3 and 5. No box changed.
- 2026-10-19 (PRD-631 reference plan): Unreal's desktop default anti-aliasing is TSR (`r.AntiAliasingMethod=4`, `Engine/Source/Runtime/Engine/Private/SceneView.cpp:235`), with 200% history at Epic. The templates use SMAA. A reconstructor that this PRD keeps becomes the desktop `high` default only after it passes the L9 row of [PRD-631](../look/PRD-631-an-unreal-reference-scene-measures-the-default-look.md) and this PRD's motion thresholds. [PRD-636](../look/PRD-636-the-finishing-post-chain-matches-unreal-defaults.md) owns the rest of L9. No box changed.
