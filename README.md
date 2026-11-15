# PRD-889 — woodland-floor judge evidence

AC-7 is **open**. A fresh read-only visual judge returned **NEUTRAL, verdict BLOCK**.

Pose: adventure kit, the `native-playtests/woodland-floor.playtest.json` pose, same seed, same camera.
Arm BEFORE has no forest floor; arm AFTER has the baked debris streamed by `ScatterField3D`.
Two independent runs per arm, captured from the packaged desktop host (its own framebuffer readback;
`page.screenshot` returns a black WebGPU canvas on this machine, and the kit's pre-existing
`grass.playtest.json` fails the same 5% capture guard).

- `run-{before,after}-{1,2}.png` — the four runs, full frames.
- `sheet-{before,after}.png` — each arm's two runs stacked, labelled.
- `ground-{before,after}.png` — the ground band at 2×, where the debris has to read.
- `change-map.png` — after minus before, brightness ×5. A diagnostic, not a look.

Verdict: the debris does not read as a forest floor at this pose — the kit's knee-high grass occludes
the flat litter layer. Nothing regressed.
