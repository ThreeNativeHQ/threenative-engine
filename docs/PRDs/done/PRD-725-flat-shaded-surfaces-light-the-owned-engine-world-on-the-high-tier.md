# PRD-725 — Flat-shaded surfaces light the owned-engine world on the high tier

**Status:** DONE
**Priority:** P1 — owned Wasm renderer presents a black world on NVIDIA while HUD remains visible.
**Complexity:** MEDIUM
**Owner:** nvblack-lane (Codex), reviewed by team-lead
**Depends on:** None

## Context and scope
Found while triaging PR #541 CI: on an NVIDIA adapter (high tier, GTAO on) the owned engine drew a black world in the tower-defense template, on develop a63ea4506 (engine parity 0.677, 6/6 runs) and on the epic. CI runs only SwiftShader, so no job covered it. Reuse scripts/engine-parity.ts and the installed tower-defense scaffold. Isolate quality/stage changes, then repair the shared engine cause, preserving authored appearance. Integration: unchanged — existing scene → Wasm renderer → post passes → canvas.

## Acceptance Criteria
- [x] AC-1 [local]: on an NVIDIA adapter at the high tier, the tower-defense world renders in the owned engine. proof: `nvidia-tower-defense-world.playtest.json` red then green (Phase 1, Phase 2); engine parity 0.001 in 3/3 runs (Phase 3).
- [x] AC-2 [local]: the SwiftShader path that CI runs does not regress. proof: engine parity 0.002 and 0.004 in 2/2 runs against 0.1087 on develop (Phase 3).
- [x] AC-3 [local]: a fresh visual judge reads no regression on either adapter. proof: OVERALL IMPROVEMENT (Phase 3).

### Phase 1 — isolate and reproduce
- [x] GTAO isolated: low tier and no-AO each score 0.110; raw AO stays black (0.677). Added HUD-free world regression, red on headed NVIDIA: nonblank 0, dark ratio 1, only the two intended visual failures. proof: playtest CLI `nvidia-tower-defense-world.playtest.json --headed --browser-recipe webgpu`; artifacts the local run. Flat materials supply zero vertex normals; the AO normal pass normalizes those rather than deriving face normals.

### Phase 2 — repair
- [x] Root corrections implemented: AO normal target derives face normals for flat materials; `facedNormal` preserves flat normals on double-sided faces as r185 Normal.js does. Focused shader regression failed twice before the latter correction, then passed in 148/148 Wasm CTests. proof: `ctest --test-dir packages/runtime-native/build/wasm -L native-engine`; world-region regression now passes on headed NVIDIA with no diagnostics, exit 0 (the local run); no authored appearance or threshold was changed.

### Phase 3 — qualify
- [x] NVIDIA tower-defense parity <0.12 in 3/3 runs: 0.001088, 0.001077, 0.001048, all exit 0; adapter vendor nvidia / architecture turing. proof: `scripts/engine-parity.ts`, the local run.
- [x] SwiftShader parity <=0.12 in 2/2 runs: 0.002266, 0.004063, both exit 0; both arms report swiftshader. proof: `scripts/engine-parity.ts` with `VK_ICD_FILENAMES=/nonexistent/none.json`, the local run.
- [x] Required build/checks pass. proof: Wasm web pair and core tests built `--parallel 4`; `ctest --test-dir packages/runtime-native/build/wasm -L native-engine --output-on-failure --parallel 4` 148/148; `pnpm typecheck` exit 0; `pnpm lint` exit 0 (1681 existing warnings); engine-parity specs 12/12. Desktop GPU CTests not run locally; the PR's CI desktop parity jobs cover the native host.

- [x] Fresh visual judge (Sonnet, read-only), 2 runs per arm against the Three.js arm of the same pose: NVIDIA IMPROVEMENT (black world to the full authored scene, no new artifact); SwiftShader IMPROVEMENT (the dark road with crack lines now matches the reference tan); runs agree. OVERALL IMPROVEMENT. proof: judge verdict on the PR.

## Decisions
- 2026-10-23 (team-lead): the lane filed this as PRD-721, which collides with the Unreal-look epic's PRD-721; renumbered to PRD-725 and filed in `done/` after the judge verdict. The fix targets develop on its own PR, not #541, because the fault predates the epic.
