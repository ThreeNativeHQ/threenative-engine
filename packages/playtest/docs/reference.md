# playtest reference

Flag tables, exit codes, per-target detail and the assertion vocabulary for
[`@threenative/playtest`](../AGENTS.md), moved out of that file verbatim so the
always-loaded rules stay short. Every paragraph below is the text AGENTS.md used to carry.

## Running a scenario — flags, exit codes and the display

Exit `0` passed, `1` assertions failed, `2` never reached assertions, `69` when a command's
external decoder is absent so nothing was inspected, and `75` when the capture lock queue timed
out — the last two are explicitly **not** test failures, and `75` prints the holder and queue
depth. `--build-report <artifact>.build-report.json` adopts the `performanceBudget` a
`threenative build` published beside that artifact: the run re-hashes the artifact under test and
exits `2` when it is not the one the report describes (`TN_PLAYTEST_BUILD_REPORT_STALE`), and
merges the budget per key into the scenario's own `assert.performance`. It needs `--artifact` on
browser and Android, which is the only thing that says which build the run exercises. `--server-command` needs a workspace that has a `dev` script — an example or a scaffolded
project; there is no root `pnpm dev`. `--browser-recipe webgpu` supplies the current Chromium WebGPU
flags including `--enable-features=Vulkan`, without which Chromium silently serves WebGPU from
SwiftShader and reports healthy-looking limits from a CPU rasteriser; `--browser-arg` is the escape
hatch, and a run that does not name its adapter is not evidence. **On Linux the runner provisions a
private Xvfb for every pixel-producing run, whether or not a display exists** (stripping Wayland env
itself), so a scenario never opens windows over whatever the operator is doing — a sweep that
borrows `:0` makes the machine unusable for as long as it runs. Set `TN_PLAYTEST_HOST_DISPLAY=1` to
paint on the session's own display instead; opt in when the run needs the session's real GPU adapter
(heavy TSL post chains have been seen falling back to SwiftShader under Xvfb) or when a human wants
to watch it. An explicit host request verifies the X connection with `xdpyinfo` (including
abstract Xwayland sockets) using the session's `DISPLAY` and credentials. Missing `DISPLAY`,
an unavailable connection, or a missing probe command fails with
`TN_PLAYTEST_HOST_DISPLAY_UNAVAILABLE`; it never silently substitutes a private Xvfb.
Do **not** reach for `--headless` to keep windows off a screen: headless Chromium
cannot capture WebGPU here, so it changes what you measure. The runner takes a capture lock only
when it detects competing runners — or always with `CAPTURE_LOCK=1`; lock state is printed to stderr
either way. `sh scripts/xvfb.sh` remains as an optional compatibility wrapper — never `xvfb-run`,
whose exit status is its own failing cleanup kill rather than the command's.

## A frame rate from a private Xvfb is wrong, not missing

**A frame rate from that private Xvfb is wrong, not missing**, so no command may print one as
though it were measured: without vsync the present wait lands inside the update phase (13.3 fps
there against 57.7 on the real display, one build). `trace` never prints one. `perf` prefers the
display's own rate whenever a window carries one — core reads the host's `__tnPresentedCount` and
reports `presents`/`presentedFps` beside the loop's `fps` — and otherwise suppresses the column and
refuses a `--min-fps` bound when the run's display is private (`--executable`) **or the log says for
itself that the frames never reached the display**: the host counts loop frames and presents
separately in `TN_PRESENTS_TICK`, and a loop the presentation cap outran inflates `fps` by exactly
that ratio — midway's native launch log reported 2631 fps beside its own
`{"frames":1740,"presents":133,"capHz":60}`, and passed a 55 fps bound. A window that counted zero
presents carries no rate at all: the column prints `0.00`, the windows are named in words, and a
bound over windows that all lack a rate fails closed. Both refusals take `--allow-virtual-display`
when the operator is deliberately reading phase timings alone. A
`--min-fps` bound that can be satisfied by a number nobody can vouch for is a green with nothing
behind it — the desktop build above reported 20,000 fps that way.

## Captured tone

`assert.tone[]` bounds `mean`, `p1`, `p50`, `p99` in display luminance bytes and
`clipFraction`, `blackFraction` in 0..1. Every metric takes inclusive min/max; at least one
bound is required. `atStep` selects a named step, otherwise the final capture is used.
Tone requests survive disabled convenience screenshots and fail on absent captures. The browser
and device paths retain their shared PNG histogram as TN_TONE under observations.tone. The game's
bridge never supplies these host measurements. The offline command
`threenative-playtest tone <png...>` prints identical metrics and a frame-average row.

## One scenario, four targets

`--target browser|android|desktop|ios` runs the same scenario file against a browser, an Android
device or emulator, a native desktop executable, and an iOS simulator or device
(`runner/androidRunner.ts`, `runner/desktopRunner.ts`, `runner/iosRunner.ts`,
`runner/deviceTransport.ts`). Desktop requires `--executable`, and the game bundle reaches the host
through repeatable `--host-arg` (`--host-arg run --host-arg dist/game.js`) — without it the host
launches with no game and the run reports `TN_PLAYTEST_BRIDGE_MISSING` at zero frames. The runner
owns a temporary local
mailbox and passes its root to the native host through `TN_PLAYTEST_MAILBOX_ROOT`. Keep it that way:
an assertion that only
means something on one target is a fork of the harness.

A device target that cannot be reached fails `TN_PLAYTEST_DEVICE_FAILED`; it never degrades
to a browser run. Where a target genuinely lacks an observer — device transport has no CDP
network observer — the assertion **errors and names the working target**, it does not skip.
The negative-control scenarios in `examples/native-smoke/playtests/` (`-misspelled`,
`-wrong-value`) prove the device path still fails closed; run them when you change transport
or observation code.

## `perf` — read the frame meters without opening a log

`threenative-playtest perf` parses `TN_FRAME_BUDGET` and `TN_HOST_GAP` out of one source —
`--file <log>`, `--executable <bin>` with repeatable `--host-arg`, or `--logcat <serial>` — and
reports fps, frame/render/hostGap p50/p95 per window plus the host-gap segments. It exists
because every number in the Android-fps hunt was read from these markers by hand; the parser
(`runner/perf.ts`) is that hand-read, encoded.

Protocol rules are built in, not optional: **window 1 is discarded as startup** (it always
lies), `--require-windows` (default 2) counts *steady* windows and a run with fewer exits **2**
— not enough evidence, never an empty pass — and a marker line whose JSON cannot be parsed
**throws** (`TN_PERF_MARKER_MALFORMED`) rather than silently vanishing. Optional bounds
`--max-frame-p95 <ms>` / `--min-fps <fps>` fail with exit **1** on any steady-window violation;
without bounds the command reports and exits 0. The host's `Present mode:` line is captured
when the host logs one. `--text` renders the human-readable table; default output is JSON.

Desktop spawn under a headless session rides the same Xvfb rule as any pixel run:
`sh scripts/xvfb.sh threenative-playtest perf --executable … --host-arg run --host-arg game.js …`,
and that Xvfb is exactly the display whose frame rate cannot be trusted — such a run prints no
`fps` column and refuses `--min-fps` (exit 1, `TN_PERF_VIRTUAL_DISPLAY`) unless the operator passes
`--allow-virtual-display`. The phase and host-gap rows, which are what the native lane's baselines
quote, are unaffected.
The command never launches a browser — the browser lane already bounds performance through
`assert.performance` — and it never tunes anything; it is a meter reader.

## `audio` — look at the sound, because nobody listens in CI

`threenative-playtest audio --expect <manifest.json>` decodes every clip a game declares and
reports band energy, peak, DC, silence and loop-seam continuity, writing one spectrogram PNG per
clip. No browser, no display, no capture lock: inspecting audio reads files, and taking the capture
queue for it would block the machine's pixel work for nothing.

It exists because **every check that does not involve listening passes on audio that is wrong**.
The file exists, it is served 200, it decodes, no page error, it is inside the byte budget — and the
clip is a hum where a chime should be. That shipped here: a discovery cue with 80% of its energy in
100-500 Hz and 1% above 2 kHz, on the one sound a player waits to hear. So did fifteen footsteps
with up to 45% of their energy below 100 Hz, which is a thud, not a boot on stone. Both are
unmistakable in a band profile and a spectrogram, and invisible in a size, a duration or a green
`loaded` marker.

**The game declares the expectations, because the inspector cannot know them.** Nothing here knows
that a forest bed should be broadband and a discovery chime should be bright. The manifest is the
game saying so:

```json
{ "version": 1, "clips": [
  { "path": "public/audio/forest-bed.ogg", "loop": true,
    "bands": { "sub": { "max": 3 }, "high": { "min": 20 }, "air": { "min": 20 } } },
  { "path": "public/audio/landmark-found.ogg", "loop": false,
    "bands": { "low": { "max": 25 }, "high": { "min": 25 } } }
] }
```

Bands are `sub` (<100 Hz), `low` (100-500), `mid` (500-2k), `high` (2k-8k) and `air` (>8k),
contiguous to Nyquist, reported as percentages of summed magnitude over Hann-windowed frames
covering the whole signal. They are comparable to each other and to what a game declares, not to
another tool's numbers. The frame hop shrinks on a short clip so its spectrogram is wide enough to
read a transient off — a half-second footstep holds twenty non-overlapping frames, and a
twenty-column picture defeats the only reason the picture exists.

Fails closed, on this package's own rule: an unknown key, a band nobody measures, a bound that can
never hold, a `seamMaxRatio` on a clip whose `loop` is false, a duplicate path, or an empty clip
list all **throw** rather than skip. `loop` is required rather than defaulted, because it is the one
fact that decides whether the seam is checked. `--dir <dir>` additionally fails when any audio file
under it is undeclared — otherwise the gate is only as good as the manifest and a clip added later
is a clip nothing checks.

**Two measurement rules, both learned by getting them wrong.**

*Decode at the file's own rate.* A seam measured on a resampled decode measures the resampler: its
FIR window runs off the end of the data at the first and last output sample and is zero-padded, so
the edge samples are the only wrong ones in the file — exactly where a seam test looks. On one real
set that inflated the reported step three to sevenfold and reordered which clip looked worst. The
command never passes `-ar` to ffmpeg.

*Judge the wrap against the steps beside it.* A click is a step that is anomalous **where it
happens**. A sparse clip is mostly quiet, so a whole-clip percentile flatters its seam; a dense one
is mostly loud, so the same percentile condemns a join nobody could hear. The reference is the
99th-percentile sample step within 50 ms either side, and the default ceiling is 1.5x rather than
1.0x — a flawless wrap that lands on the signal's steepest point *is* the largest step in its
neighbourhood and measures exactly 1.0.

Exit `0` when every check passed, `1` when one failed, `2` when it could not run (a malformed or
unreadable manifest), and `69` when ffmpeg is absent. That last code is the point: **"I could not
check" and "I checked and it is fine" must never be the same answer**, so CI can treat 69 as a skip
and still treat 1 as a defect.

`--text` prints `✓`/`!`/`✗` lines with a `fix:` on anything that is not ok; default output is JSON.
The numbers are the gate and the picture is what a person or an agent looks at when the gate fires,
so every spectrogram written is named in both. Verdicts, parsing and analysis live in
`runner/audio.ts` and are unit-tested against synthesised signals in `__tests__/audio.spec.ts`;
`runner/audioRun.ts` only drives ffmpeg.

## Startup time is an observation

The runtime stamps its startup milestones on its own clock — `loadStartedMs`, `enteredMs`,
`compileSettledMs`, `readyMs`, in milliseconds since navigation — and publishes them as
`observations.startup.timeline`. Scenarios bound them with `assert.startup`: `maxEnteredMs`,
`maxCompileSettledMs`, `maxReadyMs`. A milestone the run never reached fails closed
(`TN_PLAYTEST_STARTUP_UNOBSERVABLE`); one past its ceiling fails
`TN_PLAYTEST_STARTUP_TOO_SLOW` with the measured value. Before this, startup was a console
anecdote read off `TN_STARTUP_WARMUP` after the fact.

## Device thermal, power and battery

Every `--target android` run measures the phone around itself and reports it as
`observations.deviceMetrics` — battery temperature and level, Android thermal status, charging
state, current draw, and Pixel's per-rail ODPM power breakdown. It is sampled before `prepare()`
(the only moment a pre-launch baseline is still readable, since `prepare` clears logcat), every
five seconds during the run, and once after the last bridge sample.

The point is **comparability**. On 2026-08-24 two cold-launch runs read 44 s to first frame
against a 14.7 s baseline and the difference was blamed on a code change; the device had reached
43.2 °C at thermal status 2 while the baseline ran at 38.2 °C at status 0. A run is flagged
`thermallyConfounded` with named reasons — `hot-start` (≥ 40 °C), `throttled-start`,
`thermal-status-rose`, `charging`, `incomplete` — and a flagged run's numbers are still reported
in full. The verdict withdraws the claim of comparability, never the measurement.

Scenarios assert on it with `deviceMetrics`: `notThermallyConfounded`, `maxTemperatureRiseC`,
`maxThermalStatus`. On browser, desktop or iOS the assertion fails
`TN_PLAYTEST_UNSUPPORTED_ON_TARGET` and names android — it never skips. A reading the device does
not expose (per-rail power off Pixel hardware, `current_now` where the sysfs node is absent)
reports `{ available: false, reason }`; **nothing here ever reports an unmeasured zero**.

Ask *before* spending a run: `doctor --device <serial>` reports the phone's battery temperature,
thermal status, charge level and charging state next to the machine checks. It warns — a hot
phone is a run that will not be comparable, not a broken machine — and only fails on a device
that is unreachable or a probe that cannot be parsed.

```sh
node packages/playtest/dist/runner/cli.js doctor --device <serial> --text
```

Parsers and verdict live in `runner/deviceMetrics.ts` and are unit-tested against captured device
output in `__tests__/fixtures/device-metrics/`. Add real captures there rather than inventing a
`dumpsys` format. Both the observation lane and `doctor --device` only report; the gate that
*refuses* a hot or charging device before a benchmark is
`packages/runtime-native/scripts/device-preflight.mjs`, and they share the same battery floor so
an operator is never told two different stories.

## The room, and the feet

Two things the harness measured and nothing could read.

`doctor --url` used to end its report with *not observed: lights, materials and textures* and
*not observed: camera framing*. An agent looking at a black or washed-out frame therefore had
nothing between "the bridge answered" and a screenshot, which is the one instrument that cannot
say **why**. The bridge now reports the room as `observations.scene` — lights with their colours
and intensities, materials counted per distinct material by constructor name, fog with its own
near/far or density, the background, the camera's position, forward, fov and clip planes, and the
scene's world extent. Counts and names only: it decides nothing about how anything looks, and a
value the scene does not carry is absent rather than zero. The walk is capped
(`SCENE_WALK_OBJECT_CAP`, `SCENE_LIGHT_CAP`) and a scene past either reports `truncated: true`,
so a floor is never read as a total.

`doctor --url` reads it back as three lines — `lighting`, `materials`, `camera` — and names the
ways a frame dies while every other number stays healthy: **lit materials with no visible light**,
a **fog far plane in front of the scene it is fogging**, and a **camera far plane that clips it**.
The second is round 9's lost visual column, where a radius-90 sky dome sat behind `Fog(bottom, 18,
80)` and rendered as one flat wash; no gate could see it.

`AnimationPlayer.stride` has measured the *feet meet the floor* convention since it shipped — what
the clip carries against what the body covered — and it never crossed the bridge either, so a game
that set `strideSync: false` had turned the measurement off as far as any proof was concerned.
It now rides in `gameplay.animation.<entity>.stride`, and `assert.animation[]` bounds it:

- `maxFootSlide` — ceiling on `|feet − ground| / ground`. The feet move at the rate the clip is
  *actually playing*, which is the measured `rate` only when `synced`; an overridden clip keeps
  its authored rate. Reading `rate` unconditionally scored an overridden run at zero slide —
  the exact case the bound exists to catch, found by the locomotion scenario, not by a unit test.
- `strideSynced` — require the convention applied (`true`) or deliberately overridden (`false`).

Both fail closed, and each failure names which kind: `TN_PLAYTEST_STRIDE_UNOBSERVED` when the
producer reported no stride, reported half of one, or the body covered no ground to compare
against; `TN_PLAYTEST_STRIDE_NOT_SYNCED`; `TN_PLAYTEST_FOOT_SLIDE` with both speeds and the
ceiling. A game that does not measure stride has not measured zero slide.

A scenario bounds the same numbers with `assert.scene`, so the check outlives whoever ran
`doctor` once:

- `minVisibleLights` — floor on lights the renderer will actually see. An invisible light is no
  light.
- `litMaterialsAreLit` — fail when lit materials are mounted and nothing lights them. A scene of
  `MeshBasicMaterial` needs no light and is not failed for having none.
- `fogClearsScene` — fail when a linear fog goes opaque in front of the scene's furthest corner.
- `cameraClearsScene` — fail when the camera's far plane cuts the world it is pointed at.

`assert.scene` bounds the room. It cannot say **where one object is**, and that is the other half
of every screenshot an agent takes: is the crate in the vault or under the floor, is the camera
pointed at it, did the plate's normal map ever load, is the character's mesh visible once every
ancestor's `visible` flag is counted. Those kill a frame while every count above them stays
healthy, and a screenshot shows the damage without naming the cause.

`sceneNodes` reports the graph node by node, for the nodes a selector picks out — `name`,
`nameContains`, `pathContains`, `type` — and bounds them:

```json
{ "assert": { "sceneNodes": [
  { "select": { "nameContains": "crate" }, "minCount": 30, "visible": true, "texturesLoaded": true },
  { "select": { "name": "seal" }, "inFrustum": true },
  { "select": { "nameContains": "debug" }, "maxCount": 0 }
] } }
```

- `visible` — the node's own flag **and every ancestor's**, which is what the renderer acts on. A
  visible mesh under a hidden group draws nothing and reports `visible: true` on itself.
- `inFrustum` — the node's world bounds against the active camera's frustum. A node with no
  bounds is never tested and reports no membership, which fails rather than passing unmeasured.
- `texturesLoaded` — every bound map slot carries pixels. A slot bound to a texture whose image
  never arrived samples black while the material, the light count and the network all read fine.
- `animated` — clips are mounted on the object. This is not what the game's mixer is *playing*;
  that is `gameplay.animation` and `assert.animation`, and the failure message says so.
- `minCount` (default 1) / `maxCount` — `maxCount: 0` is how a scenario asserts a node is absent.
- `minTriangles` — summed across the matched nodes, and reported as a floor when the selector's
  limit cut the list.

Each observation is walked only when a scenario asks for it, because reading geometry, materials
and world bounds per object is real work on a large scene. The walk is capped
(`SCENE_NODE_WALK_CAP`, per-selector `limit`), `matched` always counts every match, and a cut list
reports `truncated: true` — a floor is never read as a total. A selector that filters nothing, an
assertion that selects nodes and bounds none of them, and a `minCount` above its `maxCount` all
throw at load. A run with no node observation fails once as `sceneNodes.observed`
(`TN_PLAYTEST_SCENE_NODES_UNOBSERVED`). Advertised as the `scene.nodes` capability.

## "Because", not "and then"

A run could always say *a contact happened* and *the state reads `won`*. Nothing related the two.
`assert.states[].atSteps` orders them at **step** boundaries, which cannot separate a win arriving
with the contact from one arriving 199 ticks later inside the same step — and that is exactly the
shape of a terminal state driven by a timer or a distance check that merely lands near a contact.

Measured in the field: a sandbox physics puzzle reported `won` on frame one with the player
untouched eight metres away, because its goal volume overlapped the floor slab. Its own HUD agreed
the game was won. Every assertion in the harness was green, because each was individually true.

Both sides are now tick-stamped by the producer, and `assert.causedBy` relates them:

```json
{ "assert": { "causedBy": [
  { "cause": { "contact": { "entity": "warden", "with": "seal", "kind": "trigger" } },
    "effect": { "path": "state.status", "becomes": "won" },
    "neverBefore": true, "withinTicks": 4 }
] } }
```

- `neverBefore` fails when the effect is ever observed before the first matching cause. That is the
  frame-one fake win, at tick granularity.
- `withinTicks` bounds `effectTick - causeTick`. A win long after the contact was not caused by it.
- `cause` takes a `contact` **or** a `transition`, never both — two causes in one row would
  silently make the earlier one the cause. So "the door opened because the plate was pressed" is
  the same row shape.
- A row setting neither `neverBefore` nor `withinTicks` throws at load: ordering alone is what
  `atSteps` already does, and asserting only that both events happened is two assertions wearing
  one name.

Core's `playtest()` plugin drains both logs **per tick** rather than per sample and advertises
`runtime.transitions`. The transition watcher diffs each registered entity's `state` and the
top-level primitive fields of the published game state, recording `{ path, from, to, tick }` —
`states.<entity>` or `state.<field>`. A path's first observed value is its starting point, not a
transition; recording it as one would fail every `neverBefore` against the game's own initial
state. The log is bounded by `PLAYTEST_TRANSITION_LOG_LIMIT`.

Every failure mode is named and closed. A run with no transition log fails once as
`causedBy.observed` (`TN_PLAYTEST_TRANSITIONS_UNOBSERVED`) — a loop that never ticked has observed
nothing, not nothing-changed. A matching contact carrying **no tick** fails
`TN_PLAYTEST_CAUSE_UNSTAMPED` rather than being read as a cause at tick zero, and the message says
the producer drains only at sample time. A cause the run never observed is
`TN_PLAYTEST_CAUSE_NOT_OBSERVED`; an effect that never transitioned is
`TN_PLAYTEST_EFFECT_NOT_OBSERVED`; the frame-one case is `TN_PLAYTEST_EFFECT_PRECEDES_CAUSE` with
both ticks; a late effect is `TN_PLAYTEST_CAUSE_TOO_DISTANT`. **The family never falls back to step
granularity** — that is a different measurement, and answering a tick question with it would be the
confident wrong number this package exists to refuse.

One related fix in core, from the same build: an area's contact used to be dropped unless the game
passed an explicit `entity` option, so a trigger that demonstrably fired reported no contact at all
and a `contacts` assertion went green over a run whose own state proved the overlap. The far side
now falls back to the scene-registry id the area is registered under.

A run with no scene observation fails once as `scene.observed`
(`TN_PLAYTEST_SCENE_UNOBSERVED`) rather than failing each bound against nothing, and an
`assert.scene` that sets no bound throws at load. An unmeasurable comparison — no world extent,
no far plane — fails; it never counts as cleared.

Advertised as the `scene.observe` capability. A capability the runner's registry does not define
is rejected (`TN_PLAYTEST_BRIDGE_CAPABILITY_UNKNOWN`), so a new observation channel is registered
in `src/capabilities.ts` in the same change that starts advertising it.

## Scenario-controlled spawn & aim

The scenario `setup` block carries a placement vocabulary so capturing a vantage frame is
one scenario, not a patch-run-revert ceremony:

- `setup.spawn { x, z }` (+ optional `y`) overrides the SUBJECT player start's position.
  An absent `y` preserves the game's own height (eye or ground line); it is never silently
  defaulted to zero. Requires `subject`.
- `setup.aim { yaw, pitch }` overrides the SUBJECT player start's aim; both angles are
  radians, Three.js convention (forward is -Z at yaw 0, pitch positive up). Requires
  `subject`.
- `setup.place[]` entries `{ entity, at: {x,y,z}, facing?: {yaw} | lookAt?: {x,y,z}, frozen?: boolean }`
  put named entities at explicit transforms. `frozen` sets `PLAYTEST_FROZEN_MARKER`
  (`__threenativeFrozen`) on the entity's userData — data the game reads to suppress
  physics motion, never a runner-side teleport loop.

Presence semantics are explicit and fail closed: an unknown entity id, an entity missing
from the registry at apply time, or a target coincident with the subject is a NAMED error
(`TN_PLAYTEST_SETUP_UNAPPLIED`), never a silent skip. One entity may be placed by only one
of `setup.entities` / `setup.place`.

A `click` step's `at` is viewport pixels `{ x, y }`, a registered entity `{ entity }`, or (browser
only) a DOM element `{ element: { id } | { selector } }` clicked at the centre of its live box. Prefer
the element form for interface controls: pixel positions move with the fonts a machine has
installed, which is how a rain scenario passed locally and missed its switch on CI.
Steps can also carry `{ kind: "aimAt", target: { x, z } | { entity }, pitch?, waitTicks?, screenshot?, label? }`.
The runner samples the subject's current position, computes yaw/pitch toward the target,
and applies them through the setup channel as quaternion data — no CDP mouse events and no
OS-focus dependency. An `aimAt` step cannot also deliver input (`press`, pointers) or
ignored holds (`holdTicks`/`holdFrames`); follow it with a `waitTicks` step to hold the pose.

Every requested override rides into the run report as `setup.requested` next to what
applied (`setup.applied`). A run whose placement cannot apply fails with the reason named —
an overridden spawn must be visible in diagnostics, never green-with-silence. The game keeps
its own spawn constants; scenarios override them for determinism, through this one channel.
The template-teaching copy of this vocabulary ships via the create-threenative shared
fragment when games adopt it; until then this section is the harness contract.
