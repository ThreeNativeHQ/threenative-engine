---
prd_contract: v1
---

# PRD-927 — Windows native builds pack on the Linux farm, so Windows Midway ships with no paid runner

**Status:** NOT STARTED (Windows pixels proven by a probe; the Windows UI overlay is missing)
**Priority:** P1 — Windows players get no native ThreeNative game until this ships. Owner, 2026-11-27: "sort out any blockers on windows too" and "ignore CI, i wont pay anything".
**Complexity:** 7 (HIGH) — engine CLI option (+1), store builder and farm workflow (+2), crosses the engine/store release boundary (+2), a Windows binary packed on Linux must still start on Windows (+2, risk: no Windows machine on the LAN).
**Owner:** João
**Depends on:** PRD-924 (done), store farm hardening (store #77, done)
**Repo:** this repo (`packages/create-threenative`, `packages/runtime-native/scripts`); `ThreeNativeHQ/threenative-store` (`crates/tn-store-builder`, `.github/workflows/build-game.yml`); `ThreeNativeHQ/threenative-site` (re-enable `windows-x64`)

## Context

- ✅ The Windows player crash (#614) is fixed (#615). Engine run 45942019774 passed `--check-game` on windows-2025.
- ❌ The store farm builds `windows-x64` on hosted `windows-latest`. Hosted Actions on the private store repo are unpaid, so the job never starts. Production has `settings.windows_builds_enabled=0` (site D1) so a release does not wait on it.
- ✅ The trusted local runner (`tn-store-trusted`, Linux) builds admin-owned games today. It cannot run a Windows job.
- ✅ The prebuilt download already takes a platform: `ensureNativeBinary(options.platform)` (`packages/runtime-native/scripts/install-prebuilt.mjs:322`), and the Windows engine player is `threenative-engine-player-win32-x64.exe` (`install-prebuilt.mjs:34`).
- ✅ **Windows pixels, measured 2026-11-27**: Midway built natively on hosted `windows-2025` (temporary probe, `ThreeNativeHQ/threenative-sandbox` run 46071510937) renders the carrier deck, plane, crew, ocean and sky for 110 s with no crash: Dawn D3D12 on the Microsoft Basic Render Driver (no GPU), 383 frames. Screenshot: `~/Downloads/windows-midway-probe/desktop-110s.png`. Under Wine on Linux the same player loads and runs 150 s but draws nothing on Xvfb.
- ❌ **Windows UI, the real blocker**: the published win32-x64 engine player has no web-UI overlay and no native-css backend. `threenative build --target desktop` refuses a game with `ui.renderer: "web"` on Windows (`TN_ENGINE_PLAYER_UI_UNSUPPORTED`, `packages/create-threenative/src/build.ts:1742`), and Midway's HUD is a web HUD. The probe reached pixels only by switching the HUD off in its CI copy.
- ❌ `threenative build --target desktop` packs only for `process.platform` (`desktop-distribution.mjs:129` `desktopTargetKey()` defaults). A Windows game folder is game JS plus the engine player `.exe` and its DLLs (`desktop-distribution.mjs:268` reads `SystemRoot` for DLL discovery, which is Windows only).

## Solution

`threenative build --target desktop --platform win32-x64` on Linux downloads the verified Windows engine player and writes the same folder a Windows host writes (`game.js`, `tn-native-engine-player-v8.exe`, the DLL set the player ships with, `<name>.cmd`). The store builder passes the platform through. `build-game.yml` routes `windows-x64` to the Linux runner, local when trusted and `ubuntu-latest` otherwise, and the scan job does the same. The site turns `windows-x64` back on.

## Non-Goals

- Building the Windows engine player from source on Linux: the player stays a prebuilt, verified download.
- Code signing: `win32-x64` already ships unsigned (`install-prebuilt.mjs:48`).

## Acceptance Criteria

- [ ] AC-1 [local]: On Linux, `threenative build --target desktop --platform win32-x64` in Midway writes a folder whose file list and player sha256 match a Windows-host build of the same commit (the engine CI `clean-consumer-windows` artifact). proof: the file-list diff and the sha256 line.
- [ ] AC-2 [local]: `tn-store-builder build --platform windows-x64` on Linux packs Midway, and the packed `.exe` starts the game under Wine for 300 frames, or, if Wine cannot run the WebGPU player, the AC records that and AC-3 carries the start proof. proof: the run log.
- [ ] AC-3 [shared]: A Windows machine (owner's, a VM, or one paid hosted run the owner approves) installs Midway from the production launcher and starts it. proof: screenshot in `~/Downloads/prd-927`.
- [x] AC-5 [local]: The win32-x64 engine player attaches the web UI (WebView2) or native-css, so Midway builds for Windows with `ui.renderer: "web"` and its HUD shows on a hosted `windows-2025` desktop capture. proof: the capture and `TN_UI_OVERLAY` attached true. Done 2026-11-28: WebView2 visual hosting (a DirectComposition visual topmost over the swapchain, the pointer routed in the game window procedure by `pointer_owner`) plus `document.exitPointerLock` on the player document (TAKE THE DECK threw `TN_UI_RECEIVE_FAILED`). Red-green on hosted runners (sandbox branch `probe/windows-midway-web-ui`): red arms 3823f3fcf (region clip: no title) and 277c37588 (child window: black page) failed in run 46082063592; e29163c53 passed every check in runs 46086473520 and 46088450543 (title drawn, game through the page, TAKE THE DECK starts the sortie, `TN_UI_OVERLAY` attached true). Captures: `~/Downloads/windows-midway-web-ui/`.
- [x] AC-6 [local]: The same Midway HUD works on macOS (wry WKWebView over the Metal view): drawn over the game, and a click on TAKE THE DECK starts the sortie. proof: run 46095158002 on `macos-15`, fix cb18bf948 passed (the page got pointerdown and click, `#briefing` hidden after), red arm 27aed3acb (before `with_accept_first_mouse`) kept the briefing. Fixes: overlay in front of the Metal view, AppKit hit test measured from the top, web view sized to the container, first click accepted. Captures: `~/Downloads/macos-midway-web-ui/`.
- [x] AC-7 [local]: The packaged Windows `.exe` started alone (a double-click: no arguments, no environment) runs the game beside it and applies its `launch.cfg` (`display.fullscreen: true` opens fullscreen), and the HUD fullscreen toggle switches the real game window both ways (`tn:fullscreen` frame, `SDL_SetWindowFullscreen`). proof: run 46095240761 passed all checks (1024x768 fullscreen, windowed after one toggle, fullscreen after a second, `TN_UI_FULLSCREEN` applied true twice); red arm run 46093855157 (base player) exited 2, "a game bundle path is required". Captures: `~/Downloads/windows-midway-fullscreen/`.
- [ ] AC-4 [shared]: Production: `windows_builds_enabled` is back on, a Midway deploy builds `windows-x64` on the trusted Linux runner, and the release reaches live with both platforms built. proof: the farm run ids.

## Blocked on

- AC-3 needs a Windows machine to start the game on. No Windows machine is on the LAN (owner to choose: a VM on this desktop, a borrowed machine, or one approved paid run).

## Execution Phases

#### Phase 1: Engine packs Windows on Linux
**Status:** NOT STARTED (AC-1)
**Files:** `packages/runtime-native/scripts/desktop-distribution.mjs`, `packages/create-threenative/src/` (the `--platform` flag), one spec in `packages/runtime-native/__tests__/`.
- [ ] A Linux pack of Midway for `win32-x64` matches the Windows-host folder — proof: AC-1 — covers AC-1.

- [x] The win32 player shows Midway's web HUD — proof: AC-5 (runs 46086473520, 46088450543) — covers AC-5.
- [x] The macOS player's HUD takes clicks — proof: AC-6 (run 46095158002) — covers AC-6.
- [x] The packaged player starts alone with the game's window settings and the HUD toggles fullscreen — proof: AC-7 (run 46095240761) — covers AC-7.

#### Phase 2: Store builder and farm
**Status:** NOT STARTED (AC-2)
**Files:** `threenative-store/crates/tn-store-builder/src/build.rs`, `.github/workflows/build-game.yml`, `scripts/lint-workflows.mjs` (the allowlist loses `windows-latest`).
- [ ] The builder packs Midway for Windows on Linux and the packed game starts — proof: AC-2 — covers AC-2.

#### Phase 3: Production
**Status:** NOT STARTED (AC-3, AC-4)
**Files:** site D1 `settings` (delete `windows_builds_enabled`), engine cohort release.
- [ ] Windows Midway installs and starts from the launcher — proof: AC-3 — covers AC-3.
- [ ] The farm builds `windows-x64` on Linux in production — proof: AC-4 — covers AC-4.
