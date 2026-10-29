---
name: build-on-sandbox
description: Point at a reference screenshot and build a game that matches it, in a clean sandbox where ThreeNative is installed like it would be on a user's machine. Use when the user gives a reference image and wants a game built to it, or wants to test whether the framework helps or hurts on a real build.
---

# build-on-sandbox

The user gives a genre and one reference image. You build a game that looks like it, in a
sandbox where the framework is a dependency rather than a repository.

## Why the sandbox

Measured on this repo: an agent working inside the monorepo wrote its first line of game
code at tool call **#38 of 135**, at **297k** context. The same model in a bare folder wrote
it at call **#5 of 36**, at **108k**, and the result looked better. The first 37 calls went
to reading `packages/*/src`, PRDs, agent docs and the charter — none of which a user has.

The sandbox removes those files from disk, so they cannot be read. It is not a style
preference; it is the difference between the two outcomes.

## Steps

1. **Build the sandbox** from the repo root:

   ```sh
   pnpm sandbox --bare --genre <genre> --name <name>
   ```

   `../sandbox` is a **shared, permanent folder holding one game per subfolder** — never a
   scratch directory to overwrite. The root carries the sealed `brief.md`, `reference.png`,
   `sweep.json`, `scaffold.sh` and hidden package staging under `.packages/`; the game lives
   in `../sandbox/<name>/`. `--name` defaults to `<genre>-game`; pass something the game
   earns, like `fox-game` or `fps-game`. Only that one folder is wiped, so every earlier
   game stays. It refuses an unknown genre, a missing brief or reference image, a name that
   is not a lowercase slug, any `--out` inside this repo, a sandbox root that holds a game
   directly, and reuse of a name whose build `pnpm sweep:archive` has not preserved.

2. **Scaffold**, from the sandbox root:

   ```sh
   ./scaffold.sh <name>
   ```

   It writes `../sandbox/<name>/` and copies the brief, the reference and `sweep.json` into
   it. Everything after this step happens **inside that folder**, never at the sandbox root.

3. **Look at the reference.** Read the image file before writing anything. Name what you
   are matching — palette, light direction, silhouette scale, camera height and angle, prop
   density. You cannot match what you have not described.

4. **Lock the reference and use the generated Dream Loop workflow.** Copy the supplied image
   into one immutable `.dream-loop/<run-id>/target.png`, hash it in `run.json`, and read
   `node_modules/create-threenative/agent-docs/references/dream-loop.md`. Run the existing capture/playtest and performance recipes, give
   the target and fresh gameplay frame to an independent verifier, then invoke:

   ```sh
   node scripts/visual-loop.mjs --record .dream-loop/<run-id>/run.json
   ```

   The validator owns stale-hash, functional-assertion, critic, performance, round, and stop
   decisions. Do not maintain a second prose-only loop or replace the sealed target to improve
   a score.

5. **Build the game**, then follow the validator's decision: run `pnpm dev` from
   `../sandbox/<name>`, drive it in the browser, capture the real frame, fix the largest named
   visual gap, and record the next round. A supplied target needs no image-service credential;
   target generation is opt-in through `node scripts/reference.mjs` only.

   **Commit and push after every working increment.** The sandbox is a git repository of its
   own — `ThreeNativeHQ/examples`, public, one folder per sample game. Commit when the
   scaffold first runs, and again on every visible improvement; push each time. A sandbox
   game that only exists on this disk is one `rm -rf` from gone, and these games are the
   framework's only end-to-end evidence that it builds something a player would look at.

   ```sh
   git -C ../sandbox add <name> && git -C ../sandbox commit -m "<name>: <what changed>"
   git -C ../sandbox push
   ```

   Do not commit `node_modules/`, `dist/`, `.packages/` or `.pnpm-store/`; the repo's
   `.gitignore` already excludes them. Do commit your screenshots — they are the record of
   the visual loop.

6. **Archive and measure** the completed build from the repo root:

   ```sh
   pnpm sweep:archive ../sandbox/<name>
   pnpm sweep:measure docs/benchmark/sweeps/<genre>-<date>
   ```

   Copy the JSON result into a dated `docs/verification/sweep-<genre>-<date>.md` ledger,
   including every framework API that blocked the build and the workaround used.

7. **Report the visual result**: at which tool call you first wrote game code, whether the
   result matches, and the committed ledger path. The comparison and the friction record
   are the point of the exercise.

## Rules

- **Work only inside your game folder.** `../sandbox/<name>/` is yours; the sandbox root and
  its sibling folders belong to other games. Never write a game at the sandbox root — it
  leaves no room for the next one and the archive tooling then has to guess which is which.
- **Work only inside the sandbox.** Do not read `packages/`, `docs/`, `CHARTER.md`, or any
  `AGENTS.md` in the monorepo. Everything you need is the generated `AGENTS.md`, your own
  `src/`, and the `.d.ts` files in `node_modules/@threenative/` — about 1,065 lines of types.
- **The implementation is not on disk.** The packages ship types plus bundled JS and no
  sourcemaps, so there is nothing to spelunk — the same as a real install. If the types do
  not answer a question, write plain Three.js instead and record that the types were not
  enough. That is a finding about the framework, and it is worth more than a workaround.
- **The framework is not the subject.** If an API blocks you, write plain Three.js instead
  and note what blocked you. A workaround in user space is a finding; contorting the game
  to flatter the framework destroys the measurement.
- **Nothing in the toolchain can see the game.** `typecheck`, `lint` and every playtest pass
  on grey boxes on a black screen. Only your eyes on a screenshot close the loop.
- **Headless Chromium cannot render WebGPU** — the canvas comes back blank or black and it
  looks exactly like a bug in the scene. Use browser automation against the user's real
  Chrome. Failing that, headed Chromium under a virtual display with
  `--enable-unsafe-webgpu --disable-gpu-sandbox --ignore-gpu-blocklist --enable-features=Vulkan`.
  If a screenshot is black, suspect the capture before rewriting materials.
- **Without `--enable-features=Vulkan` you are measuring SwiftShader.** Chromium does not
  reach the Linux Vulkan driver without it and silently serves WebGPU from its CPU
  rasteriser — no error, healthy-looking limits, and a software renderer's frame rate and
  stability. Measured on an RTX 2080: `adapter.info` reads `swiftshader / google` without the
  flag and `turing / nvidia` with it. Check `adapter.info` before trusting any visual or
  timing result.
- **`xvfb-run` is not safe to gate on.** On xorg-server-xvfb 21.1.24 it re-enables errexit
  before its cleanup `kill`, so a command that succeeded still exits 1
  (`xvfb-run -a -s '-screen 0 1600x900x24' true` → exit 1). Use `sh scripts/xvfb.sh <cmd>`
  from the repo, which exits with the command's own status.
- **Spend the budget on pixels.** In the run that worked, 58% of tool calls wrote game code.
  In the runs that did not, 23–27% did. If you are more than a few calls deep without having
  written any, stop and start building.

## When you think you are done

Put your screenshot next to the reference and ask whether a player would screenshot yours.
If not, name the single largest difference and fix that one thing. Repeat until the answer
is yes, or until the user stops you.
