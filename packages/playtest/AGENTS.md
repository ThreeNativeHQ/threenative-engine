# AGENTS.md — @threenative/playtest

Read `/AGENTS.md` first. This file is the operator CLI and what is different about changing the
harness. Flags, exit codes, per-target detail and the assertion vocabulary live in
[docs/reference.md](docs/reference.md); ticks and the startup wait in
[docs/determinism.md](docs/determinism.md). Anything that is reference rather than rule is there,
not here.

## Running a scenario

```sh
pnpm --filter @threenative/playtest build          # the CLI is built, not checked in
node packages/playtest/dist/runner/cli.js init     # writes playtests/smoke.playtest.json
node packages/playtest/dist/runner/cli.js playtests/smoke.playtest.json \
  --url http://127.0.0.1:5173 --server-command "pnpm --filter abyss-framework dev" \
  --browser-recipe webgpu
```

Exit `0` passed, `1` assertions failed, `2` never reached assertions, and `69` / `75` are
explicitly **not** test failures (external decoder absent; capture lock queue timed out).

- `--browser-recipe webgpu` is not optional on the browser lane. Without its Vulkan flags Chromium
  silently serves WebGPU from SwiftShader and reports healthy-looking limits from a CPU rasteriser;
  a run that does not name its adapter is not evidence. `--browser-arg` is the escape hatch.
- Never `--headless` to keep windows off a screen: headless Chromium cannot capture WebGPU here,
  so it changes what you measure. On Linux the runner provisions its own private Xvfb for every
  pixel-producing run; `TN_PLAYTEST_HOST_DISPLAY=1` opts into the session's display when the run
  needs the real GPU adapter or a human watching.
- **A frame rate from that private Xvfb is wrong, not missing.** `perf` suppresses the column and
  refuses a `--min-fps` bound (exit `1`, `TN_PERF_VIRTUAL_DISPLAY`) unless you pass
  `--allow-virtual-display`. A bound satisfied by a number nobody can vouch for is a green with
  nothing behind it.
- Wrap a headless run in `sh scripts/xvfb.sh <cmd>`, never `xvfb-run` — its exit status is its own
  failing cleanup kill, not the command's.
- A scaffolded project runs the same CLI as `npx @threenative/playtest`. The framework template
  installs the bridge with `playtest()` in `defineGame`; a plain Three.js project uses
  `installThreePlaytestBridge` from `@threenative/playtest/three`.
- A scenario's `network: { downloadKbps, latencyMs }` throttles the browser link through CDP, so a
  load-time claim runs at a stated link speed (for example 20000 kbps and 40 ms).
- `diagnostics`, console, network, screenshot and trace assertions work against any URL. Semantic
  assertions (`movement`, `camera`, `visibility`) against a project with neither bridge fail
  `TN_PLAYTEST_BRIDGE_MISSING` — that is the harness being right. Install the bridge or narrow the
  scenario; **never delete the assertion to get green**.

Ask the machine before spending a run: `doctor --text`, `doctor --url <url> --text` (adds the
scene), `doctor --device <serial> --text` (adds device thermals) — see the root `AGENTS.md`.

## The rule that outranks everything else in this package

**A check that cannot run must fail, never skip.**

v1's harness had 19 validators that returned `undefined` on a wrong-typed value and 13
`.filter()` calls that dropped them silently. One misspelled assertion type meant the
scenario ran with zero assertions and **reported green**. That is the single most dangerous
failure mode in an agent loop, because the agent optimizes against the report.

Concretely, when you touch this package:

- A malformed assertion **throws at load** (`invalidScenario(...)`). Never dropped, coerced,
  or defaulted.
- Never add a `.filter()` that removes an assertion, an observation, or a step.
- A missing entity, an absent resource, an empty effect log, or a scenario with no assertions
  is a **failure**, not a pass.
- A run reports `pass` only when at least one assertion was evaluated against an observation
  that actually arrived.
- New assertion types need a test proving the wrong-typed case fails. `__tests__/` already
  holds the shape: `vacuous-assertion.spec.ts`, `silent-drop.spec.ts`,
  `evidence-required.spec.ts`. Add to those rather than starting a new pattern.
- **"I could not check" and "I checked and it is fine" must never be the same answer.** That is
  what `69` and `75` exist for: CI may skip them and still treat `1` as a defect.

## Where it fails closed, and under what name

Each of these is a named failure, never a skip. Do not add a branch that softens one. The
vocabulary behind them is in [docs/reference.md](docs/reference.md).

- **Four targets, one scenario** — `--target browser|android|desktop|ios`. An unreachable device
  fails `TN_PLAYTEST_DEVICE_FAILED`; it never degrades to a browser run. A target that genuinely
  lacks an observer errors and names the working target. Desktop needs `--executable` plus
  repeatable `--host-arg`, or the host launches with no game and reports
  `TN_PLAYTEST_BRIDGE_MISSING` at zero frames.
- **A missing observation fails once, by name** — `causedBy.observed`, `sceneNodes.observed`,
  `scene.observed`, `TN_PLAYTEST_SCENE_NODES_UNOBSERVED`, `TN_PLAYTEST_SCENE_UNOBSERVED`. A
  `deviceMetrics` assertion off android is `TN_PLAYTEST_UNSUPPORTED_ON_TARGET` and names android.
- **An unmeasured value is never a zero** — an absent device reading reports
  `{ available: false, reason }`; a stride the producer never reported is
  `TN_PLAYTEST_STRIDE_UNOBSERVED`, not zero slide; a walk past its cap reports `truncated: true`
  so a floor is never read as a total.
- **Desktop input goes through the host's own UI routing** (`playtestInput` in `runtime.cpp`): a
  `press` held set carries modifiers (`["Shift","Tab"]`), `pointers` are touch (no hover) and
  `pointerPosition` is the mouse, `wheel` turns at its optional normalized `x`/`y`, and a step's
  `media` (`colorScheme`, `reducedMotion`) restyles a native-css UI. Android takes `wheel` and
  `media` over that same mailbox route, because its host is the same C++; iOS refuses both, because
  its overlay is a web-view mirror with no native-css scroller or environment. With
  `TN_CSS_UI_FIXED_STEP_MS=<ms>` in the host's environment the native-css animation clock moves
  `<ms>` per advanced tick, never with the wall clock (`TN_CSS_UI_CLOCK` is logged).
- **An assertion that only means something on one target is a fork of the harness.** The
  negative-control scenarios in `examples/native-smoke/playtests/` (`-misspelled`,
  `-wrong-value`) prove the device path still fails closed — run them when you touch transport or
  observation code.
- **Advertise only what you registered.** An unknown capability is
  `TN_PLAYTEST_BRIDGE_CAPABILITY_UNKNOWN`, so a new observation channel is registered in
  `src/capabilities.ts` in the same change that starts advertising it.

## Determinism

Scenario steps count fixed-step ticks, not milliseconds — `holdTicks`, `waitTicks`. Never
introduce a wall-clock sleep or a millisecond-based step into scenario semantics. Ticks are also
not the clock a launch runs on, so the runner waits, before the baseline observation, for a
bridge advertising `runtime.startup` to report `phase: "ready"`; bounded by
`PLAYTEST_STARTUP_READY_TIMEOUT_MS`, and a game that never gets there fails
`TN_PLAYTEST_STARTUP_NOT_READY` rather than being observed mid-load. A host that has *exited* is
`TN_PLAYTEST_STARTUP_HOST_EXITED`, not a slow launch. **Never fix a boot race by lengthening a
wait** — padding changes which runs get lucky. Browser frame-time and FPS assertions select the live host clock by default; an explicit
`liveClock: false` run config retains counted ticks. Other scenarios keep counted ticks.
One measurement opt-in sits outside all of it:
`--live-clock` (browser and desktop targets) makes the host's own frame pump move the simulation,
so a standing scene is measurable at all. The browser injects `__THREENATIVE_PLAYTEST_CLOCK__ =
"wall-clock"` ahead of every page script. The desktop runner sets `TN_PLAYTEST_CLOCK=wall-clock` for
the native host, which installs the same global before the game module loads. Every report then
says `clock: "wall-clock"`. A counted desktop run refuses an inherited `TN_PLAYTEST_CLOCK`. Full rule:
[docs/determinism.md](docs/determinism.md).

Optional scenario `startTick` is an absolute nonnegative safe integer fixed-step anchor, reached
after startup readiness and warmup, before baseline observations or input. It requires
`runtime.fixedStep` and an observed fixed-step clock; `--live-clock`, missing ticks, startup
overshoot and a resampled tick unequal to the anchor fail closed. It neither resets the game
nor changes relative step counts. Absent `startTick` leaves existing behavior unchanged.

## Where things live

| Concern | File |
| --- | --- |
| `perf` markers → fps, p95, host-gap segments | `runner/perf.ts` |
| audio verdicts, parsing, analysis | `runner/audio.ts` (`runner/audioRun.ts` only drives ffmpeg) |
| device thermal and power parsers | `runner/deviceMetrics.ts` |
| the four target runners | `runner/androidRunner.ts`, `runner/desktopRunner.ts`, `runner/iosRunner.ts`, `runner/deviceTransport.ts` |
| capability registry | `src/capabilities.ts` |

Add real captured device output to `__tests__/fixtures/device-metrics/` rather than inventing a
`dumpsys` format.

## This is salvaged code

Lifted from `threejs-to-bevy` and deliberately standalone: it runs against **plain Three.js
with zero ThreeNative dependencies**, and that independence is a product decision, not an
accident. `three` and `playwright` are optional peers. Do not add a `@threenative/core`
dependency.

It is also excluded from the framework LOC budget and from `biome.json`, so its style differs
from the rest of the repo. Match the file you are editing, not the root convention.

## Test layout, and a trap

Vitest at the root only collects `packages/**/__tests__/**/*.spec.ts`. The co-located
`src/**/*.test.ts` files here are **not** run by `pnpm test`. Put anything that must gate CI
in `__tests__/`, or run the co-located ones explicitly and say that you did.