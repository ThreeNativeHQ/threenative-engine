# Hot reload returns the game to its main menu — 2026-08-30

`tests/browser/hot-reload.spec.ts` claims the starter "preserves starter state and stays flat
across ten real HMR updates". It does not preserve state. A single hot update drops every entity
and the whole physics world and leaves the game on its title screen.

## The measurement

A starter was scaffolded from local tarballs, served by its own `pnpm dev`, driven headed against
the machine's RTX 2080, and taken into play through the menu. Then one edit was made to
`src/entities/Player.ts` — the same `JUMP_SPEED` edit the spec makes — and the game's own
diagnostics were read before and after:

```console
BEFORE {"reloads":0,"entities":4,"sceneObjects":38,"canvases":1,"audio":{...},"physics":4}
JUMP_SPEED matched: true
AFTER  {"reloads":1,"entities":0,"sceneObjects":11,"canvases":1,"audio":{...},"physics":0}
```

vite fired the update and the client acknowledged it:

```text
[vite] hmr update /src/style.css, /src/main.ts
[debug] [vite] hot updated: /src/style.css
[debug] [vite] hot updated: /src/main.ts
```

## What this rules out

- **The counter is not broken.** `reloads` moves 0 → 1, so `acceptHotUpdate` runs and is observed.
- **HMR is not failing to fire.** vite reports the update and the client applies it.
- **It is not the environment.** This is a hardware adapter on a real display, not CI's
  SwiftShader. The same failure reproduces on CI and on this machine.
- **It is not a stale project path.** The spec now resolves the served project when the test runs
  and fails by name if the entry point is missing; that guard does not fire.
- **It is not a timeout.** 15s, 90s and this 20s probe all show the same end state.

## What it is

`entities: 0`, `physics: 0`, `sceneObjects: 11` is the **menu** scene — the same shape the starter
shows before a game begins, and the same numbers that made the spec's earlier failure look like a
player that would not land. Applying the update re-runs `src/main.ts`, which starts the game at
`start: "menu"` in `game.ts`. The player, the goal, the audio entity and the physics world are
gone.

The spec then waits for `player.grounded === true`, which can never become true again, so it times
out — and reports `reloads: 0` because it samples once more after a further reload has restarted
the count. The reload it was waiting for had already happened and had thrown the game away.

## Why nobody knew

CI has never completed a run, so the browser lane never executed
([record](./ci-has-never-been-green-2026-08-29.md)), and `pnpm test:browser` could not pass on a
developer machine either — the provenance sweep launched Chromium headless and then rejected the
software adapter that headless guarantees. Both are fixed in `fe1f84dc`. A gate nobody can run is
a gate nobody runs.

## What this does not say

It does not say where the fix belongs. Preserving scene and entity state across a module update is
a framework concern (`acceptHotUpdate` in core), a template concern (`main.ts` restarting at the
menu), or both, and this record deliberately stops at the measurement. See
[PRD-266](../PRDs/tooling/PRD-266-the-hot-reload-proof-and-the-browser-lane-run-anywhere.md).

## The fix, and the same measurement afterwards

`Game` now records the entered scene's name and can be asked to boot into it instead of
`config.start`; `acceptHotUpdate` carries that name beside the state and asks for it on the way
back. `goto()` was not usable here — it throws before `start()`, and it resets state to the
destination's `initialState`, which would discard the state being restored.

The identical probe, on the same machine, with the rebuilt core installed into the scaffold:

```console
BEFORE {"reloads":0,"entities":4,"sceneObjects":38,"canvases":1,"physics":4}
AFTER  {"reloads":1,"entities":4,"sceneObjects":38,"canvases":1,"physics":4}
```

Four entities before and after, thirty-eight scene objects before and after, a four-body physics
world before and after, and the reload counted. The session stays where it was.

A scene resumed this way runs its constructor again and rebuilds its objects; what is preserved is
the game's state and the scene it is in, not the identity of the objects inside it. That is the
decision, and it is what "preserves starter state" now means.

**Revert check:** delete the `resumeScene` call from `acceptHotUpdate` →
`packages/core/__tests__/hot.spec.ts > should resume the scene the session was in, not the start
scene` fails:

```console
× should resume the scene the session was in, not the start scene
Tests  1 failed | 10 passed (11)
```

and restoring it returns 11 passed. A scene missing from the updated module is covered too: the
resume is skipped, the state still restores, and the game boots where it would have anyway.
