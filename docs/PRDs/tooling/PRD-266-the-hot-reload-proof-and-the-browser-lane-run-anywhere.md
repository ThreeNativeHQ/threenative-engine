---
prd_contract: v1
---

# PRD-266 — the hot-reload proof and the browser lane run somewhere

**Status:** PARTIAL — filed 2026-08-30 from CI's first working browser lane. **All three causes are
found and fixed**: §1 in `16c92a11`, §2 in `fe1f84dc`, §3 by running the lane headed. The whole
browser lane is green on a developer machine; what remains is confirming the same on CI.

**Priority:** P1 — CI never completed a browser run; open boxes need test-browser green and the hot-reload proof.
**Goal: `pnpm test:browser` can pass, and the hot-reload proof proves something.**
Two defects found by making CI run a lane it had never executed. Neither is CI plumbing; both are
the framework's own, and both were invisible for the same reason.

## 1. Hot reload throws the game back to its main menu

Measured on hardware, not inferred —
[hot-reload-drops-the-scene-2026-08-30](../../verification/hot-reload-drops-the-scene-2026-08-30.md).
One `JUMP_SPEED` edit to the served starter, read through the game's own diagnostics:

```console
BEFORE {"reloads":0,"entities":4,"sceneObjects":38,"canvases":1,"physics":4}
AFTER  {"reloads":1,"entities":0,"sceneObjects":11,"canvases":1,"physics":0}
```

vite fired the update and the client applied it (`hmr update /src/style.css, /src/main.ts`), the
counter moved 0 → 1, and the game lost every entity and its whole physics world.
`entities: 0, physics: 0, sceneObjects: 11` is the **menu** scene.

**The mechanism.** `acceptHotUpdate` in `packages/core/src/hot.ts` carries `game.state` across the
update and restores it — and that is all it carries. Applying the update re-runs `src/main.ts`,
which builds the game again and boots it at `start: "menu"` from `game.ts`. The state store comes
back saying `screen: "playing"`; the game is standing on its title screen. The two disagree, and
the shipped claim — a game hot-reloads while preserving its state — is false as written.

**Why it is not a two-line fix**, which is why this is a PRD and not a patch:

- `Game` tracks the active `Scene` instance (`get scene()`) but never its **name**, so there is
  nothing to carry. `#goto` would have to record it.
- `goto(name, options)` resets state to the destination's `initialState` merged with `carry`, so
  re-entering the scene after `restoreState` would undo the restore unless the carried state is
  passed as the carry.
- `goto` throws before `start()`, and `acceptHotUpdate` runs at module scope while the game is
  still being constructed. Re-entering has to be deferred until the game is running.
- A scene re-entered this way runs its constructor again. Whether that is "preserved state" or a
  fresh scene wearing old state is a design decision this PRD has to make, not assume.

**What is already ruled out, with evidence:** a broken counter (it increments), HMR not firing
(vite reports and the client acknowledges), the CPU rasteriser (this is an RTX 2080 on a real
display), a stale project path (the guard added in `fe1f84dc` does not fire), and the deadline
(15s, 90s and a 20s probe all end in the same state).

## 2. `pnpm test:browser` cannot pass on a developer machine

`verifyWebGpuProjects` launches Chromium through `chromium.launch({ args })` with no `headless:
false`, so it runs headless and Chromium serves WebGPU from SwiftShader. `allowSoftwareAdapter` is
`process.env.CI === "true"`, so off CI the sweep demands a hardware adapter that a headless launch
cannot give it:

```console
$ DISPLAY=:0 pnpm test:browser
Error: WebGPU lane root browser/abyss-vanilla selected a software adapter (fallback).
```

That is on a machine with an RTX 2080 and a real display. The gate is therefore red for every
developer who runs it locally and green only where software adapters are tolerated — which is why a
spec that has never worked sat unnoticed. A gate nobody can run locally is a gate nobody runs.

Either the sweep launches headed under a display the way the playtest runner already does, or the
hardware requirement moves to where it can be met. Whichever is chosen, `pnpm test:browser` must be
runnable by a person on their own machine.

## Why both were invisible

CI had never completed a single run in its history, so the browser lane had never executed. The
hot-reload defect most likely dates to the menu screen flow
([PRD-218](../done/PRD-218-scene-screens-and-menu-flow.md)); the spec
also walked straight past the main menu into a scene with no player, which was fixed in `144c6f81`
and is what let this second failure surface at all.

Recorded in [ci-has-never-been-green-2026-08-29](../../verification/ci-has-never-been-green-2026-08-29.md).

## 3. The update never reaches the page on GitHub's runners

With §1 fixed, the CI failure changed shape and separated cleanly from it. The game is now intact
and still in its play scene, and has reloaded zero times:

```text
Error: HMR reload 1 was not observed within 90 seconds:
{"reloads":0,"entities":3,"sceneObjects":38,"canvases":1,"physics":4}
```

Compare the same edit on a developer machine, where it hot-updates:

```text
[vite] hmr update /src/style.css, /src/main.ts
BEFORE {"reloads":0,"entities":4,"sceneObjects":38,"physics":4}
AFTER  {"reloads":1,"entities":4,"sceneObjects":38,"physics":4}
```

Nothing was reloaded because nothing was delivered: the spec writes the file, and vite never
reports an update.

**Two attempts, both measured, both reverted.** `CHOKIDAR_USEPOLLING` changes nothing — and
`startStarterServer` in `playwright.config.ts` has been setting it all along, so this was never the
untried idea it looked like. This workspace is on vite 8, whose watcher does not read that
variable. Generating a `--config` override that sets `server.watch.usePolling` did not help either,
and it made the *local* run worse: the spec's page came back empty
(`canvases: 0, physics: null`) where it had previously been a healthy game, which reads as vite
full-reloading the page rather than hot-updating it. Reverted rather than landed on a hunch.

**A standalone probe hot-updates the same project.** Driving the same edit against the same
scaffold with no playwright harness: `[vite] hmr update /src/style.css, /src/main.ts`, counter
0 → 1, all four entities preserved. So the probe and the spec disagree on the same project and the
same edit.

**Eliminated: the spawn form.** `playwright.config.ts` starts the server as `pnpm --dir <target>
dev` from the repository root, where the probe runs `pnpm dev` from inside the project. Running the
probe with the harness's exact spawn — `--dir` from the repo root, same environment — still
hot-updates:

```console
spawn mode: harness (--dir from repoRoot)
BEFORE {"reloads":0,"entities":4,"sceneObjects":38,"physics":4}
AFTER  {"reloads":1,"entities":4,"sceneObjects":38,"physics":4}
```

So it is not how vite is launched. What remains is how the page is **driven**.

**Eliminated: the playtest bridge.** The spec steps the game through
`__THREENATIVE_PLAYTEST_BRIDGE__.advance(150)` rather than letting it run on its own clock, and
`waitForHotReload` requires both the counter and `player.grounded === true` — so a bridge that did
not survive the rebuild would explain everything. It survives:

```console
BEFORE {"reloads":0,"entities":4,"sceneObjects":38,"physics":4}
BRIDGE BEFORE: advanced; grounded=true
AFTER  {"reloads":1,"entities":4,"sceneObjects":38,"physics":4}
BRIDGE AFTER: advanced; grounded=true; position=[-2.000000476837158,0.5100999474525452,~0]
```

Every condition `waitForHotReload` waits for is satisfied here, through the same bridge, after the
same edit, on the same project, with the harness's spawn form. Three hypotheses are now closed by
measurement: the watcher, the spawn form, and the bridge.

**It was headedness.** The probe launched Chromium with `headless: false`; Playwright's test
projects run headless unless told otherwise, and headless Chromium serves WebGPU from SwiftShader
whatever the flags say — the same fact that made §2's sweep unfixable until it launched headed. Run
the identical spec headed, changing nothing else:

```console
$ DISPLAY=:0 pnpm exec playwright test --project=hot-reload --headed
  1 passed (32.1s)
```

The `hot-reload` project now sets `headless: false`. One thing surfaced behind it: with the reload
finally happening, three.js's timestamp-query readback is aborted when the renderer is disposed
mid-frame — `Error resolving queries: AbortError: ... Buffer was unmapped before mapping was
resolved` — which is the backend describing a scene torn down under it, the same class as the two
console errors this spec already tolerates. It joins that list, named.

```console
$ DISPLAY=:0 pnpm test:browser
  4 passed (40.5s)
```

That is the whole browser lane green on a developer machine for the first time.

Run the spec's own project headed and see whether the reload arrives, before changing any
production code.

Two things this is not, both established by measurement: not the scene defect in §1 (fixed, and the
game now survives with all four entities), and not the deadline (15s, 90s and a 20s probe end in
the same state).

## Acceptance criteria

- [x] `pnpm test:browser` passes on a developer machine with a GPU, with the adapter it used named
      in the output — fixed in `fe1f84dc`; the sweep launches headed and the three non-HMR browser
      specs pass here.
- [x] After a hot update the game is in the scene it was in, with its entities and physics world —
      fixed in `16c92a11`, measured 4 entities / 38 scene objects / 4 physics bodies across the
      update, with a red-green unit test.
- [x] The decision — a resumed scene runs its constructor again, so what is preserved is the state
      and the scene, not the identity of the objects in it — is recorded in
      [hot-reload-drops-the-scene-2026-08-30](../../verification/hot-reload-drops-the-scene-2026-08-30.md).
- [ ] The templates' AGENTS.md says which one a game author gets.
- [x] §3: the update reaches the page — it was headless Chromium, and the lane runs headed now.
      `pnpm test:browser` is 4/4 green locally.
- [ ] The same green on CI, whose runner has no GPU: headed there means headed under Xvfb, and the
      lane already provisions one. Confirm on the next run.
- [ ] `test-browser` green on CI, and the run names the adapter it had.
