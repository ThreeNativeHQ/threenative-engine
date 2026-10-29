# The debug surface — probing a running game

The bridge globals exist but were discovered by trial: six throwaway probe scripts in one
day, each re-finding the shapes through TypeErrors. This page lists every global a running
game exposes, what it returns, and how to read it from the browser console. All of them are
read-only observation surfaces; none exists to drive gameplay.

## One debug switch and one report window

Set `TN_DEBUG=1` in the host environment, add `?tnDebug=1` to the browser URL, or assign
`globalThis.__THREENATIVE_DEBUG__ = true` before the game boots. A console assignment after boot
does not install instrumentation retroactively. Worker boot must receive the flag before its game
module evaluates. The switch enables incumbent spans/counters and debug producers for bridge,
callbacks, scene/renderer/GPU, memory, loading, host and UI activity.

`TN_FRAME_BUDGET.counters.engine` contains numeric per-frame summaries by name (`samples`, `mean`,
percentiles and `max`). One `TN_DEBUG_REPORT` for that same window ranks observed costs with
`basis`, caller and a matching lever where available. Read the units before comparing:

| Basis | Meaning |
| --- | --- |
| Measured CPU milliseconds/share | Timed synchronous work divided by the observed frame interval. Parent phases and nested callbacks overlap; adding them double-counts work. |
| Getter-equivalent estimate | Crossing count times a measured getter calibration. This estimates boundary overhead; it does not time every invoke, set or write. |
| Counts and bytes | Work or traffic observed, with unavailable cost unless separately timed. A large total alone is no measured CPU share. |
| Asynchronous wall time | Time until a decode, GPU sample or completion arrives; it can overlap other work and is not synchronous CPU/GPU duration. |

Debug windows expose `durationMs` between completed report boundaries, including host gaps.
Count/byte observations include `perSecond` derived from that duration. The first window,
zero/unavailable duration, missing frame samples or a truncated summary ring leave the rate null.
Worker traffic reports shallow UTF-16/primitive byte estimates and explicit unmeasured nested
fields, rather than claiming structured-clone wire sizes. HUD serialized bytes are exact UTF-8.
Asset dispatch costs name each URL; asynchronous load/decode wall time stays out of CPU rankings.
`textureMainThreadDecodeFallbacks` identifies the image-element path, whose later decode CPU cost
is unavailable. Shared TRS writes include unchanged writes; pure math values stay outside the
scene-transform census. GPU created/freed bytes begin at diagnostic activation, without claiming
an inventory of earlier allocations.
Native V8 installs GC prologue/epilogue callbacks only after debug activation and reports
`gcPauses`/`gcPauseMs`; shutdown removes them. Browser/Wasm GC entries are optional platform
observations, so an unavailable GC observer leaves those counters absent.

GPU query results can arrive in a later frame. Join requested/resolved/delivered sample identity
before comparing cadence or attributing a duration to a world draw. Queue completion delivery
delay, host gaps and measured GPU execution are separate observations. An unsupported observer or
counter remains absent; treat it as unmeasured rather than a zero. Shared Wasm/native counter names
do not establish that desktop or Android has executed; those claims require their actual lanes.
The owned renderer's current CMake adapters reject Android/iOS; forwarding a debug flag to the
legacy host supplies no shared-renderer parity on those platforms.
`findings.share: null` means the finding has no corresponding measured cost; it is not zero cost.

`TN_HOT_CALL`, `TN_BRIDGE_WARNING` and `TN_SCENE_WARNING` are actionable performance warnings;
playtest fails them even when console-error checks are opted out. `TN_DEBUG_REPORT` is diagnostic
and does not itself fail a run. Bound its numeric source through `assert.engineCost`, using the
exact names from `TN_FRAME_BUDGET.counters.engine`; a missing or unmeasured bounded counter fails.

The engine-only smoke scenario reuses the native-smoke game without changing its gameplay:

```sh
node packages/playtest/dist/runner/cli.js examples/native-smoke/playtests/debug-telemetry.playtest.json \
  --url 'http://127.0.0.1:5173/?tnDebug=1' \
  --server-command 'pnpm --filter threenative-native-smoke dev --host 127.0.0.1 --port 5173' \
  --browser-recipe webgpu --headed
```

It requires a debug-only callback counter in an actual budget window and bounds it by the loop's
five-step cap. This proves the observation path when run; it does not qualify every producer or
claim a device lane. Debug-off retains the existing census without installing debug observers,
timers or call stacks.

## `window.__THREENATIVE__` — entity snapshot (dev builds only)

Installed by `defineGame` when the dev-server flag is on (`installDevTools`); absent in
production builds.

```js
window.__THREENATIVE__.snapshot()
// → { entities: [{ id, kind?, ...entity debug fields }], ... }
```

`snapshot()` prefers an entity's own `debug()` and falls back to `autoFields`. This is the
fastest "what does the game think exists" probe; playtest assertions and the dev overlay
read the same registry.

## `window.__THREENATIVE_PLAYTEST_BRIDGE__` — the harness channel

Installed by `playtest()` (core plugin) or `installThreePlaytestBridge`
(`@threenative/playtest/three`). One object, JSON-safe in and out:

| Member | Shape | Use |
| --- | --- | --- |
| `describe()` | `{ name, protocolVersion, capabilities, limits }` | First call. Tells you what this game's bridge supports and the protocol limits. |
| `ready()` | `{ ready: true }` | Liveness check before sampling. |
| `sample(request)` | JSON-safe observation snapshot (entities, camera, renderer stats, resources, components, and `scene`: the lights, materials, fog, background, camera framing and world extent) | The main probe. Pass `{}` for the default sample; `request.include` names optional series such as `physicsDebugSeries`. |
| `advance(ticks)` | fixed-step bridges only: advances exactly N ticks and returns `{ clock, ticks }`; throws if the step count mismatches | Deterministic stepping without wall-clock waits. Throws when the bridge is render-frame. |
| `applySetup(request)` | applies scenario `setup` placements/resources through the registry | What scenario setup uses; also usable by hand for one-off staging. |
| `drainEvents(limit)` | event-queue bridges only: returns up to `limit` queued events | Reads events shorter than one state flush. |

A console one-liner that works on any bridged game:

```js
await window.__THREENATIVE_PLAYTEST_BRIDGE__.describe()
```

Missing global means no bridge is installed — semantic assertions against that page fail
`TN_PLAYTEST_BRIDGE_MISSING`, which is the harness being right, not a bug to work around.

## `window.__THREENATIVE_NATIVE__` — native host channel

Present only under the native runtime. The host injects its side; core's viewport and
`@threenative/playtest/three`'s device reporting read it (adapter identity, host snapshot).
On web this global does not exist — do not probe for it in portable code.

## Scene-entry markers

`TN_ENVIRONMENT_TOO_SMALL`: scene-entry console error; use an equirectangular environment at least 64 pixels wide for PMREM.
`TN_OPACITY_TRANSPARENT`: scene-entry console warning; the engine turned `transparent` on for visible materials with `opacity < 1` so the authored opacity takes effect. Override on the material: `alphaHash: true`, or `opacity: 1` for an opaque surface.
`TN_OPACITY_IGNORED`: printed by a direct `renderTrapAudit(scene)` call for a material that still ignores its opacity.

Markers print at the Verbose (`console.debug`) level in the browser console, so DevTools hides them
by default; harnesses still receive them. Open the page with `?tnLog=1` to print them normally.

## Runner-side markers

Two further globals are set by tooling, not the game, and are named here so a stray
assignment is recognisable: `__THREENATIVE_PLAYTEST_RUNNER_EXPECTED__` (core's playtest
plugin marks the expected runner contract) and `__THREENATIVE_FRAMEBUFFER_COVERAGE_PROBE__`
(the framebufferCoverage assertion installs its sampler). Leave both alone in game code.

## What does not exist

There is no `__THREENATIVE_SCENE__` global. Scene-graph inspection goes through
`sample()` — which reports counts, extents and visibility, and under `scene` the lights,
materials, fog, background and camera framing the renderer was handed — or through your
own registered entities' `debug()` output, never by reaching into three.js objects from
the console and treating what you find as an observation surface.

`scene` counts and names; it does not read texture contents or shader graphs, and a scene
past the walk's cap reports `truncated: true` so a floor is never read as a total. A value
the scene does not carry is absent rather than zero.
