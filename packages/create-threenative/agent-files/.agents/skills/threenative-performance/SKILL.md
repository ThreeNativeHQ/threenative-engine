---
name: threenative-performance
description: Measure ThreeNative frame budgets and report platform evidence without guessing. Use when the game is slow, when a frame budget, FPS floor, or platform performance claim is in question, when reading `TN_FRAME_BUDGET`, or when writing a bounded performance assertion.
---

# ThreeNative performance evidence

Pool objects; load static GLBs via `ctx.assets.model()`; Unexecuted platforms stay unverified. `TN_FRAME_BUDGET` reports `fps`, `hostGap`, `update`, `render`, `overlay`,
`residual` and per-pass draws and triangles. `defineGame({ frameBudget: false })` silences
output, never measurement.

## When the scene is the problem

`TN_SCENE_WARNING` fires when the GPU used under a third of a frame whose render phase overran
the display period: move draws and objects, not settings. `npx threenative doctor` and
`DEV_MODE=true` repeat it; `TN_FRAME_SPANS=1` splits that phase.
Largest static win: three skips binding updates when nothing changed; not writing a transform saved 7.35 ms on 1,561 objects, `markStatic(root)` 0.009 ms.
An uncaught per-frame walk or poll? Fix it, then `file-engine-bug`.

## Slow or stuttering game

`npx @threenative/playtest trace --url <url> --text` names the hot function (`--cpu-prof <file>`
writes a `.cpuprofile`). Then use the `threenative-devtools` MCP: quote its GPU, heap and network, not its
inflated CPU times.

## Use the shipped defaults

The engine prepares transforms, batches, culls, scales resolution and cooks assets;
read `node_modules/create-threenative/agent-docs/references/performance-basics.md` before hand-rolling any.
Withdraw thermally-confounded Tiers 1–3 comparisons; always report Tier 4. Proof:
`{"performance":{"minFps":60,"maxPhaseMsP95":{"render":12},"maxPassDrawCalls":{"shadow":400}}}`; frame time defaults to 16.7 ms p95 (looser needs `maxFrameMsReason`);
defined in `node_modules/create-threenative/agent-docs/references/assertion-reference.md#performance`; pass bounds fail closed without a
per-pass split.

|Tier|Measure|Floor|Target|
|---|---|---:|---:|
|1|Starter/browser-desktop|60fps|display-refresh|
|1|Starter/browser-Android|30fps|58fps|
|1|Starter/native-desktop|60fps|display-refresh|
|1|Starter/native-Android|55fps|58fps|
|1|Starter/native-iOS|unverified|no-number|
|1|All-platform/hostGap-p95|—|≤4ms|
|1|All-platform/update-p95|—|≤2ms|
|1|All-platform/residual-p95|—|≤0.5ms|
|1|All-platform/overlay-p95|—|≤1ms|
|2|Same-device-fps-parity|.85|.95|
|2|Inverted-render-p95-parity|.80|.95|
|3|Light|55fps|58fps|
|3|Medium|30fps|58fps|
|3|Heavy|30fps|58fps|
|4|Sustained-duration|10min|10min|
|4|Final/opening-fps|.75|.90|
|4|Last-minute-heavy|25fps|50fps|
|4|Peak-battery-temperature|≤45C|≤40C|
|4|Thermal-status|≤2|≤1|
|4|Whole-device-current|—|report;not-gated|

Android: budget a ~500 MiB driver floor before textures; a dual-use equirectangular
environment adds ~48 MiB: `node_modules/create-threenative/agent-docs/references/mobile-memory-budget.md`.
