# create-threenative

Scaffold a ThreeNative game:

```sh
pnpm create threenative my-game
```

The default template is `starter`. Choose `minimal`, `platformer`, `action-rpg`, `tower-defense`,
`racing`, `sailing`, `rain`, `shooter`, or `snow` for a different starting point:

```sh
pnpm create threenative my-game --template minimal
pnpm create threenative my-game --template starter
pnpm create threenative my-game --template platformer
pnpm create threenative my-game --template action-rpg
pnpm create threenative my-game --template tower-defense
pnpm create threenative my-game --template racing
pnpm create threenative my-game --template sailing
pnpm create threenative my-game --template rain
pnpm create threenative my-game --template shooter
pnpm create threenative my-game --template snow
```

Prerequisites are Node.js 20.19.0 or newer and pnpm 10 or newer. npm is also supported for the
same clean-room workflow:

```sh
npm create threenative@latest my-game -- --template starter
cd my-game
npm install
```

## Branding your game

The identity a player sees is yours, and it lives only in generated game files — never in a
package. Three surfaces carry it:

- `threenative.config.ts` — `app.name`, `app.icon` (and `app.icons` per platform), the desktop
  `window.title`, and `bootSplash` for the launch background. `app.id` is the reverse-DNS identity
  the installer and file manager show.
- `public/` — the images those fields point at. Replacing the scaffold's `public/icon.png` is what
  stops a packaged app shipping the engine's default icon.
- `src/render/` — `loading.ts` owns the in-game loading appearance; every file there is generated
  game source you can rewrite.

`threenative doctor --target desktop` reports which of those a desktop build actually resolves.

Once a desktop release container exists, inspect the brand it actually carries rather than the
config you meant to ship:
`node node_modules/@threenative/runtime-native/scripts/verify-starter-desktop.mjs --container <unpacked-directory> --config .threenative/build/config.json`.
It compares the launcher/file-manager name, the embedded icon bytes and the declared loading
sequence against that config, and refuses a container that still carries the engine's default icon
— which the scaffold's own `public/icon.png` is until you replace it.

The published package declares those Node and pnpm minimums. Its asset pipeline reaches `sharp`
through `@gltf-transform/functions` → `ndarray-pixels` → `sharp`; `@threenative/core` also brings
the asset MCP's `sharp` copy. On a machine whose system has an incompatible global libvips, let
sharp use its supported prebuilt binary instead of changing the project or bypassing install
scripts:

```sh
SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install
SHARP_IGNORE_GLOBAL_LIBVIPS=1 pnpm install
```

This is an environment repair, not a default flag. Do not use `--ignore-scripts`: core's
postinstall wires the project-scoped MCP configuration. The registry verification records the
Node-version warning from transitive packages and runs the dependency audit separately; neither is
hidden by the install recipe.

Inside a generated project, `npx threenative doctor --text` reports what would break a build:
missing or version-mismatched `@threenative` packages, a portable entry with no default game
export, no web entry, no scenario, no capability search for your agent. Naming the build you
intend — `--target web|desktop|android|ios` (iOS is not a supported target yet), optionally with `--mode debug|release` — makes that
build's prerequisites decide the verdict instead of warning beside "available".

Tool discovery reports four separate facts, because three of them are routinely mistaken for the
fourth:

| Check | The fact it reports | What it does **not** claim |
| --- | --- | --- |
| `capability search` | each configured MCP server starts and advertises tools | that any application its tools drive is installed |
| `editor activation` | which project-scoped host configs carry the servers | that an editor loaded one — that is not observable from a CLI |
| `model conversion` | Blender is on this machine and the server is up | that a conversion has ever run |
| `model conversion` detail | what the bake manifest records as converted | anything, when no manifest exists |

Every repair is one you run in your own game, and doctor performs none of them:

- **A host config is unreadable or missing servers.** Doctor names the exact file and stops. The
  file is yours: reinstall `@threenative/core` to rewrite the configs its postinstall owns, or fix
  the named file by hand. Doctor never edits it, so a config holding servers of your own survives.
- **Your host is not listed.** Windsurf, Cline, Amp and the JetBrains assistants read a
  machine-wide config only. Installing a library into one game must never edit a file that governs
  every other project on your machine, so those are wired by hand, once, in that host's own
  settings.
- **Conversion is unavailable.** Install Blender with the command doctor prints. A project with no
  `.fbx`, `.blend`, `.obj` or `.dae` in it needs none, and stays green without it — the hard
  failure lives in the build, where the source is actually read.
