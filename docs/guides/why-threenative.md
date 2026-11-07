# Why ThreeNative?

Three.js draws the frame. ThreeNative is everything else a game needs around it: a loop, input,
physics, asset builds, a HUD, playtests that fail closed, and a native runtime that runs the same
`src/game.ts` on desktop and Android without a browser.

## The short version

Write the game once in TypeScript. Run it in a browser with WebGPU, as a desktop binary, and on an
Android phone, where the native runtime renders the same build at roughly twice the frame rate of
Chrome on that phone. Your agent gets a searchable manifest of every engine API and four MCP servers
for assets, and a playtest harness checks gameplay instead of screenshots you eyeball.

Everything is MIT-licensed npm packages. You keep plain Three.js meshes, materials, cameras and
loaders, and your game is ordinary source you review and version like any other code.

## What you stop writing

A game on vanilla Three.js starts by rebuilding the same plumbing: a fixed-step loop, key and
gamepad mapping, a physics bridge, loading screens, a HUD bridge, scene teardown. ThreeNative ships
that plumbing, so a game is its scenes and its rules.

| You need | On vanilla Three.js | On ThreeNative |
| --- | --- | --- |
| A game loop | `requestAnimationFrame` plus your own fixed step and pause | `defineGame({ step: 1 / 60 })` and `Scene.update(ctx, dt)` |
| Input | Key, pointer, touch and gamepad listeners you merge yourself | Named actions: `ctx.input.vector("move")`, `ctx.input.axis("zoom")` |
| Physics | Wire Rapier, sync transforms, step it on time | `@threenative/physics` with Godot-style `CharacterBody3D` and `RigidBody3D` |
| Many objects | Hand-built instancing and merged geometry | `defineGame` collapses static scenes automatically; `InstancedBatch` for your own repeats |
| A HUD | A DOM overlay that does not exist on native | One React HUD that runs on web and native |
| Asset builds | Ad hoc glTF compression scripts | A content-addressed compile step with texture, mesh and audio passes |
| Tests | Screenshots and hope | Scenario playtests that drive the real build and assert game state |
| Desktop and mobile | A separate native host, or none | `threenative build` for desktop and Android from the same source |

## Measured, not promised

Each number below comes from a recorded run in the engine repository.

- **About 2× faster on a phone.** A 2,282-mesh platformer on a Pixel 8 runs at about 106 fps
  median in the native runtime, with 0 of 253 windows below 60. The identical build in Chrome on
  that phone is pinned at 60 fps with worst frames past the 16.7 ms budget.
- **11.6× faster than the same scene on plain Three.js.** At 4,096 objects the automatic scene
  collapse turns 9,400 draw calls into 3: 20.90 ms down to 1.80 ms, with no game-side code.
- **3× to 3.9× ahead of Godot 4.7.1** on an identical instanced scene, on the web, on desktop and
  on the Pixel 8.
- **Half the plumbing.** Framework plumbing is 74 lines against 138 in a hand-written control, and
  cloth costs 46 lines against 761.

## Built for agents

An agent that cannot see what already exists rewrites it. ThreeNative gives it the map:

- A capability manifest of every public engine API, searchable by the situation you are in. The
  [API reference](../../packages/core) on this site is generated from it.
- Four MCP servers wired by one install: assets, sculpting, Blender and engine capability search.
- A generated `AGENTS.md` in every project that routes each kind of task to the right tool.
- Playtests the agent can run itself, which fail closed instead of passing on a blank frame.

## Everything in the box

| Area | What you get | Read |
| --- | --- | --- |
| Game structure | `defineGame`, scenes with enter, update and exit, typed state, entities, hot reload | [Scenes and the game loop](core-concepts.md) |
| Rendering | WebGPU with WebGL2 fallback, render settings as project source, post effects, virtual geometry for dense meshes, automatic draw-call collapse | [Rendering](rendering.md) |
| Input | Named actions over keyboard, mouse, touch, gamepad, scroll and pinch; pointer raycasts | [Input](input.md) |
| Physics | Rapier with character and rigid bodies, spatial queries, navmesh pathfinding on the web | [Physics](physics.md) |
| Assets | glTF loading with progress, a build-time compile step, texture atlases, mesh LODs, audio conditioning, Unreal and Fab imports | [Assets](assets.md) |
| Animation | Skeletal clips, blending, retargeting between rigs | [Animation](animation.md) |
| UI | A React HUD shared by web and native, state mirroring, UI intents, a debug overlay | [UI and state](ui-state.md) |
| Audio | Positional and ambient sound on web and native | [Audio](audio.md) |
| Open worlds | Terrain tiles, heightmaps and cell streaming around the player | [World streaming](world-streaming.md) |
| Networking | An authenticated WebTransport channel shared by browser and native | [API reference](../../packages/core) |
| Testing | Scenario playtests, frame capture guards, slow-frame tracing, on-device runs | [Playtesting](playtesting.md) |
| Shipping | A native runtime for Windows, macOS, Linux and Android, signed Android releases | [Native runtime](native-runtime.md) |

## When to pick something else

- **A browser-only demo under about 500 lines.** Vanilla Three.js is less to learn, and the starter
  costs more than it saves at that size.
- **An App Store release.** iOS runs in the simulator only. No iOS hardware is qualified yet.
- **An editor, a scene format or visual scripting.** ThreeNative is code-first by design and will
  not add them. Godot, Unity or Unreal fit that workflow better.
- **Navmesh pathfinding on native.** It is browser-only today.
- **A native prebuilt for Windows, Android or iOS from a clean install.** The prebuilt runtime is
  Linux x64. Other hosts build the runtime from source.

See [Compare engines](comparison.md) for Godot, Unity and Unreal side by side, or
[get started](getting-started.md) with your first scene.

## Source

- [Value proposition and its evidence](../strategy/VALUE-PROPOSITION.md)
- [Capability manifest](../../packages/core/capabilities.json)
