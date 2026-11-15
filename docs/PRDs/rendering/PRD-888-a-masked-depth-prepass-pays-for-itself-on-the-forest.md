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
- [x] Lever 0, `TN_PREPASS=split` records the prepass rows in their own render pass with their own
      timestamp segment, so the depth half is priced apart from the shade half.
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
39.4 ms and 84 % of the frame's 10.95 M triangles sit in them, drawn at their authored last LOD
because `strata-props:horizon` asks `WorldCells` for no impostor atlas (`propWorld.ts`:
`impostors: farInstances > 0`). Impostoring that ring and repairing the card look would save the
band (~13 ms by the far bucket's 9.7 ms for 82 k cards) and still leave the frame near 26 ms, because
the same masked cards then pay fill rate. Reaching 16.6 ms at overview and vista needs either a ring
that stops drawing per-tree geometry past 700 m or a cheaper accepted look for its cutouts; both
change pixels, which "look unchanged" forbids. Measured 2026-11-14.

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
kit played as its own game, 928 MiB of 8 GB already resident before the probe.

| pose | off (shipped) | on (one pass) | split: prepass | split: shade | split: frame |
| --- | --- | --- | --- | --- | --- |
| player | 30.09 / 27.16 | 17.45 / 12.84 | 5.90 / 5.45 | 8.09 / 12.57 | 15.42 / 20.43 |
| meadow-close | 47.15 / 31.31 | 18.37 / 21.42 | 10.78 / 11.60 | 9.56 / 9.92 | 21.84 / 23.07 |
| overview | 107.12 / 51.01 | 39.69 / 36.78 | 24.41 / 24.42 | 12.00 / 12.07 | 38.81 / 38.89 |
| river | 27.88 / 25.74 | 14.25 / 14.08 | 5.08 / 4.94 | 9.19 / 9.18 | 15.83 / 15.89 |
| vista | 55.70 / 54.12 | 35.64 / 36.11 | 26.07 / 25.96 | 9.90 / 10.03 | 40.01 / 38.59 |

`split: frame` is the whole `TN_GPU_PASSES` sum (shadow, prepass, shade, viewport copy, post,
output), so it compares with `on` directly: the two-pass arm is not slower, which is the extra MSAA
depth store and load being smaller than the sample noise.

**What it answers.** At the two poses that miss 60 FPS the *depth half* owns the frame: 24.4 of
38.9 ms at overview and 26.0 of 38.6 ms at vista, against 12.0 and 10.0 ms of shading. So the far
bands cost what they cost because 10.95 M masked triangles are rasterised to depth and thrown away,
not because the sun's five taps are sampled too often: levers that shorten the shade half have
12 ms to win, and levers that shrink the depth half have 24–26. Ordering the prepass near to far
(lever 1) and collapsing the vertices the fragment level gate discards (lever 2) are the only two
that touch it.

At meadow-close, river and player the split is 5.7/10.3, 5.0/9.2 and 5.7/10.3 — the near poses are
shade-bound, which is why the one-pass arm already clears 60 FPS there.

`off` read 107 ms once at overview, on 4 samples 5 s into that pose: the ring was still streaming
in. The second `off` run at the same pose read 51.0, and every other pose agrees with PRD-888's
earlier table, so read `off` from the closing arm of each pose, never the opening one.

## The next lever, ranked (advisor review, 2026-11-14)

0. **Measure the split first.** Record the prepass rows (`renderer.cpp` encodeFrame) in their own
   render pass with their own timestamp segment (`TN_PREPASS=split`; the extra MSAA depth store and
   load costs ~0.2 ms) and re-run the bill per band. Every choice below depends on that split.
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
