# PR #440 merged-source acceptance checkpoint — 2026-10-05

Candidate source: `da632c337ca6ea1a60b50291b0c2a8d76d2166c0`, reconciled with
`develop` `d5d169705f34b6b41d1888f3885cb8968e81cb60`. The latest base adds docs and
exposure clock tests; it changes no captured runtime, template, scenario or asset inputs.
Phase 2 and Phase 3 remain open. No original threshold, deadline or assertion was weakened.

| Criterion | Evidence at this checkpoint | Result |
| --- | --- | --- |
| Shared graph and actual camera layers | Independent review found the owner-camera bug; the new same-frame/four-render regression was red before repair. All twelve template copies and the fixture use actual `NodeFrame.camera`. Camera/matrix/lifecycle 31/31; scaffold/compiler contracts 101/101, real thirteen-template hashes. | CPU verified |
| Isolated difficult lighting | Six fresh local end-pose PNGs independently inspected; unchanged decoded-PNG qualifier passes. Edge/body p99 52/2 versus zero-rim 7/0, original margin 30. Fill p99 43 versus black 0; black fails only two intended tone assertions. Marker omission passes the runner but is rejected by the external marker qualifier. Actual camera world/inverse/projection matrices match across all four assertion arms. | Verified for this fixture |
| Build and CPU contracts | Ordinary JS/DTS build, root typecheck, lint, docs and budgets pass. Lint has existing warnings; budgets reports existing native-census drift. Latest exposure/docs/instruction tests 35/35. | Verified |
| Current integrated frame budget | Six fresh unchanged 1920×1080, warmup60, 33 ms scenarios; table below. | **RED** |
| Startup and gameplay/all-template gates | Recorded incomplete startup warmup is not repeated startup p95. Full root `pnpm test`, all-template gates, dark/no-sun per-template appearance, multi-camera and mixed-material/disposal GPU pixels have not been rerun here. | Unverified |
| Native | Existing primary host predates current native/WebGPU inputs. No native build or launch in this task. Historical conservative original-material fallback cannot prove enabled native grazing/fill. The previously denied native backlight replay/sampler was not attempted. | Unverified; enabled path unresolved |

## Integrated performance — all outcomes retained

| Launch | Template | p95 ms (limit 33) | Samples | FPS (minimum 30) | Draws | Triangles |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | shooter | **112.9** | 307 | 33.78 | 1176 | 420917 |
| 2 | snow | **59.8** | 225 | 138.89 | 119 | 888397 |
| 3 | snow | **48.6** | 227 | 243.90 | 119 | 888397 |
| 4 | shooter | **144.5** | 345 | **27.93** | 1176 | 420917 |
| 5 | shooter | **88.9** | 279 | 35.97 | 1176 | 420917 |
| 6 | snow | **51.8** | 227 | 243.90 | 119 | 888397 |

All six fail p95; launch 4 also fails FPS. Draw and triangle limits pass in every run.
[Report seals](pr440-acceptance-2026-10-05.json) identify the retained raw local reports.
These are failed acceptance under recorded conditions; this series does not isolate code causality.

The serial captures used the global `/tmp/threenative-playtest-capture` lease, separate child
temporary directories, hardware NVIDIA Turing WebGPU, and CPU affinity `10,11,22,23`
(two physical cores). The allocation protected concurrent CI but was not established as the
original performance allocation. Preflight load was 26.7 with other GPU clients; a later actual
15-second sample measured CPU busy 59.6–84.7% and CPU pressure some avg10 about 21.7%.
GPU samples were mostly 6–7% at 300–315 MHz/P8 with a 30%/1515 MHz/P2 spike. Foreign
processes and affinities were not changed. A suitable comparison window remains pending.

## Historical evidence transfer and current-asset comparison

All 21 retained raw/gzip report seals and 12 selected historical PNG seals match their manifest.
The published shared graph at `6875e1f2` has identical emitted JS token streams to the historical
candidate after only comments, formatting and relative-import suffix normalization. The current
camera repair deliberately changes callbacks, requiring fresh evidence.

The shooter scenario SHA, adapter/features, browser flags and viewport match the historical run.
41 of 50 source files match historical shared-graph bytes; differences include the repaired graph,
unused declaration removal and later opt-in exposure plumbing (still disabled). Draw/triangle
counts match. All sixteen cooked texture image payloads match historical seals despite renamed
paths; basis files, sky, icon and favicon match. Both GLB hashes, manifest and receipt differ.

Historical cooked GLBs are absent from their documented retained paths and are not in the
tracked benchmark archive. Direct decoded historical cooked equivalence cannot be established.
Both raw model sources are byte-identical to the historical revision. Decoding raw versus current
cooked confirms animation payloads are unchanged; current cooking also prunes nodes/accessors,
changes texture packaging and converts the viewmodel scope from BLEND to MASK. These are
real cooking transformations, not proof that historical cooked assets are equivalent.

Two separate owned comparison projects now use identical current packages, dependency locks,
all 25 cooked asset files and the unchanged scenario. The current-source per-material control imports the same
repaired allocation-free helpers; only per-material graph construction versus WeakMap caching
differs. Independent review rejected the initial comparison because its old inline helpers
allocated arrays; those first arms are retained, and the corrected v2 arms were rebuilt and sealed
before any GPU launch (`comparison-projects-v2/`, `comparison-source-proof-v2.json` in the
delegated workspace). Both CPU-only Vite bundles pass, with no
asset recook. One balanced comparison is planned when a recorded capture-only allocation is
available; it cannot substitute for the original all-template/startup/native acceptance.

All new images and raw captures remain local under `artifacts/pr440-acceptance/` and the delegated
workspace. Failed wrappers and unobserved launches are retained. No image was uploaded or added
to Git while sharing approval remains pending.
