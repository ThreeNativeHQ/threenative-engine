# Fix common problems

Find your symptom and follow the steps. Start with doctor, which reports what would break a build
without changing your game's source. `doctor --fix` is the one form that writes: it regenerates
`AGENTS.md`, `CLAUDE.md`, the skills, the hooks and the MCP configs.

## First checks

Run these from the game directory and note the first error:

```sh
node --version
pnpm --version
pnpm exec threenative doctor --text --target web
pnpm typecheck
pnpm build:web
```

ThreeNative needs Node 20.19.0 or newer and pnpm 10 or newer. Doctor reports missing or mismatched
`@threenative` packages, a game entry with no default export and a missing web entry. Replace
`--target web` with `desktop` or `android` to check that build's prerequisites.

If the cause is still unclear, compare against a freshly generated project with the same template.

## Install fails on sharp or libvips

1. If sharp conflicts with a system libvips, reinstall with sharp's prebuilt binary:

   ```sh
   SHARP_IGNORE_GLOBAL_LIBVIPS=1 pnpm install
   SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install
   ```

2. Do not install with `--ignore-scripts`. Core's postinstall writes the project's MCP
   configuration.

## A type or export is missing

1. Run `pnpm exec threenative doctor --text` and look for version mismatches.
2. Keep every `@threenative` package on the same version.

## The world is blank or black

1. Check the console for the first startup error.
2. Confirm the scene loads and the camera faces an object.
3. Check lights, materials and which renderer the game picked.

## Loading stops partway

1. Look for asset names that never finish loading.
2. If you hold startup with `ctx.startup.hold()`, start that work from
   `ctx.startup.whenFrameworkReady()`. Work started from `whenReady()` waits on its own hold.
3. Handle load errors for every file the game needs to start.

## A model returns 404 or fails to decode

1. Check its logical path and its entry in `assets.manifest.json`.
2. Convert it to a format the target supports. See [Assets](assets.md).

## A mouse action does not fire

1. Bind mouse buttons with `mouseButtons`. `buttons` is the gamepad.
2. Check that a UI element is not taking the click.

```ts
fire: { keys: ["Space"], mouseButtons: [0] }
```

## Characters share one animation pose

1. Create one `SkeletalMesh3D` per character. It clones the skeleton from its `source`.
2. Update each instance's clip separately.

## The HUD is blank or lags

1. Check that the UI mounts and receives its first state update.
2. Read state through the `@threenative/ui` hooks, such as `useGameState`, and handle the value
   before the first update arrives.

## A sound is silent on a device

1. Check that audio unlocked after the first user input.
2. Play a supported format close to the listener.
3. Check paused voices and sound options, then test pause and resume.

## The native runtime download fails

1. Check the installed `@threenative/runtime-native` version.
2. Read the manifest filename and the download or checksum error.
3. Check your network. If you work offline, set `THREENATIVE_PREBUILT_MANIFEST` to a local
   `prebuilt-lock.json`.

`THREENATIVE_RUNTIME_SOURCE` does not fix a failed download. It needs a full engine checkout.

## The game only runs from the project folder

1. Build a release container with `pnpm exec threenative build --target desktop --mode release`.
2. Extract it somewhere else and run the verifier on it. See
   [Native runtime](native-runtime.md).
3. On Linux, install the prerequisites the verifier names.

## Report a bug

Remove tokens, signing keys and personal data from logs first. Then include:

1. What you expected, what happened and the action that triggers it.
2. Package versions, the command, the platform and the renderer.
3. The first error and the relevant doctor or startup output.
4. A small repro, a failing [playtest](playtesting.md) or exact steps.
5. For a visual bug, a capture from the game camera. For a slowdown, the scene and render
   resolution.

## Source

- [create-threenative README](../../packages/create-threenative/README.md)
- [scene.ts](../../packages/core/src/scene.ts)
- [input.ts](../../packages/core/src/input.ts)
