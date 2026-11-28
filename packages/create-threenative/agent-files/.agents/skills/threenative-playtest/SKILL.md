---
name: threenative-playtest
description: Diagnose a ThreeNative game, prove behavior, and keep playtests fail-closed. Use for a blank, black, or washed-out frame, a browser, device, or import failure, or when writing or repairing a playtest scenario and its assertions.
---

# ThreeNative diagnosis and playtests

For browser, blank-frame, device, or import failures, run `npx threenative doctor` and
`npx @threenative/playtest doctor` first. For a running game, use:

```sh
npx @threenative/playtest doctor --url http://127.0.0.1:5173 --text
npx @threenative/playtest playtests/<name>.playtest.json --browser-recipe webgpu --headed
```

Read visibility, scale, draw cost, frame rate, advancing state, and errors. Missing output means
unobserved, never zero.

**Read the room before you reach for a screenshot.** `doctor --url` also reports three lines named
lighting, materials and camera — how many lights the renderer can see, what materials are mounted,
the background, the fog, and the camera's position and clip planes — and it names the three ways a
frame dies while every other number looks healthy: lit materials with no visible light, a fog far
plane in front of the scene it fogs, and a camera far plane that clips it. A black or washed-out
frame is a question those lines answer and a screenshot cannot.

Bound the same things in a scenario so the check outlives the session:
`assert.scene` takes `minVisibleLights`, `litMaterialsAreLit`, `fogClearsScene` and
`cameraClearsScene`; `assert.animation[]` takes `maxFootSlide` and `strideSynced`, which catch a
character skating across the floor when the clip and the ground disagree. Both fail closed — a
bridge that reports no scene has not reported a well-lit one. For a relative-placement question, publish a scene probe with derived
`checks`, drive it with Playwright, sweep candidates in one run, and turn the winning check into a
playtest assertion.

When an `@threenative/*` API is broken, missing, or does not do what you need, replace only that
piece with portable Three.js/plain code. Keep the loop, scenes, input, entity registry, and bridge;
avoid `document`, `window`, `localStorage`, dynamic `import()`, and raw physics handles. **Report
what blocked you**: API, expectation, result, and replacement. Never stall on a framework bug.

Playtests fail closed: a missing entity, absent observation, or empty assertion set fails. Every
`allowTrivial` waiver needs a 20-character reason; `true` alone is invalid, and all-waived
triviality fails `TN_PLAYTEST_SCENARIO_ASSERTS_NOTHING`. Use `holdTicks`/`waitTicks` for fixed-step
time (`holdFrames`/`waitFrames` are compatibility aliases); `warmupFrames` means RAF warmup.
Read `node_modules/create-threenative/agent-docs/references/assertion-reference.md` for assertion fields and `node_modules/create-threenative/agent-docs/references/debug-surface.md`
for bridge globals. The JSON-safe bridge resource is `state`; `GameState` is a deprecated alias.

**Lint, full-loop proof, and capture health:**
- Run `pnpm typecheck && pnpm lint` **before** invoking `threenative-playtest` so static/unused-var errors never block playtests late in a round.
- Every game with a multi-lap, multi-stage, or collection loop needs one deterministic playtest scenario covering start/countdown handover -> progression -> collision/hazard -> finish/end screen -> clean restart reset (adapting or deleting incompatible kit scenarios such as rival DNF checks in a solo race).
- Never toggle `"passes": true` on code inspection alone: quote the exact passing JSON snippet (`"pass": true` plus key terminal/restart metrics) before closing a task, and verify a non-blank live frame (`npx @threenative/playtest doctor --url`) after edits, reverting breaking changes before ending the turn.
