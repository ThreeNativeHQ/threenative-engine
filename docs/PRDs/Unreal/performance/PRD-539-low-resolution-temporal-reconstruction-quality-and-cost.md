---
prd_contract: v1
---

# PRD-539 — A lower internal raster reconstructs into a stable full-resolution frame

**Status:** PARTIAL — levers 1 and 2 are the provider default and pass every full-resolution motion check (2026-11-03); the low-input checks stay open; successor to [PRD-455](../../done/PRD-455-temporal-reconstruction-from-dynamic-resolution.md); no reconstructor has cleared the quality gate (2026-10-07).  
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

- [x] One-variable control for the `.010` drift loss: the same reconstructor with history at 200% against 100% of output resolution, everything else equal, reports moving- and static-camera edge error for both arms. proof: `sh scripts/xvfb.sh node --import tsx scripts/verify-temporal-motion.ts` run once per arm on hardware WebGPU.
  Result 2026-11-02, nvidia/turing, `3edfb89c7` (static: `TN_STATIC_CAMERA=1`): `temporal` moving `.05648` / static `.04682` (drift loss `.0097`, reproduces PRD-455); `history200` moving `.04850` / static `.05001` (drift loss gone). History resampling is the drift loss. The static cost `.0032` stays. A first run that also switched a full-resolution input to the Gaussian gather read `.05525` / `.05311`, so the one-variable arm keeps the owned point sample.
- [x] A velocity-clamped history weight (Unreal's TSR keeps about 4 samples of history at 1 px/frame of motion) runs as one gate arm. proof: `sh scripts/xvfb.sh node --import tsx scripts/verify-temporal-motion.ts` run once per arm on hardware WebGPU.
  Result 2026-11-02, same runs: `velocity-clamp` moving `.05647` / static `.04533`. With 200% history (`history200-clamp`): moving `.04566` / static `.03850`, both under the full-resolution `<.04778` bar and under 0.95× the no-AA reference (`.04616`). Static residual instability rises (`.0079` to `.0192`). Low input: `quality-history200-clamp` `.07388` beats spatial `.07514` but is far from `<.04687`. Port: `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/PostProcess/TemporalSuperResolution.cpp:3219-3224`, `Engine/Shaders/Private/TemporalSuperResolution/TSRUpdateHistory.usf:1262-1276`.

- [ ] Thin fences, foliage, sub-pixel edges, a moving character and an instanced object stay within the pinned temporal thresholds against a full-resolution reference, and the temporal arm beats the spatial arm on the named stability metric. proof: an automated frame-sequence report records edge flicker, rejected-history ratio and image delta for full-res, low-res spatial upscale and temporal reconstruction; `sh scripts/xvfb.sh node --import tsx scripts/verify-temporal-motion.ts` exits 0 on hardware WebGPU with the original thresholds (`edge <.04778` full-res, `<.04687` low-input).
  Open. Gate run 3 (2026-11-02, nvidia/turing) added Unreal's alignment refine (`tsr` = `history200-clamp` + refine, `UE 5.8.3: Engine/Shaders/Private/TemporalSuperResolution/TSRUpdateHistory.usf:1106-1168`, kernel `TSRKernels.ush:438-446`): moving `.05962` / static `.04982`, low input `.08079`. All three are worse than `history200-clamp`, so the refine is rejected. Moving residual instability drops (`.0317` to `.0285`). The gate still exits 1 (`edgeImprovement`, `qualityEdgeImprovement`, `qualityRevealRecovery`). Gate run 4 (2026-11-03) added lever 3, Unreal's spatial anti-aliasing of rejected input (`history200-clamp-saa`: 8-step edge march, offset up to half an input texel on invalid-history pixels; `UE 5.8.3: Engine/Shaders/Private/TemporalSuperResolution/TSRSpatialAntiAliasing.ush:128-174,280-352,456-493`, `TSRUpdateHistory.usf:1093-1101`). Edge error does not change (moving `.04575`, static `.03859`), and reveal stale gets worse (moving full `.0024` against `.0003`, low input `.0204` against `.0177`). Rejected. Low-input reveal stale is `.014`-`.018` in every arm, so the 3x3 current-frame gather at the reveal edge is the likely cause, not the history weighting. As the provider default, `history200-clamp` would pass every moving-camera full-resolution check (edge `.04566` < `.04616`, stability, reveal, zero velocity), but it presents a 2x raster, so every later post stage would run at 4x pixels. Gate runs 6 and 7 (2026-11-03, nvidia/turing, `0d0d600fd` and the default commit) added the display-sized history resolve: a 4x4 Mitchell filter (B = C = 1/3) with the `1/(R+2G+B+4)` HDR weight, clamped to its 16 samples (`UE 5.8.3: Engine/Shaders/Private/TemporalSuperResolution/TSRResolveHistory.usf:82-83,312-357`, `TSRColorSpace.ush:167-195`). The chain now reads a display-sized raster, so later post stages stay at display pixels (red-green: presented `3840x2160` at a `1920x1080` display, then `1920x1080`). It also lowers edge error: `history200-clamp` moving `.04566` to `.04387`, `history200` `.04850` to `.04674`. The 100% control repeats `.05647`/`.05648` in both runs. With `history200-clamp` as the provider default, gate run 7 passes every full-resolution check (`edgeImprovement` `.04387` < `.04616`, stability `.0314` < `.0450`, reveal `.0003`, zero velocity, both negative controls, `authoredLinearEquivalent` against `history100`). It still exits 1 on `qualityEdgeImprovement` (`.07321` against `<.04532`) and `qualityRevealRecovery` (`.0175`). Neighbourhood overshoot rises from `.00015` to `.00094`, which is 18x under the no-AA reference (`.0171`). `verify-temporal-aa.ts` exits 0. Visual judge (Opus, read-only, 2 runs per arm, frames 24/30/36): full resolution IMPROVEMENT (cleaner fence bars and rod, no ghosting, halo or colour shift), low input NEUTRAL. Gate runs 8 and 9 (2026-11-03) added lever 4 as the opt-in `flicker` arm: Unreal's moire state (gradient, total variation, count, 0.95 decay on still pixels) widens the clip box by 3x the moire error (`TSRShadingAnalysis.ush:225-229,263-271,381-455,477-490,586-593`). Without the 5x5 flicker dilation it changed about 4200 pixels but no metric. With it: static full resolution edge `.03744` to `.03559` and instability `.0193` to `.0183`; low-input frame-to-frame change down 14%; but moving edge `.04387` to `.04492`, overshoot `.00094` to `.00193`, and low-input edge and reveal unchanged (`.07319`, `.0175`). Lever 4 stays an opt-in arm. Static-camera ceiling: the unclipped `quality-unchecked-history` arm keeps every sub-texel fence bar, while the clipped arms and spatial upscale lose them in moving bands, so the per-pixel clip to the low-input 3x3 box is what erases low-input detail. Unreal does not apply that clip where input and history agree at low frequency: it lerps the clamped history back to the unclamped one by `DisableHistoryClamp` (`TSRUpdateHistory.usf:1256-1257`), which is `min(RejectionClampBlend, VelocityEdge, Min3x3(HistoryUncertainty))` and 0 on disocclusion (`TSRRejectShading.usf:863`), with `RejectionClampBlend` from a median-filtered low-frequency comparison (`TSRShadingAnalysis.ush:374`). Left: that low-frequency clamp release, as lever 6.
- [ ] Newly revealed surfaces do not inherit stale colour, and disabling disocclusion rejection fails the check. proof: the same command, `revealRecovery` and `qualityRevealRecovery` true (`<=1%` stale after one frame).
  Open on low input only. Gate run 7: `revealRecovery` is true (full resolution, max `.0003`), and disabling rejection still fails it (`quality-unchecked-history` `1.0`). Low input reads `.048 .018 .002 .002 .002 .017 .002 .001` over the 8 frames after the reveal, the same in `history100`, the default and `quality-zero-velocity` (reprojection broken). A second spike at frame 5, long after any history of the occluder is gone, and no change from breaking reprojection mean the failure is not inherited history. The no-history spatial arm reads `.030`-`.066` on every frame. Crops of frames 28-35 show the cause: fence bars thinner than an input texel drop out of the low input in bands that move each frame (moire), in the spatial and the temporal arms alike, and a missing bright bar over the revealed area is what the stale metric counts. The neighbourhood clamp then discards the history that still holds the bar. That is the case lever 4 targets: Unreal relaxes rejection on pixels whose luma flickers (`TSRRejectShading.usf:466-500`), so the history keeps the bar. Lever 4 is the next arm for this box and for the low-input edge box.

### Phase 2 — Keep it only if it buys frame time

- [ ] On a GPU-bound representative game, sub-1.0 rendering plus reconstruction lowers GPU/render p95 versus full resolution while meeting the Phase 1 thresholds. proof: paired fixed-route browser WebGPU and desktop-native table of internal pixels, reconstruction cost, GPU/render p50/p95 and visual metrics (no FPS-only verdict).
  Open: no representative game yet. Same-scene calibration, 2026-11-02, gi:cornell at 1280×720, RTX 2080, shared GPU (12-72% busy from other work), 2 runs per arm:

  | Arm | Internal pixels | GPU p50 (ms) | Reconstruction p50 (ms) | Edge error vs own 100% (pan 0-60) |
  |---|---|---|---|---|
  | Unreal 5.8.3 TSR 100% (Epic, history 200%) | 1280×720 | 6.83 / 6.78 | TSR 1.81 / 1.82 | reference |
  | Unreal 5.8.3 TSR 50% | 640×360 | 4.30 / 4.64 | TSR 0.90 / 0.93 | `.00583` |
  | ThreeNative engine TRAA 100% | 1280×720 | corner 7.65-7.70 / 7.63-7.69; cornell 7.57-9.55 / 13.70-13.86 | unverified (no GPU stage split) | reference |
  | ThreeNative engine TRAA 50% | 640×360 | corner 4.60-11.18 / 3.48-3.55; cornell 2.88-3.47 / 2.78-3.78 | unverified | `.00566` |

  Unreal times the pan motion run (CSV profiler, `GPUTime` over 1 ms, `GPU/TemporalSuperResolution`). ThreeNative times the still poses (`--measure 20`, `TN_FRAME_BUDGET` gpu window p50). Distance to Unreal is the same at both scales (mean absolute error `.0277` at 100%, `.0274` at 50%). Sheets: branch `prd-539-screenshots`, `benchmark-cornell-pan/`. The 50% capture needed one engine fix: the lamp shadow-map size now reads the unjittered camera. Before it, TRAA jitter flipped the cornell lamp between two mips every frame and the Wasm engine lost the device in 120 frames (red-green `lamp_size_ignores_temporal_jitter`; visual judge NEUTRAL, mean absolute error `.0002` over 180 frames).
- [ ] Automatic resolution moves between at least three scales in one run without history corruption, allocation growth or a reconstruction cost spike larger than the saved raster cost. proof: scripted scaler route recording transitions, history resets, render-target allocation count and per-stage cost; repeated cycles end at the initial allocation baseline.

## Decisions

- The thresholds and the 31-arm corpus carry over unchanged; a candidate that needs them relaxed is rejected, not merged.
- Candidates already falsified (do not repeat): reactive mask, raw4 current-footprint weighting, variance-clip widening, and a rejection-fraction metric (it is velocity-blind; see PRD-269).
- CI: `verify-temporal-motion.ts` is not in CI today (its hardware Vulkan flags lose the device on the GPU-less runner, and four checks fail by design). Phase 1 includes returning it to the `temporal` integration job, with the unmet checks fail-closed once they pass.
- Ghosting margin to keep honest: the pinned moving-edge ratios (`<=.75`, `>=1.25x`) sit against measured `.629`/`.651` and `1.485`/`1.435` (hardware/CI).
- First step for the owner of this PRD: explain the `.010` camera-drift loss (history resampling) with a one-variable control before designing the next reconstructor.
- 2026-10-09 (João, via the Unreal source review): that one-variable control is history resolution, 200% against 100% (Unreal TSR lever 1 above). Its box is now the first box of Phase 1. Levers 2–4 follow in the listed order as gate arms. No existing box changed.
- 2026-10-12 (Unreal source review): corrected lever 4. Flicker detection relaxes history rejection to ghost within a luma bound, it does not add rejection. Also corrected the tier defaults for levers 1, 3 and 5. No box changed.
- 2026-11-03 (gate runs 3 and 4): the alignment-refine and rejection-anti-aliasing arms are deleted from the provider and the gate, with their numbers kept in Phase 1. `history200-clamp` stays an opt-in arm until the provider resolves the 2x history to a display-sized raster. No box changed.
- 2026-11-03 (gate runs 6 and 7, visual judge IMPROVEMENT): the provider default is Unreal's Epic tier, 200% history with the velocity clamp, presented through the Mitchell resolve. `{ historyScale: 1, velocityWeightClamp: false }` is the named override and the `history100` gate arm. The raw4 path keeps 100%, because it was measured only there. The provider's own GPU cost for the 2x history is unverified. No box changed.
- 2026-11-03 (gate runs 8 and 9): lever 4 is deferred, not declined. It reduces flicker but leaves both low-input checks unchanged and costs full-resolution moving edge `+2.4%`. Revisit it after lever 6 keeps low-input history detail, because then the flicker it damps is the remaining error. No box changed.
- 2026-10-19 (PRD-631 reference plan): Unreal's desktop default anti-aliasing is TSR (`r.AntiAliasingMethod=4`, `Engine/Source/Runtime/Engine/Private/SceneView.cpp:235`), with 200% history at Epic. The templates use SMAA. A reconstructor that this PRD keeps becomes the desktop `high` default only after it passes the L9 row of [PRD-631](../../done/PRD-631-an-unreal-reference-scene-measures-the-default-look.md) and this PRD's motion thresholds. [PRD-636](../look/PRD-636-the-finishing-post-chain-matches-unreal-defaults.md) owns the rest of L9. No box changed.
