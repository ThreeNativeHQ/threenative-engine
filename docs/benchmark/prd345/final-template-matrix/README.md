# Final PRD-345 default template captures

All twelve conventional templates pass strict matched hardware WebGPU readiness captures
at the fixed tick-60 default camera: 1280×720, NVIDIA Turing, 4× MSAA, identical per-pair
camera/game state/clock/backend/buffer and cooked assets. Candidate generated runtime
source matches checkpoint `dca2d8d4b`, including read-only light matrices. All 24 full PNGs
were personally inspected by root and a separate reviewer. The original authored palettes
and surrounding geometry/shadows remain stable. Bright photographed IBL suppresses extra
analytic fill; difficult backlit/black-environment controls are separately qualified.

This custom boot capture is not a full gameplay/playtest matrix, native proof, pipeline
compile-completion claim or a final per-frame/startup performance budget. Source manifests,
readiness session, runtime snapshots and adapter provenance are preserved in each gzip
report and the complete matrix. Earlier attempts and rejected racing frames remain in
separate historical evidence; they were not overwritten or silently filtered.

Platformer flags and runner smoke can vary with presentation time despite matched gameplay
clock. Tower-defense HUD hover differs slightly. These differences are disclosed, not
claimed as lighting improvements or exact whole-frame pixel equivalence. Puzzle/tower
extra material rim/fill remain zero to preserve authored lights; runner/snow extra fill
remains zero. Custom RTS terrain/water and snow materials stay original. Rain's custom
raymarched shader is explicitly unqualified; native/mobile/software/WebGL retain originals.

| Template | Before | After |
| --- | --- | --- |
| racing | ![Before](racing/before.png) | ![After](racing/after.png) |
| minimal | ![Before](minimal/before.png) | ![After](minimal/after.png) |
| starter | ![Before](starter/before.png) | ![After](starter/after.png) |
| platformer | ![Before](platformer/before.png) | ![After](platformer/after.png) |
| runner | ![Before](runner/before.png) | ![After](runner/after.png) |
| shooter | ![Before](shooter/before.png) | ![After](shooter/after.png) |
| action-rpg | ![Before](action-rpg/before.png) | ![After](action-rpg/after.png) |
| rts | ![Before](rts/before.png) | ![After](rts/after.png) |
| tower-defense | ![Before](tower-defense/before.png) | ![After](tower-defense/after.png) |
| puzzle | ![Before](puzzle/before.png) | ![After](puzzle/after.png) |
| sailing | ![Before](sailing/before.png) | ![After](sailing/after.png) |
| snow | ![Before](snow/before.png) | ![After](snow/after.png) |

[Effective mechanisms, named zero controls and remaining original acceptance](mechanisms.md)
separate authored illumination from the new grazing/disc terms; palette-preserving boot proof
does not establish equivalent difficult-light behavior in every template.

## Historical capture coordination limitation

A reported `held` capture lease establishes ownership within that process's temporary namespace. `defaultCaptureLockRoot()` derives its path from `TMPDIR`; durable-TMPDIR gameplay/native-opening and matched performance runs used private namespaces. We manually serialized our own jobs, but shared global GPU exclusion and external workload isolation were not established for those historical runs. Their measured outcomes remain retained with this limitation; they must not be described as globally exclusive qualification. Future timing runs use an explicit outer existing-API shared `/tmp/threenative-playtest-capture` lease and durable child temps.
