# PRD-721 — NVIDIA tower-defense black world

**Status:** LOCAL COMPLETE — awaiting team-lead visual judgement
**Priority:** P1 — owned Wasm renderer presents a black world on NVIDIA while HUD remains visible.
**Complexity:** MEDIUM
**Owner:** nvblack-lane
**Depends on:** None

## Context and scope
Execute the owner's nvblack-lane brief on fix/nvidia-black-world, without push or PR. Reuse scripts/engine-parity.ts and the installed tower-defense scaffold. Isolate quality/stage changes, then repair the shared engine cause, preserving authored appearance. Integration: unchanged — existing scene → Wasm renderer → post passes → canvas.

### Phase 1 — isolate and reproduce
- [x] GTAO isolated: low tier and no-AO each score 0.110; raw AO stays black (0.677). Added HUD-free world regression, red on headed NVIDIA: nonblank 0, dark ratio 1, only the two intended visual failures. proof: playtest CLI `nvidia-tower-defense-world.playtest.json --headed --browser-recipe webgpu`; artifacts `~/.cache/tmp-tn/nvblack/runs/red-world-headed`. Flat materials supply zero vertex normals; the AO normal pass normalizes those rather than deriving face normals.

### Phase 2 — repair
- [x] Root corrections implemented: AO normal target derives face normals for flat materials; `facedNormal` preserves flat normals on double-sided faces as r185 Normal.js does. Focused shader regression failed twice before the latter correction, then passed in 148/148 Wasm CTests. proof: `ctest --test-dir packages/runtime-native/build/wasm -L native-engine`; world-region regression now passes on headed NVIDIA with no diagnostics, exit 0 (`~/.cache/tmp-tn/nvblack/runs/green-world-headed`); no authored appearance or threshold was changed.

### Phase 3 — qualify
- [x] NVIDIA tower-defense parity <0.12 in 3/3 runs: 0.001088, 0.001077, 0.001048, all exit 0; adapter vendor nvidia / architecture turing. proof: `scripts/engine-parity.ts`, `~/.cache/tmp-tn/nvblack/runs/final-nvidia{1,2,3}/result.json`.
- [x] SwiftShader parity <=0.12 in 2/2 runs: 0.002266, 0.004063, both exit 0; both arms report swiftshader. proof: `scripts/engine-parity.ts` with `VK_ICD_FILENAMES=/nonexistent/none.json`, `~/.cache/tmp-tn/nvblack/runs/final-swift{1,2}/result.json`.
- [x] Required build/checks pass. proof: Wasm web pair and core tests built `--parallel 4`; `ctest --test-dir packages/runtime-native/build/wasm -L native-engine --output-on-failure --parallel 4` 148/148; `pnpm typecheck` exit 0; `pnpm lint` exit 0 (1681 existing warnings); engine-parity specs 12/12. Desktop GPU CTests not run; this is Wasm/browser qualification.

## Blocked on
team-lead provides independent visual judgement. Two NVIDIA BEFORE and AFTER runs per engine arm, all fixed-step tick 360, are ready under `~/.cache/tmp-tn/nvblack/judge/`; `pose.png` preserves the raw screenshot and `pose-labelled.png` burns the BEFORE/AFTER label into a banner. No verdict is claimed by this lane.

## Decisions
2026-10-23: owner's brief explicitly requires no push or PR and retention of this supplied worktree for coordinator review. Final evidence goes in ~/.cache/tmp-tn/nvblack/report.md.
