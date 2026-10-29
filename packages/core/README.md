# @threenative/core

## What it is

`@threenative/core` is the portable vanilla Three.js game runtime: `defineGame` wires the
renderer, fixed-step loop, scenes, lifecycle, input, state, plugins, and the build entry that
runs on web and native. It is not a visual-design system; your game owns materials, shaders,
lights, camera framing, and the look in its generated source.

## Install

Install the runtime with its Three.js dependency:

```sh
pnpm add @threenative/core three
```

## Example

In a generated `minimal` project, `src/game.ts` is a runnable game entry:

```ts
import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import type { IPhysicsContext } from "@threenative/physics";
import { rapier } from "@threenative/physics";
import config from "../threenative.config.js";
import { Play } from "./scenes/Play.js";
import type { GameState } from "./state.js";

const game = defineGame<GameState, IPhysicsContext>({
  plugins: [rapier(), playtest()],
  render: config.renderer,
  scenes: { play: Play },
  start: "play",
});

export default game;
```

## Licensing

The runtime and TypeScript source in this package are MIT licensed. The bundled Blender conversion
scripts under `gpl/` are GPL-2.0-or-later licensed and ship with their license text at
[`gpl/LICENSE.GPL`](gpl/LICENSE.GPL). The package metadata declares the aggregate SPDX expression
`MIT AND GPL-2.0-or-later`; apply the license that belongs to each part you use.

- [MIT License](https://github.com/ThreeNativeHQ/threenative/blob/main/LICENSE)
- [GPL-2.0-or-later](gpl/LICENSE.GPL)

`bakeShoreWaves` adapts the shore-wave algorithm of
[Ultra-Water](https://github.com/Humpalumps/Ultra-Water) (MIT, read at `ce9248f`): a fast-sweeping
eikonal solve of shallow-water travel time, the front direction, ray-tube convergence and the
breaking limit, rewritten as TypeScript. No source code was copied.

## Links

- [Repository](https://github.com/ThreeNativeHQ/threenative)
- [MIT License](https://github.com/ThreeNativeHQ/threenative/blob/main/LICENSE)
- Start a project with `pnpm create threenative my-game`.
