---
prd_contract: v1
---

# PRD-729 — Assets ship as few bytes as they can and preload as fast as they can

**Status:** PARTIAL — Phases 1 and 2 are done; Phase 3 has cut the corpus from 5.37 to 3.68 MiB and
both preload goals are met. The bytes goal is open.
**Priority:** P1 — the corpus ships 3.68 MiB against a 3 MiB goal and 30.9% of source against 25%;
preload is 372 ms local and 1162 ms at 40 Mbps on the RTX 2080.
**Complexity:** 5 (MEDIUM) — 3–5 files in Phase 1 (+1): a loop script, its spec, the ledger, the
generated page and this PRD; Phase 2 adds a probe game and a playtest network option (+2); each
Phase 3 lever changes `packages/assets` defaults that every game inherits (+2).
**Owner:** João
**Depends on:** [PRD-351](PRD-351-compression-never-looks-worse-than-a-floor.md) (the quality
floor that every lever must hold), [PRD-496](../performance/PRD-496-the-loading-screen-is-bytes-not-files.md)
(the loader fan-out and progress work; its probe method is the preload method here).
**Dashboard:** [`docs/asset-perf/index.html`](../../asset-perf/index.html), generated from
[`docs/asset-perf/ledger.json`](../../asset-perf/ledger.json) by `node scripts/asset-perf-loop.mjs report`.

## Context

The owner asked for the asset pipeline to ship the most compressed assets it can and the fastest
preload it can, with a performance dashboard to watch it (2026-10-23).

The loop copies the CI speed loop (PRD-550): a script measures one arm, appends one iteration to a
JSON ledger, and renders a static HTML page from the ledger. The page opens from `file://` with no
script.

**Corpus.** Every asset directory the scaffolder ships: `template-assets/assets` plus each
`templates/*/assets`. That is 18 files and 11.91 MiB of source: 6 models (7.04 MiB), 6 audio clips
(4.59 MiB) and 3 images (0.27 MiB). Each measurement copies the corpus into a fresh temporary
project and runs a cold `compileAssets`, so no earlier bake is reused.

**Baseline (iteration #1, `6da4a6606`, default cook).** 11.91 MiB → **5.37 MiB, 45.1%**, cook 55 s.
The compiler's own `TN_ASSETS_BUDGET` line agrees: 5,627,982 bytes total.

| Kind | Source | Shipped | Shipped/source |
| --- | ---: | ---: | ---: |
| model | 7.04 MiB | 4.33 MiB | 61.4% |
| runtime (Basis transcoder) | 0 | 0.56 MiB | n/a |
| texture | 0.27 MiB | 0.27 MiB | 100% |
| audio | 4.59 MiB | 0.21 MiB | 4.7% |

What the baseline says:

- **Models are 81% of the shipped bytes** and shrink only to 61%. `player-viewmodel.glb` (1.58 MiB)
  and `mannequin-combat.glb` (1.56 MiB) are the two largest files.
- **The Basis transcoder is 10% of the shipped bytes** (0.50 MiB `.wasm` + 0.05 MiB `.js`).
- **`shared/sky.jpg` ships as authored** (0.27 MiB). The cause is not read yet.
- **Audio is already at 4.7%.** It is not a lever on this corpus.

**Preload baseline (iteration #3, same commit, default cook).** GPU-ready in **629 ms** on localhost
and **1705 ms** at 40 Mbps / 20 ms, median of 5 cold loads each, on the RTX 2080 (`adapter.info`:
vendor `nvidia`, architecture `turing`; the probe refuses a software adapter). The probe loads through
core's own `createAssetLoader` and `loadAll`, then compiles and renders one frame, so the time holds a
fixed shader-compile and first-render part of about 365 ms (629 ms ready against 264 ms loaded).

**Noise.** A paired A/A run (default against default, runs alternating) read 657 against 656 ms
local and 1943 against 1976 ms throttled, a spread of 5% and 3%. Two separate runs of the same
build differ by up to 14% (1705 against 1943 ms), so a lever is judged only against its own paired
control (`measure --pair`), never against an earlier iteration.

The uncooked control (iteration #2, `--arm none`) ships 11.91 MiB, 100%, so the cook halves the
corpus today.

## Execution Phases

### Phase 1 — The bytes loop and the dashboard

- [x] `measure` cooks the corpus cold and records source and shipped bytes per file and per kind. proof: `node scripts/asset-perf-loop.mjs measure --label "default cook, what a game ships today" --decision baseline` — exit 0, 11.91 → 5.37 MiB (45.1%), cook 55,073 ms; `--arm none --decision control` — exit 0, 11.91 MiB (100%).
- [x] The dashboard renders the goal strip, the bytes per kind, the largest files, the trend charts and the iteration table. proof: `node scripts/asset-perf-loop.mjs report` — exit 0; headless Chromium at 1280 px light and dark and at 390 px, no horizontal overflow, screenshots in `~/Downloads/asset-perf-dashboard/`.
- [x] A source the receipt does not name counts as shipped as authored, an output with no source counts as runtime, and a control arm never becomes the baseline. proof: red-green `pnpm exec vitest run scripts/__tests__/asset-perf-loop.spec.ts` — 3/3 pass; with the "as authored" rule removed, 1 fails.

### Phase 2 — Preload is measured

Preload ends at GPU-ready: every model is in the scene, every texture is uploaded and every clip is
decoded. Run `engine_search_capabilities` first: `loadAll` and the playtest startup timeline
(`enteredMs`, `readyMs`) already exist and are the expected building blocks.

- [x] A probe page loads the cooked corpus through core's `createAssetLoader` and `loadAll`, and the loop records `preloadLocalMs` on a named WebGPU adapter, 5 runs, median. proof: `sh scripts/xvfb.sh node scripts/asset-perf-loop.mjs measure --label "default cook with preload, what a game ships today" --decision baseline` — exit 0, local runs [673,629,626,629,628] ms, median 629, adapter nvidia/turing.
- [x] The probe throttles the network (CDP `Network.emulateNetworkConditions`, 40 Mbps down, 20 ms latency, as in the PRD-496 probe), and the loop records `preloadThrottledMs`. proof: the same run — throttled runs [1704,1711,1709,1705,1699] ms, median 1705. The playtest runner does not throttle; see Decisions.
- [x] The two preload goals are set from the Phase 2 baseline and lose their `provisional` flag. proof: `node scripts/asset-perf-loop.mjs report` — goals 450 ms local and 1200 ms at 40 Mbps, no `provisional` on the page.

### Phase 3 — Levers, one at a time

Levers tried (the dashboard holds the numbers; a verdict lands here when it lands there):

| # | Lever | Bytes | Preload (paired) | Verdict |
| --- | --- | ---: | --- | --- |
| 5 | Meshopt `FILTER` for animation outputs | 5.37 → 4.94 MiB (−8.0%) | local 830 vs 798 ms, 40 Mbps 1892 vs 1970 ms: noise | **Rejected.** Worst rotation error 0.712° against 0.041° today, translation 0.97 mm against 0. A limb tip moves 12 mm. `__tests__/model-animation-filter.spec.ts` now pins the floor: red on `FILTER`, green on the current cook. |
| 6 | Drop animation tracks that hold the rest pose (`passes.restTracks`, on by default) | 5.37 → 4.42 MiB (−17.7%) | local 621 vs 645 ms, 40 Mbps 1545 vs 1757 ms (−12%) | **Kept** (iteration #6). Visual judge **NEUTRAL**: 114 poses x 2 runs on the RTX 2080 (`scripts/asset-pose-capture.mjs`), 35 isolated pixels over 8 levels and no connected region, runs repeat to 0 pixels. `pnpm test:templates`: 7 of 8 templates pass; **snow `production-performance` is red** (p95 201, 61 and 75 ms against 33 ms, desktop under load). Snow ships no model and its cook is byte-identical to the control, but it has not run on a clean develop build, so the gate is **not** green. 3,926 of 5,583 combat tracks dropped; clips, durations and every keyframe time unchanged. Real-model proof: `prune-rest-tracks-pose.spec.ts` plays all 7 `mannequin.glb` clips in three's `AnimationMixer`, worst node difference below 1e-5; with the tolerance loosened to 0.5 it fails at 0.484. |
| 7 | Drop the glTF spec-default fields from the GLB JSON (`glb-spec-defaults.ts`, always on, lossless) | 4.42 → 4.33 MiB (−2.0%) | local 684 vs 699 ms, 40 Mbps 1611 vs 1646 ms: tie | **Kept** (iteration #7). 114 animated poses of the two mannequins are pixel-identical to the lever 2 build (0 differing pixels), so no judge subagent was needed. The 7 templates that ship models pass `pnpm test:templates` (95 scenarios, exit 0). `glb-spec-defaults.spec.ts` is red without the call. |
| 9 | KTX2 only when an embedded image repays the 600 KiB Basis transcoder (`transcoderBytes`, always on) | 4.33 → 3.78 MiB (−12.7%) | local 1109 vs 1483 ms, 40 Mbps 1823 vs 2086 ms (−25% / −13%) | **Provisional** (iteration #9). A paired control on the RTX 2080 under host load, 5 runs each; the absolute 1109/1823 ms are load-inflated and a quiet-machine rerun must confirm them. The transcoder is copied only when a KTX2 output exists; a JPEG/PNG texture no longer drags it in. `model-texture-pass.spec.ts` pins the new rule (authored bytes and no `basis/`) and the constant against three's real pair. Visual judge on 15 `player-viewmodel` poses (2 runs): **IMPROVEMENT**, small fabric/receiver detail gain, no banding or alpha break. Assets suite green; template gate pending on a quiet machine. |
| 10 | Smallest passing JPEG for opaque colour maps (`encodeJpegCandidate`, always on) | 3.78 → 3.68 MiB (−2.6%) | local 569 vs 619 ms, 40 Mbps 1322 vs 1448 ms (−8% / −9%) | **Kept** (iteration #10). The ladder tries quality 75/80/85/90 and keeps the smallest that holds SSIM 0.95 / ΔE00 3; data slots never enter it. Visual judge **NEUTRAL** on 15 `player-viewmodel` poses (2 runs, RTX 2080). `model-texture-pass.spec.ts` pins the rung, the smaller output and the untouched normal map. Shooter and action-rpg template gates pass on the quiet RTX; snow and rain passed on the laptop. |

| 11 | Standalone colour maps take the smallest passing JPEG (`sky.jpg`) | 3.68 → 3.55 MiB (−3.5%) | local 416/459/402 vs control 400/426/379 ms; 40 Mbps 1122/1136/1115 vs 1145/1141/1175 ms | **Rejected.** Three paired runs: local preload rose 4–8% while throttled fell about 5%, so the other preload metric got worse than its paired control. The 0.13 MiB is real and returns if the local decode cost is explained. |

Ceilings measured before building (no iteration; nothing here is worth a lever by itself):

| Candidate | Ceiling | Why |
| --- | ---: | --- |
| Lossless JPEG recompression (`jpegtran -optimize -progressive`) of the 11 textures that ship as authored | −12 KB (1%) | 617,831 → 605,554 bytes. The one PNG gains 61 bytes. |
| Spec-default JSON fields in the GLB (`"interpolation":"LINEAR"`, `"normalized":false`) | about −0.1 MiB | 78 KB on combat, 18 KB on mannequin; a lossless rewrite of the JSON chunk. |
| Textures that ship as authored (`not-smaller`) | none without a lower floor | Every rung that passes the PRD-351 floor is at least as large as the source. |

With these the corpus ends near 4.3 MiB. The 3 MiB / 25% goal needs a structural or lossy lever
(shared mesh and skin between the two mannequins, keyframe reduction with a timing bound, Draco), and
each of those is an owner call.

Each lever is one iteration on the dashboard: measure, then `keep` or `reject`. A lever changes what
reaches the screen, so a kept lever needs the visual judge (root `AGENTS.md`, owner rule
2026-10-09) to return NEUTRAL or IMPROVEMENT, and no texture may fall below its PRD-351 floor.
Candidates, ranked by baseline bytes:

1. Model geometry: `EXT_meshopt_compression` with its filters against Draco, on the two mannequin GLBs.
2. Embedded textures: KTX2 Zstandard supercompression on UASTC, ETC1S quality and RDO.
3. `sky.jpg`: read why it skips the cook, then cook it.
4. Basis transcoder: confirm it ships only when a KTX2 output references it, and long-cache it.
5. Preload order: critical assets first, the rest after `enter()`.

- [x] Each kept lever lowers `shippedMiB` or a preload metric, holds every texture floor, passes the visual judge and keeps the template playtests green. proof: ledger iterations #6, #7, #9 and #10 are `keep`; judges NEUTRAL/IMPROVEMENT (iterations #6, #9, #10) or pixel-identical (#7); every texture floor holds; template gate green across two hosts — snow, rain and the other templates on the idle laptop, shooter and action-rpg on the quiet RTX 2080 (`TN_TEMPLATE_ONLY=shooter|action-rpg`).
- [ ] The corpus ships at most 3 MiB and at most 25% of its source. proof: `node scripts/asset-perf-loop.mjs show` — latest kept iteration.
- [x] Both preload goals are met. proof: iteration #14, a quiet RTX 2080 run on `nvidia/turing`: local samples [422,372,382,362,362] ms, median **372 ms** ≤ 450; 40 Mbps samples [1168,1162,1243,1118,1134] ms, median **1162 ms** ≤ 1200. `node scripts/asset-perf-loop.mjs show` — latest kept iteration.

## Decisions

- **2026-10-23: the probe throttles the network itself.** The Phase 2 box asked for throttling in
  the playtest runner. The probe is a plain Playwright page that owns its CDP session, and no other
  caller needs a runner option, so the runner stays unchanged (root `AGENTS.md`: smallest diff).
- **2026-10-23: preload goals from the baseline.** Local ≤ 450 ms: the fixed shader-compile and
  first-render part is about 365 ms, so 250 ms was unreachable. At 40 Mbps ≤ 1200 ms: 3 MiB takes
  about 600 ms to transfer, plus 450 ms local.
- **2026-10-23: judge a lever against its own paired control.** `measure --pair` cooks the default
  beside the candidate and alternates their preload runs in one browser. Bytes do not need it.

- **2026-10-23, João: the compression is automatic.** A kept lever becomes the `packages/assets`
  default, and the cook picks its setting for each asset from what it measures there (codec,
  quality, geometry filter, cap). A game sets nothing to get the win. A lever that wins only through
  a game config is rejected. This is the root `AGENTS.md` "auto by default" rule.
- **2026-10-23: a live view.** `node scripts/asset-perf-loop.mjs serve` serves the page at
  `http://127.0.0.1:8767`. The page reloads when the ledger changes and shows a running `measure`.

- **2026-10-23, João: build the loop and the dashboard first.** The owner asked for this work
  directly, so it runs ahead of the open wave in the Unreal feature map.
- **2026-10-23: no Unreal port yet.** This PRD measures and tunes the existing cook. A lever that
  ports an Unreal subsystem (Oodle, IoStore, texture streaming) cites `UE 5.8.3` source in its own
  box before work starts.
- **2026-10-23: web target first.** `measure` cooks for the default web target. Android and iOS ship
  PNG instead of KTX2 (`packages/assets/README.md`), so a native arm gets its own ledger entry label
  when a lever reaches it; the trend line does not mix targets.
- **2026-10-23: byte goals from the baseline.** 3 MiB and 25% are a 44% cut from 5.37 MiB. Models
  hold 4.33 MiB, so the goal is out of reach without a model lever.

- **2026-10-23, João: fix the Wasm engine provisioning on this PR.** `pnpm test:templates` needs the
  browser Wasm engine, which git does not carry. Two gate runs failed on it (`TN_WASM_ENGINE_MISSING`,
  then a build without `cgltf` that refused every model). `pnpm wasm:build` now fetches the sources
  and builds it, the target refuses to build without `cgltf`, and the template gate stops at once
  without the pair. Lever 2 stays provisional until the gate runs green on a quiet machine.

## Blocked on

Nothing.
