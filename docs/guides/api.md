# Find the right API

Look up which package and export covers the job you have, then read its types in the source for the
full options.

## Packages

A generated project installs a matching set for its template. Add others as your game needs them.

Runtime packages export code your game calls. Build-time packages run in `pnpm build` or in your
own scripts. Agent packages add MCP tools to an editor; nothing in the game imports them.

| Package | Provides | Used from |
| --- | --- | --- |
| `create-threenative` | Project templates, setup, build, doctor, deploy | `pnpm create threenative`, `pnpm exec threenative` |
| `@threenative/core` | Scenes, game loop, input, loading, rendering helpers | Game code |
| `@threenative/physics` | Rapier bodies, triggers, character movement, navigation | The `rapier()` plugin, `@threenative/physics/navigation` |
| `@threenative/assets` | Asset conversion and compression | The build |
| `@threenative/ui` | React components and UI hooks | The UI entry |
| `@threenative/playtest` | Scripted input and gameplay checks | Tests against a running build |
| `@threenative/runtime-native` | Native host and packaging | Desktop and Android builds |
| `@threenative/three-native` | The owned engine's Three.js API catalog and the sources its bundlers read | Engine bundling |
| `@threenative/terrain` | Headless Strata authoring: validated recipes, baked heightfields, indexed geometry, six starter worlds | A bake script, plus `threenative-terrain` MCP |
| `@threenative/procedural-environment` | Bake-first procedural nature GLBs: vegetation, rocks, city modules, the Stylized Biome Kit | A bake script, then the game at runtime |
| `@threenative/metahuman` | MetaHuman head expressions: checksum-verified OpenRigLogic evaluator and the binding contract | Game code |
| `@threenative/ueformat` | UEFormat v10 `.uemodel` parser and Three.js loader | An import script |
| `@threenative/raw-unreal` | Raw Unreal `.uasset` static-mesh loader, UE5 and UE4.18 layouts | An import script |
| `@threenative/blender-bridge` | Drives an installed Blender headlessly so a `.fbx` or `.blend` becomes a GLB | The asset build |
| `threenative-engine-mcp` | Offline capability and reference discovery for authoring agents | The `threenative-engine` MCP server |
| `threenative-animation-mcp` | Inspect, attach, edit and verify character animation as build-time GLB edits | The `threenative-animation` MCP server |

[Unreal assets](unreal-assets.md) covers the ueformat path, [MetaHuman heads](metahuman.md) the
metahuman one, and [Scenes and the game loop](core-concepts.md) the runtime shape they all share.

## The scene context

A scene's `enter(ctx)` receives `ICtx`, which holds the scene's runtime tools. It can return a
per-frame function:

```ts
import { type ICtx, Scene, type SceneFrame } from "@threenative/core";
import { BoxGeometry, Mesh, MeshStandardMaterial } from "three";

export class Play extends Scene<GameState> {
  override enter(ctx: ICtx<GameState>): SceneFrame<GameState> {
    const box = ctx.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial()));
    return (frame, dt) => {
      box.rotation.y += dt;
    };
  }
}
```

| Fields | Use them to |
| --- | --- |
| `scene`, `camera`, `add` | Place Three.js objects and frame the view. `add` returns the object with its type. |
| `renderer`, `viewport` | Reach render controls and screen size. `renderer.raw` is the underlying renderer. |
| `input`, `pointer`, `raycast`, `raycastAll` | Read actions and pick objects. Use physics queries for collision shapes. |
| `assets`, `startup` | Load files and track startup. `startup.hold()` keeps the loading screen up. |
| `state` | Hold game values that a separate UI reads. |
| `after`, `every`, `tween` | Schedule work and animate values. |
| `afterPhysics`, `beforeRender` | Follow solved bodies and adjust visuals before drawing. |
| `entities`, `goto`, `random` | Register entities, switch scenes and make seeded random choices. |
| `sceneLoad` | A scene change in flight: `progress` runs 0 to 1, is monotonic inside one `goto()`, and is what a level-transition bar reads. During boot it equals `startup.progress`. |
| `timeScale` | Simulation speed multiplier, after Godot's `Engine.time_scale`. Default 1. |
| `quit()` | End the app, as Godot's `get_tree().quit()` does. The native host exits with status 0; the web cannot end its own process, so there it reports `TN_QUIT_UNSUPPORTED` once and does nothing. |

A scene also has lifecycle hooks beyond `enter`/`exit`: `applicationPaused(ctx)` runs once when the
app goes to the background — save there, because a backgrounded mobile app can be ended without
another callback — and `applicationResumed(ctx)` when it returns.

## Two subpaths a game imports directly

Most of `@threenative/core` comes from the main entry. Two subpaths exist because not every game
wants them, and importing them is the opt-in:

| Subpath | Holds | Import it when |
| --- | --- | --- |
| `@threenative/core/ui-layer` | The UI layer's platform seam: one bridge and one hit-region protocol, host-independent | You write the UI without React. `<UiLayer>` from `@threenative/ui` connects the UI end and `game.ui` is the game end of the same bridge. |
| `@threenative/core/render/environment` | The environment measure-and-sample mechanism: what a scene's environment contributes, a bounded GPU sample with a readback deadline, and the gate that decides which renderer may run the material lane | You need the environment's contribution as data. The backlight itself is a shader in `src/render/`, so its look stays yours. |

Use the same seed for `random` to repeat choices in a playtest.

## Reusable features

All of these export from `@threenative/core`.

| Job | Exports | Notes |
| --- | --- | --- |
| Animated characters | `AnimationPlayer`, `SkeletalMesh3D` | `SkeletalMesh3D` clones the skeleton, so each character poses on its own. |
| Many copies of one mesh | `InstancedBatch` | `add` or `place` each copy, then `build()` the `InstancedMesh`. |
| Merged static geometry | `mergeParts` | Keeps each part's colour. `preserve` keeps authored normals and UVs. |
| Dense static models | `ClusteredMesh`, `ClusteredBatch` | Use cluster data from the asset build. The cut is taken for the render camera only: a mesh drawn through a second camera (a mirror, a portal) sets `viewCull = false`, and `viewCullReport` says what it did. |
| Distance detail | `updateModelLods`, `baseGeometryOf` | Picks asset-built LODs. `baseGeometryOf` returns LOD0 for collision. |
| Visibility | `alwaysRender`, `MatrixWorldPass` | `alwaysRender` keeps a small object drawn at range. |
| Camera-facing objects | `Billboard3D` | Turns an object to face the camera when you call `update()`. |
| Camera shake | `CameraShake` | `update()` returns an offset. Apply it after your camera rig. |
| Sky | `WorldEnvironment`, `Daylight` | The look a new scene inherits. See [Rendering](rendering.md). |
| Sound | `AudioBus` | Loads and plays sounds and manages volume. Unlocks on first input. |
| GPU ray queries | `GPUSceneBVH` | Call `rebuild()` after the scene geometry changes. |
| Frame timing | `FrameBudget`, `SpanRecorder` | GPU timings appear when the platform provides timestamps. |

Physics nodes (`RigidBody3D`, `Area3D`, `CharacterBody3D`, `CollisionShape3D`) export from
`@threenative/physics`. See [Physics](physics.md).

## Procedural content

Three optional packages bake their content ahead of time and ship it as ordinary GLBs or baked
bytes, so a game loads them like any other asset.

| Package | Load with | Note |
| --- | --- | --- |
| `@threenative/procedural-environment` | `bakeVegetation`, `bakeRock`, `bakeCity` in a bake script | Trees, ground cover, rocks, 75 city modules, plus the Stylized Biome Kit on `/stylized` |
| `@threenative/terrain` | A copied starter world and its `bake.mjs` | Six worlds: `alpine`, `arbor`, `coastal`, `desert`, `forest`, `tundra` |

Every appearance value is yours: the bake decides the bytes, and the material, scale and motion
are game source.

## What the project's own build asks of you

`create-threenative` is more than the scaffolder: it also ships the Vite plugins and the lint config
a generated project uses. They stay in the game's own config rather than the capability manifest,
because they run at build time, not in a scene.

| Export | Import from | Used in |
| --- | --- | --- |
| `threenative()` | `create-threenative` | `vite.config.ts`. Every plugin the kits share: engine catalog and freshness, web brand, Asset Library, asset watch, worker defaults. Pass `{ assetLibrary: false }` or `{ assetsWatch: false }` to drop one. |
| `qualityConfig({ root })` | `create-threenative/quality` | `eslint.config.js`: the project lint rules, including the kit quality rules |
| `defineAssetStory` | `create-threenative` | `src/**/*.story.ts`: one Asset Library page per module. See [Assets](assets.md) |

A game that wants one plugin alone imports it by name (`createAssetLibraryPlugin`,
`createEngineCatalogPlugin`, `createEngineFreshnessPlugin`, `createWebBrandPlugin`,
`createAssetsWatchPlugin`) instead of calling `threenative()`.

## Search the engine before you write

An agent works from this repository's MCP servers, which are wired into every generated project's
`.mcp.json`. `threenative-engine` is the one that answers "does the engine already do this?".

| Server | Answers |
| --- | --- |
| `threenative-engine` | Capability and classic-game reference search |
| `threenative-assets` | Finding, acquiring and converting models, textures, audio and characters |
| `threenative-terrain` | Cooking an editable starter terrain kit |
| `threenative-sculpt` | Sculpting from a reference image, gated pass by pass |
| `threenative-animation` | Inspecting, attaching, editing and verifying a rigged GLB |
| `threenative-devtools` | Performance traces, GPU timing, network, heap and console of the running game |

| Tool | Takes | Answers |
| --- | --- | --- |
| `engine_search_capabilities` | `situation` (required), `scope` (`"request"` or `"mechanic"`, default `"mechanic"`) | Up to 15 deduplicated capabilities for a complete cross-system request, up to 5 for one mechanic |
| `engine_capability_detail` | `symbol` (required), `importPath` when two packages export that symbol | One capability's import, signature, example, constraints and overrides |
| `engine_search_references` | `situation` (required) | Mechanic cards and repository-map nodes from decompiled classic games, so you borrow a mechanic rather than invent one |
| `engine_reference_detail` | `game`, `name` | One pinned game's map or mechanic card, with files, key functions and constants |
| `engine_save_reference` | `game`, `node` or `card` | Validates and saves what you reverse engineered, and returns a contribution command |
| `engine_watch_reference` | `situation` (required) | A contact sheet of real gameplay footage for a mechanic, so you see it before you build it |

Search the mechanically explicit request with `scope: "request"`, then search each implied mechanic
with `scope: "mechanic"`. A request that names a game or genre a starter kit covers (`like mario`) leads with a `starterKits`
entry and its `npx create-threenative <dir> --template <name>` command: scaffold it, then search the
mechanics it does not cover. Every result carries the
`matchedSituation` it matched and a `score`, so a weak match is visible rather than silent, and
`engine_capability_detail` is authoritative on platform support: it never states a limitation it does
not actually have.

A reply with `verdict: "none"` is an answer, not a failed search. Follow its `guidance` and write the
behavior in your own `src/`. Only results at or above the relevance floor of `0.27` are returned.

The server fails closed on the JSON-RPC layer, so a broken call is legible:

| Code | Meaning |
| --- | --- |
| `-32700` | The line was not valid JSON |
| `-32601` | Unknown method |
| `-32000` | A tool rejected its arguments, with the message as written |

The asset and sculpt servers are separate servers with their own tools and their own argument
shapes. The recipes cover them: [Finding assets](../../packages/create-threenative/agent-docs/references/finding-assets.md)
and [Sculpt from a reference](../../packages/create-threenative/agent-docs/references/sculpt-from-a-reference.md).

Blender is not an MCP server. Converting `.fbx`, `.blend`, `.obj` or `.dae` is `blenderImportPass`,
an asset-build pass that runs on `pnpm build` with no agent present, and the asset server's own
`blendkit_status` and `blendkit_import_asset` reach a running Blendkit client. A machine without
Blender fails the build where the source is actually read, not a server that never starts.

## Read an API in the source

Start at a package's `src/index.ts` and follow the export to its file. The doc comment above each
export lists its options, constraints and an example. Your editor's completion shows the APIs in the
version you installed.

## Source

- [core index.ts](../../packages/core/src/index.ts)
- [scene.ts](../../packages/core/src/scene.ts)
- [ui index.ts](../../packages/ui/src/index.ts)
- [physics README](../../packages/physics/README.md)
