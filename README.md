# PR #483 — Strata forest, BEFORE/AFTER the develop merge

Static images for the pull-request comment. Not a build input.

| Arm | Tree | three |
| --- | --- | --- |
| BEFORE | `epic/strata-terrain-hardening` @ `dd6a4a1b8` | 0.185.1 |
| AFTER | same branch + `origin/develop` merged (local commits `6d0a29423`, `25b814f1a`) | 0.187.0 |

Each image is one pose: BEFORE on the left, AFTER on the right, two independent runs per arm
(R1 top, R2 bottom). Same viewport 1600x900, same capture recipe
(`.claude/skills/capture-strata-worlds/shoot-worlds.mjs`), same GPU (NVIDIA Turing RTX 2080,
`adapter.info` vendor=nvidia architecture=turing in both arms).

Popped/grass scatter is randomised per load, so positions differ between runs and arms; density and
appearance are what can be compared.
