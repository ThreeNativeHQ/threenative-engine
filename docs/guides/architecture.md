# How ThreeNative fits together

See which parts ThreeNative provides, which parts your game owns and where each kind of code goes.

## The layers

You build scenes with plain Three.js objects. `defineGame` connects them to rendering, the game
loop, input, asset loading, state and plugins.

The shared game lives in `src/game.ts`. It runs in the browser or in the ThreeNative native
runtime, which supplies the window, graphics surface and input for the device. Browser setup stays
in `src/main.ts`. Materials, lights, camera and effects are editable files in `src/render/`.

## Who owns what

| Part | Provides | You decide |
| --- | --- | --- |
| Your game | Scenes, characters, rules, assets and UI. | How the game looks, plays and responds. |
| `@threenative/core` | Startup, game loop, input, asset loading and state. | Scenes, controls, settings and game systems. |
| Plugins | Shared services such as Rapier physics and playtesting. | Which services to use and how gameplay reacts. |
| Native runtime | The window, graphics surface and device input. | Target platforms and platform integrations. |
| Build tools | Asset processing and app packaging. | Asset settings, app identity and release options. |

ThreeNative reports events and your code gives them meaning. The physics plugin detects that a
body entered a trigger. Your scene decides whether that scores a point or opens a door.

## Choose the engine

Two renderers sit behind one API. The default is ThreeNative's own C++ engine — compiled to Wasm on
web, the V8 engine player on desktop. `engine: "threejs"` in `threenative.config.ts` is the named
override, which keeps upstream Three.js on web and the legacy host on desktop. Android and iOS run
the legacy host under either setting.

Nothing in your game changes. `defineGame`, the scene objects, the materials and the render settings
are the same files, because both renderers answer the same Three.js API. What changes is what a
frame can afford and, on the default engine, that WebGPU is required: it has no WebGL2 path, so a
browser without WebGPU fails with `TN_NO_RENDERER`. Details in
[Native runtime](native-runtime.md) and [Rendering](rendering.md).

## From startup to a frame

At startup, plugins set up their services and the first scene loads. The scene's `enter` adds
objects. ThreeNative then runs gameplay updates at a fixed step and draws the scene.

Put gameplay rules in the update. Two hooks cover work that must run at a specific point:

- `ctx.afterPhysics` runs after physics writes body positions. Use it for a camera that follows a
  body.
- `ctx.beforeRender` runs once before each world draw. Frames that show only the loading screen do
  not call it.

`ctx.renderer` is the ThreeNative renderer wrapper. If a library needs the Three.js renderer, use
`ctx.renderer.raw`. If an effect needs one backend, check `ctx.renderer.kind` first. It is
`"webgpu"` or `"webgl2"`, and `"webgl2"` only exists under `engine: "threejs"`.

## UI

The optional `@threenative/ui` package runs React HUDs, menus and debug panels over the scene. The
minimal template takes the other route and draws its HUD inside the scene.

A HUD reads game values with `useGameState` and sends intents with `useUiIntent`. An intent is a
named request, such as `"restart"`, that the game decides how to handle. The same state and intent
flow works over a native game.

The native runtime draws the 3D world itself. A WebUI overlay uses the platform WebView for menus
and HUDs. See [Native runtime](native-runtime.md) for supported platforms and UI requirements.

## Your own systems

Start an enemy, weapon or inventory as a plain TypeScript class, kept with the scene that creates
it. Write a plugin when a service must take part in startup, updates and cleanup across the whole
game.

Check the [API](api.md) before you build animation, camera, input or asset tools. Keep code that
uses the raw renderer or raw physics behind a check for the backend it needs.

To keep a game portable:

- Keep browser setup in the web entry, so the shared game can run natively.
- Use `ctx.input`, `ctx.assets` and the game loop for controls, loading and timing.
- When a scene ends, remove its callbacks and free resources it created. Leave shared assets alone.
- Run the playtests on every platform you release.

## Source

- [CHARTER.md](../architecture/CHARTER.md)
- [game.ts](../../packages/core/src/game.ts)
- [scene.ts](../../packages/core/src/scene.ts)
- [ui index.ts](../../packages/ui/src/index.ts)
