# PRD-824 — The `mystral` desktop host confines untrusted game JS

**Status:** NOT STARTED
**Priority:** P1 — Phases 1-3 are open: game JS in the `mystral` host can write, read and delete any file the player can reach, so a store game on this host could install malware.
**Complexity:** 4 (HIGH) — 1-5 files (+1), crosses the engine/store boundary (+2), external API: curl options (+1); risk override: code execution on player machines.
**Owner:** João
**Depends on:** None
**Consumer:** `threenative-store` PRD-815 (`docs/PRDs/PRD-815-native-builds-run-only-the-engine.md`); until this PRD is done the store ships native builds only on `tn-native-engine-player-v8`.

## Context

Audit (read-only, 2026-11-05, `develop` at `e9707dd6c`, cross-checked by DeepSeek V4.1 Flash): `threenative-store/docs/security/engine-capabilities-audit.md`. Findings in `packages/runtime-native`:

| # | Capability | Code | Today |
|---|---|---|---|
| 1 | Write any file, ≤ 1 MB | `__THREENATIVE_NATIVE__.playtest.respond(path, payload)`, `src/runtime.cpp:3817-3830` | Always installed (`:3875`), no path check |
| 2 | Read and delete any file | `__THREENATIVE_NATIVE__.playtest.receive(path)`, `src/runtime.cpp:3797-3815` | Always installed, no path check |
| 3 | Read any file | `__readFileSync`/`__readFileAsync` (`fetch("file://…")`), `src/runtime.cpp:2328-2430`; `resolveFetchFilePath`, `:169-185` | Desktop passes the raw path to `std::ifstream` |
| 4 | Load JS from outside the game | `require`/`import`, `src/js/module_resolver.cpp:154-167` | Absolute and `..` paths pass when no `game.bundle` is present |
| 5 | Write a PNG anywhere | `__THREENATIVE_NATIVE__.captureScreenshot(path)`, `src/runtime.cpp:3640-3645` | No path check |
| 6 | curl schemes | `src/http/http_client.cpp:138-196` | No `CURLOPT_PROTOCOLS` (`file://`, `ftp://` UNVERIFIED) |

Row 1 is code execution: a `.desktop` file in `~/.config/autostart/` or a `.bat` in the Windows Startup folder runs at the next login.

Not affected: `tn-native-engine-player-v8` (`src/engine/player/v8_main.cpp:1211-1318` exposes no file, network or module access; its mailbox uses fixed names under `TN_PLAYTEST_MAILBOX_ROOT`, `src/engine/player/mailbox.cpp:49-59`). No process spawn, `dlopen` or FFI binding exists in either host.

## Solution

Owner constraint (2026-11-05): no regressions and no nerfing. Block only what a legitimate game never does; turn on stricter limits only where a store needs them.

- **A. Playtest gate (always).** Install `__THREENATIVE_NATIVE__.playtest` only when `TN_PLAYTEST_MAILBOX_ROOT` is set, and confine `receive`/`respond` to that root with `canonicalize` + prefix check, the same check `native/ui-overlay/src/desktop.rs:167-171` uses. The playtest runner always sets the variable (`packages/playtest/src/runner/desktop.ts:123`).
- **B. Store mode (`--store`).** A new CLI flag. Store launchers pass it with fixed arguments; dev, CLI tools, benchmarks and playtests do not, so they keep today's behavior exactly. Game JS cannot start a process, so it cannot drop the flag.
- **C. In store mode,** confine file reads (row 3) and module resolution (row 4) to the game folder, the way Android maps to the bundle (`runtime.cpp:174-178`). A refused path throws `TN_STORE_PATH_REFUSED` naming the path.
- **D. In store mode,** confine `captureScreenshot` (row 5) to the game's save folder.
- **E. Always,** set `CURLOPT_PROTOCOLS` and `CURLOPT_REDIR_PROTOCOLS` to HTTP and HTTPS (row 6). Network stays open for games; in store mode the host logs each contacted host once per run, so a store can show what a game talks to.

## Acceptance Criteria

#### Phase 1: Always-on fixes (A, E)
- [ ] Without `TN_PLAYTEST_MAILBOX_ROOT`, `__THREENATIVE_NATIVE__.playtest` is `undefined`; with it, `respond` to a path outside the root returns false and writes nothing. proof: new runtime-native test (red on `develop` first) — Evidence: pending.
- [ ] `fetch("ftp://…")` and a redirect from HTTPS to `file://` both fail. proof: same test file — Evidence: pending.
- [ ] No regression: the runtime-native conformance run and the desktop playtest specs (`packages/playtest/__tests__/desktop-playtest.spec.ts`) pass unchanged. proof: those commands — Evidence: pending.

#### Phase 2: Store mode (B, C, D)
- [ ] With `--store`, `fetch("file:///etc/hostname")`, `require("/tmp/x.js")` and `captureScreenshot("/tmp/x.png")` each fail with `TN_STORE_PATH_REFUSED`; the same game's own assets, modules and save-folder screenshot work. proof: new runtime-native test — Evidence: pending.
- [ ] Without `--store`, the same calls behave as on `develop` today (dev mode untouched). proof: same test — Evidence: pending.
- [ ] A `mystral`-host starter and a React UI starter run 300 frames with `--store` and log zero refused paths. proof: the desktop starter verification with `--store` — Evidence: pending.

#### Phase 3: Store consumer
- [ ] The store launcher passes `--store` for `mystral` builds, and the store builder accepts `mystral` native builds again (reverting the store's engine-player-only rule). proof: `threenative-store` PRD-815 follow-up, `cargo test -p tn-store-builder` and a real `build-game.yml` run — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Playtest gate | host start → native host setup in `runtime.cpp` | Replaces the always-on playtest object | Phase 1 |
| Store mode | `mystral --store` from the store launcher | New flag; default behavior unchanged | Phase 2, 3 |
