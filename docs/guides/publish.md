# Publish a playable link

`threenative deploy` builds the web game, uploads it to ThreeNative Studio and prints a link a
friend can open. Three commands, all run from the game directory.

## Sign in once

```sh
pnpm exec threenative login
```

It opens threenative.com, asks you to authorize this machine, and saves the token it grants in the
ThreeNative config directory, readable only by you. `--no-browser` prints the link and the code
instead, for signing in on a machine with no browser.

`THREENATIVE_TOKEN` overrides the saved token for any command that needs one, so CI can publish
without writing that file. `THREENATIVE_SITE` names another site origin.

```sh
pnpm exec threenative logout
```

`logout` revokes the token on the site first and deletes the local file only once the site confirms
it — or says the token was already invalid. A refused or offline revocation keeps the file, exits 4
or 5, and can be run again.

## Deploy

```sh
pnpm exec threenative deploy
```

`deploy` runs the project's own `build:web` script with the package manager that started the CLI, so
the install and the build share one lockfile. It then packs `dist/` and uploads it to
`studio.threenative.com`. The last line it prints is the share link alone, which is the line an agent
reads.

| Limit | Value |
| --- | --- |
| Files in one build | 2,000 |
| Upload size | 50 MB |

`.threenative/share.json` remembers the project id and the first deploy's key, so the next deploy
updates the same link instead of making a second one. Commit it with the game.

`THREENATIVE_STUDIO` names another Studio origin, and `THREENATIVE_TOKEN` signs in for one run.

## Deploy a native game to the store

```sh
pnpm exec threenative deploy --target desktop --shot cover.png
```

This pushes the game's **source** to the ThreeNative store. The store builds the native game itself
(Linux now, Windows after threenative-engine#614). The command downloads the checked `tn-store`
client once into `$XDG_CACHE_HOME/threenative/bin/`, and exits 4 when its sha256 does not match.
`THREENATIVE_STORE_CLI=<path>` runs a client you built yourself instead.

The first deploy needs `--shot <png>`, the cover picture, because the store refuses a listing with
no picture. It writes `.threenative/store.json` with the game id, the file Studio also reads, so
Studio and the terminal publish to one game. Commit it. Every deploy then pushes to that game with
the `package.json` `version`, else `app.version` from `threenative.config.ts` (the version the native app is built with). It prints the release state, then
the store page `https://threenative.com/games/<slug>/` alone on the last line.

macOS exits 2: the store has no macOS build.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Published, or signed in/out |
| 2 | Bad arguments: no `build:web` script, no `package.json` name, a first native deploy with no `--shot`, macOS |
| 3 | Sign in again: the token was refused |
| 4 | The server refused it, the build failed, or `tn-store` failed its checksum |
| 5 | No network |

## What a share link is not

It is a web build on ThreeNative Studio's origin, not an app store release. A desktop or Android
binary is signed with your own certificate — see [Native runtime](native-runtime.md) and
[Configuration](configuration.md).

## Source

- [deploy.ts](../../packages/create-threenative/src/deploy.ts)
- [store-cli.ts](../../packages/create-threenative/src/store-cli.ts)
- [account.ts](../../packages/create-threenative/src/account.ts)
