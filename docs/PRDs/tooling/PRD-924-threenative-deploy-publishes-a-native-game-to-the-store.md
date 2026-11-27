---
prd_contract: v1
---

# PRD-924 — `threenative deploy --target desktop`: publish a native game to the store from the terminal, Midway first

**Status:** NOT STARTED
**Priority:** P1 — AC-1 to AC-5 are open: a ThreeNative game deploys to the web from the terminal, but its native build reaches players only through Studio or a hand-built `tn-store` (owner, 2026-11-26).
**Complexity:** 8 (HIGH) — 1-5 files (+1), new module (+2), crosses the engine/store/site release boundaries (+2), external API: the store API and the build farm (+1), a downloaded executable runs on the author's machine (+2, risk override: binary integrity).
**Owner:** João
**Depends on:** PRD-904 (done: `threenative login` and the device token)
**Repo:** this repo (`packages/create-threenative`); `ThreeNativeHQ/threenative-store` (CLI binary release, local farm run); `ThreeNativeHQ/threenative-sandbox` (Midway, the proof subject, no game edits expected)

## Context

Owner, 2026-11-26: "currently im able to deploy a web game to cloudfare thorugh the TN lib. I need to be able to do the same, but a native game. Do it with midway."

What exists:

- ✅ **Web deploy** (PRD-904): `threenative deploy` runs `build:web`, packs `dist/` and PUTs it to Studio's `/api/cli/share`. Studio stores it in R2 and returns a share link (`packages/create-threenative/src/deploy.ts:173`). Web only.
- ✅ **Native distribution is the store**, on Cloudflare (site Worker + D1 + R2). An author pushes **source** (`tn-store push`). `build-game.yml` builds `linux-x64` and `windows-x64` on Actions, then the scan and the review run, and the release goes live. The launcher installs and starts it (store PRD-790 to PRD-797, `threenative-store/DECISIONS.md` rows 3 to 6). The store builds from source by rule, and a native game is the engine player plus game data only (store PRD-815). So a native deploy must push source, not upload a local binary.
- ✅ **The token already fits.** `threenative login` device tokens have scope `push` (site `worker/store-device.ts:123`), the scope the store push API takes.
- ❌ **No public store client.** `tn-store` (Rust, `threenative-store/crates/tn-store-cli`) is not published. The store's `release.yml` and `scripts/release-local.mjs` ship only the launcher. Studio spawns `tn-store` from its own image with `TN_STORE_TOKEN` in the environment. It keeps the game id in `.threenative/store.json` (`threenative-live-studio/src/server/release/publish.ts:36,68`).
- ⚠️ **Windows native is blocked**: the win32-x64 engine player crashes at startup (threenative-engine#614, open). The builder packs only the Linux launch entry (`tn-store-builder/src/build.rs:236`).
- **Midway**: `~/projects/threenative/sandbox/midway-open-pacific` (`ThreeNativeHQ/threenative-sandbox`). It has `@threenative/core` 0.3.21 and a `build:desktop` script. Its source is 751 MB without `node_modules/` and `.git/`, under the 2 GiB snapshot limit. Unverified: whether its pnpm lockfile passes the builder's registry integrity check (PRD-805), and whether it runs on the small engine player that PRD-815 allows.

## Solution

```mermaid
sequenceDiagram
    participant A as Author or agent
    participant C as threenative CLI
    participant W as threenative.com (site Worker)
    participant T as tn-store (downloaded)
    participant F as Build farm (Actions)
    A->>C: threenative deploy --target desktop [--shot cover.png]
    C->>W: GET /launcher/cli/cli.json (version, sha256 per OS)
    C->>C: download tn-store once, check sha256, cache it
    C->>T: games create (first deploy only), TN_STORE_TOKEN in env
    C->>T: push <gameId> --version <package.json version>
    T->>W: missing chunks, PUT chunks, create snapshot
    W->>F: build-game.yml linux-x64 (windows-x64 after #614)
    F->>W: build, scan, review: live or held
    C-->>A: state, then https://threenative.com/games/<slug>/ on the last line
```

- **Reuse the proven client instead of a port.** `tn-store` already does ignore rules, the secret scan, chunking, upload, `games create` and release polling. It is the one Studio uses. A TypeScript port would be a second copy of about 400 lines of Rust that can drift. The engine CLI downloads the binary and runs it the way Studio does.
- **Binary release** (store repo): `scripts/release-local.mjs` also builds `tn-store` for `linux-x64` and `windows-x64`. It uploads them and a `cli.json` (`{version, files:[{os, name, size, sha256}]}`) to the site media bucket under `launcher/cli/`. This is the same bucket and shape as `launcher/downloads.json`.
- **Engine CLI** (`packages/create-threenative/src/deploy.ts`, one new `store-cli.ts`):
  - `--target desktop` selects the store path. Without it, deploy keeps the web path unchanged. The vocabulary matches `threenative build --target desktop` and `doctor --target`.
  - It fetches `cli.json`, downloads the file for this OS and refuses a sha256 mismatch (exit 4). It caches the file in `$XDG_CACHE_HOME/threenative/bin/tn-store-<version>`, mode `0755`. The download and the hash check follow `packages/runtime-native/scripts/install-prebuilt.mjs:88-126`.
  - The token comes from `requireToken()` (PRD-904) and goes in the child's environment as `TN_STORE_TOKEN`, never in argv.
  - **First deploy** (no `.threenative/store.json`): `games create` with the `package.json` name, genre "Game", the store entry as play URL (Studio's defaults, `publish.ts:31-33`) and `--shot <png>`. Without `--shot` the command exits 2 and names the flag. Then it writes `.threenative/store.json` `{ "gameId" }`, the file Studio already reads, so Studio and the terminal publish to one game.
  - Every deploy: `push <gameId> --version <package.json version>`. It prints the release state (`building`, `live`, `held` …) and ends with the store page URL on its own line. Exit codes are the same as web deploy: 0, 2, 3 (sign in again), 4 (refused), 5 (network).
- **Risks:** ⚠️ a downloaded executable runs on the author's machine. HTTPS plus a sha256 from the same origin protects it the same way as the launcher download. A signed `cli.json` waits for PRD-817's signing key. ⚠️ Farm minutes: Midway is a large snapshot, but chunk dedupe sends only changed chunks after the first push.

## Non-Goals

- A Windows native build of Midway: it waits for #614 (see Blocked on). The deploy path itself is OS-independent.
- macOS: the store has no macOS build or launcher (`DECISIONS.md` row 9). On macOS the command exits 2 with that reason.
- Uploading a locally built binary: the store builds from source by rule (PRD-815).
- Changes to the store page or the install flow: those are PRD-925.

## Acceptance Criteria

- [ ] AC-1 [local]: The Midway source passes the store's own build for `linux-x64` on this machine (tag, registry integrity, engine-player shape). The packed player runs Midway 300 frames with a non-blank screenshot. proof: `node scripts/local-farm.mjs` in the store repo on the Midway folder, then `threenative-playtest --target desktop` on the packed player — Evidence: pending.
- [x] AC-2 [local]: `threenative deploy --target desktop` on a game without `store.json` downloads `tn-store`, refuses a wrong sha256 and runs `games create` then `push` with the token only in the environment. It writes `store.json` once and prints the store URL last. A second run pushes onto the same game id. proof: `pnpm exec vitest run packages/create-threenative/__tests__/deploy-native.spec.ts` (fake site, fake `tn-store`) — Evidence: `pnpm exec vitest run packages/create-threenative/__tests__/deploy-native.spec.ts` passes 5 tests (fake site serves `cli.json` and a binary, fake `tn-store`): download once, mode 0755, wrong sha256 exits 4 with no cached file, token only in the child env, `games create` then `push` then `games show`, `store.json` written once, second run reuses the game id, missing `--shot` exits 2, store exit 3 passes through. The web specs `deploy.spec.ts` and `deploy-nolink.spec.ts` stay green.
- [x] AC-3 [local]: The real flow with a local site `wrangler dev` and a `tn-store` built from source: deploy Midway, the snapshot lands, and the second deploy sends only changed chunks. proof: run log in the PR — Evidence: local `wrangler dev` (isolated D1/R2 state, port 4291) and a release `tn-store` built from the store repo; `git archive` copy of Midway, `THREENATIVE_STORE_CLI=<tn-store> threenative deploy --target desktop --shot cover.png`. Run 1: listing created, `Pushed 509 files, 621 of 621 chunks uploaded`, local D1 holds the snapshot (game bound, version `0.0.0`, 201,536,129 bytes, 621 chunks). Run 2 after a one-line README change: `Pushed 509 files, 1 of 621 chunks uploaded`, same game id from `store.json`, same store URL. The release is `held` with `TN_API_NO_DISPATCH_TOKEN` because no farm runs locally (farm is AC-1/AC-5). Run log in the PR comment.
- [ ] AC-4 [shared]: `release-local.mjs` publishes `tn-store` for Linux and Windows, plus `launcher/cli/cli.json`, and `https://threenative.com/launcher/cli/cli.json` serves hashes that match the files. proof: release run log + `curl` + `sha256sum` — Evidence: pending.
- [ ] AC-5 [shared]: From the Midway checkout, `npx threenative deploy --target desktop` against production. The farm builds `linux-x64`, the release goes live, and the launcher on this machine installs Midway from the store and starts it from the library, the way Steam does. proof: deploy log, the `build-game.yml` run link, a launcher screenshot in `~/Downloads/prd-924/` — Evidence: pending.

## Blocked on

- Windows native Midway: threenative-engine#614 (win32-x64 player crash) — unblocked by the #614 fix. After the fix, the builder's Windows launch entry (`build.rs:236`) needs one line, and the deploy path needs no change.
- AC-5 only if the release gate holds Midway: an admin approves it in `/admin` (PRD-814) — unblocked by João.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Native deploy | `threenative deploy --target desktop` → `deploy.ts` → `store-cli.ts` → `tn-store` | New path beside the web deploy, which is unchanged | AC-2, AC-3, AC-5 |
| Store client distribution | `release-local.mjs` → site media `launcher/cli/` → `GET /launcher/cli/cli.json` | New; the launcher release is unchanged | AC-4 |

## Decisions

- 2026-11-26 (agent): run the published `tn-store` binary, not a TypeScript port. It reuses the client that Studio already runs in production, its secret scan included, and keeps one implementation of the store protocol.
- 2026-11-26 (agent): `THREENATIVE_STORE_CLI=<path>` makes the command use a local `tn-store` instead of the download. AC-2 and AC-3 need it to test a source-built client before AC-4 publishes one. It is also how Studio's image can keep its own copy.
- 2026-11-26 (agent): a `package.json` with no `version` (Midway) deploys as `0.0.0`. The store takes any 1 to 40 printable ASCII label and does not require it to be unique, so the default blocks nothing. A version outside that range exits 2.
- 2026-11-26 (agent): the store page URL comes from `tn-store games show <id> --json`, whose `slug` the owner's listing carries before it is live. If that call fails, the last line falls back to `/games/game/?id=<id>`, which the site redirects once the game is live.
- 2026-11-26 (agent): the first deploy needs `--shot`. The store listing requires a picture, and running the game to capture one costs more than the flag.

## Execution Phases

#### Phase 1: Midway builds the way the farm builds it
**Status:** NOT STARTED
**Files:** none expected. A builder or engine refusal is fixed at its layer: a Midway lockfile problem in the sandbox repo, an engine-player gap in `packages/runtime-native`.
**Implementation:** run the store's `local-farm.mjs` (the `build-game.yml` steps without Actions) on a clean Midway clone. Then run the packed player under the desktop playtest. Each refusal becomes a fix with its own test before Phase 3.
- [ ] Midway packs for `linux-x64` and the packed player runs 300 frames — proof: AC-1 — covers AC-1 and the PRD-805 and PRD-815 risks.

#### Phase 2: `threenative deploy --target desktop`
**Status:** NOT STARTED
**Files:** `packages/create-threenative/src/deploy.ts` (target switch), `src/store-cli.ts` (fetch, verify, cache, spawn), `src/threenative.ts` (help text), `__tests__/deploy-native.spec.ts`.
**Implementation:** as in Solution. The web path keeps its tests green, unchanged.
- [x] The unit contract passes — proof: AC-2 — covers AC-2.
- [x] The local end-to-end deploy of Midway works — proof: AC-3 — covers AC-3.

#### Phase 3: Published client, live Midway
**Status:** NOT STARTED
**Files:** `threenative-store/scripts/release-local.mjs` (CLI binaries + `cli.json`).
**Implementation:** publish the client, release the engine cohort with the new command, then deploy Midway against production and install it with the launcher.
- [ ] `cli.json` and the binaries are live and match — proof: AC-4 — covers AC-4.
- [ ] Midway is live on the store and plays from the launcher — proof: AC-5 — covers AC-5.
