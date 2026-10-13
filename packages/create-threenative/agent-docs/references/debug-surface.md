# The debug surface — probing a running game

The bridge globals exist but were discovered by trial: six throwaway probe scripts in one
day, each re-finding the shapes through TypeErrors. This page lists every global a running
game exposes, what it returns, and how to read it from the browser console. All of them are
read-only observation surfaces; none exists to drive gameplay.

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
`TN_OPACITY_IGNORED`: scene-entry console error; set `transparent: true` or `alphaHash: true` on visible materials with `opacity < 1`.

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
