# Get started

ThreeNative is a framework that ships one Three.js codebase to the web, desktop and Android. Create
a game, run it and write your first scene.

## Requirements

You need Node 20.19 or newer and pnpm 10 or newer. The game runs in a browser with WebGPU. The
default engine has no WebGL2 path: a browser without WebGPU fails to start with
`TN_NO_RENDERER`. You can add native build tools and Blender later.

```sh
node --version
pnpm --version
```

## Create and run

```sh
pnpm create threenative my-game --template minimal
cd my-game
pnpm install
pnpm dev
```

Open the local URL that Vite prints. The default template is `starter`, a game with a React HUD.
This guide uses `minimal`, which draws its HUD in the scene. Nineteen templates ship, and
`pnpm create threenative --help` lists each one with its blurb. Name one with `--template`, or
name a genre with `--genre`:

```sh
pnpm create threenative my-game --template tower-defense
pnpm create threenative my-game --genre mario
```

`--genre` matches a kit's `genre` or one of the words in its `kit.json` `aliases`, so `mario`
scaffolds `collectathon` and `zelda` scaffolds `adventure`. A word no kit claims starts from
`minimal` rather than picking a near neighbour.

If you use npm, pass template flags after `--`:

```sh
npm create threenative@latest my-game -- --template minimal
cd my-game
npm install
npm run dev
```

Pick one package manager and keep its lockfile. If setup fails, run doctor from the game directory.
It reports missing tools and configuration:

```sh
pnpm exec threenative doctor --text --target web
```

## Project files

| Path | What it holds |
| --- | --- |
| `src/game.ts` | The shared game: scenes, input, plugins and settings. |
| `src/main.ts` | The browser entry. It starts the game and attaches the canvas. |
| `src/scenes/` | Scenes that load, add objects, update gameplay and clean up. |
| `src/entities/` | Game objects such as the player. |
| `src/render/` | Materials, lights, camera, effects, HUD and the loading screen. |
| `src/state.ts` | The typed game state, such as score. |
| `public/` | Files served to the game, such as icons. |
| `threenative.config.ts` | App name, display, window, engine, renderer, native entry and UI options. |
| `playtests/` | Scenarios that drive the game and check the results. |
| `AGENTS.md` | The generated guide for an authoring agent: which tool to reach for, and which conventions hold. |
| `CLAUDE.md` | The same file for Claude Code. Regenerate both with `pnpm exec threenative doctor --fix`. |
| `.agents/skills/`, `.claude/skills/` | The agent skills, one directory each. `.claude/skills` links into the `.agents` copy. |
| `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.zed/settings.json`, `.codex/config.toml`, `.gemini/settings.json`, `opencode.json` | The MCP servers, written in each host's own format. |
| `.claude/hooks/` | The discovery gate: it blocks a new file under `src/` until the engine was searched for this prompt. `.threenative/discovery-gate.json` holds its state. |

The `starter` template also has `src/ui/` for the React HUD and `assets/` for source assets.

An agent host that reads a machine-wide config only — Windsurf, Cline, Amp, the JetBrains
assistants — is wired by hand: installing a library into one game must never edit a file that
governs every other project on the machine.

`TN_DISCOVERY_GATE=off` turns the gate off for one session. The opt-out is reported, not silent.

## Check the project

```sh
pnpm typecheck
pnpm build:web
pnpm test
```

`pnpm test` builds the web game and runs the playtests in a headed Playwright browser with WebGPU.
On a headless machine, set up a display and GPU first. Commit the project before you edit it.

## Your first scene

Replace `src/game.ts` with the code below. Keep `src/main.ts`, the stylesheet and the config. The
cube uses an unlit material, so it needs no lights, physics or models.

```ts
import { defineGame, Scene, type ICtx } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import { BoxGeometry, Color, Mesh, MeshBasicMaterial } from "three";
import config from "../threenative.config.js";

type DemoState = { x: number };

class FirstScene extends Scene<DemoState> {
  private cube: Mesh<BoxGeometry, MeshBasicMaterial> | undefined;

  override enter(ctx: ICtx<DemoState>): void {
    const geometry = new BoxGeometry(1, 1, 1);
    const material = new MeshBasicMaterial({ color: 0x70e0b0 });
    this.cube = ctx.add(new Mesh(geometry, material));
    ctx.scene.background = new Color(0x0d1b2a);
    ctx.camera.position.set(0, 1.5, 5);
    ctx.camera.lookAt(0, 0, 0);
  }

  override update(ctx: ICtx<DemoState>, dt: number): void {
    if (this.cube === undefined) return;
    const move = ctx.input.vector("move");
    const x = Math.max(-2, Math.min(2, this.cube.position.x + move.x * 2 * dt));
    this.cube.position.x = x;
    this.cube.rotation.y += dt;
    ctx.state.set({ x });
  }

  override exit(): void {
    // These resources belong only to this scene, not a shared asset cache.
    this.cube?.removeFromParent();
    this.cube?.geometry.dispose();
    this.cube?.material.dispose();
    this.cube = undefined;
  }
}

export default defineGame<DemoState>({
  initialState: { x: 0 },
  input: { move: {
    left: ["KeyA", "ArrowLeft"], right: ["KeyD", "ArrowRight"],
  } },
  plugins: [playtest()],
  renderer: config.renderer,
  display: config.display,
  scenes: { first: FirstScene },
  start: "first",
  step: 1 / 60,
});
```

Save, then press A and D or the arrow keys. The cube spins, slides sideways and stops at x = -2 and
x = 2. Change its color, speed or limits, then run `pnpm typecheck` and `pnpm build:web`.

ThreeNative supplies the timing and input. The scene owns the mesh and the movement rule. When the
scene ends, `exit` frees the geometry and material it created.

The template playtests check the original player, pickup and score, so they fail against this
scene. Write a scenario that checks `x` and its limits. The code already installs `playtest()`. To
run the original scenarios, restore the template's `src/game.ts`.

If a step fails, see [Troubleshooting](troubleshooting.md).

## Source

- [create-threenative README](../../packages/create-threenative/README.md)
- [minimal template game.ts](../../packages/create-threenative/templates/minimal/src/game.ts)
- [scene.ts](../../packages/core/src/scene.ts)
