# Production readiness assessment — 2026-09-08

**Verdict: not ready to promise “install the library, develop any game, and ship web, desktop and Android without engine-source work.”** The published starter can produce a web build. Game branding and much of authoring are configurable in the consumer project. Native distribution is blocked by missing public runtime binaries, default UI portability has gaps, and the Android command produces a development artifact rather than a store submission.

Assessed source: `912a567e3e7592e6b437e49fe6318a3987d1f7c1`. Public packages inspected: `create-threenative@0.2.3`, core/physics/UI/runtime `0.3.0`. Scope excludes iOS. Assessment includes live npm/GitHub queries, a fresh registry starter install, web builds, desktop build attempt, MCP transport checks, source inspection and focused tests. It is not a certification of every game or platform.

## 1. What a developer can do today

| Consumer journey | Verdict | Evidence and practical boundary |
| --- | --- | --- |
| Install and develop a web game | Conditional yes | Fresh published starter scaffolded and built. Initial install failed in sharp; retry with `SHARP_IGNORE_GLOBAL_LIBVIPS=1` succeeded. No engine checkout or local dependency links were used. Browser gameplay was not exercised in this assessment. |
| Customize name, icon, splash and loading UI | Yes in game files, with platform limits | Published web output reflected a changed name, icon paths and theme color. Native adapters exist, but their visible results were not executed here. See customization table. |
| Build Linux desktop from public packages | Blocked | Published consumer built its JS/UI bundles, then failed because the Linux runtime binary was missing. Doctor confirmed the public manifest returns HTTP 404. |
| Build Windows/macOS with the default HUD | Blocked | Same missing release; additionally current CLI rejects `ui.renderer: "web"` on these OSes. Native core CI passes do not prove the default React HUD works. |
| Build Android and later submit to a store | Not complete | Prebuilt release missing; current packaging selects `assembleDebug` and copies `app-debug.apk`. Signing/release-bundle delivery and current Play compatibility remain work. |

The engine has meaningful cross-platform implementation. That is distinct from a complete public distribution workflow. A developer willing to compile and modify the engine can get further than a developer using only installed packages.

## 2. MCP installation and authoring experience

**Published starter: three MCPs are configured automatically and all three initialized successfully.** No manual server package install was needed in the successful npm consumer install. The generated `.mcp.json` launches project-local core shims; `.codex/config.toml` is also scaffolded.

```text
threenative-assets: threenative-asset-mcp@0.6.0; 35 tools advertised
threenative-sculpt: threenative-sculpt-mcp@0.1.1; 5 tools advertised
threenative-engine: bundled in @threenative/core@0.3.0; 2 tools advertised
```

These are real transport initialization/tool-list observations from the published `threenative doctor --text`, not just configuration-file inspection. Individual asset downloads, sculpt operations and editor UI integration were not exercised.

**Current source has four servers, while the downloaded starter has three.** The additional Blender server is bundled with core in current source; assets is pinned to 0.7.0 there. Those improvements must be released before describing them as the public installation experience. See [server definitions](../../packages/core/mcp/servers.mjs) The bundled Blender launcher named here was removed with the Blender MCP server on 2026-10-30.

| Detail | Consumer experience |
| --- | --- |
| Supported editor configuration | Current postinstall wires Claude Code, Codex, Cursor, VS Code, Gemini CLI, opencode and Zed project files. The audit confirmed published Claude/Codex files, not every editor host. |
| Automatic setup conditions | Install scripts must run for postinstall setup; `THREENATIVE_SKIP_MCP_SETUP` disables it. Scaffolded configs provide a separate path. Unreadable/unwritable configs can be left alone while installation succeeds. |
| Editor connection | The host must load/trust the project configuration and launch from the game root. Installing npm dependencies cannot guarantee an already-running editor has connected its tools. |
| External applications | The Blender MCP does not install Blender. Actual conversion requires a separately installed Blender. Configuring a server is not proof that every external tool/provider operation is ready. |
| Other editors | Hosts requiring machine-wide config are deliberately not modified automatically; their MCP setup remains manual. |

Sources: [MCP installer](../../packages/core/mcp/install.mjs), [postinstall setup](../../packages/core/scripts/ensure-mcp.mjs), [scaffold validation](../../packages/create-threenative/src/index.ts). MCPs are authoring tools; they are not runtime dependencies a player needs to install.

## 3. Customization without engine source

| Developer request | Game-owned surface | What is proven / missing |
| --- | --- | --- |
| Name, application ID and version | `threenative.config.ts`: `app.name`, `app.id`, `app.version`, `app.build`; desktop `window.title` | Available. Android packager maps identity/version into generated native files. Web name change was verified in emitted manifest. |
| Launcher icon and browser favicon | `public/icon.png`, `public/favicon.svg`, `app.icon`, `app.icons.web`, `app.icons.android` | Available. Shared icon validates as square PNG; web has separate SVG/PNG paths; Android supports foreground/background/monochrome variants. Web output verified. Desktop stages an SDL window icon; this does not establish Windows executable-resource or macOS Finder/app-bundle branding. |
| Initial splash/launch page | `bootSplash.backgroundColor`, `bootSplash.image`, generated `index.html` | Web metadata/launch markup and Android splash resources have adapters. Web theme color verified. Native splash appearance and desktop OS launch branding remain unverified. |
| In-game loading screen | `src/render/loading.ts` | Generated editable source exposes colors, background/logo image, progress-bar layout and status display. Distinct from the OS splash before the JS game starts. File exists in the published starter; visual customization was not browser-tested. |
| HUD, menus, game visuals and display | `src/ui/`, `src/render/`, `display`, `window`, `renderer` in config | Editable without engine source. Default web HUD works only on native hosts with an implemented WebView overlay; Windows/macOS are explicitly rejected by the current build guard. |

**Do not tell developers to patch engine source to change their icon or loading screen.** Those authoring controls already exist. The missing work concerns consistent native packaging and validation, not basic game-side customization APIs.

Actual consumer-only experiment: changed name to `Readiness Demo`, copied a PNG to a custom icon path, created a custom SVG favicon, and set splash/theme color to `#123456`. `npm run build:web` exited 0; emitted manifest contained the name, color and custom icon URLs; generated HTML referenced the custom favicon. No framework code was edited.

Sources: [config types](../../packages/core/src/config.ts), [validation](../../packages/create-threenative/src/config.ts), [web branding](../../packages/create-threenative/src/web-brand.ts), [loading source](../../packages/create-threenative/template-assets/loading.ts), [Android adapter](../../packages/runtime-native/scripts/package-android.mjs), [desktop staging](../../packages/runtime-native/scripts/package-desktop.mjs).

## 4. Release blockers, in priority order

1. **Public native runtime artifacts do not exist for the installed version.** Live GitHub releases listed only `quiche-owned-v1`; the runtime `0.3.0` manifest returned HTTP 404. `pnpm publish:check` independently reported the same blocker. The installed runtime package contains no full C++ build tree. Android's documented fallback explicitly requires an engine source checkout, which violates the requested consumer experience. Fix: publish and consumer-verify a matching runtime release for every advertised desktop architecture and Android ABI. [Runtime installation contract](../../packages/runtime-native/README.md).

2. **The default UI is not portable across advertised desktop platforms.** Current `assertNativeUiRendererCompatible` accepts desktop WebView UI only on Linux and throws `TN_UI_RENDERER_UNSUPPORTED` on Windows/macOS. Switching to `ui.renderer: "native"` changes the UI implementation contract; it is not proof that the existing React/CSS HUD retains its behavior or appearance. The published Linux doctor also detected a Wayland/Xwayland overlay failure on this machine. Fix: implement and run default starter HUD/input proof on each claimed desktop OS/session. [Build guard](../../packages/create-threenative/src/build.ts).

3. **Android output is development-oriented and below the current Play target requirement.** The packager invokes `assembleDebug`, expects `app-debug.apk`, and the Gradle project has `compileSdk = 35` and `targetSdk = 35`. Google's current requirement for new ordinary phone apps/updates is API 36 from August 31, 2026, with extension provisions; no extension was established here. Fix: expose a consumer-owned release/signing workflow, produce the chosen store artifact, update SDK configuration and validate the actual upload. [Gradle configuration](../../packages/runtime-native/android/app/build.gradle.kts), [packager](../../packages/runtime-native/scripts/package-android.mjs), [Google target API requirement](https://developer.android.com/google/play/requirements/target-sdk).

4. **Default Android V8 still has a documented 16 KB compatibility gap.** The runtime contract records `libv8android.so` as misaligned, despite alignment fixes for owned libraries and SDL. Google's documentation requires 16 KB support for affected Play apps; deadlines/extensions are not a substitute for compatibility. This audit did not remeasure the binary. QuickJS avoids that V8 dependency but is a different performance/compatibility lane, not a proven store-ready workaround. Fix: provision aligned binaries, inspect every packaged shared library and run the final app in a 16 KB environment. [Runtime contract](../../packages/runtime-native/AGENTS.md), [alignment checker](../../packages/runtime-native/scripts/check-android-16kb-alignment.mjs), [Google page-size guidance](https://developer.android.com/guide/practices/page-sizes).

5. **Current source and published artifacts have diverged.** `publish:check` exited 1 with ten findings: eight already-published versions with subsequent source changes, missing runtime prebuilts, and a core `scripts/vsm-proof/run.mjs` import reaching unpublished sibling playtest source. Fix: repair the package boundary, bump/release a coherent package set, and run public-registry consumer gates. The helper finding is a specific installed-tool failure, not evidence that every core import fails. [Publish checker](../../scripts/check-publish-state.ts).

## 5. “Any game” and shipping boundaries

ThreeNative is an alpha general-purpose framework with useful game systems, not a guarantee that every browser library, asset codec, workload or third-party SDK is portable. Current native guards reject browser DOM code in the portable graph and mobile WASM dependencies; mobile asset guards reject KTX2 and compressed mesh cases. Game-specific physics, networking, save behavior, touch/gamepad input, suspend/resume, offline startup and performance must be proven for the actual shipped game. No complete per-feature/per-platform census was executed in this assessment. [Native build guards](../../packages/create-threenative/src/build.ts), [runtime contract](../../packages/runtime-native/AGENTS.md).

Desktop packaging runs the current host runtime to compile an executable. It is host-platform packaging, not a demonstrated “build Windows and macOS from Linux” toolchain. The WebView UI directory is staged beside the executable and must travel with it. The inspected command does not produce a signed/notarized macOS app, a Windows installer or a store submission. Those can be legitimate downstream developer tasks, but need a documented path that works with installed packages and no engine patches. [Desktop packager](../../packages/runtime-native/scripts/package-desktop.mjs).

A web build can be deployed to static hosting, subject to testing the actual hosting path and browser behavior. Emitting a web manifest alone does not prove offline/PWA installation or store suitability. Signing keys, store accounts, listings and game-specific SDK integrations belong to the developer; the framework should provide reliable build artifacts and extension points. Store acceptance has not been demonstrated here.

## 6. Evidence recorded during this assessment

| Check | Result | Scope |
| --- | --- | --- |
| Fresh public starter scaffold/install/build | Scaffold 0; initial install 1; adjusted install 0; web build 0; branding build 0 | Linux, Node 20.19.6, npm 11.18.0. Lockfile contained zero `file:`/`link:` dependency specifiers. |
| Published desktop build and doctor | Both exit 1 | Missing Linux prebuilt and manifest HTTP 404; doctor also flagged local Linux overlay and JDK 26 versus supported JDK 17. Android APK build not attempted. |
| Current-source focused tests | 4 files, 134 tests passed | Config, web-brand, build and MCP-install suites. Unit proof, not native visual proof. |
| Publish preflight | Exit 1, ten findings | Live registry/version checks and package-boundary inspection. |
| Recent upstream CI | CI and native platform workflow success on `76321e46d93f8ece59528315e83b17a644b7a77b` | Different from assessed local HEAD. Windows/macOS core, Linux starter, Android emulator/parity and networking jobs passed; this is not a public runtime release. |

Live runs: [CI 34260312712](https://github.com/ThreeNativeHQ/threenative/actions/runs/34260312712), [native evidence 34260312723](https://github.com/ThreeNativeHQ/threenative/actions/runs/34260312723). This supersedes the old “Android CI is red” statement in [CURRENT-CHALLENGES](../CURRENT-CHALLENGES.md) for these observed runs. Older registry/alpha summaries also do not substitute for the current consumer result.

Report validation: `pnpm check:docs` passed (1,723 relative links across 1,013 Markdown files); the six required prose-lane test files passed all 134 tests. A separate check verified all 22 local links in this new report. Final Git status contained only this new report.

Selected exact output:

```text
Missing prebuilt runtime for 'linux-x64':
/tmp/tn-readiness-wqcqyp50/game/node_modules/@threenative/runtime-native/prebuilt/linux-x64/threenative-runtime

Prebuilt release manifest fetch failed for 'linux-x64' at
https://github.com/ThreeNativeHQ/threenative/releases/download/runtime-native-v0.3.0/prebuilt-lock.json: HTTP 404.

Test Files  4 passed (4)
     Tests  134 passed (134)

10 finding(s). This tree must not be published as it stands.
```

Initial sharp failure: its install selected a source build and requested `node-addon-api`. Setting `SHARP_IGNORE_GLOBAL_LIBVIPS=1` made the retry succeed, consistent with local libvips detection; that cause was not independently instrumented. This is environment friction, not a demonstrated universal install failure. npm also reported a transitive Node >=22 engine warning and six high-severity audit findings; their reachability was not assessed and no automatic dependency fixes were applied.

Temporary consumer/logs: `/tmp/tn-readiness-wqcqyp50/`. Focused-test log: `/tmp/tn-readiness-focused-tests.log`. These paths are local diagnostic artifacts, not portable release evidence. No full repository typecheck/lint/test, new browser gameplay run, physical-device run, Windows/macOS execution, native signing or store submission was performed. No engine implementation was modified.

## 7. Acceptance bar for changing this verdict

1. Release a coherent version set and verify a fresh public-registry install, actual MCP discovery and web gameplay on supported package managers.
2. From that installed game, customize identity/icon/splash/loading and produce Linux, Windows, macOS and Android artifacts with no engine checkout or local tarball substitution.
3. Run the same game's HUD, controls, assets, saves and lifecycle on each target; record physical Android performance and 16 KB compatibility where required.
4. Verify release signing and distribution: Android store artifact/upload validation, desktop packaging/install/launch on clean machines, and web deployment. Keep all required configuration in the game or external build environment.
5. Have an external developer follow the documented path and an external player play the result; retain failures as release blockers until reproduced green.

**Next action (under two minutes): open the native release workflow and create one tracked release blocker for the missing `runtime-native-v0.3.0` manifest.** Resolving public binary delivery is the first dependency; it does not by itself close UI portability or store readiness.
