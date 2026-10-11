<div align="center">

# ThreeNative

**The application framework for Three.js games — one codebase, web and native.**

Write ordinary `three/webgpu`. Ship it to the browser, Windows, macOS, Linux, and Android.

[![CI](https://github.com/ThreeNativeHQ/threenative/actions/workflows/ci.yml/badge.svg)](https://github.com/ThreeNativeHQ/threenative/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@threenative/core?label=%40threenative%2Fcore&color=cb3837)](https://www.npmjs.com/package/@threenative/core)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![three.js r185](https://img.shields.io/badge/three.js-r185-000000.svg)](https://threejs.org)
[![Node >= 20.19](https://img.shields.io/badge/node-%E2%89%A520.19-5fa04e.svg)](https://nodejs.org)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Code of Conduct](https://img.shields.io/badge/code%20of%20conduct-v2.1-ff69b4.svg)](CODE_OF_CONDUCT.md)

[Quickstart](#quickstart) · [Templates](#templates) · [Packages](#packages) · [Docs](#docs) · [Contributing](#contributing)

</div>

---

## Three.js and ThreeNative

ThreeNative does not replace Three.js — it is Three.js, with the game layer and the platform
layer filled in. `ctx.scene` is a `THREE.Scene`, `ctx.renderer` is a `WebGPURenderer`, and every
Three.js tutorial from the last decade still applies inside a ThreeNative scene.

| | Plain Three.js | ThreeNative |
| --- | --- | --- |
| **Rendering** | `three/webgpu`, TSL, your materials | The same `three/webgpu`, unchanged and unwrapped |
| **Game loop, fixed timestep, dt clamp** | You write it, in every project | Shipped |
| **Input** | Per-project key, pointer, pad and touch plumbing | One input map; `ctx.input.vector("move")` on every device |
| **Physics and navigation** | Pick a library, write the bridge | `RigidBody3D`, `Area3D`, `CharacterBody3D` over Rapier |
| **HUD and menus** | Hand-rolled DOM, or a second render loop | React 19 + Tailwind bound to game state at ~10 Hz |
| **Assets** | Manual copies and paths | `assets/` in, hashed output and a manifest out |
| **Proof it still works** | Screenshots and hope | Playtest scenarios that drive a real build and assert |
| **Desktop and Android** | Browser only | An owned C++ runtime running the same source |
| **The look** | Yours | Yours — visual code is generated into `src/render/`, never hidden in a package |

The framework owns the wiring and never the look. Anything that decides how a frame looks —
materials, lighting, tonemapping, post, camera framing — is scaffolded into your repo as ordinary
Three.js you can read, edit, or delete.

## Quickstart

```sh
pnpm create threenative my-game
cd my-game
pnpm install
pnpm dev
```

That is a complete game: a loop, physics, a React HUD, a playtest scenario, and a scene you can
edit. Requires Node 20.19+ and a WebGPU-capable browser (WebGL2 fallback is automatic).

## A small game

The real portable entry from the `minimal` template's `src/game.ts`:

```ts
import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import type { IPhysicsContext } from "@threenative/physics";
import { rapier } from "@threenative/physics";
import config from "../threenative.config.js";
import { Play } from "./scenes/Play.js";
import type { GameState } from "./state.js";

const game = defineGame<GameState, IPhysicsContext>({
  input: {
    move: {
      down: ["ArrowDown", "KeyS"],
      left: ["ArrowLeft", "KeyA"],
      right: ["ArrowRight", "KeyD"],
      up: ["ArrowUp", "KeyW"],
    },
  },
  plugins: [rapier(), playtest()],
  render: config.renderer,
  scenes: { play: Play },
  start: "play",
});

export default game;
```

A scene is a class with three optional methods — `load`, `enter`, `update`. That is the whole
lifecycle.

## Features

- **Godot-shaped conventions.** `RigidBody3D`, `CharacterBody3D`, `Area3D`, `CollisionShape3D` —
  borrowed vocabulary, so there is nothing new to learn.
- **Conventions on by default.** Feet meet the floor, a weapon stays in the hand that holds it, an
  agent walks around a wall, one metre is one metre — each with a named override on the same object.
- **React HUD bindings.** Game state flows into React through an external store that never
  re-renders on the game loop.
- **A real test harness.** Playtest scenarios drive the actual build in a browser or on a device
  and assert what happened — frames, transforms, state, performance.
- **An asset pipeline.** Models and textures compile to hashed, manifest-tracked output.
- **An owned native runtime.** The same TypeScript runs on a C++ host for desktop and Android.
- **Built for agents.** A searchable capability manifest ships with the library and is exposed over
  MCP, so an authoring agent finds what already exists instead of rewriting it.

> [!TIP]
> **Picking the model that writes the scene.** [threejseval](https://threejseval.com/ranking) ranks
> AI coding agents on Three.js work — one prompt, blind arena votes on the scenes they build, Elo
> with cost and tokens beside each entry.

## Templates

`pnpm create threenative my-game --template <name>`

| Template | What you start with |
| --- | --- |
| `starter` *(default)* | A polished default project with a React HUD, physics, and a ready-to-edit scene |
| `minimal` | The smallest project — core and physics only |
| `platformer` | Jumping, patrols, pickups, camera follow |
| `action-rpg` | A three-room dungeon with melee, loot, equipment, and persistence |
| `tower-defense` | Four tower types, three upgrade levels, twelve waves and an orbital strike on a polished diorama |
| `racing` | Three laps, checklines, rescue sectors, boost pads |
| `sailing` | Wind, waves, buoyancy, and an ordered course |
| `rain` | A procedural coastal storm, weather controls, and a free-fly camera |
| `shooter` | Hitscan and projectile weapons, hunting targets, timed pickups |
| `snow` | Deformable snow footprints, a ball that carves its own track, blizzard weather |

Details in [`create-threenative`](packages/create-threenative/README.md).

## Packages

| Package | Purpose |
| --- | --- |
| `@threenative/assets` | Build-time asset compile step: `assets/` in, hashed outputs and a manifest out |
| `@threenative/core` | Bootstrap, scenes, lifecycle, input, and renderer integration |
| `create-threenative` | Scaffold a readable game project from eight templates |
| `@threenative/metahuman` | MetaHuman head expressions — checksum-verified OpenRigLogic WASM evaluator and the binding-metadata asset contract |
| `@threenative/physics` | Rapier-backed Godot-shaped physics and navigation |
| `@threenative/playtest` | Browser, native, and scenario assertion harness |
| `@threenative/procedural-animals` | Baked animal payloads, runtime poses, accepted-state following, and conservative bounds |
| `@threenative/runtime-native` | Owned C++ host for desktop and Android |
| `@threenative/raw-unreal` | Raw Unreal editor `.uasset` static-mesh loader — UE5 FMeshDescription and UE4.18 FRawMesh, no interchange conversion |
| `@threenative/terrain` | Optional headless Strata authoring: validated recipes, baked heightfields and indexed Three.js geometry |
| `@threenative/ui` | React bindings for HUD and game state |
| `@threenative/ueformat` | UEFormat v10 `.uemodel` parser and Three.js loader for meshes exported from Unreal packages |
| `threenative-engine-mcp` | Offline MCP capability discovery for authoring agents |
| `threenative-blender-mcp` | Drives an installed Blender headlessly so a downloaded `.fbx` becomes a loadable GLB — ships no Blender |

## Platform support

ThreeNative is **alpha**: the API is settling and versions are `0.x`.

**Supported targets: web, Windows, macOS, Linux and Android. iOS is not supported yet.**

**You sign your own game.** A desktop or Android release is signed with *your* certificate and
keys, because the signature names the publisher of the game a player downloads. ThreeNative ships
no certificate; `threenative build --mode release` signs with yours. See
[`docs/RELEASE-SIGNING.md`](docs/RELEASE-SIGNING.md).

| Platform | Renderer | State |
| --- | --- | --- |
| Web | WebGPU, WebGL2 fallback | Verified every CI run |
| Desktop (Linux, macOS, Windows) | Owned native host | Verified — 300 native frames and a non-blank capture |
| Android | Owned native host | Emulator lane runs; physical-device performance is being measured |
| iOS | — | **Not supported.** Experimental host code exists; no release supports it |

Every claim here is backed by a run. The current numbers live in
[`docs/verification/runtime-perf-state.md`](docs/verification/runtime-perf-state.md), and
everything the framework does not yet do well — with what is being done about it — is in one
place: [`docs/CURRENT-CHALLENGES.md`](docs/CURRENT-CHALLENGES.md).

## Docs

- [`docs/README.md`](docs/README.md) — the map: PRDs, verification, benchmarks, strategy,
  architecture, product, spikes.
- [`docs/architecture/CHARTER.md`](docs/architecture/CHARTER.md) — what the framework is, what it
  refuses to be, and the rules that decide both. Binding.
- [`docs/architecture/AGENT-INTERFACE.md`](docs/architecture/AGENT-INTERFACE.md) — the surface an
  authoring agent reads.
- [`CONTRIBUTING.md`](CONTRIBUTING.md#versioning-and-deprecation) — what the public surface is, what
  each version number promises before and after 1.0, and how a symbol gets deprecated.
- [`packages/create-threenative/README.md`](packages/create-threenative/README.md) — templates and
  the scaffold command.

## Contributing

Contributions are welcome — issues, discussions and pull requests alike.

```sh
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm test
```

Native compilation is opt-in; the default gate needs no CMake, NDK, or Xcode. There is no root
`pnpm dev` — run an example by name, for example `pnpm --filter abyss-framework dev`.

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request, and
[`AGENTS.md`](AGENTS.md) for the full working conventions. Everyone taking part is expected to
follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Community and support

- **Questions and ideas** → [GitHub Discussions](https://github.com/ThreeNativeHQ/threenative/discussions)
- **Bugs and feature requests** → [Issues](https://github.com/ThreeNativeHQ/threenative/issues)
- **Security reports** → [`SECURITY.md`](SECURITY.md) (please do not open a public issue)

## Licence

MIT — see [`LICENSE`](LICENSE). ThreeNative is MIT end to end, including the native runtime.

The name and logo are not covered by the MIT licence — see [`TRADEMARKS.md`](TRADEMARKS.md).
