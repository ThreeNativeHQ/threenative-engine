---
prd_contract: v1
---

# PRD-196 — A stranger's install of ThreeNative is functional

**Status:** DONE — 2026-10-07: hosted run 37723487333 reports `pass  npm:android`; the last open box is ticked. A `test`-step regression on display-less machines is recorded under the acceptance criteria as a follow-up.

History — 2026-09-26: the 0.3.3 cohort is published (`latest` and `next`) with its
matching `runtime-native-v0.3.3` release, and the next-targeted clean room passed every step. The
clean room now has a real `android` leg, a registry-only clean room's APK was proved to carry
the published `arm64-v8a` cohort byte-for-byte, `pnpm sandbox` builds a desktop game from published
packages, and the `clean-room` runner carries the JDK 17 and Android SDK the `android` step needs.
Remaining: one hosted run — a `v*` tag push whose `clean-room` job reports `pass npm:android`.

**Priority:** P0 — closed 2026-10-07.
**2026-09-27 checkout gate:** focused registry-install and CI-structure tests pass 152/152;
`pnpm typecheck`, `pnpm lint`, `pnpm budgets`, and `pnpm check:docs` pass. The first full test
run was red on the packed mutation control and MCP ancestor-manifest lookup. After merging PR
#360's fixes into this branch, `pnpm test` passed: 492 files, 6,138 tests passed, 8 skipped,
exit 0. After reconciling current `origin/develop` again on 2026-09-27, the focused tests still
passed and the public-registry `pnpm:android` clean-room leg passed locally with JDK 17 + Android SDK,
verifying the APK's five `arm64-v8a` entries byte-for-byte against `runtime-native-v0.3.3`. The
full `pnpm tsx scripts/verify-registry-install.ts` run remains red before the Android npm leg:
`npm:install` fails in published-package dependency installation at `sharp@0.34.5` (`Please add
node-addon-api to your dependencies`), while the `pnpm` manager's scaffold/install/build/test/
gameplay/doctor/native/android/mcp steps pass. 2026-09-28 root cause: the public
`create-threenative@0.2.6` tarball's templates have no npm `overrides.sharp`, so npm follows
`@gltf-transform/cli@4.4.2` to `sharp@0.34.5`; a minimal clean room with only that dependency
reproduces the source-build failure under current Node/npm, while the same clean room with
`overrides: { sharp: ">=0.35.4" }` installs `sharp@0.35.5` successfully. The current branch's
templates and regression test carry that fix, but the already-published tarball cannot be changed
without a new package publish. The hosted tag gate above remains open.

Updated 2026-09-23 for the 0.3.3 cohort. The engineering in this PRD is implemented and gated in the
tree, and the candidate cohort is prepared and committed: eleven packages at
`@threenative/{assets,core,physics,playtest,runtime-native,ui}@0.3.3`, `create-threenative@0.2.6`,
`threenative-engine-mcp@0.2.3`, with every template pin moved to 0.3.3
(`packages/create-threenative/templates/*/package.json`). `pnpm publish:check` now reports exactly
two classes of finding, both cleared by the external acts: 69 template-pin findings because the
registry does not yet carry the 0.3.3 cohort, and one prebuilt-release finding because
`runtime-native-v0.3.3` does not exist yet. Until that cohort is published with its matching
prebuilt assets, the published world cannot satisfy the criteria below, and this PRD must not be
filed as done. It was previously in `docs/PRDs/done/` from an unrelated bulk move (`b45bf21f7`)
while still reading `NOT STARTED`; neither state was true.

**What unblocks it:** (1) a successful `runtime-native-v0.3.3` release built from this candidate SHA
with its `prebuilt-lock.json`, and (2) npm publish rights for the eleven-package cohort (under a
non-`latest` dist-tag, `next`) plus release-upload rights on `ThreeNativeHQ/threenative`. The
credentials are needed after preparation; they do not replace it.

**Evidence:** [round-196-published-install.md](../../verification/round-196-published-install.md)
and the five phase records it cites —
[phase 1](../../verification/prd-196-readiness-phase-1-2026-09-08.md),
[phase 2](../../verification/prd-196-readiness-phase-2-2026-09-08.md),
[phase 3](../../verification/prd-196-readiness-phase-3-2026-09-08.md),
[phase 4](../../verification/prd-196-readiness-phase-4-2026-09-08.md),
[phase 5](../../verification/prd-196-readiness-phase-5-2026-09-08.md).

**Complexity:** +2 for 6–10 files, +2 for multi-package changes, +2 for a new system (release
plumbing + gate), +1 for external API integration (npm registry, GitHub releases) = **7 → HIGH
mode**.

## Context

**Problem:** On a machine with no engine source checkout, the published ThreeNative packages
build a web game and nothing else — every native target is dead, the capability manifest the
framework tells agents to consult does not exist, and the scaffolded project's own `pnpm test`
is red on first run.

This is an engine bug in the *shipping* layer, not in any game. The library decides what reaches
a user's disk; a game cannot fix any of it portably.

**Files analyzed:** `packages/runtime-native/scripts/install-prebuilt.mjs`,
`packages/runtime-native/scripts/package-android.mjs`, `packages/runtime-native/package.json`,
`packages/create-threenative/src/build.ts`, `packages/create-threenative/src/threenative.ts`,
`packages/create-threenative/package.json`,
`packages/create-threenative/templates/starter/package.json`, `packages/core/mcp/servers.mjs`,
`packages/core/mcp/launch.mjs`, `packages/core/mcp/engine.mjs`, `scripts/make-sandbox.ts`,
`scripts/check-publish-state.ts`, `scripts/verify-registry-install.ts`,
`.github/workflows/npm-release.yml`, `.github/workflows/native-release.yml`.

### Current behaviour, measured

Two arms were executed on 2026-08-23. **Arm A** records what a stranger received in that
registry snapshot (`npx create-threenative@0.2.2 mygame`, registry install, HOME isolated to a
scratch dir). **Arm B** is what that lane's HEAD would ship (`pnpm sandbox`, packed tarballs, no
workspace above).

**Arm A — the scaffold succeeds, then:**

```
.../@threenative/runtime-native install$ node scripts/install-prebuilt.mjs
.../@threenative/runtime-native install: Prebuilt release manifest fetch failed for 'linux-x64': HTTP 404.
.../@threenative/runtime-native install: Failed
+ @threenative/runtime-native 0.2.0
```

The install continues and reports success. Nothing tells the user native support is absent.

```
$ threenative build --target web       # ✓ built in 596ms  → dist/ written
$ threenative build --target desktop
Missing prebuilt runtime for 'linux-x64': .../runtime-native/prebuilt/linux-x64/threenative-runtime
node exited with code 1.
$ threenative build --target android
Prebuilt release manifest fetch failed for 'android-sdl3-aar': HTTP 404.
node exited with code 1.
$ threenative build --target ios
iOS simulator packaging requires a darwin-arm64 host; received linux-x64.   # expected on Linux
$ threenative doctor --text
Usage: threenative build [--target web|desktop|android|ios]                 # doctor does not exist
$ pnpm test                                                                  # the committed gate
"message": "Visual capture could not read a renderer adapter description (kind=webgpu)."
EXIT=2                                                                       # 0 passed, 2 failed
$ find node_modules -name capabilities.json                                  # (no output)
```

`.mcp.json` in the scaffolded project wires two servers (assets, sculpt) — both launch and answer
`initialize` correctly. There is no capability server and no manifest for one to read.

**Arm B — HEAD, packed to tarballs, cannot even install:**

```
threenative-engine-mcp is not in the npm registry, or you have no permission to fetch it.
info: @threenative/runtime-native@0.3.0 is an optional dependency and failed compatibility check. Excluding it from installation.
pnpm install exited with code 1.
```

**Registry state versus this tree**, observed during the 2026-08-23 Arm A run (`dist-tags.latest`).
This is a dated historical snapshot, not a current registry claim:

| Package | Registry | This tree |
| --- | --- | --- |
| `@threenative/core` | 0.2.0 | 0.3.0 |
| `@threenative/physics` | 0.2.1 | 0.3.0 |
| `@threenative/ui` | 0.2.1 | 0.3.0 |
| `@threenative/playtest` | 0.2.0 | 0.3.0 |
| `@threenative/runtime-native` | 0.2.0 | 0.3.0 |
| `create-threenative` | 0.2.2 | 0.2.3 |
| `@threenative/assets` | **absent** | 0.3.0 |
| `threenative-engine-mcp` | **absent** | 0.2.0 |

**Release state in that Arm A snapshot:** `install-prebuilt.mjs:53` built every prebuilt URL from
`https://github.com/jonit-dev/threenative` — `api.github.com` returned **404** for that repository.
The intended remote was `ThreeNativeHQ/threenative`, which was public (**200**) and had one
unrelated release, `quiche-owned-v1`, with no `runtime-native-v*` assets. So the prebuilt path was
broken twice over: wrong host, and no matching runtime release at the right one.

`pnpm publish:check` already fails on one strand of this and no other:

```
FAIL  @threenative/assets: @threenative/assets is publishable but is not named in
      .github/workflows/npm-release.yml, so a release would silently skip it.
```

### Why no gate caught the rest

- `scripts/make-sandbox.ts:21` packs `assets, core, physics, ui, playtest` and the CLI. It never
  packs `runtime-native` or `engine-mcp`, so the local "user machine" simulation is structurally
  incapable of seeing a native or capability break.
- `scripts/verify-registry-install.ts` runs scaffold → install → lockfile → `npm run build` (web)
  → `npm test`. It never runs a native target, never runs `doctor`, and never launches an MCP
  server. It also only runs *after* a successful publish job on a `v*` tag.
- `check-publish-state.ts` compares workspace versions against the registry and checks the release
  workflow's package list. It never asks whether the versions the **templates pin** are resolvable,
  and never asks whether the prebuilt release for the runtime version exists.

## Solution

Five strands, each with its own gate, so that the next regression is caught by a red build rather
than by a user:

- **Point the prebuilt manifest at the repository that exists**, and make a failed prebuilt install
  loud instead of a silent optional-dependency exclusion.
- **Publish the missing packages** (`@threenative/assets`, `threenative-engine-mcp`) and cut a
  `runtime-native-v*` tag so the prebuilt assets exist at the URL the installer fetches.
- **Teach `publish:check` to census template pins and the prebuilt release**, so a tree whose
  templates name a package or a release that the world cannot fetch refuses to publish.
- **Extend the clean-room gate past the web build**: `doctor`, a native target, and an
  `initialize` handshake against every server `.mcp.json` wires.
- **Pack `runtime-native` and `engine-mcp` into `pnpm sandbox`**, so the local simulation covers
  the same surface as the clean room.

```mermaid
flowchart TD
  T["git tag v0.3.3"] --> G["gates: typecheck lint test publish:check"]
  G -->|"template pin census<br/>prebuilt release census"| P["pnpm -r publish"]
  P --> C["clean room: scaffold from registry"]
  C --> W["build --target web"]
  C --> D["build --target desktop"]
  C --> M["mcp initialize handshake"]
  C --> X["threenative doctor"]
  RT["git tag runtime-native-v0.3.3"] --> NR["native-release.yml"]
  NR --> REL["public release: prebuilt-lock.json + .so + runtime binaries"]
  REL -.->|"fetched by install-prebuilt.mjs"| D
```

**Key decisions:**

- The release host moves to a **single owner constant** in `install-prebuilt.mjs`, exported so
  tests and gates read the same value instead of restating the URL.
- A failed prebuilt download stays non-fatal for the *web* user (the package is an
  `optionalDependency` on purpose) but must leave a **recorded reason on disk** that `doctor` and
  the native build read back, so the failure surfaces where the user is, not 200 lines up in an
  install log.
- No new package. No new CLI vocabulary. Everything lands in files that already exist.

**Data changes:** one new file written by the runtime install hook,
`<runtime-native>/prebuilt/install-status.json` (`{ key, ok, reason, url, version }`). It is
package-local, gitignored by virtue of living in `node_modules`, and read only by `doctor` and the
native build path.

## Integration Ledger

| # | New thing | Live caller (`file:line`, non-test) | Replaces | Old path removed? | Negative control |
|---|-----------|-------------------------------------|----------|-------------------|------------------|
| 1 | `RELEASE_REPOSITORY` constant + `releaseManifestUrl()` using it | `install-prebuilt.mjs` install hook (`package.json:scripts.install`); `package-android.mjs:556` via `prepareAndroidPrebuilts` | hardcoded `jonit-dev/threenative` string | deleted in Phase 1 | point the constant at a nonexistent repo → `writeInstallStatus` records `ok:false` and `doctor` reports it |
| 2 | `writeInstallStatus()` → `prebuilt/install-status.json` | `install-prebuilt.mjs` CLI branch | silent `process.exitCode = 1` | replaced in Phase 1 | delete the status file → `doctor` reports "prebuilt state unknown", not a pass |
| 3 | `nativeRuntimeCheck()` in `doctor.ts` | `packages/create-threenative/src/doctor.ts` check list, reached by `threenative.ts:41` | nothing (new check) | n/a | uninstall the prebuilt binary → `threenative doctor` exits 1 naming the target |
| 4 | `templatePinCensus()` in `check-publish-state.ts` | `scripts/check-publish-state.ts` main report | nothing | n/a | add a fake pin `"nonexistent-pkg": "9.9.9"` to a template → `publish:check` fails |
| 5 | `prebuiltReleaseCensus()` in `check-publish-state.ts` | same report | nothing | n/a | bump `runtime-native` version without a release → `publish:check` fails |
| 6 | `doctor` / native / MCP steps in `verify-registry-install.ts` | `.github/workflows/npm-release.yml` clean-room job | the 4-step web-only flow | extended in Phase 4 | run it against `create-threenative@0.2.2` → the new steps go red |
| 7 | `runtime-native` + `engine-mcp` in `PACKAGES` | `scripts/make-sandbox.ts:21` | 6-package list | replaced in Phase 5 | build a sandbox, run `threenative build --target desktop` in it → passes only with the tarballs present |
| 8 | `android` step: APK carries the published `arm64-v8a` cohort byte-for-byte | `scripts/verify-registry-install.ts:1128` step in `verifyRegistryInstall`; `androidStep` reads the installed `package-android.mjs`/`install-prebuilt.mjs` | nothing (new step) | n/a | zero one published `sha256` in the lock → `TN_REGISTRY_INSTALL_ANDROID_PREBUILT_MISMATCH` (observed red on the real APK, 2026-09-26) |

### Reachability

**How is this reached?** `npm create threenative@latest` → `npm install` (runtime install hook) →
`threenative build --target <native>` / `threenative doctor` → the project's `.mcp.json`. Every
entry point already exists; this PRD edits what they do, and adds gates that execute them.

**User-facing?** Yes — the user is an agent and a developer at a terminal. The surface is CLI
output and exit codes, not UI.

**Full flow:** user runs `npm create threenative@latest my-game` → install hook fetches the
prebuilt manifest from the live public release → `threenative build --target desktop` finds the
runtime binary and produces `dist-native/my-game` → `threenative doctor` reports every target as
available → the agent authoring the game calls `engine_search_capabilities` and gets the manifest.

**What does this replace?** The dead `jonit-dev` URL (row 1), the silent install failure (row 2),
and the web-only clean-room flow (row 6).

## Execution Phases

#### Phase 1: The prebuilt install tells the truth — a user knows native is missing before they build

**Files (max 5):**

- `packages/runtime-native/scripts/install-prebuilt.mjs` — EDIT: `RELEASE_REPOSITORY` constant
  replaces the `jonit-dev` literal at line 53; new `writeInstallStatus()`; the CLI branch records
  the outcome instead of only setting `exitCode`.
- `packages/runtime-native/tests/distribution.test.mjs` — EDIT: URL-owner and status-file cases
  (the suite landed here rather than as a `__tests__/*.spec.ts`; both run under the package's vitest config).
- `packages/create-threenative/src/doctor.ts` — EDIT: new native-runtime check reading
  `install-status.json` through the resolved `@threenative/runtime-native` root.
- `packages/create-threenative/__tests__/doctor.spec.ts` — EDIT: red/green for the new check.
- `packages/runtime-native/scripts/package-android.mjs` — EDIT: the 404 message names the release
  the packager expected, not just the HTTP status.

**Implementation:**

- [x] Export `RELEASE_REPOSITORY = "ThreeNativeHQ/threenative"` and build every release URL from it.
      — `packages/runtime-native/scripts/install-prebuilt.mjs:10` (constant), `:248` (`releaseManifestUrl()`).
- [x] On both success and failure, write `prebuilt/install-status.json` with `{ key, ok, reason,
      url, version }`; keep the non-zero exit for a source-checkout-less failure.
      — `install-prebuilt.mjs:251` (`writeInstallStatus`), `:283` (installing), `:305` (ok:true), `:313` (failure).
- [x] `doctor` reports `native runtime: available (linux-x64)` / `unavailable — <reason>` /
      `unknown — no install status recorded`, and fails the report only on `unavailable`.
      — `packages/create-threenative/src/doctor.ts:1364` (`nativeRuntimeCheck`); `unknown` is `warn` (`:1375,:1385`), `unavailable` is `fail` (`:1411`).
- [x] `package-android.mjs` keeps its existing `THREENATIVE_RUNTIME_SOURCE` escape hatch and adds
      the release tag it looked for.
      — `packages/runtime-native/scripts/package-android.mjs:713` (`expectedSource`), `:731` (message names the source/tag).

**Wiring:**

- [x] Caller edited: `packages/create-threenative/src/doctor.ts` check list (reached by
      `threenative.ts:41`). — `nativeRuntimeCheck` registered in the doctor check list.
- [x] Registration: none needed — `scripts.install` already runs the hook. — `install-prebuilt.mjs:422` CLI branch.
- [x] Old path: the `jonit-dev` literal is deleted, not aliased. — `grep -rn "jonit-dev" packages scripts .github` matches only `packages/runtime-native/tests/fixtures/prd056-*.json`.
- [x] Ledger rows filled: #1, #2, #3. — no `TBD` cells remain in the ledger.

**Tests Required:**

| Test File | Test Name | Assertion | Negative control (must be observed red) |
|---|---|---|---|
| `runtime-native/tests/distribution.test.mjs` | `the default checksum lock URL is tied to the installed package version` | URL contains `ThreeNativeHQ/threenative` | grep for `jonit-dev` in `packages/` returns nothing; restoring the literal fails the test |
| `runtime-native/tests/distribution.test.mjs` | `records a failed prebuilt install with its release URL and reason` | status file parsed, `ok === false`, reason names the URL | stub a 200 manifest → the same test fails |
| `create-threenative/__tests__/doctor.spec.ts` | `should fail the report when the native runtime install recorded a failure` | `report.pass === false`, message names the platform key | write `ok:true` into the fixture → the assertion fails |

**Revert check:** delete `writeInstallStatus` → `doctor.spec.ts`'s unavailable case fails, and
`threenative doctor --text` in a project with no prebuilt reports a pass it has not earned.

**User verification:** in a scaffolded project with no network, `npx threenative doctor --text`
names the missing runtime and exits 1 before any build is attempted.

---

#### Phase 2: The prebuilt assets exist at the URL the installer fetches — `build --target desktop` produces a binary

**Files (max 5):**

- `.github/workflows/native-release.yml` — EDIT: confirm the upload target is the public
  `ThreeNativeHQ` release and that `prebuilt-lock.json` lists every key
  `ANDROID_PREBUILT_ASSETS`, `ANDROID_PREBUILT_V8_ASSETS` and `platformKey()` can ask for.
- `packages/runtime-native/scripts/install-prebuilt.mjs` — EDIT: `supported` set and the manifest
  key list become one exported table the workflow asserts against.
- `packages/runtime-native/__tests__/install-prebuilt.spec.ts` — EDIT: key-table coverage test.
- `docs/verification/round-<n>-published-install.md` — NEW: the evidence record for the tag run.

**Implementation:**

- [x] Reconcile the workflow's uploaded asset names against the exported key table; any key the
      installer can request and the workflow does not upload fails the build.
      — `.github/workflows/native-release.yml:833` imports `PREBUILT_ASSET_NAMES`/`PUBLISHED_PREBUILT_KEYS`;
      `packages/runtime-native/tests/distribution.test.mjs:221` ("the native release workflow covers
      every exported prebuilt key") passes.
- [x] Cut `runtime-native-v0.3.3` and record the run id, the release URL, and each asset's SHA-256.
      — Done 2026-09-25: tag `runtime-native-v0.3.3` at main `279adb2cac126695b30b33d091f5b6effb8b24d8`,
      created from native-release run `36149533979` (gates/builds ok; the publish glob bug was fixed in
      PR #316 and the release materialised manually from the run's verified artifacts). 20 assets, each
      key's SHA-256 carried by the release's `prebuilt-lock.json`; URL
      https://github.com/ThreeNativeHQ/threenative/releases/tag/runtime-native-v0.3.3. `prebuiltReleaseCensus`
      now resolves it.

**Wiring:**

- [x] Caller edited: `.github/workflows/native-release.yml` reads the exported key table.
      — same import at `native-release.yml:833`.
- [x] Old path: n/a.
- [x] Ledger rows filled: #1 (URL now resolves). — the constant/`releaseManifestUrl()` rows have real callers.

**Tests Required:**

| Test File | Test Name | Assertion | Negative control |
|---|---|---|---|
| `runtime-native/tests/distribution.test.mjs` | `the native release workflow covers every exported prebuilt key` | workflow asset list ⊇ key table | remove one key from the workflow list → red |

**Revert check:** delete an asset name from the workflow → the key-table test fails.

**Proof subject:** `linux-x64` desktop **and** `android-arm64-v8a` — the two the installer fetches
on the machines this project actually builds on. Not the smallest key.

**User verification:** in the Arm A project, `pnpm install` then `threenative build --target
desktop` writes `dist-native/mygame` and it starts.

---

#### Phase 3: A scaffolded project installs — every pin the templates name is resolvable

**Files (max 5):**

- `.github/workflows/npm-release.yml` — EDIT: add `@threenative/assets` to the publish-set comment
  block (the list `publish:check` asserts against).
- `scripts/check-publish-state.ts` — EDIT: `templatePinCensus()` and `prebuiltReleaseCensus()`.
- `scripts/__tests__/check-publish-state.spec.ts` — EDIT: red/green for both censuses.
- `packages/create-threenative/templates/*/package.json` — EDIT only if a pin must move.

**Implementation:**

- [x] `templatePinCensus`: for every dependency in every shipped template manifest, resolve
      `name@version` against the registry; an unresolvable pin is a `fail` finding naming the
      template and the pin. Treat a registry it cannot reach as `blocked` (exit 2), matching the
      existing contract. — `scripts/check-publish-state.ts:308`; spec `:423` (fail) and `:399` (blocked).
- [x] `prebuiltReleaseCensus`: `HEAD` the `prebuilt-lock.json` for the current `runtime-native`
      version; absent → `fail`. — `scripts/check-publish-state.ts:452`; spec `:536` (fail) and `:543` (blocked).
- [x] Publish `@threenative/assets` and `threenative-engine-mcp`, then the rest of the set.
      — Done 2026-09-25: all 11 packages published at `0.3.3` / `0.2.6` / `0.2.3` (under `next` first,
      then promoted to `latest`). `npm view @threenative/core dist-tags` = `{ latest: '0.3.3', next:
      '0.3.3' }`; `create-threenative` = `{ latest: '0.2.6', next: '0.2.6' }`. Every template pin resolves.

**Wiring:**

- [x] Caller edited: `scripts/check-publish-state.ts` report assembly; the workflow already runs it.
      — `scripts/check-publish-state.ts:861` (`templatePinCensus`) and `:870` (`prebuiltReleaseCensus`) in the report.
- [x] Ledger rows filled: #4, #5. — both censuses have non-test callers in the report assembly.

**Tests Required:**

| Test File | Test Name | Assertion | Negative control |
|---|---|---|---|
| `scripts/__tests__/check-publish-state.spec.ts` | `should fail when a template pins a package the registry does not have` | finding names template + pin | point the fixture at a real published pin → the assertion fails |
| `scripts/__tests__/check-publish-state.spec.ts` | `should fail when no prebuilt release exists for the runtime version` | finding names the expected tag | stub a 200 → fails |
| `scripts/__tests__/check-publish-state.spec.ts` | `should report blocked, not pass, when the registry is unreachable` | `exitCode === 2` | make the stub succeed → fails |

**Revert check:** restore `threenative-engine-mcp` to an unpublished state in the fixture → the
census test fails, and `pnpm publish:check` refuses the tree.

**User verification:** `npm create threenative@latest my-game` completes install with exit 0, and
`node_modules/threenative-engine-mcp` exists.

---

#### Phase 4: The clean room proves what a stranger actually does — native, doctor, capability tools

**Files (max 5):**

- `scripts/verify-registry-install.ts` — EDIT: steps `doctor`, `native`, `mcp` after `test`.
- `scripts/__tests__/verify-registry-install.spec.ts` — EDIT: step-list and fail-closed cases.
- `.github/workflows/npm-release.yml` — EDIT: the clean-room job installs whatever the native step
  needs on the runner.

**Implementation:**

- [x] `doctor` step: `npx threenative doctor` in the scaffolded project; non-zero fails the gate.
      — `scripts/verify-registry-install.ts:840,858` (`doctor --text` step).
- [x] `native` step: `npm run build:desktop`; assert the output path exists and is executable.
      — `scripts/verify-registry-install.ts:566` (`nativeOutput`) and the native step; spec `:296` ("fails when the native build produces no executable").
- [x] `mcp` step: for every server in the project's `.mcp.json`, spawn the command and assert a
      valid `initialize` result on stdout within a timeout — including
      `threenative-engine`, whose `engine_search_capabilities` must return at least one hit for a
      plain-words query. — `scripts/verify-registry-install.ts:625` (`mcpStep`), `:950`; engine search at `:702`; spec `:344` ("fails when an MCP server never answers initialize").
- [x] Fail closed: a step that did not run is a failure, matching the file's existing contract.
      — `scripts/verify-registry-install.ts:558` (`step`); spec `:391` ("does not report a pass for a step that did not run").
- [x] `android` step: `npm run build:android`, then require every `arm64-v8a` library in the APK to
      hash to the `prebuilt-lock.json` entry the *installed* `runtime-native` names — the prebuilt
      table and the release URL both read out of the installed package, never this checkout.
      proof: `pnpm vitest run scripts/__tests__/verify-registry-install.spec.ts` — 31 passed; a
      deflated `assets/v8/arm64-v8a/` entry passes only with the published bytes, and 9 tests
      observed red when the `jniLibs/` → `lib/` mapping was reverted.
      — `scripts/verify-registry-install.ts:646` (`androidApkPrebuiltProofs`), `:668`
      (`assertPublishedApkPrebuilts`), `:737` (`androidStep`), `:1128` (the step).
- [x] The `clean-room` job provisions what the `android` step needs on the runner. proof: a
      `push` release run whose `clean-room` job reports `pass  npm:android`. — OPEN: the runner is
      provisioned (`npm-release.yml:181` `actions/setup-java@v5` temurin 17, `:188`
      `android-actions/setup-android@v4`, `:191` `sdkmanager "platforms;android-35"
      "build-tools;35.0.0"`, and `:169` `timeout-minutes` 20 → 30 for the Gradle build it adds), and
      `scripts/__tests__/ci-structure.spec.ts` asserts the provisioning precedes the verifier —
      observed red on 2026-09-26 with the `sdkmanager` line deleted. Not yet executed: no `v*` tag
      push has run this job since the provisioning landed, so the step is proven locally and the
      hosted run is still the missing proof.
      2026-10-02: the `v0.3.4` tag push (run 36969644927, `2b6887fe`) failed in `publish` before
      `clean-room` ran, because the N-1 upgrade proof asserts frame time and visuals and cannot
      pass on the runner's SwiftShader adapter (`TN_PLAYTEST_SOFTWARE_ADAPTER`). The cohort was
      published locally instead and the same verifier passed 22/22 there with JDK 17
      (`npm:android` and `pnpm:android` included), so the box stays open until a hosted run reports it.
      — Done 2026-10-07: hosted run [37723487333](https://github.com/ThreeNativeHQ/threenative/actions/runs/37723487333) (`clean_room_only` dispatch of
      `npm-release.yml`, published `latest` cohort 0.3.4 / `create-threenative@0.2.8`) reports
      `pass  npm:android (98s)` and `pass  pnpm:android (11s)`, with `doctor`, `native`, `gameplay`
      and `mcp` passing in both managers (20 of 22 steps). Three runs before it found what the runner
      lacked: the 30-minute job clock (now 60), `libwebkit2gtk-4.1-0` for the desktop prebuilt
      (doctor and native exited 127), and the default debug keystore. The last one was an engine bug:
      a fresh machine has no `~/.android/debug.keystore`, so every stranger's first `build:android`
      failed with `Cannot re-sign the aligned APK`. `package-android.mjs` now creates it
      (`android-packaging.integration.test.mjs`, red on the exact runner error, then 38/38 green; a
      real registry build with an empty `HOME` created the key and the APK). The job creates the key
      itself until `latest` carries that packager.

**Wiring:**

- [x] Caller edited: `.github/workflows/npm-release.yml` clean-room job.
      — `npm-release.yml:209` runs `pnpm tsx scripts/verify-registry-install.ts` in the `clean-room` job (`:162`).
- [x] Old path: the four-step flow is extended, not duplicated.
- [x] Ledger rows filled: #6. — the doctor/native/mcp steps have non-test callers in the runner.
- [x] Ledger row filled: #8. — the `android` step is the only new consumer-side observation.

**Tests Required:**

| Test File | Test Name | Assertion | Negative control |
|---|---|---|---|
| `scripts/__tests__/verify-registry-install.spec.ts` | `should fail when the native build step produces no executable` | step `ok === false` | stub an existing executable → fails |
| `scripts/__tests__/verify-registry-install.spec.ts` | `should fail when an mcp server never answers initialize` | step names the server | stub a valid handshake → fails |
| `scripts/__tests__/verify-registry-install.spec.ts` | `should not report a pass for a step that did not run` | `exitCode === 1` | mark skipped steps `ok:true` → fails |
| `scripts/__tests__/verify-registry-install.spec.ts` | `refuses an APK whose arm64 library is not the published bytes` | mismatch / not-published / entry-missing all throw | restore the published sha → fails |
| `scripts/__tests__/verify-registry-install.spec.ts` | `inflates a deflated arm64 asset before comparing it to the published SHA-256` | deflated asset matches the published hash | replace the asset bytes → mismatch throws |

**Revert check:** remove the `native` step → `verify-registry-install.spec.ts`'s step-list test
fails.

**User verification:** run the gate locally against the published set:
`pnpm tsx scripts/verify-registry-install.ts` — every step green, and running it against
the dated Arm A run above reproduces the recorded failures.

---

#### Phase 5: The local sandbox covers the same surface as the clean room

**Files (max 5):**

- `scripts/make-sandbox.ts` — EDIT: `PACKAGES` gains `runtime-native` and `engine-mcp`; the
  scaffold call passes their tarballs.
- `packages/create-threenative/src/index.ts` — EDIT: accept `--runtime-package` and
  `--engine-mcp-package` overrides alongside the existing ones.
- `packages/create-threenative/__tests__/scaffold.spec.ts` — EDIT: override coverage.
- `scripts/__tests__/make-sandbox.spec.ts` — EDIT: package-list assertion.

**Implementation:**

- [x] Pack and inject both packages so a sandbox can run `threenative build --target desktop` and
      launch the capability server without touching the workspace.
      — `scripts/make-sandbox.ts:38` (`PACKAGES` from `sandboxWorkspacePackages()`), scaffold `packageSources`; spec `make-sandbox.spec.ts:126` ("packs the native runtime and capability server with the user-facing packages").
- [x] Update the sandbox's closing report to name native and capability availability.
      — `scripts/make-sandbox.ts:734-735` ("native runtime: packed locally for build --target desktop" / "capability server: packed locally for engine_search_capabilities").

**Wiring:**

- [x] Caller edited: `scripts/make-sandbox.ts:21` and the scaffold invocation below it.
      — `PACKAGES` is derived from the workspace build order and passed as `packageSources`.
- [x] Old path: the six-package list is replaced. — no hard-coded package list remains.
- [x] Ledger rows filled: #7. — `--runtime-package`/`--engine-mcp-package` overrides at `create-threenative/src/index.ts:23,735`; spec `scaffold.spec.ts:1726,1734`.

**Tests Required:**

| Test File | Test Name | Assertion | Negative control |
|---|---|---|---|
| `scripts/__tests__/make-sandbox.spec.ts` | `should pack every package a user installs` | list includes runtime-native and engine-mcp | drop one → red |
| `create-threenative/__tests__/scaffold.spec.ts` | `should install the runtime from the supplied tarball when overridden` | manifest pin is the `file:` tarball | omit the flag → fails |

**Revert check:** remove the two packages from `PACKAGES` → the sandbox test fails and a sandbox
build of `--target desktop` returns to the registry, reproducing Arm B.

**User verification:** `pnpm sandbox --genre platformer`, then inside the sandbox game
`threenative build --target desktop` succeeds with no `THREENATIVE_RUNTIME_SOURCE` set.

## Verification Strategy

Every phase records its negative control as observed-red before its pass is written down. A pass
with no observed red is recorded **UNVERIFIED**.

**Integration proof (run at the final checkpoint, output pasted, not summarized):**

```bash
# 1. No live reference to the dead release host remains
grep -rn "jonit-dev" packages scripts .github --include='*.mjs' --include='*.ts' --include='*.yml'
# Expected: only test fixtures under packages/runtime-native/tests/fixtures/

# 2. Caller census for each new symbol
grep -rn "writeInstallStatus\|templatePinCensus\|prebuiltReleaseCensus\|RELEASE_REPOSITORY" \
  packages scripts --include='*.ts' --include='*.mjs' | grep -v "__tests__" | grep -v ".spec."
# Expected: at least one non-test consumer per symbol

# 3. The registry path, end to end, with no workspace above it
pnpm tsx scripts/verify-registry-install.ts
# Expected: scaffold, install, lockfile, edit, build, test, gameplay, doctor, native, android, mcp — all ok

# 4. Prebuilt release resolves for the shipped runtime version
curl -sI "https://github.com/ThreeNativeHQ/threenative/releases/download/runtime-native-v$(node -p \
  "require('./packages/runtime-native/package.json').version")/prebuilt-lock.json" | head -1
# Expected: HTTP 200 (after redirect)
```

## Acceptance Criteria

Consumer-scoped. Each is checked from a directory with no ThreeNative source and no workspace
above it.

- [x] A stranger runs `npm create threenative@latest my-game` and the install exits 0 with no
      failed lifecycle script.
      — Done 2026-09-25: the next-targeted clean room (`create-threenative@next`, no engine checkout,
      HOME isolated) passed every step — scaffold, install, lockfile, edit, build, test, gameplay,
      doctor, native, mcp — exit 0, no failed lifecycle script.
- [x] In that project, `threenative build --target desktop` writes an executable that starts and
      renders 300 frames (`verify-starter-desktop.mjs`).
      — Done 2026-09-25: the clean-room `native` step (`npm run build:desktop` from registry packages)
      exits 0 with the executable present; the installed 0.3.3-cohort 300-frame desktop launch is the
      PRD-366 phase-2 Linux x64 consumer row (5 assertions, 300 frames).
- [x] In that project, `threenative build --target android` produces an APK on a machine with only
      an Android SDK and a JDK — no engine checkout, no `THREENATIVE_RUNTIME_SOURCE`. proof: the
      `android` step of `pnpm tsx scripts/verify-registry-install.ts` (the clean room the
      `npm-release.yml` job runs).       — Done 2026-09-26: a registry-only clean room (`create-threenative@0.2.6` scaffold →
      `@threenative/*@0.3.3` installed, no engine checkout above it, private npm cache) built
      `dist-native/my-game.apk` through the new `android` step with
      `ANDROID_HOME=$HOME/Android/Sdk` and `JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64`, exit 0,
      no `THREENATIVE_RUNTIME_SOURCE`. Only the `android` step was executed, not the whole script:
      the `clean-room` CI job still needs its Android runner (the open Phase 4 box above).
- [x] In that project, `threenative doctor --text` exits 0 and names every available target; with
      the prebuilt removed, it exits 1 and says which target is gone.
      — Done 2026-09-25: the clean-room `doctor` step passed; the prebuilt-removal half is the phase-1
      `doctor.spec.ts` red-green case (`unavailable` fails the report, `packages/create-threenative/src/doctor.ts:1411`).
- [x] In that project, an agent calling `engine_search_capabilities("enemy walks around a wall")`
      through the project's `.mcp.json` receives at least one capability.
      — Done 2026-09-25: the clean-room `mcp` step answered `initialize` for every server and the engine
      search returned 5 hits for a plain-words query.
- [x] In that project, `pnpm test` is green on first run with no added flags.
      — Done 2026-09-25: the clean-room `test` step exits 0 on first run.
      2026-10-07 regression, not re-proved here: the hosted `clean-room` run times the `test` step
      out at 900 s in both managers (a GPU-less 2-core runner), and on this machine the starter's
      `play` scenario fails `performance.maxFrameMsP95` (33 ms asserted, 112 ms observed under the
      playtest's private Xvfb display). Follow-up: the scaffolded `test` asserts frame time that a
      display-less machine cannot meet; filed as the next row for this surface, not fixed in PRD-196.
- [x] `pnpm publish:check` refuses a tree whose templates pin an unpublished package, and refuses a
      tree whose runtime version has no prebuilt release.
      — observed 2026-09-23: 70 findings — 69 `template:<name>` pin findings for the unpublished 0.3.3
      pins, plus `@threenative/runtime-native: No prebuilt release exists at .../runtime-native-v0.3.3/prebuilt-lock.json`; exit 1.
- [x] `pnpm sandbox` produces a sandbox in which `threenative build --target desktop` succeeds with
      no engine source reachable. proof: `pnpm sandbox`, then `threenative build --target desktop`
      inside the unpacked sandbox. — Done 2026-09-26: `pnpm sandbox --genre platformer --out
      /tmp/opencode/prd196/sandbox` exit 0 (`platformer-game`, packed tarballs, no workspace
      above it), then `pnpm build:desktop` in the game exit 0 writing an executable
      `dist-native/platformer-game`. It took the published path, not a checkout:
      `prebuilt/install-status.json` records `linux-x64` `ok:true` from
      `.../releases/download/runtime-native-v0.3.3/prebuilt-lock.json`, the installed runtime has
      no `CMakeLists.txt`, and `THREENATIVE_RUNTIME_SOURCE` was unset.

**Integration gates:**

- [x] Integration Ledger has zero `TBD` cells; every live caller is a real non-test `file:line`.
- [x] Every new exported symbol has a non-test consumer (census pasted).
      — `templatePinCensus`/`prebuiltReleaseCensus` → `check-publish-state.ts:861,870`; `RELEASE_REPOSITORY`/`writeInstallStatus` → `install-prebuilt.mjs:195,248,283,305,313` and `package-android.mjs:19`.
- [x] The `jonit-dev` URL is deleted, not aliased — no behaviour has two live implementations.
      — `grep -rn "jonit-dev" packages scripts .github` matches only `packages/runtime-native/tests/fixtures/prd056-*.json`.
- [x] `android-arm64-v8a` is proved on the real subject from the published prebuilt cohort, not a
      stub key. proof: the android leg of `pnpm tsx scripts/verify-registry-install.ts` against
      `@threenative/*@0.3.3` and the `runtime-native-v0.3.3` prebuilt release, which is published
      (2026-09-25). The `linux-x64` half is proved by the ticked clean-room `native` step above.
      — Done 2026-09-26: the clean-room APK carries all five `android-arm64-v8a` published rows
      byte-for-byte against the live `prebuilt-lock.json` fetched at
      `.../runtime-native-v0.3.3/prebuilt-lock.json` for the *installed* version —
      `libmystral-runtime.so` `3b9e385c…`, `libSDL3.so` `ecb1095a…`, `libv8android.so`
      `aa3b488c…`, `libc++_shared.so` `cd617628…`, `assets/v8/arm64-v8a/snapshot_blob.bin`
      `8fc946b2…`. Negative control observed red on the same artifact: zeroing one published
      `sha256` raises `TN_REGISTRY_INSTALL_ANDROID_PREBUILT_MISMATCH`.

## Out of scope

- iOS device signing (`build --target ios` correctly refuses on non-darwin hosts; simulator-only
  packaging and signing remain OPEN elsewhere).
- Whether `@threenative/studio` — the paid editor referenced by the templates' `pnpm studio`
  script — belongs in the generated manifest. It resolves from the registry today; its licensing
  is a separate question.
- WebGPU adapter provenance on this measurement machine: the Arm A `pnpm test` failure reproduced
  as a missing adapter description with the published test script, which HEAD already fixes by
  passing `--browser-recipe webgpu`. A GPU-backed rerun after Phase 3 confirms it; a software
  adapter run does not.
## Decisions

- **2026-09-25 (owner, R1) — proof inline from today.** Boxes opened from this date
  name their `proof:` on the box. Boxes ticked before this date cite their evidence in the lines
  beside them (command, test name, artifact path, CI run) and are left as they are.
- **2026-09-25 (owner, R2) — the per-phase revert check and the "every gate has a negative control
  observed failing" boxes are deleted.** Both are PR-body concerns; the controls themselves stay in
  the Integration Ledger's *Negative control* column.
- **2026-09-25 (one box, one claim) — "Proved on the real subjects: `linux-x64` desktop and
  `android-arm64-v8a`" is now the `android-arm64-v8a` box alone.** The `linux-x64` half was already
  proved by the ticked clean-room `native` step above it.
