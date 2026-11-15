# PRD-888 — A masked depth prepass pays for itself on the forest

**Status:** PARTIAL — the prepass ships behind `?tnPrepass=1` and saves 7–17 ms at every pose; judge, MRT identity and native proof are open.
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
- [ ] Visual judge (fresh read-only subagent, matched poses, before/after): NEUTRAL or IMPROVEMENT.
      First judge: NEUTRAL, low confidence — the meadow-close dark leaf blocks also show in a
      shipped BEFORE frame; a clean fresh-page recapture is pending.
- [ ] Native proof on the desktop host, same pose, same sign.
      The host builds from this tree (`tn-native-engine-player-v8`), but the forest kit does not
      bundle for the desktop engine: 12 `TN_NATIVE_ENGINE_UNBOUND` (three/tsl `rotateUV`, `bumpMap`,
      `mx_fractal_noise_float`, `GLTFLoader`, `KTX2Loader`, …). Needs a masked-foliage scene the
      desktop player bundles, or those bindings.
### Phase 3 — the proof

- [ ] Add the overdraw gauge this PRD was decided by, so the next regression names itself: a
      shaded-fragment counter surfaced as `TN_FRAME_BUDGET.counters.engine` (the IR already has
      `atomicAdd` and atomic storage buffers — `shader/ir.h:132`).

## Acceptance

Ship only with all of: 0 changed pixels, `gpuSegmentScene` ≥ 2 ms better at every fixed pose, no CPU
regression, the judge NEUTRAL/IMPROVEMENT, and the native delta the same sign. Break-even is a
shaded/visible ratio of about 1.35–1.65, because the prepass re-rasterises the cutouts; this scene
measures ≈ 3.0×.

## Blocked on

Nothing. The instrument, the gate, the refusal list and the acceptance criteria are all in hand.
