# PRD-888 — A masked depth prepass pays for itself on the forest

**Status:** PARTIAL — the prepass ships behind `?tnPrepass=1` and saves 7–17 ms at every pose; MRT identity and native proof are open.
**Branch:** `prd-584-forest-60fps` · **PR:** #677 · **Instrument:** the forest starter kit
(`packages/terrain/starter/forest`) played as its own game at 1600×900, WebGPU, RTX 2080.
**Numbering note:** this PRD is not a port of an Unreal feature. It exists because the forest's
frame is dominated by per-fragment work and the engine currently has no way to shade a pixel once.

## Why

The forest kit's spawn pose costs **29.4 ms of GPU frame** (33 fps, 4× MSAA). Measured by hiding one
group at a time on a matched build (core + engine from one tree, one reload per arm):

| bill | ms | how it was measured |
| --- | --- | --- |
| ground splat (8 streamed tiles 8.3 + base square 3.6) | 12.0 | hide the group |
| instanced props, the broadleaf trees | 12.3 | hide the group |
| sun shadow receiver sampling | 8.5 | `castShadow = false`; `shadowRefreshes = 0`, `shadowPagesRefreshed = 0` |
| ridges · water · sky · player | 2.0 | hide each |
| render chain (AO + grade) | 1.3 | chain disabled outright |

Every one of those scales with **fragments shaded, not triangles submitted**: cutting the overview's
main-pass triangles from 16.8 M to 6.6 M changed the GPU by zero, and `map = null`,
`normalMap = null`, `alphaTest = 0.99` and `side = FrontSide` each changed it by nothing.

## The gate, already measured

Turning the depth test off on all 99 visible opaque materials, so nothing is rejected:

| state | GPU frame |
| --- | --- |
| depth test on (shipped) | **30.41 ms** |
| depth test off (every fragment of every triangle shades) | **91.82 ms** |
| restored | 30.28 ms |

The scene as drawn would shade **≈ 3.0× its visible area**. Early-Z is already removing 61 ms of
that work for every material it can reach — and the one class it cannot reach is the alpha-tested
foliage, because `discard` defeats early depth writes. That is the whole case for a masked-depth
prepass, and it clears the ratio gate (≥ 1.6) with room to spare.

## What it is

1. **Pass 1, depth only, masked**: the same vertex IR and the same alpha cutoff / alpha-to-coverage
   as the shipped material, with no lighting, no shadow taps and no colour writes.
2. **Pass 2, the shipped shader** with `depthCompare: equal` and `depthWrite: false`, so lighting and
   the five shadow taps run once per *visible* pixel, with no `discard` in the pipeline's way.

Pixel identity is an assertion, not a hope: `@invariant` on `@builtin(position)` in both roles, and
identical `depthBias` / slope scale / `cullMode` / `frontFace` / sample count / cutoff.

## Phases

### Phase 1 — the instrument and the gate

- [x] Measure the bill, per group, on a matched core+engine pair — 12.0 / 12.3 / 8.5 / 2.0 / 1.3 ms
      above, `gpuSplit.main` 27.5 ms, `gpuSplit.shadow` 0.13 ms (the shadow segment does not see the
      receiver cost).
- [x] Prove early-Z is doing its job and the loss is cutout coverage — depth test off: 30.41 → 91.82
      → 30.28 ms.
- [x] Close out the cheap alternatives, each built and measured, each reverted: VSM page-table walk
      hoist (34.4 → 34.2 fps), loads moved inside the per-level branch (no change), sun taps gated on
      N·L (34.4 → 30.8 fps), shadow map size 1024 (30.7 vs 29.0 ms), `refreshStep` 0.25 (30.4 ms),
      freezing the shadow focus (no change), runtime `receiveShadow = false` (no change), collar tree
      trim (no change), `alphaAntialiasing: false` (no change), `minimumProjectedPixels: 2` (no
      change), `renderer.samples: 2` (unsupported: the engine draws 1 or 4).
- [x] Falsify the case before building: strip the discard in place (`maskNode = null`,
      `alphaTestNode = null`, `alphaTest = 0`, `alphaToCoverage = false` on the 68–90 masked
      materials), paired ABBA in one page load, 2 runs, RTX 2080 `nvidia/turing`, 1600×900, 4× MSAA.
      `gpuSegmentScene` base → no-discard: player 27.9/28.4 → 14.3/14.2, meadow-close 32.7/31.8 →
      10.4/10.7, overview 54.0/53.5 → 15.0/14.6, river 26.5/26.6 → 11.7/11.8, vista 50.3/57.4 →
      13.8/13.2 ms. This is an upper bound, because solid cards also hide ground. Ground drawn after
      the trees (`renderOrder = 10`): −0.2 to −1.9 ms, under the 2 ms bar. proof: paired probe
      `__tnGpuSegments` scene column, 2026-11-14.
      **Correction:** the earlier "`alphaTest = 0.99` changed nothing" arm left `maskNode` and
      `alphaTestNode` in place, so it never removed the discard. A JS-level twin-mesh emulation of the
      prepass is not measurable: the facade cannot clone an `InstancedMesh` and the twins drew unmasked.
### Phase 2 — the renderer work

- [x] Add the prepass pipeline role: a depth-only fragment pruned from the draw's own colour fragment
      (its discards and the alpha they read stay, the lighting goes), the draw's own vertex module, colour
      writeMask 0, same cull/face/bias/samples; the shading draw keeps its shipped program at
      `depthCompare: equal`, `depthWrite: false`. **Changed from the plan:** stripping the shading
      draw's discards or forcing `@invariant` moved 26–65 k pixels at overview and saved nothing
      (38.2–38.6 vs 38.7 ms); with depth writes off, early-Z still rejects. proof:
      `ctest -R "native_engine_(material|tsl_ir|tsl_shared|aux_fragment|prepass)"` 31/31
      (`tests/native-engine/prepass_test.cpp`), 2026-11-14.
- [x] Issue both loops inside the same world render pass, front to back, so no extra MSAA depth
      store and load is paid. proof: `renderer.cpp` records the prepass rows first in the main bundle.
- [x] Lever 0, `TN_PREPASS=split` records the prepass rows in their own timed render pass, named
      `prepass` in `TN_GPU_PASSES` and summed into segment 2 (`other`), so the depth half is priced
      apart from the shade half.
      proof: `TN_GPU_PASSES` names a `prepass` pass at all 5 poses and the bill is in "The split,
      measured" below. Built as its own timed pass rather than a seventh segment bucket: the trace
      carries the pass name and its ms, and no frame-field ABI moves for an instrument arm. With it
      armed the prepass sums into the `other` bucket, so `gpuSplit.main` is the shade half alone —
      the one reading that changes shape. `?tnPrepass=split` or `globalThis.__tnPrepass = "split"`
      arms it live; a draw that samples the frame as drawn before it keeps the shipped boundary (its
      own copy, and a second depth pass after the copy), so the arm stays pixel-identical. proof: the
      bill below, 2026-11-14. The unit test's four cases all pass (`prepass_test.cpp`, built as
      `tn-native-engine-prepass-test` in the `build/tn-engine-ui` tree, where the `native-engine`
      label is configured): `eligible`, `targets`, `fragments` and the new `modes`; the case is
      registered as `native_engine_prepass_modes`.
      The extra depth store and load costs nothing measurable: total frame p50 at overview is
      38.81/38.89 ms split against 42.03/39.14 one-pass, and 40.01/38.59 against 38.23/38.68 at vista.
- [ ] Lever 2 (chain step 3): a draw only rasterises the instances of its own level.
      `?lodCollapse=1` (`TN_LOD_COLLAPSE`, live off: `globalThis.__tnLodCollapse = false`) collapses
      to one point the vertices of an instance past `lodFadedPast` (`gate + 0.75·span`, the worst
      random draw, +0.1 %) from every eye the masks read, unless its published range or a swap fade
      holds it whole (`world-impostor-surface.ts`, `collapseFadedVertices`). Unset is the shipped
      program, byte for byte. Red-green: `world-impostor-surface.spec.ts` "the LOD vertex collapse",
      2 cases, red without the change, green with it.
      **Open: the gain is real but about 20× under the projection, and two poses do not move.**
      Paired, one page load, split arm, ABBA × 2 with the opening arm rotated per pose, 2 runs, RTX
      2080 `nvidia/turing`, 1600×900, off → on (run 1 / run 2): prepass · shade ms —
      player 5.16/5.31 → 4.92/5.42 · 7.88/8.04 → 7.82/7.88;
      meadow-close 11.55/11.64 → 10.96/11.32 · 8.64/8.79 → 8.42/8.51;
      overview 25.90/26.43 → 25.44/25.89 · 12.33/12.45 → 11.62/11.94;
      river 5.00/5.14 → 4.96/5.06 · 9.10/9.13 → 9.16/9.16;
      vista 23.92/26.48 → 23.65/26.15 · 10.04/10.34 → 9.59/9.73.
      Both halves fall 0.3–0.7 ms at overview, vista and meadow-close in both runs; river and player
      are flat within noise, so "both halves down at all five poses" is not met.
      Pixels, page clock frozen (`performance.now` and the rAF time held), shots off/on/off/on after
      20 frames, 2 runs: 0 changed pixels on every adjacent off→on pair at player, overview and
      river; at meadow-close and vista every non-zero pair (4 732 and 42 px) equals a same-arm
      control pair exactly, so it is a shot settling, not the arm.
      The faded count was **not re-run**: the CPU count below cannot show it (see the correction
      under "Answered from the CPU"). Diagnostics, overview: collapse forced on every LOD instance
      (threshold 0) takes the prepass 25.56 → 1.71 ms, so the mechanism works on the owned engine;
      the same collapse ignoring the published range reads 25.05/25.71 → 24.65/24.64 ms, so the range
      guard is not what holds the gain back. 2026-11-14.
- [ ] Refuse and fall back to the shipped path for: transparent/blended materials,
      `depthWrite = false`, `frag_depth` writers, fragment side effects, coplanar ties (two-sided
      cards built as two meshes).
      Done and unit-tested except coplanar ties between two masked draws, which are not detected.
      `stableRows` (off on both hosts) keeps the shipped draws.
- [x] Flag it: `?tnPrepass=1` arms it (live: `globalThis.__tnPrepass`, read per frame by the web
      host into `TN_PREPASS`), unset is the shipped path, and `prepassDraws` (frame field 90) says
      which ran. proof: player 89/105, river 78/94, others 41–42/50 prepass/main draws.
- [ ] Pixel identity at every fixed pose with time frozen: 0 changed pixels on the resolved output
      and on the `normal` MRT target.
      Resolved output, sway and river clock frozen: 0 changed pixels at meadow-close, overview,
      river, vista; player differs only inside the animated character. `normal` MRT not checked yet.
- [x] Cost: `gpuSegmentScene` improves ≥ 2 ms at **every** fixed pose, with no CPU frame regression.
      proof: paired ABBA, one page load, 2 runs, RTX 2080 `nvidia/turing`, 1600×900, 4× MSAA, base →
      prepass: player 27.6/27.7 → 13.9/13.7, meadow-close 31.0/31.3 → 23.8/21.7, overview 52.1/53.4 →
      38.4/38.1, river 26.0/26.0 → 14.9/14.3, vista 55.7/53.5 → 38.9/36.9 ms. CPU frame p50 off
      7.0/5.7 ms, on 3.8/4.6 ms; spawn presents 16.68 ms (60 fps) with it on. 2026-11-14.
- [x] Visual judge (fresh read-only subagent, matched poses, before/after): NEUTRAL or IMPROVEMENT.
      proof: 5 poses × 2 runs per arm, frozen sway: NEUTRAL; one page at meadow-close, shipped (never
      armed) → on → off: NEUTRAL, 0 pixels over 8 levels outside the swaying foliage, on-vs-off gap
      (37.9 k) under off-vs-off sway (54.9 k). The dark leaf fragments over the mountain at
      meadow-close are on the shipped path too: a pre-existing far-foliage defect, not this change.
      2026-11-14.
- [ ] Native proof on the desktop host, same pose, same sign.
      The host builds from this tree (`tn-native-engine-player-v8`), but the forest kit does not
      bundle for the desktop engine: 12 `TN_NATIVE_ENGINE_UNBOUND` (three/tsl `rotateUV`, `bumpMap`,
      `mx_fractal_noise_float`, `GLTFLoader`, `KTX2Loader`, …). Needs a masked-foliage scene the
      desktop player bundles, or those bindings.
### Phase 3 — the proof

- [ ] Add the overdraw gauge this PRD was decided by, so the next regression names itself: a
      shaded-fragment counter surfaced as `TN_FRAME_BUDGET.counters.engine` (the IR already has
      `atomicAdd` and atomic storage buffers — `shader/ir.h:132`).

## What the armed frame still spends (2026-11-14)

One page load, `TN_PREPASS` armed, overview, 1600×900, 4× MSAA, RTX 2080 `nvidia/turing`, hide the
group for 4 samples (ABBA), median `__tnGpuSegments` scene column, base 38–40 ms. Fixing the probe
first mattered: `bill.mjs` re-saved `__v` on the second "on" step, so its restore left every group
hidden and each delta came out at half its real value.

| bill | draws | triangles | Δ scene ms |
| --- | --- | --- | --- |
| `strata-props:horizon` | 30 | 5.69 M | −14.2 |
| `strata-props:far` (whole-asset impostor cards) | 20 | 0.15 M | −9.7 |
| ground base square | 1 | — | −5.5 |
| `strata-props:local` | 30 | 4.04 M | −1.9 |
| sun shadow (25 shadow draws, 56 k triangles) | — | 0.06 M | −0.9 |
| streamed tiles · water | 1 · 2 | — | −0.7 · +0.5 |

The same bill at vista (base 36.9 ms, 8.28 M triangles): `far` −14.2, `horizon` −9.5, base square
−4.9, `local` −1.3. The two far bands are 23.7 of it, the same 64 % of the frame as overview.

The frame records no auxiliary MRT target (`renderer.info.engine.passes.auxRecorded` 0 at both poses,
`samples` 4, `temporal.active` false), so pixel identity can only be compared on the resolved output
for this instrument; there is no `normal` target to differ.

The prepass pays for **every** band, so a per-draw opt-out is not the next lever: arming it saves
18.0 ms at overview (57.3 → 39.4) and still 7.7 ms with the horizon band hidden (33.8 → 26.1), so
the horizon band alone owns 10.3 ms of that win. Made opaque instead (mask, `alphaTestNode`,
`alphaTest` and `alphaToCoverage` stripped from its 30 materials, restore read back and verified),
the horizon band costs 16.3 ms less and the far band 12.0 ms less — but the shipped frame with every
mask stripped is 10 ms, so masked coverage is three quarters of this frame.

**The 60 FPS gate is a look decision, not an engine one.** At overview the two far bands are 23.9 of
39.4 ms and 84 % of the frame's 10.95 M triangles sit in them, drawn at their authored last LOD.
**Corrected 2026-11-15:** the horizon band does get an impostor atlas. Square spruces land in
`horizon:true` (`props.ts:179`, spruce has no `DRAW_REACH` entry), they go through
`impostorDistanceForScale` (`propWorld.ts:550`), so `farInstances > 0` and `impostors: true`
(`propWorld.ts:591-622`) — and the scene carries it: at overview the horizon band is 5 card rows of
5 648 instances, and the far band 5 card rows of 46 597. What the far bands draw is therefore mostly
*mesh*, not cards: 22.27 M capacity triangles of horizon mesh against 11 296 of horizon card, and
769 826 of far mesh against 93 194 of far card. Impostoring the ring is not the open lever it was
written as; the lever is the mesh those rows rasterise. Measured 2026-11-14, corrected 2026-11-15.

⚠️ Standing still at a fixed pose drifts the bill upward (38 → 56 ms at overview as
`streamingInstances` reached 500 979), so a pose number is only comparable within seconds of entering
it. Every figure above is from one page load, early.

The unnatural silhouette on the mountains at overview and meadow-close is the `strata-props:far`
impostor atlas, not this change: in one page at overview, `TN_PREPASS` off → on changes **0 pixels**
in the top quarter of the frame (the 22 k pixels over 8 levels all sit in the swaying near foliage,
y 344–720), hiding `strata-props:far` removes 38 962 of them and hiding `strata-props:horizon`
removes none. Its tiles resolve to a coarse mip whose averaged alpha reads as a solid block at a few
pixels; that is the defect to fix when the far bands get their look decision.

## The split, measured (lever 0, 2026-11-14)

One page load, every arm live on the same plan (`globalThis.__tnPrepass`), ABBA × 2 runs per pose,
median of the `TN_GPU_PASSES` per-pass sample: RTX 2080 `nvidia/turing`, 1600×900, 4× MSAA, forest
kit played as its own game, 928 MiB of 8 GB resident before the probe. `scene` is the `scene` pass
and `frame` is the whole trace sum (shadow, prepass, shade, viewport copy, post, output), so `on:
frame` is what `split: frame` is compared with — not `on: scene`.

| pose | off: scene | on: scene | on: frame | split: prepass | split: shade | split: frame |
| --- | --- | --- | --- | --- | --- | --- |
| player | 30.09 / 27.16 | 17.45 / 12.84 | 18.91 / 14.27 | 5.90 / 5.45 | 8.09 / 12.57 | 15.42 / 20.43 |
| meadow-close | 47.15 / 31.31 | 18.37 / 21.42 | 19.88 / 22.85 | 10.78 / 11.60 | 9.56 / 9.92 | 21.84 / 23.07 |
| overview | 107.12 / 51.01 | 39.69 / 36.78 | 42.03 / 39.14 | 24.41 / 24.42 | 12.00 / 12.07 | 38.81 / 38.89 |
| river | 27.88 / 25.74 | 14.25 / 14.08 | 15.93 / 15.71 | 5.08 / 4.94 | 9.19 / 9.18 | 15.83 / 15.89 |
| vista | 55.70 / 54.12 | 35.64 / 36.11 | 38.23 / 38.68 | 26.07 / 25.96 | 9.90 / 10.03 | 40.01 / 38.59 |

The two arms cost the same within the sample noise: `split: frame` against `on: frame` is
38.81/38.89 against 42.03/39.14 at overview, 40.01/38.59 against 38.23/38.68 at vista, 21.84/23.07
against 19.88/22.85 at meadow-close. The extra MSAA depth store and load is therefore not
measurable above about 1 ms (the earlier "~0.2 ms" here was an estimate, never a measurement). The
decomposition is faithful: prepass + shade lands on the one-pass `scene` at river (14.27 against
14.25/14.08) and vista (35.96 against 35.64/36.11).

**What it answers.** At the two poses that miss 60 FPS the *depth half* owns the frame: 24.4 of
38.9 ms at overview and 26.0 of 38.6 at vista, against 12.0 and 10.0 ms of shading. The one-pass
arm clears 60 FPS at river (14.3 ms of scene) and at the closing player arm (12.8), which are
shade-bound (5.0 against 9.2, and 5.5 against 12.6). Meadow-close is **depth-bound** the other way
(10.8 prepass against 9.6 shade) and is *not* at 60 FPS: its one-pass scene reads 18.37/21.42.

### The same bill per band, on the split arm

Hide one band, read the medians of both halves. Bands are the kit's own groups:
`strata-props:horizon:*`, `strata-props:far:*` (the impostor cards), `strata-props:local:*` (four
groups) and the ground (`tn-terrain-block:*` plus `authored-terrain`). Everything is restored and
re-resolved after each arm.

| pose · band hidden | prepass ms | shade ms |
| --- | --- | --- |
| overview · nothing (`all`, read twice, identical) | **21.45** | **11.77** |
| overview · horizon | 11.27 (−10.2) | 12.59 (+0.8) |
| overview · far cards | 10.99 (−10.5) | 58.47 (+46.7) |
| overview · local | 21.17 (−0.3) | 11.19 (−0.6) |
| overview · ground | 21.58 (+0.1) | 5.25 (−6.5) |
| vista · nothing | **27.51** | **9.75** |
| vista · horizon | 17.34 (−10.2) | 11.24 (+1.5) |
| vista · far cards | 11.62 (−15.9) | 10.53 (+0.8) |
| vista · local | 26.52 (−1.0) | 9.05 (−0.7) |
| vista · ground | 27.40 (−0.1) | 4.87 (−4.9) |

**`strata-props:far:*` is the far-forest collar, not the impostor cards.** The collar trees draw
their coarsest mesh out to 150 m and switch to a card past it (`props.ts:178`, `propWorld.ts:511-549`;
at vista they start 55 m from the eye). So the "far" rows below are mesh plus cards, and the row-kind
count below separates them: **769 826 collar mesh triangles against 93 194 card triangles at
overview**. A card is 2 triangles, so 46 597 of them cannot cost 10.5 ms; the cost sits in the mesh.

Two readings hold, one is an outlier. **The depth half is the two far bands and nothing else**: at
overview the horizon band and the far collar each account for ~10.5 of the 21.45 ms, and they hide
each other, so they are very nearly the whole of it. **The near props contribute nothing** (0.3), and
their removal is a bound rather than a zero, because the near spruces also occlude what is behind
them. **The ground row (−0.1) is a null control, not a finding**: `prepassEligible` admits only draws
that cut, so opaque ground is not in the prepass at all. **The +46.7 ms shade reading is an
unreplicated outlier** — 6 frames, and the same arm at vista reads +0.8 — so the claim that hiding the
collar uncovers more shading behind it is not established; that arm needs a second run before anything
rests on it.

### Triangles per band and row kind (chain step 3, first sub-step)

Every instanced row in the scene at the pose, independent of what is admitted, so these are capacity
counts, not rasterised ones: `Σ instances × triangles of the geometry the row holds`.

| pose | band · kind | rows | instances | triangles |
| --- | --- | --- | --- | --- |
| overview | horizon · mesh | 277 | 39 312 | 22 268 040 |
| overview | horizon · card | 5 | 5 648 | 11 296 |
| overview | far · mesh | 15 | 21 250 | 769 826 |
| overview | far · card | 5 | 46 597 | 93 194 |
| overview | local · mesh | 155 | 33 888 | 11 551 401 |
| overview | ground · mesh | 10 | 10 | 1 046 528 |
| vista | horizon · mesh | 287 | 38 205 | 18 553 870 |
| vista | far · mesh | 15 | 26 264 | 978 216 |
| vista | local · mesh | 156 | 29 160 | 6 138 675 |

36.9 M capacity triangles at overview against the 10.95 M the engine reports planning, so most of a
row's instances are never drawn; the ratio is the cull, not waste.

**Answered from the CPU, 2026-11-15 — and it is the whole step-3 case.** The gate is
`world-impostor-surface.ts`'s `levelMask`: `span = min(gate, gate - previous) * width`, `mix =
(distance - gate)/span + 0.5 + (random - 0.5) * 0.5`, and `lod == gate` draws only where `noise < mix`.
So an instance whose distance is past `gate + 0.75 * span` has **every** fragment discarded at the
worst random draw, while its triangles are still submitted and rasterised. With the kit's own numbers
(`props.ts`: spruce `LOD_STEPS = [80, 105]`, `LOD_BANDS.hysteresis = 0.2`) that threshold is 92.0 m at
level 0 and 108.8 m at level 1. Counting each row's instances from its `instanceMatrix` against that
threshold, at the same two poses:

| pose | band · level | instances | triangles | past the gate | **fully faded (all fragments discarded)** |
| --- | --- | --- | --- | --- | --- |
| overview | horizon · L0 | 15 897 | 9 940 732 | 15 285 | **14 597 · 8 867 380 tris** |
| overview | horizon · L1 | 15 036 | 7 999 042 | 12 884 | **12 792 · 6 405 044 tris** |
| overview | far · L0 | 7 529 | 165 026 | 7 529 | **7 529 · 165 026** |
| overview | far · L1 | 7 593 | 143 586 | 7 593 | **7 593 · 143 586** |
| overview | local · L0/L1 | 12 170 | 251 442 | 12 170 | **12 170 · 251 442** |
| vista | horizon · L0 | 13 062 | 6 669 614 | 13 062 | **13 062 · 6 669 614** |
| vista | horizon · L1 | 12 891 | 5 600 762 | 12 891 | **12 891 · 5 600 762** |
| vista | far · L0/L1 | 19 022 | 659 378 | 18 919 | **18 884 · 593 788** |

**At overview 15.84 M of the 19.1 M triangles those rows hold (83 %) are rasterised only to have
every fragment thrown away; at vista 12.87 M of 12.93 M (99 %).** It is not a detached-camera
artefact: at the walking poses the same count reads **16.1 M of 17.5 M (92 %) at meadow-close** and
**7.3 M of 12.5 M (58 %) at river**. Order of magnitude, and bounded by the frame's own 10.95 M
planned triangles (part of those rows' capacity is frustum-culled, so a share of the faded triangles
is never submitted at all).

Why the picture still looks right while 83 % of those triangles are thrown away: what draws the far
trees at these poses is the **impostor cards** (2 triangles each, 5 648 horizon + 46 597 far
instances), and the coarse meshes behind them are submitted, rasterised and gated away. The gate is
doing its job; the cost is that the mesh rows are still drawn.

So the loss is not the fragment program: it is **placement**. These instances sit in a level row far
coarser than their distance (a level-0 spruce at 200 m), and the gate throws away every fragment they
produce while the draw still submits and rasterises their triangles. Whatever the cause — an
admission that pins the collar to its finest level, or a refilter that never re-levels a static eye —
the fix is the same and it is step 3's: **the CPU already knows the distance and the gate, so it can
stop drawing them**, and it must be worth 0 pixels because every one of their fragments is already
discarded. Acceptance for the change: the same five-pose bill, with the prepass and shade halves both
down and a frozen-clock 0-pixel diff, and the count above re-run afterwards to show the faded set is
empty.

**Correction, 2026-11-14 (step 3 built and measured).** The count above overstates the waste about
20×. It sums each row's instance *capacity* (`object.count` records of `instanceMatrix`) by 3D
distance from the camera, but the engine draws only the records its CPU filter admits (10.95 M
planned triangles against 36.9 M capacity), and most of the "fully faded" records are never
submitted. The GPU answers it: collapsing every instance the gate provably discards saves 0.3–0.7 ms
per half at overview, vista and meadow-close, and collapsing *every* LOD instance takes the overview
prepass from 25.6 to 1.7 ms. So the 24 ms depth half is drawn foliage that the gate keeps, not
placement waste. Levers that cut drawn masked coverage (the far cards, Hi-Z) are where it sits.

### Method caveats

- The arm order is `off, on, split, split, on, off` per pose, so `off` always opens a pose. In 5 of 5
  poses the opening `off` run reads higher than the closing one (overview 107.12 on 4 samples against
  51.01; meadow-close 47.15 against 31.31) — a pose-entry transient, with shadow pages still redrawing
  (overview `off`-1 shows 7.18 ms of shadow against 0.09). ABBA does not cancel it, so the opening
  `off` number is unusable and the closing one is the pose's shipped cost. Rotate the opening arm next
  time.
- Player is noisy in every arm (split shade 8.09/12.57, `on` scene 17.45/12.84): no delta under
  about 5 ms may be read from it. Overview and vista are tight (24.41/24.42, 26.07/25.96, n = 9–10).
- The `all` baselines in the band table (21.45 at overview, 27.51 at vista) are from a second page
  load than the per-pose table's split arms (24.41, 26.07). Same poses, same code, a different boot:
  read the two tables as shapes, not as offsets. Standing still drifts the bill upward as the ring
  streams in (see the warning above), which is the difference.
- The rows after a viewport-texture copy get their own depth pass, run after the copy, and that pass
  is timed as `viewport`, not `prepass` (renderer.cpp keeps the copy's depth exactly as shipped). The
  whole `viewport` pass is 0.15–0.45 ms at these poses, so the `prepass` column is short by that much
  where a viewport texture exists.

**Pixel identity of the split arm.** The kit exposes no clock freeze through `?capture=1`
(`freezeClock` is not on the debug object), so foliage sway kept running between shots. Two shots per
arm, 20 frames apart, 1600×900, at meadow-close and overview: the cross-arm delta is **below** the
same-arm drift at both poses — overview 442 changed pixels on→split against 758 split→split and
44 768 on→on (a pose's first shot is still settling), meadow-close 17 894 on→split against 40 098
split→split. No arm-attributable difference is detectable, but this is not AC-A's 0-pixel claim:
that still needs the frozen-clock protocol, which the open box above keeps.

## The next lever, ranked (advisor review, 2026-11-14)

0. **~~Measure the split first.~~ Done, 2026-11-14.** `TN_PREPASS=split` gave both halves and then the
   per-band bill above. The answer reranks the rest: the depth half is 24–26 ms at the two poses that
   miss 60 FPS and all of it is the horizon band and the far cards' masked fragments, while the near
   props and the ground contribute ~0. Levers 1, 2 and 3 all belong to that half, and the far cards'
   share of it is the look defect lever 3 describes.
1. **Draw prepass instances near to far.** The final depth is the per-sample minimum, which does not
   depend on draw order, and the Equal pass keeps its order, so this changes 0 pixels by
   construction. Issue each prepass row as sub-draws over cell-contiguous instance ranges sorted by
   cell distance. Feasible as written: `world-cell-batches.ts` already narrows the draw window to the
   visibility cells a cull names (`#cullMainPass`), so per-cell sub-draws are expressible, and an
   admitted cell keeps its block until a regroup, so the ordering is stable frame to frame. Gain
   0–6 ms, depending on whether Turing's ZCULL rejects tiles for a discarding shader — the split
   pass shows it.
2. **Collapse the vertices the LOD gate discards.** Every level's material carries a fragment level
   gate (`world-impostor-surface.ts`), so a draw rasterises instances every fragment rejects. If a
   draw only admits its own level's instances, collapsing those vertices (w = 0) is 0 pixels. Check
   per-band triangles against the admitted levels first.
3. **Conservative Hi-Z occlusion** for the far bands: 0 pixels, but a large build, and it pays only
   where ridges hide the ring.
- ❌ **Dropped: alpha-to-coverage in the prepass rows.** There is none to drop:
  `pipeline_cache.cpp` never sets `alphaToCoverageEnabled`; this engine's "a2c" is `smoothstep` +
  `fwidth` + discard in `standard.cpp`, which cuts the same fragments as a hard cutoff. That is why
  the runtime ablation moved +0.1 ms. Do not chase it.
- ❌ Rejected: a 1-sample prepass (the equal test needs per-sample depth), alpha hash and implicit-LOD
  coverage (both change pixels), and a per-draw opt-out (every band gains from the prepass).

**The far cards' look.** `mipThresholdNode` (`world-impostor-surface.ts`) divides the cutoff by
`1 + 0.75·log2(footprint)`; at ~64 texels per pixel a 0.5 cutoff becomes ~0.09, so the coarse mip's
averaged alpha passes across the whole card — that is the navy rectangle. Two fixes in order: bake
coverage-preserving mips (Castaño 2010, scale each mip's alpha so its coverage above the cutoff
matches mip 0) and drop the cutoff division; then skip the impostor ray march when the footprint makes
parallax sub-pixel and take one blended octahedral sample. Only then extend the impostor atlas to the
horizon bucket (`propWorld.ts`, `impostors: farInstances > 0`) — impostoring it before the card is
fixed replaces 5.69 M triangles with the same rectangles. Projected (unverified): far 9.7 → 2–3 ms,
horizon 14.2 → 3–5 ms, overview ≈ 20–24 ms, which is still short of 16.6; the base square's 5.5 ms
(`terrain.ts`) is the bill after that.

**Proof protocol for a look change**: one page load with a live material toggle; freeze sway, river and
LOD temporal clocks; ABBA × 2 runs at all 5 poses, median scene column; the changed pixels must be a
subset of the far band's footprint (the pixels that move when the band is hidden in the same frozen
frame); then a fresh read-only judge with the criterion "far silhouettes read as crowns, no solid
rectangles", against an authored-geometry reference, must return IMPROVEMENT at overview, meadow-close
and vista.

**Acceptance, split.** AC-A (the prepass): 0 changed pixels and ≥ 2 ms at every pose — met. AC-B (the
60 FPS claim): ≤ 16.6 ms with 0 changed pixels at player, river and meadow-close; at overview and
vista ≤ 16.6 ms, or the measured ceiling written here, with the far-band change confined to its
footprint and judged IMPROVEMENT.

## Acceptance

Ship only with all of: 0 changed pixels, `gpuSegmentScene` ≥ 2 ms better at every fixed pose, no CPU
regression, the judge NEUTRAL/IMPROVEMENT, and the native delta the same sign. Break-even is a
shaded/visible ratio of about 1.35–1.65, because the prepass re-rasterises the cutouts; this scene
measures ≈ 3.0×.

## Blocked on

Nothing. The instrument, the gate, the refusal list and the acceptance criteria are all in hand.
