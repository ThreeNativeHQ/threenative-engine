# PRD-890 — Cutouts keep alpha-to-coverage on the owned engine

**Status:** NOT STARTED — found 2026-11-14 while the PR #677 lane priced the Strata forest frame.
**Priority:** P1 — the default engine fades the cutout alpha but never turns hardware coverage on, so foliage edges alias at 4x MSAA on web and desktop.
**Complexity:** 4 (MEDIUM)
**Depends on:** None.
**Chain:** step 6 of [FOREST-PERF-CHAIN.md](../../../packages/terrain/docs/PRDs/FOREST-PERF-CHAIN.md) · **PR:** #677 (owner, 2026-11-14)

## Problem

Core turns `material.alphaToCoverage` on for every cutout material (`packages/core/src/render/alpha-antialiasing.ts:124-125`, Godot's `alpha_antialiasing_mode`). On the `engine: "threejs"` arm, three fades the cutout alpha over one pixel and sets `multisample.alphaToCoverageEnabled` on the pipeline, so the faded alpha becomes partial sample coverage.

On this branch the owned engine does the first half only:

- ✅ The flag reaches the shader variant (`renderer_frame.cpp:628`), and `standard.cpp:708-725` fades the cutoff as three r187 does (commits `0ad0a97f4`, `7e1395be8`).
- ❌ `pipeline_cache.cpp:435-436` sets only `multisample.count` and `multisample.mask`. The pipeline key carries no coverage bit.
- ❌ The fragment still discards at the cutoff, so the faded band never reaches the coverage mask. PRD-888 measured this: its "a2c" ablation moved +0.1 ms because it cuts the same fragments as a hard cutoff.

Result: each leaf edge is one hard `discard` edge per pixel at 4x MSAA. Nothing reports it. This is a look fix, not a frame-time lever (PRD-888 dropped it as a lever for that reason).

## Execution phases

### Phase 1 — the pipeline turns coverage on

- [ ] The pipeline key carries a coverage bit, and `pipeline_cache.cpp` sets `multisample.alphaToCoverageEnabled` when the bit is set and `sampleCount > 1`. proof: a native renderer test `alpha_to_coverage` reads a partial-coverage edge texel (strictly between 0 and 1) on a 4x target, red then green
- [ ] With coverage on, the fragment keeps the faded band and discards only where three r187 does. proof: the same test reads the faded band's texels, red then green

### Phase 2 — passes that share depth

- [ ] The masked depth prepass (PRD-888) and the shade pass write the same coverage per sample, so the equal-depth test leaves no holes or halos on a cutout edge. proof: the `alpha_to_coverage` test reads the shade pass with `?tnPrepass=1` on and off, and the two are identical
- [ ] Shadow and single-sample passes keep `discard`. proof: the same native test on a 1x target

### Phase 3 — proof on screen

- [ ] Web conformance row for a cutout scene matches the threejs arm. proof: `node conformance/run-conformance.mjs --engine threenative --only-tests <new row>`
- [ ] Desktop runs the same row. proof: `node conformance/run-conformance.mjs --target desktop --engine threenative --only-tests <new row> --reference <web capture dir>`
- [ ] Visual judge at the forest kit's player and meadow-close poses returns IMPROVEMENT on leaf edges. proof: fresh judge subagent, headed `--browser-recipe webgpu`, `adapter.info` checked, 2 runs per arm, sheets on the `prd-890-screenshots` branch

## Acceptance criteria

- [ ] A cutout on the default engine draws with alpha-to-coverage at 4x MSAA on web and desktop, and `gpuSegmentScene` at each fixed PRD-888 pose is within 0.5 ms of the run without it. proof: Phase 3 rows plus the PRD-888 pose bill, 2 runs per arm

## Blocked on

- Android and iOS: the owned-renderer adapters reject these platforms today (`packages/runtime-native/AGENTS.md`). This PRD claims web and desktop only.

## Decisions

- 2026-11-14, owner: file a separate PRD for this gap, and land it on the PR #677 branch.
- 2026-11-14: the facade and shader-fade boxes are moot. Commits `0ad0a97f4` and `7e1395be8` on this branch already carry the flag to the shader and fade the alpha.
