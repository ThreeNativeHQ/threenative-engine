# Scenes, the game loop and plugins

Define a game, write scenes with the right lifecycle methods, run updates at a fixed step and share
services through plugins.

## Define the game

`defineGame` connects scenes, input, plugins and project settings. The result runs in the browser
and in the native runtime. This entry comes from the minimal template, which uses physics:

```ts
import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import { rapier, type IPhysicsContext } from "@threenative/physics";
import config from "../threenative.config.js";
import { Play } from "./scenes/Play.js";
import type { GameState } from "./state.js";

const game = defineGame<GameState, IPhysicsContext>({
  input: { move: {
    up: ["KeyW", "ArrowUp"], down: ["KeyS", "ArrowDown"],
    left: ["KeyA", "ArrowLeft"], right: ["KeyD", "ArrowRight"],
  } },
  plugins: [rapier(), playtest()],
  renderer: config.renderer,
  display: config.display,
  scenes: { play: Play },
  start: "play",
  step: 1 / 60,
});
export default game;
```

The two type parameters type `ctx.state` and `ctx.physics` in every scene. `rapier()` adds physics.
`playtest()` lets scenarios observe the game. Browser page setup stays in `src/main.ts`.

## Scene lifecycle

A scene extends `Scene` and overrides the methods it needs.

| Method | When ThreeNative calls it |
| --- | --- |
| `load(ctx)` | Before the scene enters. Return a Promise for async loading. |
| `enter(ctx)` | Once, to add objects. It can return a `SceneFrame` update callback. |
| `update(ctx, dt)` | Every fixed step, if `enter` returned no callback. |
| `render(ctx)` | When the world draws. Use it for visual-only adjustments. |
| `exit(ctx)` | When the scene ends. Remove callbacks and free scene-owned resources. |

The minimal template returns a callback from `enter`, so the objects and the per-step code share one
closure. If `enter` returns a callback, ThreeNative calls it instead of `update`.

## Fixed-step updates

Every gameplay update receives the same `dt`. Set it in seconds with `step`. The default is
`1 / 60`. After a slow frame, the loop runs catch-up steps, up to `maxSteps` per frame. The default
is 5. Do not add your own accumulator on top of `step`.

Two hooks run at fixed points in the frame. Both return a function that removes the callback:

```ts
const removeFollow = ctx.afterPhysics(() => {
  // Follow the body's solved transform here.
});
const removePresentation = ctx.beforeRender(() => {
  // Update a presentation-only element once per world draw.
});
// Retain these removal functions in the owning scene.
// Call removeFollow() and removePresentation() in its teardown.
```

`ctx.afterPhysics` runs after physics writes body positions. `ctx.beforeRender` runs once before
each world draw. Frames that show only the loading screen skip it.

State changes reach UI subscribers once per drawn frame. If you want fewer UI updates, set
`stateFlushMs` to a longer interval.

## The scene context

`ctx` has the type `ICtx`. It holds the Three.js scene and camera, input, assets, state, timers and
other services. The [API](api.md) lists them all.

Read controls with `ctx.input` and change game values with `ctx.state.set`. Rules written against
these run the same in the browser and natively.

`ctx.renderer` is the ThreeNative renderer wrapper. If a library needs the Three.js renderer, use
`ctx.renderer.raw`. If a feature needs one backend, check `ctx.renderer.kind` first.

## Change scenes

Call `ctx.goto(name)` to switch scenes. It returns a Promise, so handle its rejection. Keep a
scene's callbacks and resources where its `exit` can reach them.

Removing a mesh from the scene does not free its geometry or material. Dispose what the scene
created for itself. Keep shared assets until every user is done with them. Test leaving and
re-entering each scene.

To show a game object in diagnostics and playtest observations, register it with
`ctx.entities.add(id, object)`. The object itself can stay a plain TypeScript class.

## Development reload and replays

Editing a file under `src/` in `pnpm dev` rebuilds the module without losing the session.
`acceptHotUpdate(game, import.meta.hot)` registers that restore in the web development entry. The
state store is what crosses the boundary, so it must be portable: finite numbers and plain objects
only. `assertPortableState(state)` enforces it and names the value that cannot cross.

```ts
import { acceptHotUpdate } from "@threenative/core/hot";

acceptHotUpdate(game, import.meta.hot);
```

`replay()` is the same idea for a whole session: a plugin that records the input of each tick and
plays it back, so a bug the player hit is reproducible. Seeded random and a fixed-step simulation
are what make a replay mean anything. `replay({ portable: true })` lets another host with the same
simulation contract replay a recording; without it a recording belongs to the host that made it.
`createReplayDriver(recording, target)` dispatches a recording against a target element when you
drive a page or a test rather than a plugin.

## Run the game off the page thread

A busy page — a heavy React tree, a large parse — delays the frame. The game can run in a web worker
instead, with the page left owning only the canvas, input forwarding and the HUD bridge.

```ts
import { startWorkerGame } from "@threenative/core/worker"; // in the page entry
import { serveWorkerGame } from "@threenative/core/worker"; // in the worker entry
```

In the worker entry, call `serveWorkerGame(game)` last, after the game module evaluated: it posts the
ready message the page waits for before it sends the canvas. In the page entry, call
`startWorkerGame(worker, container)` **before** the UI mounts — it returns `{ ready, stop }`, and the
HUD's bridge host globals exist only from that call on. It throws `TN_WORKER_HOST_REQUIRED` when it
runs outside a page.

A worker has no DOM, so the parts that touch it — a web HUD, a canvas-only effect, a library that
reads `document` — stay on the page side of the bridge.

## Plugins

A plugin connects a reusable service to the game lifecycle. It is either a function that takes
`ctx` and returns a cleanup, or an object with any of these hooks: `setup`, `beforeUpdate`,
`update`, `sceneExit` and `dispose`.

Physics and playtesting are plugins. Write one when your own service needs startup, per-step or
cleanup work across scenes. Keep single gameplay rules, such as how a weapon deals damage, on the
game object.

## Source

- [scene.ts](../../packages/core/src/scene.ts)
- [game.ts](../../packages/core/src/game.ts)
- [state.ts](../../packages/core/src/state.ts)
- [hot.ts](../../packages/core/src/hot.ts)
- [replay.ts](../../packages/core/src/replay.ts)
- [worker.ts](../../packages/core/src/worker.ts)
- [minimal template Play.ts](../../packages/create-threenative/templates/minimal/src/scenes/Play.ts)
