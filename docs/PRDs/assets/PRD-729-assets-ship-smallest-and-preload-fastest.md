---
prd_contract: v1
---

# PRD-729 — Assets ship as few bytes as they can and preload as fast as they can

**Status:** PARTIAL — Phase 1 (bytes loop and dashboard) is done with a recorded baseline. Phase 2
(preload measurement) and Phase 3 (levers) are open.
**Priority:** P2 — Phase 2 is open: no preload time is measured yet, so the two preload goals are provisional.
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

- [ ] A probe game loads the cooked corpus through `ctx.assets` and `loadAll`, and the loop records `preloadLocalMs` from its startup timeline on a named WebGPU adapter, 5 runs, median. proof: `node scripts/asset-perf-loop.mjs measure --label "preload baseline"` with the playtest command it runs printed, `--browser-recipe webgpu`, `adapter.info` checked.
- [ ] The playtest runner can throttle the network (CDP `Network.emulateNetworkConditions`, 40 Mbps down, 20 ms latency, as in the PRD-496 probe), and the loop records `preloadThrottledMs`. proof: red-green `pnpm exec vitest run packages/playtest/__tests__/<network>.spec.ts` and the same `measure` run.
- [ ] The two preload goals are set from the Phase 2 baseline and lose their `provisional` flag. proof: `node scripts/asset-perf-loop.mjs report` shows no `provisional`.

### Phase 3 — Levers, one at a time

Each lever is one iteration on the dashboard: measure, then `keep` or `reject`. A lever changes what
reaches the screen, so a kept lever needs the visual judge (root `AGENTS.md`, owner rule
2026-10-09) to return NEUTRAL or IMPROVEMENT, and no texture may fall below its PRD-351 floor.
Candidates, ranked by baseline bytes:

1. Model geometry: `EXT_meshopt_compression` with its filters against Draco, on the two mannequin GLBs.
2. Embedded textures: KTX2 Zstandard supercompression on UASTC, ETC1S quality and RDO.
3. `sky.jpg`: read why it skips the cook, then cook it.
4. Basis transcoder: confirm it ships only when a KTX2 output references it, and long-cache it.
5. Preload order: critical assets first, the rest after `enter()`.

- [ ] Each kept lever lowers `shippedMiB` or a preload metric, holds every texture floor, passes the visual judge and keeps the template playtests green. proof: the ledger iteration with `--decision keep`, `pnpm test:templates`, and the judge verdict beside the box.
- [ ] The corpus ships at most 3 MiB and at most 25% of its source. proof: `node scripts/asset-perf-loop.mjs show` — latest kept iteration.
- [ ] Both preload goals are met. proof: `node scripts/asset-perf-loop.mjs show` — latest kept iteration.

## Decisions

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

## Blocked on

Nothing.
