# playtest determinism and startup readiness

Why scenario timing is ticks rather than milliseconds, and what the runner waits for
before it observes a game. Moved out of
[`@threenative/playtest/AGENTS.md`](../AGENTS.md) verbatim; every paragraph below is the text
AGENTS.md used to carry.

## Scenario steps count fixed-step ticks, not milliseconds

Scenario steps count fixed-step ticks, not milliseconds — use `holdTicks`, `waitTicks`. The
deprecated `holdFrames` and `waitFrames` aliases remain accepted for compatibility and are
treated as ticks when the bridge exposes `runtime.fixedStep`; `warmupFrames` remains a genuine
requestAnimationFrame warmup. Never introduce a wall-clock sleep or a millisecond-based step
into scenario semantics.

`"reducedMotion": "reduce"` (web target only) opens the page with `prefers-reduced-motion: reduce`
emulated before navigation, so a game that suppresses flashes or motion for it can prove so.

## Ticks are not the clock a launch runs on

**Ticks are not the clock a launch runs on.** A run advances ticks as fast as the machine allows,
so a whole scenario can complete during a launch that has not finished — and everything the
application gates on startup (compute dispatch, the first world present) then never happens inside
the run. `starter-look` read `flagSteps` 0 before and 0 after because the cloth had never been
dispatched; twelve starter scenarios photographed the loading screen and reported
`TN_CAPTURE_BLANK`. Both depended only on how long boot took.

So after `warmupFrames` and before the baseline observation, the runner waits for the application
to say its world is safe to observe: a bridge that advertises **`runtime.startup`** reports
`{ phase, progress }` from `ready()` (core's `playtest()` plugin publishes `ctx.startup`), and the
runner holds — pumping frames on browser, ticks on device — until `phase` is `"ready"`. Bounded by
`PLAYTEST_STARTUP_READY_TIMEOUT_MS`; a game that never gets there fails
`TN_PLAYTEST_STARTUP_NOT_READY` rather than being observed mid-load. An application that reports no
startup at all — a plain Three.js page — is never waited on, and advertising the capability without
reporting it is malformed and throws.

Readiness means two things, and the wait always insists on both. Core reaches `"ready"` after
first-use compilation settles **and** a frame window — five sustained in-budget frames, or a
bounded expiry of `STARTUP_STABLE_WINDOW_MS` (10s) when a CPU rasteriser can never meet them.
Observing at bare compile settlement is not enough: a game that builds its world on `whenReady()`
(the puzzle's crate pile is one) has not run yet, and the run then asserts against a half-built
world. So the software lane waits for `"ready"` like any other — at most 10s more per scenario —
and the declaration (`--allow-software` / `TN_PLAYTEST_ALLOW_SOFTWARE=1`) only **labels** the
result: `startup.rule` is `"compile-settled"`, because a CPU rasteriser reached readiness on the
bounded window rather than on sustained frames, and an operator must not read that pass as a
smoothness measurement. A lane that reaches readiness immediately is labelled the same way.

Compile settlement is still required — it is the part that makes a run observe the game rather than
the loading screen — and a game whose phase never leaves `"collapsing"` fails
`TN_PLAYTEST_STARTUP_NOT_READY` rather than being observed mid-load. The label is keyed *only* off
that declaration, never off a timeout or an adapter guess. Every report carries `startup.rule`,
`"sustained-frames"` or `"compile-settled"`, so a software-lane pass is never read as a smoothness
measurement.

A bridge that stops answering is not automatically a slow launch. A host that has **exited** looks
identical from the runner's side — both are operation timeouts — so on the device targets the wait
also asks the driver whether the process is still there, and a dead one fails immediately as
`TN_PLAYTEST_STARTUP_HOST_EXITED` with the console tail that says why. Only a `false` reading ends
the wait: a driver that cannot answer leaves it exactly as it was, because inferring a crash from an
unreadable probe is the implicit fallback everything else here refuses. Without it a crashed runtime
spent the full `PLAYTEST_STARTUP_READY_TIMEOUT_MS` and was then reported as the game's loading gate
being too slow — three minutes of silence blamed on the wrong layer, which is how the hosted
Windows performance collector read on PR #122.

Never fix a boot race by lengthening a wait. Padding changes which runs get lucky; the tick counts
were already identical in the runs that disagreed.

## `--live-clock`: the one wall clock a measurement may ask for

**A standing scene is not measurable on counted ticks, and that is not the game's defect.** The
browser runner sends each fixed-step tick through its own bounded `advance(1)` request, while recording
path samples in groups of ten ticks. A counted group presents no extra observation frame: a game
standing still while a scenario watches it reports one boot window and nothing after it, because
there was no second frame to close a window on.

`--live-clock` (browser and desktop targets) is the opt-in, and it is the harness half of what the
native production profile's own `--live-clock` already does there. On the browser the runner puts
`globalThis.__THREENATIVE_PLAYTEST_CLOCK__ = "wall-clock"` in an `addInitScript` — ahead of every
page script, so a request that lands after the game's module evaluated cannot happen — and on the
native desktop host it hands the same request over as `TN_PLAYTEST_CLOCK=wall-clock`, which
`loadScript` reads before it evaluates the game entry (`runtime.cpp`). Either way the
producer reads it: the loop is left unfrozen, the host's frame pump moves the simulation at the
machine's own rate, and `advance` spends the span of wall time its ticks name and reports the ticks
that pump really ran instead of insisting on the count it asked for. Every report then carries
`clock: "wall-clock"`, so a rate is never read without the clock that produced it.

The request lives in the protocol beside the mode it names, so a game that installs the bridge
itself (`installThreePlaytestBridge`, a plain Three.js project) honours it too: only an installer
that names its own mode outranks it, and a producer with no request still reports the clock it
really runs on. An unrecognised value throws `TN_PLAYTEST_CLOCK_UNSUPPORTED` rather than falling
back — a misspelling that quietly left the loop frozen published a frame rate for a game that was
not playing.

It is a measurement switch, not scenario semantics. `holdTicks` and `waitTicks` stay tick counts,
the flag is refused on the device targets (their hosts take the request from the production
profile's injected instrumentation, not from this runner), and a deterministic scenario that wants
ticks asks for none. A value the host does not recognize is refused there too:
`TN_PLAYTEST_CLOCK_UNSUPPORTED` on stderr, and the launch fails rather than reporting a wall-clock
run that never happened.
