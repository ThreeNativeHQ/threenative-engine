---
prd_contract: v1
---

# PRD-366 — One installed consumer game proves the supported platform contract

**Status (2026-09-28): 100% of its boxes — every phase box and every acceptance box is ticked, and only `## Blocked on` items remain, so this file is filed under [`BLOCKED/requires-physical-device/`](../../BLOCKED/requires-physical-device/) per R6.** What stays unproven is exactly the hardware and release-credential set named under `## Blocked on`: the physical-Android collector row, the Windows and macOS published-cohort rows, and the `npm install` of the published template. Read that section before treating any target claim below as done. **Reclassified 2026-09-28 under R3/R6:** boxes that named a physical device, a Windows host, a macOS host or a registry republish were moved out of the checkbox lists — hardware, credentials and owner calls are not boxes (R3, owner 2026-09-25) — and the phase-3 collector box was split into its proven implementation and its blocked device run ("one box, one claim"). No ticked box, its proof or its prose was removed.

**Priority:** P0 — Blocked rows name a cohort whose npm install fails and whose prebuilt APK crashes at startup.
**Status (through 2026-09-27, kept as the record):** PHASE 2 COMPLETE (independent reviewer PASS on `9a30102d5`); phase 3's code/test portion landed 2026-09-27 and its physical run is open — phase 1's local-tarball browser gameplay proof is recorded below; a public-registry cohort install still waits on PRD-196. Phase 2's cross-target scenario policy was corrected in `d10375e500df5d82cf93fe3487e7d70124f1a157`; the bounded evidence-hardening checkpoint below passes 42 isolated Node regressions, but repository gates, real distributed desktop/Android consumer runs and independent approval remain unverified for this repair. The 2026-09-15 native-consumer repair (portable `KeyR` restart, platform-library noise not counted as game console errors) passes its focused lanes — playtest red 3 failed → 28 passed, runtime-native **87 passed** across the three consumer test files (re-measured at HEAD; the earlier "73" cited a pair that does not reproduce), scaffold 61 passed, both package typechecks — and its real distributed consumer rows now execute locally: a starter scaffolded from the candidate's 11 packed tarballs qualifies on **Linux x64 desktop**, on a **physical Pixel 8** (`arm64-v8a`, API 37) and on an **Android emulator** (`x86_64`, API 35) — every row `pass: true`, 5 assertions, 0 failures, the same scenario hash, application id and **the same five assertion ids**, now machine-checked for set equality across targets after a second review found the qualifier trusted an assertion count alone and would pass a run on assertions the scenario never declared. macOS, Windows and iOS are CI-owned by owner decision; PRD-365 release containers stay unrun. Phase 2 closed with an independent reviewer PASS on `9a30102d5`; the reviewer re-ran the B4 exploits and matched every test count. **Reconciled with PRD-375 (`20f5d6191`) on 2026-09-16:** that merge landed the predicted cross-PR hazard — #255 hardened flag parsing and added `--config`, `--brand-only` and `verifyContainerBrand` inside the very file this branch had turned into a router. Resolved by moving #255's implementation, brand surface and hardening into `verify-starter-desktop-base.mjs`, with the router re-exporting both contracts. #255's parser superseded the guard written here (it also rejects unknown flags), so this branch adopted its `TN_NATIVE_STARTER_CLI_INVALID` taxonomy and rewrote its own tests to the incumbent contract; no #255 test was adjusted to pass. Proved by mutation rather than by green: disabling brand inspection in the base file reds 4 of #255's brand rows (4 failed / 67 passed) and restoring gives 71/71, so its tests genuinely execute against the merged file. Desktop family **203 passed** across five suites; typecheck 0, lint 0. Two findings the reviewer raised as non-blocking were fixed after that verdict: the cross-target assertion-set gate is now **wired and tested** (`--qualify-existing --target desktop,android`) where before it could not fire in any caller, and `ROW_OUTDATED` no longer prescribes a remedy that cannot work. Cross-target equality is verified by that wired, executed command, not by a gate that fires on its own in CI — no shipped script passes two targets yet. Phase 3 physical Android qualification (its own collector, provenance schema and performance budget) remains open, and now carries two items this phase produced: rows keyed by `target` alone lose a row when one target has two devices, and the row should retain `diagnostics[0]` so a repeat pre-assertion abort names itself. Both are landed on the clean-room side as of 2026-09-26 (array shape kept, composite key internal, zero-assertion arm carries the run's own `diagnostics[0]`, and a row with `pass: false` now fails the cohort instead of reporting `exitCode 0`); the physical run itself is still unclaimed. **Phase 3's code/test portion (2026-09-27):** `qualify-physical-mobile.mjs` takes a declared consumer project/scenario and resolves one application identity for the launch, the telemetry, the playtest CLI and the device readback, refusing an emulator, a stale installed APK, an off-project scenario and a report that ran a different one; its test file is 30/30 with each guard red-controlled. No device was touched, the default scenario path does not exist so a default invocation blocks by name, and the phase-3 acceptance boxes stay open. Revised 2026-09-08; phase 1 worked 2026-09-12; phase 2 contract and repair worked 2026-09-15.
**Complexity:** 8 → HIGH (+3 files, +2 multi-package, +2 lifecycle/proof state, +1 hosted/device integration).
**Problem:** Isolated engine feature tests and core smoke screenshots do not establish that a developer can build, customize and distribute a playable game using installed packages only.

Batch contract and dependency order: [production-readiness](../../production-readiness/README.md). Baseline: [the assessment](../../../verification/production-readiness-2026-09-08.md), source `912a567e3e7592e6b437e49fe6318a3987d1f7c1`. iOS is outside this batch; no iOS readiness credit is created or removed.

## Phase 2 evidence-hardening checkpoint — 2026-09-15

This bounded three-file checkpoint changes the existing engine consumer verifier, adds
`packages/runtime-native/tests/starter-consumer-qualification.test.mjs`, and updates this PRD.
It does not complete the distributed-platform or physical-device qualification phases.

The verifier rejects malformed or contradictory assertion evidence, diagnostics-only reports,
incomplete process completion, duplicate target rows and substituted scenarios. It invalidates
old passing rows before reruns, preserves failure logs, binds scenario bytes and checks artifact
stability across execution. Per-target expected identities allow desktop and Android artifacts
to have different hashes. Android installs the selected APK, passes its package/activity to the
installed runner and checks the installed APK hash before and after gameplay.

Fresh verification against `d10375e500df5d82cf93fe3487e7d70124f1a157`: its verifier blob
`9ac43b2f014189ac56fffb049956bb0d22e1fa94` exactly matches the recovered repair baseline. The same
42 regressions produced **38 failed / 4 passed** on that source and **42 passed / 0 failed** on
the repair, using Node 22.16.0 with `node:test`. The test block is the same as the new Vitest file;
only the unrelated PNG import was isolated, with a stub that throws if used. Runner/ADB results
were boundary fixtures, including one real subprocess executing a fixture CLI, not a game.
`node --check` passed for both changed JavaScript files. Uploaded source and test Git blob hashes
match the tested local files. Existing CLI flags were checked against `packages/playtest/src/runner/config.ts`.

Repository Vitest, typecheck, Biome lint, full tests, budgets, scaffold snapshot and actual
browser/native/device runs were **not executed** in this sandbox: it has no repository checkout,
pnpm/Vitest or native toolchain and cannot resolve GitHub/npm for dependency installation. This
is not an independent reviewer PASS. The historical phase-test counts below are not rerun claims.

The scenario's explicit `noNetworkErrors` field was already removed in `d10375e`: the existing
target policy retains browser observation and allows reasoned native waivers. This checkpoint
preserves that newer change. The coupled starter scaffold snapshot still needs verification from
the complete candidate; no replacement hash is invented. Android workflow staging, real target
rows, release aggregation, actual desktop session coverage and all phase 3 requirements remain
open. Phase and acceptance checkboxes are unchanged; this PR must remain draft/PARTIAL.

## Integration ledger

| # | New or revised thing | Live caller at planning time | Replaces | Old path removed? | Negative control |
| --- | --- | --- | --- | --- | --- |
| 1 | Candidate game scenario gate | scripts/verify-registry-install.ts: verifyRegistryInstall; scripts/verify-template-playtests.ts: existing runner | web-build-only qualification | Extend existing harness, no new runner | Wrong state assertion or absent scenario fails |
| 2 | Distributed target gameplay evidence | .github/workflows/native-platforms.yml: starter/Android jobs → installed playtest CLI | core-only smoke used as full-game proof | Core gates remain narrow; add consumer subject | Delete UI/assets or change application ID; gate fails |
| 3 | Physical consumer qualification | packages/runtime-native/scripts/qualify-physical-mobile.mjs:759 scenario invocation | hardcoded native-smoke-only subject | Existing collector accepts declared consumer project/scenario | Supply emulator or wrong artifact SHA; physical gate rejects |

## Current behavior and ownership

The assessment built web output and reproduced a desktop prebuilt failure; it did not run new browser gameplay or native player/device flows. Existing golden-path, registry-install, template playtest and physical qualification harnesses provide the mechanism; no new test runner is needed.

Consumer verification, not new gameplay systems. [PRD-196](../../done/PRD-196-published-install-is-functional.md) owns installation/MCP fixes; [PRD-217](../../done/PRD-217-webview-ui-layer.md) HUD; [PRD-212](../../done/PRD-212-published-install-builds-android.md)/[PRD-365](../../done/PRD-365-consumer-desktop-distribution.md) artifacts; [PRD-153](../../done/PRD-153-game-branding-from-launch-to-play.md) brand. Existing PRD-054 owns conformance, PRD-056 owns physical collector schema, PRD-058 owns performance/reliability mechanisms, PRD-080 owns stranger-test protocol. Consume their non-iOS evidence without declaring their iOS scope done.

## Approach and boundaries

Use a freshly scaffolded default starter with its real React UI, models, physics, audio and loading; extend only the consumer scenario to exercise save/relaunch and input as needed through existing capabilities. Start with that production subject, not native-smoke. Use an additional existing platformer reference for its device performance criterion and action-rpg for persistence if starter has no save feature; each additional proof remains separately identified and cannot replace default-starter HUD qualification. Enumerate supported exports/formats through capability and conformance manifests; unsupported browser/WASM/codecs fail early and are documented, never promised as “any game.”

Data/migration: no application database migration. New build metadata and evidence extend the existing package/config/artifact contracts; no parallel scene, project or release framework.

```mermaid
flowchart LR
    U[Consumer command in game project] --> C[Existing caller named in ledger]
    C --> V{Validate inputs and prerequisites}
    V -->|valid| A[Target artifact or observed behavior]
    V -->|invalid or missing| E[Named failure with actionable next step]
    A --> G{Real consumer gate and negative control}
    G -->|pass| P[Evidence for this exact candidate]
    G -->|fail or absent| E
```

```mermaid
sequenceDiagram
    actor Developer
    participant CLI as Existing build or release caller
    participant Target as Installed target or external service
    Developer->>CLI: Invoke documented project workflow
    CLI->>Target: Validate and execute declared inputs
    alt Successful execution and observation
        Target-->>CLI: Artifact identity and measured result
        CLI-->>Developer: Output path and precise supported claim
    else Missing prerequisite or failed observation
        Target-->>CLI: Concrete failure
        CLI-->>Developer: Non-success with location, cause and fix
    end
```

## Execution phases

### Phase 1 — The installed starter proves browser gameplay after a normal edit

**Progress:**

- [x] Callers wired and building: `scripts/verify-registry-install.ts`, `scripts/__tests__/verify-registry-install.spec.ts`, `packages/create-threenative/templates/starter/playtests/production-readiness.playtest.json` (+1 more)
      The clean-room gate now applies a game-only edit, requires the scenario with non-empty assertions, requires the edit in the build, and runs the scenario; `STARTER_PATHS` and the frozen starter scaffold hash moved with the new template file.
- [x] Required test green: `scripts/__tests__/verify-registry-install.spec.ts`
      25/25 passed 2026-09-12; with `packages/create-threenative/__tests__/scaffold.spec.ts` the pair is 86/86.
- [x] Observed red recorded, then restored green
      Four new spec cases fail closed: no assertions, removed scenario, false assertions (playtest throws), edit absent from the build.
- [x] User verification performed on the named platform
      Real browser WebGPU run of the new scenario against a fresh local-tarball scaffold on a fresh generated starter (NVIDIA Turing, rule `sustained-frames`): exit 0, pass true, 943 frames, movement 5.49; `forward`/`restart` siblings pass on the same scaffold. A public-registry cohort install still waits on PRD-196 (PARTIAL).
- [x] Evidence record written: `docs/verification/prd-366-readiness-phase-1-2026-09-12.md`
- [x] Independent reviewer returned PASS
      Three fresh-eyes reviews. The first found two blocking defects (a comment marker Vite strips; a serverless playtest) and three doc issues, all fixed. The second verified those and found the missing `--headed`, fixed and confirmed by a real hardware run. The third verified the invocation, scenario and hash as sound and required only the test-count/status corrections applied here.

**Files (maximum five):**

- EDIT `scripts/verify-registry-install.ts` — run candidate template gameplay after game-only edit.
- EDIT `scripts/__tests__/verify-registry-install.spec.ts` — non-vacuous external consumer assertions.
- NEW `packages/create-threenative/templates/starter/playtests/production-readiness.playtest.json` — observable real starter sequence.
- EDIT `scripts/verify-template-playtests.ts` — verified, no change required: `scenarioFiles` already discovers every `*.playtest.json`, so the new scenario is included without an edit.
- NEW `docs/verification/prd-366-readiness-phase-1-<date>.md` — commands, identities, red/green and reviewer decision.

**Implementation and wiring:** Scaffold from the exact candidate, install without workspace protocols, edit a game-owned movement/UI value, build and run actual browser gameplay against the built output. Verify input changes position, HUD action changes state, asset/physics/audio observation exists and scene can restart. Register using the existing playtest glob. Add one export/asset compatibility audit from existing capability/conformance inventory; do not infer that arbitrary Three.js/browser plugins work natively.

**Required test:** `scripts/__tests__/verify-registry-install.spec.ts`: should reject a consumer result when its real gameplay assertions are absent or false; production-readiness.playtest.json must exercise actual state transitions with nonzero assertions.

**Observed-red / revert control:** Change the expected player displacement/HUD state to a false value and remove the playtest bridge separately. The real installed runner exits nonzero; removing the scenario must also fail required coverage.

**Verification commands** (from repository root unless noted; proposed flags are explicitly identified):

```sh
pnpm exec vitest run scripts/__tests__/verify-registry-install.spec.ts
pnpm tsx scripts/verify-registry-install.ts
pnpm test:templates
```

**User verification:** Play the edited starter from a deployed production build at site root and a subpath. Inspect missing asset URLs, WebGPU adapter and WebGL2 fallback separately; a generated manifest is not an offline/PWA claim.

### Phase 2 — The same distributed game plays on desktop and Android

**Progress:**

- [x] Callers wired and building: `packages/runtime-native/scripts/verify-starter-consumer.mjs`, `packages/create-threenative/templates/starter/package.json`, `scripts/verify-registry-install.ts` (+2 more)
      Corrected 2026-09-15 (review B2/B3): this box previously named `.github/workflows/native-platforms.yml` and `packages/runtime-native/tests/starter-desktop.test.mjs` as wired callers. **Neither is edited by this PR** — `git diff --stat <merge-base>..HEAD -- .github/` is empty and the workflow carries no `--consumer` flag. What actually ships: `verify-starter-desktop.mjs` became a 31-line router that spawns either the new `verify-starter-desktop-base.mjs` (PRD-365's behaviour, moved byte-for-byte) or the new `verify-starter-consumer.mjs` (this phase's `verifyStarterConsumerGameplay` and row contract); the consumer run is invoked by the **starter template's own `test:native` script**, which both the workflow's `starter-linux` and `desktop` matrix jobs already run unchanged; and `readConsumerTargetRows`/`consumerTargets` were added to `scripts/verify-registry-install.ts`.
- [x] Required test green: `packages/runtime-native/tests/starter-consumer-gameplay.test.mjs` and `tests/starter-consumer-qualification.test.mjs`
      Corrected 2026-09-15 (review B1): this box previously cited `tests/starter-desktop.test.mjs` at 31/31. That file is **unchanged by this PR** and contains no PRD-366 work (`grep -c PRD-366` = 0); the 31/31 count does not reproduce. Re-measured at HEAD on this machine, per file, with the package's own config: `starter-desktop.test.mjs` **25 passed** (24 pre-existing + one new control for the merge hazard below), `starter-consumer-gameplay.test.mjs` **12 passed** (it holds both PRD-named rows), `starter-consumer-qualification.test.mjs` **50 passed**, the three together **87 passed**. Also `scripts/__tests__/verify-registry-install.spec.ts` **25 passed** and `packages/create-threenative/__tests__/scaffold.spec.ts` **61 passed**.
- [x] Observed red recorded, then restored green
      Re-measured at HEAD. The B4 repair below was written red first: 6 failed / 43 passed with the exploit report accepted, then 50 passed once the ids are parsed, stored and compared. The merge-hazard control was red first: 1 failed / 24 passed, then 25 passed. Negative controls still fail distinctly by cause: substituted native-smoke subject `SCENARIO_MISMATCH`, stale build `ARTIFACT_MISMATCH`, deleted asset/UI `NO_ASSERTIONS`, injected false state assertion `ASSERTION_FAILED`, missing target `ROW_MISSING`, undeclared assertion `ASSERTION_FAMILY_MISSING`, divergent target evidence `ASSERTION_SET_MISMATCH`, pre-ids row `ROW_OUTDATED`.
- [x] User verification performed on the named platform
      **Three real rows, all executed here, all `pass: true` with 5 assertions and 0 failures: Linux x64 desktop, Android on a physical Pixel 8 (arm64-v8a), and Android on an emulator (x86_64) — and the desktop row independently reproduces on a second machine:** CI job `104662689257` produced `5 assertions, artifact 648ca9ff2bef` on a GitHub runner, different hardware and a different artifact hash for the same scenario and assertions, which is stronger proof than any local row alone. The recorded "environmentally blocked (host GBM)" and "`fetch failed`, no APK exists" notes are both superseded. The candidate's own desktop host was built in this worktree (`mystral` `3bd25e2dabe163fb…`, 405/405) because the primary checkout's Sep-9 binary predates `e36887a05`; the starter was scaffolded from the 11 packed candidate tarballs, installed, and the generated game's own `test:native` — the exact command CI's `starter-linux` job runs — exited 0 (`300 frames, 21696 colors, 331 asset pixels`, then `consumer gameplay qualified on desktop: 5 assertions, artifact b0f7d4e28e11`). Android needed the packager's documented `THREENATIVE_RUNTIME_SOURCE=… --allow-source-build` hatch plus the `-PthreenativeJsEngine=quickjs` rollback (`v8-android` has no usable payload and falls through to a ~3.5 h Chromium compile); `BUILD SUCCESSFUL in 2m 34s` produced a 47.6 MB APK, 16 KB-page clean on both ABIs, which qualified on the **physical Pixel 8** (`arm64-v8a`, `17 (API 37)`, `session: android-device`, charging, 74%, thermal 0) and on **`emulator-5556`** (`x86_64`, `15 (API 35)`, `session: android-emulator`). Every row carries the **same** `scenarioHash` `4edb52f1fb8d6ded…`, the same `applicationId` `com.threenative.starternative` and — after the B4 repair — the **same five assertion ids** `diagnostics, movement.axisDelta, resource.state.entityCount.atSteps, resource.state.score.atSteps, visibility.player`, with different artifact hashes per target. That equality is now machine-checked, not asserted: perturbing one id on the real rows raises `ASSERTION_SET_MISMATCH`. Observations: score 1→0 and entityCount 3→4 across restart, 0 console errors with `runtimeReady`, `-z` movement delta 3.99997 (≥ 0.5), player visibility 3699.6 projected px (≥ 20). **Not covered by this box:** macOS, Windows and iOS, which are CI-owned by owner decision and run the same `test:native` on the hosted matrix; and PRD-365 release containers (these rows are the `dist-native` artifact, not a relocated container). **The physical claim is stated as: arm64-v8a is proven across four runs, with a named unexplained prior failure.** The first Pixel attempt exited 1 with `assertions: 0`; I misattributed that to an API-37 diagnostics gap, when it is `failureReport()`'s generic pre-assertion abort (`packages/playtest/src/runner/shared.ts:119-130`) — physical arm64 failed *before* gameplay. The device was then cold-launched four consecutive times: **4/4 pass**. That does not retire the failure, for a reason that must be disclosed rather than footnoted: between the two observations **the lane coordinator plugged the device into AC and set `stay_on_while_plugged_in=15` at the owner's request** — a deliberate operator intervention on the machine under test, not a variable that drifted. The failing run was at 15% discharging with no stay-awake; all four passes at 74-82% on AC held awake, and the failing condition was not re-created. A run that aborted on the very target being claimed is evidence of something even while unexplained, so it **survives as a phase-3 observation**: *physical arm64 aborted before assertions once; cause unisolated, did not reproduce across four subsequent runs under changed and partly intervened-upon device state.* Phase 3 also carries whether the row should retain `diagnostics[0]` so such an abort names itself.
- [x] Evidence record written: `docs/verification/prd-366-readiness-phase-2-2026-09-15.md`
- [x] Independent reviewer returned PASS
      **PASS** (independent fresh-eyes review of `9a30102d5b21b01d5bd37b94e5557edf5e3b59a5`, 2026-09-15). The reviewer re-ran this work rather than reading it: it reproduced every test count independently (`starter-desktop` 25, `starter-consumer-gameplay` 12, `starter-consumer-qualification` 50, together 87; registry 25; scaffold 61) and re-ran the B4 exploits against the shipped code — `totally-made-up` raises `ASSERTION_FAMILY_MISSING`, an empty assert block raises `NO_ASSERTIONS … declares no recognised assertion family` (it called the vacuous-declaration hole "genuinely closed"), dropping 1 of 4 declared families fails by name, and an honest 5-assertion run still exits 0, so the check does not simply refuse everything. The `--container ""` merge hazard was confirmed fixed in the base file. Target-keying was confirmed as correctly non-blocking because both Android rows are carried in the evidence with the limitation named. On the hardware wording it was explicit that the phrasing here is **"not too hedged"** and is narrower and more useful than its own suggested "proven once": it distinguishes what is proven (arm64-v8a 4/4 under charged-and-awake conditions) from what is open (behaviour under power pressure), and it agreed that 4/4 cannot retire the prior failure while no run was taken in the state that failed. Retaining `diagnostics[0]` was endorsed as the right phase-3 fix. Earlier verdicts on this phase — NEEDS CORRECTION on the C1 scenario policy, then on B1-B4 and the causal paragraph — are superseded; every finding from them is fixed and recorded in the evidence. Findings raised as non-blocking and addressed after this review: the cross-target gate is now wired and tested (it previously could not fire), and `ROW_OUTDATED` no longer prescribes a remedy that cannot work.

**Native consumer repair (2026-09-15):** the distributed rows CI still failed for two real causes are fixed in this branch. The shared scenario no longer restarts through the WebView menu (`Tab`/`Tab`/`Enter`, which native's pointer-only overlay injection cannot deliver and which the unreachable Linux overlay never receives); it presses the game's own portable `restart: { keys: ["KeyR"] }` binding and samples `restarted` after a 120-tick wait, so `score`/`entityCount` are read after `Play.enter` restores them. `desktopConsoleType` no longer counts hosted-host ALSA/AT-SPI platform-library lines (`ALSA lib`, `[Audio] … ALSA`, `dbind-WARNING`) as the game's console errors, keeping every line observable and leaving `noConsoleErrors`/`runtimeDiagnostics`/`runtimeReady` intact. Executed here: `desktop-playtest.spec.ts` red **3 failed → 28 passed**. The other counts this paragraph carried were stale and are superseded by the re-measured set in the progress boxes above (`starter-desktop` 25, `starter-consumer-gameplay` 12, `starter-consumer-qualification` 50, together 87; `scaffold.spec.ts` 61 at starter hash `f9b0ac87…`, recomputed after the develop merge). The claim that no local desktop consumer row was run and that CI would be its first execution is **superseded**: desktop, physical Pixel 8 and emulator rows all executed locally, recorded in the user-verification box.

**Files (maximum five):**

- EDIT `.github/workflows/native-platforms.yml` — consume final containers and Android artifacts.
- EDIT `packages/runtime-native/scripts/verify-starter-desktop.mjs` — invoke same consumer gameplay scenario.
- EDIT `packages/runtime-native/tests/starter-desktop.test.mjs` — artifact identity and false assertion controls.
- EDIT `scripts/verify-registry-install.ts` — record per-target consumer results.
- NEW `docs/verification/prd-366-readiness-phase-2-<date>.md` — commands, identities, red/green and reviewer decision.
- Repair: EDIT `packages/create-threenative/templates/starter/playtests/production-readiness.playtest.json`, `packages/playtest/src/runner/desktop.ts`, `packages/playtest/__tests__/desktop-playtest.spec.ts`, `packages/create-threenative/__tests__/scaffold.spec.ts`.

**Implementation and wiring:** Use exact artifacts from PRD-212/365 and exact public candidate inputs from PRD-262/060. Run keyboard/mouse/gamepad where supported and Android touch; test menu action, movement, physics collision, audio event, scene restart, missing asset refusal and offline launch after packaging. Add real scenario coverage through the same installed playtest runner; no hardcoded pass strings. Record actual OS/architecture/session and fail if any required row is absent.

**Required test:** `packages/runtime-native/tests/starter-desktop.test.mjs`: should reject target qualification when the artifact hash/application ID differs from the built consumer; should reject a missing required gameplay row.

**Observed-red / revert control:** Substitute a native-smoke artifact or stale starter build, delete one asset/UI folder and inject a false state assertion; each must fail the target gate for its real cause.

**Verification commands** (from repository root unless noted; proposed flags are explicitly identified):

```sh
pnpm --filter @threenative/runtime-native exec vitest run --config vitest.config.ts tests/starter-desktop.test.mjs
# On each installed desktop game host; substitute actual executable path:
pnpm exec threenative-playtest playtests/production-readiness.playtest.json --target desktop --executable <game-executable>
# On the Android consumer/device lane:
pnpm exec threenative-playtest playtests/production-readiness.playtest.json --target android --device <serial>
```

**User verification:** Play the actual distributed game on Windows, macOS, supported Linux sessions and Android emulator. Background/resume and close/reopen it; inspect save persistence on the action-rpg subject where the starter has no save system.

### Phase 3 — Physical Android and release limitations are measured honestly

**Progress:**

- [x] The clean room carries the physical-mobile identity: `scripts/verify-registry-install.ts`
      records it in the cohort result. proof: `pnpm exec vitest run
      scripts/__tests__/verify-registry-install.spec.ts` — **29 passed** exit 0 (2026-09-27). —
      VERIFIED LOCALLY: `IRegistryInstallReport.consumerTargets` keeps its public **array** shape; the composite
      key (`target session architecture osVersion`) is internal, so one target's physical arm
      (`android-device arm64-v8a 17 (API 37)`) and emulator arm (`android-emulator x86_64 15
      (API 35)`) both survive with their own `artifactHash` and a caller reads each row's own
      `session`/`architecture`. The key separates physical from emulator; it is **not** a device
      identity, so two phones reporting the same values still share one row. A zero-assertion arm
      carries the run's own `diagnostics[0]` (`code: message`) read back from
      `artifacts/native/consumer-<target>.stdout.json`, or an explicit
      `TN_REGISTRY_INSTALL_CONSUMER_DIAGNOSTIC_MISSING` naming the file that holds none. **Found
      while landing it: a row with `pass: false` did not fail anything** — the native step read the
      rows and reported `exitCode 0`. The step now fails closed on a failed row
      (`TN_REGISTRY_INSTALL_CONSUMER_TARGET_FAILED`) *after* the row is recorded, so the returned
      report keeps `diagnostics[0]` and the step detail repeats it. The same code now also fires on
      a row that evaluated **zero** assertions whatever `pass` claims, because an empty assertion
      set is a failure and a row that asserted nothing proved nothing: that row read `exitCode 0`
      before the clause, red 1 failed / 28 passed, 29/29 after, with the row and its
      `diagnostics[0]` still carried in the returned report. Red 3 failed / 25 passed with
      the guard absent (the failing arm read `exitCode 0`) and against the previous record shape;
      three mutations each red, each restored to 28/28: key → `row.target` 1 failed, diagnostic
      retention disabled 2 failed, fail-closed guard disabled 1 failed. `pnpm exec tsc --noEmit -p
      tsconfig.json` exit 0; `pnpm typecheck` exit 0; `pnpm budgets` exit 0; `pnpm lint` exit 0,
      839 warnings and no new one. **Not claimed here:** any physical execution (the Android row
      below stays blocked), and the row *file* still keeps one
      row per target (`verify-starter-consumer.mjs` replaces a same-target row), so a phone and an
      emulator must be qualified in separate clean rooms for both to be in one cohort result. The
      full `pnpm test` passed after the native test executables were built (492 files,
      6,136 tests passed; 2 files and 8 tests skipped; exit 0). `pnpm check:docs` passed 2,342 links.
- [x] Required test green: `packages/runtime-native/tests/physical-mobile-qualification.test.mjs`.
      proof: `pnpm --filter @threenative/runtime-native exec vitest run --config vitest.config.ts
      tests/physical-mobile-qualification.test.mjs` — 1 file, **30 passed** exit 0 (2026-09-27;
      21 before this pass). Written red first: 9 failed / 20 passed against the pre-change script,
      then green. Each guard is proved by mutation, not by green — removing the installed-APK
      readback, the reported-scenario check, the Android `applicationId` cross-check or the
      Android-only scope of that cross-check reds exactly one control each (1 failed / 29 passed,
      30/30 restored).
- [x] The collector qualifies a **declared consumer** subject and proves the device holds that exact
      artifact. proof: the same command, 30/30, plus `node packages/runtime-native/scripts/qualify-physical-mobile.mjs --help`.
      `qualify-physical-mobile.mjs` takes `--project` / `--scenario` / `--application-id` /
      `--activity` and resolves **one** identity for the launch, the `pidof`, the `gfxinfo`/`meminfo`
      telemetry, the playtest CLI and the device readback. The guards, each red-controlled: an
      **emulator** serial is refused before anything is installed; the **installed** APK is hashed
      with `pm path` + `sha256sum` and must equal the supplied artifact
      (`TN_QUALIFY_ARTIFACT_PROVENANCE_MISMATCH`); a scenario that is absent, names nothing or lies
      outside the declared project blocks by path, and the report's own `scenario` must be the
      declared one (`TN_QUALIFY_SCENARIO_MISMATCH`); missing lifecycle or persisted-state evidence
      and a zero-assertion run still fail closed (`TN_QUALIFY_LIFECYCLE_CONTINUITY`). The pass
      result now carries the resolved `subject` and is written to `qualification-result.json`, not
      only failures. The package-id rules are **Android's only** — iOS is judged on project and
      scenario alone, as before, because an iOS artifact carries a `codesign` bundle id the Android
      lane never reads. `pnpm typecheck` exit 0; `pnpm exec biome check` on both files: no new
      warning. **Root cause found while landing it:** the application id was hardcoded in two places
      that disagreed — the orchestrator launched `com.threenative.game` while the playtest CLI it
      invoked defaulted to `com.mystral.engine`, so a consumer run drove a package the consumer never
      installed. `pnpm lint`, `pnpm budgets` and the full `pnpm test` were not re-run;
      `tests/device-preflight.test.mjs` (25 passed) was, because it imports the same scripts.

**Files (maximum five):**

- EDIT `packages/runtime-native/scripts/qualify-physical-mobile.mjs` — accept declared consumer project/scenario instead of fixed fixture. **done** (this pass).
- EDIT `packages/runtime-native/tests/physical-mobile-qualification.test.mjs` — project/artifact/device identity controls. **done** (this pass, 21 → 30).
- EDIT `scripts/verify-registry-install.ts` — include physical evidence identity in cohort result. **done** (previous commit, first box above).
- EDIT `docs/CURRENT-CHALLENGES.md` — state observed limitations and supported envelope. **not done**: the supported-envelope claim needs the physical run first; the two observed limitations are in the boxes above meanwhile.
- NEW `docs/verification/prd-366-readiness-phase-3-<date>.md` — **superseded**: routine proof belongs in this file (owner R2), so no new evidence document is written.

**Not claimed, and why the physical rows stay blocked (2026-09-27 slice):** nothing here ran on a device, and the
default path is **not** functional. `examples/native-smoke/playtests/physical-mobile-lifecycle.playtest.json`
has never existed — absent from the repository and from every branch's history — so a default
invocation now blocks naming that file instead of failing later inside the runner. No scenario could
fix it: `lifecycleEvents` / `sessionNonce` / `stateContinuity` (with `framesPaused`,
`framesAdvanced`, `surfaceValidAfterResume`, `backgroundGapIntegrated`, `maxFrameIntervalMs`,
`physicsStepDelta`) are read out of `observations.resources.GameState.after`, which no runner
produces. The runner-owned phases and plugin-owned step count below replace those claims without
asking the game to report its own lifecycle. The collector still read the old fields then, which is
why the acceptance boxes stayed open until the v2 slice below proved the implementation half. The
Pixel 8 was not touched for this slice.

**Remaining lifecycle producer slice (2026-09-27; no physical credit):**

- [x] [engine; local] The Android playtest runner drives background, foreground and rotation as
      explicit scenario steps, then reports device-observed lifecycle phases and render/physics
      continuity. Missing observations fail rather than becoming game-authored `GameState` values.
      proof: focused runner red-green test with the real step parser and Android driver boundary.
      **Verified on an emulator with a real orientation change.** `{ "kind": "lifecycle", "lifecycle":
      { "operation": "background" | "foreground" | "rotate", "rotation": 0-3 } }` is a real
      scenario step (`schema-base.ts` / `schema-validate.ts`, with rejection cases), driven through
      `AdbAndroidDriver` as `input keyevent 3` / `am start` / `wm user-rotation lock`, each op
      polling `dumpsys window` until the device reports the effect. The report carries
      `observations.deviceLifecycle` — ordered phases with `pid` (`pidof`), `focused` and
      `windowRotation` (`dumpsys window`) and `frames` (`dumpsys gfxinfo`), plus
      `session.pid` and `render.framesPaused` / `framesAdvanced`. Missing readings fail: no frame
      counter → `TN_PLAYTEST_ANDROID_LIFECYCLE_UNOBSERVED`, a pid that changed →
      `..._SESSION_CHANGED`, an operation the device ignored or a refused rotation →
      `..._NOT_APPLIED`, a lifecycle step on browser/desktop/iOS or on a driver without the
      operations → `TN_PLAYTEST_UNSUPPORTED_ON_TARGET`; none of them reaches the report.
      `physics` is reported as `{ available: false, reason }` when the bridge advertises no
      physics plugin, never as a guessed zero.
      Two things a critic caught on this slice are now fixed rather than argued: `framesPaused` is
      only `true` once the platform's counter has held one value for a full second of settling
      reads (two equal reads are what a backgrounded surface *still drawing at 10 Hz* produces), and
      a `rotate` locks `wm user-rotation` on its own account so `stop()` frees that override without
      resetting size or density. The four `dumpsys` readers stay module-private — they are not a
      requested public API, so their `@situation` tags are gone and `pnpm capabilities:sync` put the
      224 generated manifest/reference lines back to zero, with the lifecycle behaviour unchanged.
      proof: `pnpm exec vitest run packages/playtest/__tests__/android-lifecycle-steps.spec.ts` —
      **10 passed**, and the two regression cases each red exactly one case (2 failed / 8 passed)
      when the pre-fix settle and the missing rotation flag are put back. `pnpm exec vitest run
      packages/playtest` **1237 passed** / 3 skipped, `pnpm typecheck` exit 0, `pnpm lint` exit 0 with
      839 warnings (none in the files this slice owns), `pnpm check:docs` 2342 links, and
      `scripts/check-capability-docs.ts --census`,
      `scripts/generate-capability-reference.ts --check`, `scripts/generate-ctx-surface-table.ts
      --check`, `scripts/detect-capability-duplicates.ts examples --strict` and `pnpm caps:recall`
      all exit 0. **Emulator check:** the external starter lifecycle scenario at
      `/home/joao/.cache/tn-prd366-emulator/prd366-emulator/playtests/physical-mobile-lifecycle.playtest.json`
      passed on `emulator-5554`: 944 game frames, five gameplay assertions, stable pid 4653,
      background `framesPaused: true`, foreground frames 24 → 27, and
      `render.framesAdvanced: true`. A requested rotation of 1 was reported as 1, but the
      foreground was already at 1, so this does **not** prove an orientation change. A separate
      run requested rotation 3 from foreground rotation 1 and failed closed with
      `TN_PLAYTEST_ANDROID_LIFECYCLE_NOT_APPLIED` because `dumpsys window` remained at 1.
      No physical collector wiring or physical run occurred for this slice; that is the blocked row.
      **Physics counter producer and reader (2026-09-27; emulator-verified, no physical credit —
      the device row stays blocked):** `packages/physics/src/plugin.ts`
      counts `simulation.step` calls in a monotone `physicsSteps` incremented only after the call
      returns, and reports it on the observation contribution it already registered for
      `runtime.physics` — the same path as `physicsDebugSeries`, on every sample rather than only a
      debug-series request, so a lifecycle phase can read it without asking for the series. Nothing
      game-authored, and no new capability, dependency or transport operation. The runner reads it
      through the ordinary sample request at three named points — immediately before `background`,
      the moment `foreground` returns and **before** its own advance, and once after that advance —
      and never while the app is backgrounded, because a backgrounded host is asleep and a sample
      there reads as a hung bridge rather than a value. It reports
      `physics.steps.{beforeBackground,afterForeground,afterAdvance}` with `stepsPaused` and
      `stepsAdvanced`; a read the scenario never reached is `null`, and a bridge that advertises
      `runtime.physics` and answers with no count, a string or a negative number fails closed as
      `TN_PLAYTEST_ANDROID_LIFECYCLE_PHYSICS_UNOBSERVED` instead of becoming a zero. A build with no
      physics plugin reports `{ available: false, reason }` naming `runtime.physics`.
      proof: `pnpm exec vitest run packages/physics/__tests__/playtest-capability.spec.ts
      packages/playtest/__tests__/android-lifecycle-steps.spec.ts` — **18 passed**; red first at
      1 physics + 3 runner cases, and the fake bridge's `clock.tick` moves on every sample while its
      `physicsSteps` moves only on `advance`, so a tick counted as a step fails the run. `pnpm exec
      vitest run packages/playtest packages/physics packages/core` **3236 passed** / 3 skipped,
      `pnpm typecheck` exit 0, `pnpm lint` exit 0 (839 warnings, none in these files, unchanged from
      the pre-change baseline), `pnpm budgets` exit 0 (census drift unchanged at 2 pre-existing
      lines), `pnpm check:docs` 2342 links, `scripts/check-capability-docs.ts --census`,
      `scripts/generate-capability-reference.ts --check` and
      `scripts/detect-capability-duplicates.ts examples --strict` all exit 0.
      **Real emulator proof:** a source-built APK with the changed physics package
      (SHA-256 `dd9485642750e85e0cefdf965ba49e762643e24998f9ac9bd882944076e3426f`)
      passed the external starter lifecycle scenario on `emulator-5554`: 944 game frames, five
      gameplay assertions, pid 4585 unchanged, render paused/resumed, physics steps 1021 before
      background = 1021 after foreground before advance, then 1023 after the foreground and
      rotation advances. Rotation 1 was already active, so an actual orientation change is still
      unproven on the default landscape config. A second source-built APK with
      `display.orientation: "sensor"` (SHA-256
      `24dbcbd47860d9e833a234bb3658414aca9445ed7c85cd520c4e12987836afc0`) passed the
      same 944-frame scenario with five gameplay assertions and a real window rotation 1 → 3,
      pid 3205 unchanged, render paused/advanced and physics steps 1021 → 1021 → 1023. This
      closes the runner's local rotation proof; the release consumer's default landscape
      behavior and physical cohort are separate open claims. No Pixel 8 use or physical
      performance credit. **Prebuilt consumer blocker:** the same project rebuilt against its installed
      `@threenative/runtime-native@0.3.3` prebuilt produced APK SHA-256
      `aa75e0ffdb274e842b6ebc239e00ce08fafe3647f1dce11e7887f9f0d572b1dd` and crashed
      at activity startup with `UnsatisfiedLinkError` for
      `TnUiOverlay.nativeUiCompositePath(String)`. Building with
      `THREENATIVE_RUNTIME_SOURCE=.../packages/runtime-native --allow-source-build` resolved the
      Java/native mismatch. The published prebuilt cannot be credited as the installed consumer
      cohort until its native library matches the Java wrapper.
- [x] [engine; local] The physical collector consumes those runner-owned observations, binds them
      to the exact scenario and installed APK already checked above, and rejects absent or
      inconsistent continuity. proof: `pnpm --filter @threenative/runtime-native exec vitest run
      --config vitest.config.ts tests/physical-mobile-qualification.test.mjs` — **32 passed** at
      2026-09-28, eleven of them corrupting the written document (a surface that never stopped, a
      summary denying its own frame counts, a simulation that stepped while away, a rotation never
      turned to, a mid-run pid, and so on), each refused against its own named field; plus the
      runner's real Android emulator lifecycle scenario in the box above (`emulator-5554`, 944
      frames, rotation 1 → 3, one pid, physics 1021 → 1021 → 1023). **Split 2026-09-28 under "one
      box, one claim": the device half is not this box and is not proven.** The collector refuses
      an emulator identity at three sites (`TN_QUALIFY_PHYSICAL_DEVICE_REQUIRED`,
      `qualify-physical-mobile.mjs:255`, `:551`, `:752`), so no collector-produced evidence document
      has ever come from a real run; that device run is a `## Blocked on` item. An emulator pass
      grants no physical performance credit.
      **Landed and unit-proven; the device run is blocked** (the
      evidence document itself is written and re-validates as of 2026-09-28, below).
      `evaluateLifecycleObservation` reads `observations.deviceLifecycle` and nothing
      else: `observations.resources.GameState` is no longer read, so a game can no longer certify its
      own resume. It requires the ordered phases (`background` → `foreground` → `rotate`, then
      foreground resumes) with `at` and `frames` nondecreasing across them, one pid across every
      phase that is the pid the collector launched, unfocused only while away, a rotation that
      actually turned — `windowRotation` equal to `requestedRotation` **and** different from the
      previous phase's, so the "requested rotation 1 while the window was already at 1" run above is
      a named rejection instead of a pass — and the continuity of the counters, re-derived from the
      phases' own readings rather than trusted: `phases[0].framesPaused` must be `true` and
      the backgrounded reading itself, rather than the `render` summary, proves the surface stopped;
      the last phase's count must advance
      past it, and `render.framesPaused` / `framesAdvanced` and `physics.stepsPaused` /
      `stepsAdvanced` must agree with those counts rather than contradict them. The 300-frame floor
      is read off the device's own counter. Absent, malformed, reordered, nonmonotone and false
      data each fail with a diagnostic naming the field, under `TN_QUALIFY_LIFECYCLE_CONTINUITY`;
      the installed-APK SHA, the reported-scenario identity check and the telemetry / prerequisite /
      signing / device guards still run ahead of it, unchanged.
      **The gap, closed by a v2 form the device can fill (2026-09-28):** the run used to stop at
      `TN_QUALIFY_LIFECYCLE_EVIDENCE_UNREPRESENTABLE` and write no document, because
      `physicalDeviceEvidenceV1` (PRD-056's `physical-device-evidence.mjs`) wants exactly four
      lifecycle rows, each carrying a wall-clock `at`, a `sessionNonce` and a `physicsStepCount`
      read *during* that phase, while a report carries phase offsets from the run's own clock, no
      session nonce, and three step reads around the away period, none of them keyed to a phase.
      The collector now writes `physicalDeviceEvidenceV2` — same document, `schemaVersion: 2` —
      whose `lifecycle` is `{ clock: "run-relative-ms", operations[], framesPaused, framesAdvanced,
      physics: { steps, stepsPaused, stepsAdvanced } }`. One `operations` row per device-read
      operation, carrying only that reading: `operation`, `offsetMs`, `frames`, `focused`, `pid`,
      `framesPaused` on the backgrounded reading, and `windowRotation` / `requestedRotation` on the
      rotation. Nothing is attributed to a phase that did not produce it: no fourth phase, no
      wall-clock phase time, no per-phase step count, no `sessionNonce` (the session claim is the
      one pid every reading and `execution` share). `execution.readyAt`, `firstFrameAt` and
      `frame300At` are `null` — the run measures none of them, and the v2 validator refuses a
      string in any of them rather than let the scenario's start read as a measurement. What v1
      asserted as standalone booleans with no measured field behind them
      (`sameSession`, `surfaceValidAfterResume`, `stateContinuity`, `backgroundGapIntegrated`, and
      `physicsStepDelta`, which is a count rather than a delta) is not restated: v2 re-derives each
      claim from the readings and refuses a document that denies them, so `framesPaused` must equal
      the backgrounded reading's own `framesPaused`, `framesAdvanced` must equal what the readings'
      frame counts show, and the three step counts must actually bracket the away period.
      `validatePhysicalDeviceEvidence` dispatches on `schemaVersion`, so the v1 validator, its
      fixture and `--validate-fixture` and the rollup all still read v1 unchanged and reject a v2
      document; no collector logic was re-implemented — `evaluateLifecycleObservation` still gates
      the observation before any document is built, and the v2 validator is an independent reader of
      the same numbers rather than an import of it (no cycle). The lifecycle claim is now
      unit-proven end to end, which is why its device half stays blocked: **no device ran this v2
      slice** — the collector refuses an emulator identity, so no collector-produced document has
      come from a real run.
      proof: `pnpm exec vitest run --config vitest.config.ts
      tests/physical-mobile-qualification.test.mjs` from `packages/runtime-native` — **32 passed**
      (was 31): the declared-consumer run now reaches `TN_QUALIFY_PHYSICAL_PASS` and the report it
      writes re-validates as v2; `buildProductionEvidence` returns a v2 document whose operations
      are exactly the four measured offsets, frame counts and pids, whose `physics.steps` are the
      three measured reads, and whose unmeasured timings are `null`; a three-operation observation
      validates with three rows and no fourth invented; and eleven controls corrupt that written
      document — a surface that never stopped, a summary denying its own frame counts, a
      backgrounded reading denying its pause, a simulation that stepped while away, `stepsPaused:
      false`, a non-advance offset, a mid-run pid, a rotation never turned to, a first-frame time
      copied from the run's start, `clock: "utc"`, and a v1 `sameSession` — each is refused and each
      is checked against its own named field. Mutation-checked: disabling the `clock`, the
      unmeasured-timings, the derived-`framesAdvanced`, the step-count and the per-operation pid /
      rotation / `framesPaused` checks each reds a specific control, so those rows execute.
      `pnpm exec biome check` on the three files reports no error; warnings are 3 complexity in
      `physical-device-evidence.mjs` (its v1 lifecycle, its new v2 lifecycle and the v2 body) and
      the 12 pre-existing complexity plus 2 pre-existing `noDelete` in the collector, and the test
      file its 1 pre-existing `noDelete` — the rule is warn-level, and `pnpm lint` exits 0.
      `pnpm typecheck` exits 0. The repository-wide `pnpm test` from the previous pass (runtime-native
      1454 passed / 59 skipped, repository vitest 6150 passed / 8 skipped) was **not** re-run for this
      slice: the only test files that import `physical-device-evidence.mjs` or
      `qualify-physical-mobile.mjs` are `physical-mobile-qualification.test.mjs` and
      `device-preflight.test.mjs`, and both pass (**57 passed**). No collector-produced physical
      evidence was run or claimed.

**Carried in from phase 2 (2026-09-15), both with concrete evidence rather than theory:**

1. **Consumer rows are keyed by `target` alone**, so a physical-device run overwrites an emulator run
   in `consumer-targets.json`. Observed here: the Pixel 8 row replaced the `emulator-5556` row, and
   both survive only because phase 2's evidence document writes them out by hand. A target reachable
   by more than one device needs the device identity in the key. — Partly closed above: the clean
   room's cohort result now keeps one row per arm, keyed internally by target **and** what the run
   named (session, architecture, OS version), so two clean rooms contributing one arm each no longer
   overwrite each other and one target's phone and emulator both appear. That is a
   physical-versus-emulator distinction, not a device identity, and the row *file* is unchanged
   (one row per target, written by `verify-starter-consumer.mjs`), so two devices of one target still
   need two clean rooms.
2. **One physical arm64 run aborted before assertions** and its cause was never isolated; the row
   retained only `failureReport()`'s generic pre-assertion shape, not the `diagnostics[0]` that named
   the real cause. Retaining that entry on the row is the prerequisite for diagnosing a repeat. —
   Closed on the clean-room side: a zero-assertion row in the cohort result now names the run's own
   `diagnostics[0]`, and a failed row now fails the cohort instead of reporting `exitCode 0`. The
   verifier's own row file still stores only `failureReport()`'s shape; the cause is preserved in the
   cohort result and in the `consumer-<target>.stdout.json` beside it. The physical repeat is not
   claimed — the Android box below is still open.

**Published 0.3.3 `next` cohort per-target verification — 2026-09-25** (Linux host, Node v20.19.6,
npm 11.18.0, pnpm 10.25.0, NVIDIA RTX 2080 / Vulkan 1.4.351; full commands and hashes in
`docs/verification/prd-366-readiness-phase-3-2026-09-25.md`):

- [x] **Browser / web, Linux** — scaffolded `create-threenative@next` 0.2.6, installed the 0.3.3 cohort
      (lockfile names `@threenative/{core,physics,ui,playtest,assets,runtime-native}@0.3.3`, zero
      `file:`/`link:` specifiers), `pnpm build:web`, then the installed `threenative-playtest` on
      `playtests/production-readiness.playtest.json --browser-recipe webgpu --headed`: `pass: true`,
      **5 assertions / 0 failures** (`diagnostics`, `movement.axisDelta`,
      `resource.state.entityCount.atSteps`, `resource.state.score.atSteps`, `visibility.player`),
      941 frames, exit 0.
- [x] **Linux x64 desktop** — `pnpm build:desktop` produced `dist-native/my-game` (142,629,115 B) from
      the downloaded prebuilt runtime. 300-frame gate: `300 frames, 22504 colors, 335 asset pixels,
      overlayAttached true`. Consumer row: **5 assertions / 0 failures**, artifact
      `85a8202802e0a49f…`, app `com.threenative.mygame`, `linux/x64`, `session wayland`,
      `scenarioHash 4edb52f1fb8d6ded2159a4d39cb35b48089db917edbe79d3b52109edbf3146ed` — the same
      scenario hash and the same five assertion ids phase 2 recorded.

#### Blocked on — the rows this lane cannot run

R3 (owner, 2026-09-25): hardware, credentials, other people and owner calls are not boxes. The four
rows below name a Windows host, a macOS host, a physical Android device and a registry republish, so
they are dependencies rather than work, and each is listed in one line under `## Blocked on` at the
end of this file. Their evidence stays here. The browser and Linux x64 rows above them are ticked
and executed.

- **Windows desktop** — CI-owned by owner decision: job `native-platforms / Windows desktop core`
  in `.github/workflows/native-platforms.yml` completed **success** on
  [run 36175962979](https://github.com/ThreeNativeHQ/threenative/actions/runs/36175962979)
  (`workflow_dispatch`, `develop`, 2026-09-25). It builds local tarballs, so it proves the source
  tree rather than the published cohort, and no Windows host exists on this lane to run the
  registry install.
- **macOS desktop** — CI-owned: job `native-platforms / macOS desktop core` completed **success**
  on the same run, with the same source-vs-registry limitation.
- **Android** — owner authorized the Pixel 8 on 2026-09-27; the physical run remains open until
  the phone is unplugged and the lifecycle observation channel produces real evidence. The published
  cohort carries `@threenative/runtime-native@0.3.3` for `android-arm64-v8a` / `android-x86_64`;
  no device row was run in this lane, and the emulator row below is a **source-override diagnostic,
  not a published-cohort pass**, so this row stays open on both counts.
  **Emulator diagnostic 2026-09-27 (source override).** `node scripts/download-deps.mjs --android`
  in this worktree reported `v8-android: OK` (recipe 6, V8 11.0.226.16, `libv8android.so` +
  `libc++_shared.so` + a per-ABI `snapshot_blob.bin` for `arm64-v8a` and `x86_64`, all 16 KB
  aligned), and a debug-signed consumer APK for the same 0.3.3-cohort game was built with
  `THREENATIVE_RUNTIME_SOURCE=<worktree>/packages/runtime-native`,
  `pnpm exec threenative build --target android --allow-source-build`, JDK 17,
  `ANDROID_HOME=/home/joao/Android/Sdk`, `TMPDIR=/home/joao/.cache/tn-tmp`: `BUILD SUCCESSFUL in
  48s`, 8 native libraries 16 KB clean on both ABIs, 107,071,692 B, sha256
  `e723735513ae1b1975b5768facc7e5cf91c1299f59866dbde7377b27e6fcb664`, `aapt dump badging`
  applicationId `com.threenative.prd366emulator` (debug key, `META-INF/ANDROIDD.RSA`). The
  installed consumer runner `node node_modules/@threenative/runtime-native/scripts/
  verify-starter-consumer.mjs --consumer --target android --device emulator-5554 --project .`
  installed it (`adb -s emulator-5554 install -r --no-streaming`, `base.apk` hashing to the same
  sha256 before and after gameplay) and ran the real
  `playtests/production-readiness.playtest.json` on `emulator-5554` — `x86_64`, `15 (API 35)`,
  `session: android-emulator` — exit 0, twice, 2/2 with the same result: **`pass: true`, 5
  assertions / 0 failures**, the same
  `scenarioHash 4edb52f1fb8d6ded…` and the same five assertion ids phase 2 recorded
  (`diagnostics, movement.axisDelta, resource.state.entityCount.atSteps,
  resource.state.score.atSteps, visibility.player`), 941 frames, distance 5.4916,
  `startup.phase ready` under rule `sustained-frames`, 0 console errors, 0 runtime diagnostics,
  `-z` delta 3.99997 (≥ 0.5), 3699.6 projected px (≥ 20), `score` 1→0 and `entityCount` 3→4
  across the `KeyR` restart. **The bridge is present**: the packaged `assets/scripts/main.js`
  carries `__THREENATIVE_PLAYTEST_BRIDGE__`, and the device console reads `[V8] Version:
  11.0.226.16`, `JS engine created: V8`, `Using external startup snapshot (45421 bytes)`.
  **The earlier `TN_PLAYTEST_BRIDGE_MISSING` / 0-assertion failure in the same sandbox is
  explained rather than reproduced:** that APK came from plain `threenative build --target android`
  with no `THREENATIVE_RUNTIME_SOURCE`, and Gradle's Problems-report path proves it compiled the
  **published tarball** `…/node_modules/.pnpm/@threenative+runtime-native@…0.3.3-e5a1dd710cc1.tgz/…`,
  whose `libmystral-runtime.so` carries no device playtest mailbox (the source-built one carries
  `TN_PLAYTEST_MAILBOX_ROOT`, `tn-playtest-request.json`, `tn-playtest-response.json`). So the
  cause was the runtime the packager resolved, not the JS engine; the two intervening QuickJS
  builds were never played. **Not claimed here:** a public-registry install, any physical-device
  credit (`x86_64` emulator reporting the SwiftShader WebGPU adapter, so it is not a performance
  result either), or any native-performance measurement.
- **npm install of the published template** — red on this host and at the root, not yet fixed:
  `npm install` dies at `sharp@0.34.5` (`node install/check.js || npm run build`, then a source
  build) because the template's `@gltf-transform/cli@4.4.2` devDependency drags `sharp ~0.34.5`,
  whose prebuilt does not load on Linux 7.2.6; `sharp@0.35.4` installs and loads clean in
  isolation, and `pnpm install` succeeds only because `pnpm.onlyBuiltDependencies` skips sharp's
  build script. Owner: PRD-196 (`BLOCKED — requires-release-credentials`); a forward fix also
  needs the ten templates to force `sharp >=0.35.4` so it reaches consumers. Forward fix landed
  as **#323**: all ten templates now pin `sharp: ">=0.35.4"` in both npm `overrides` and
  `pnpm.overrides` (contract test + ten re-pinned scaffold hashes; red undefined → 716 passed).
  This row stays open only until a cohort republishes with the fix, since the published 0.3.3
  template still carries the old pins.

**Implementation and wiring:** Extend the existing physical collector with validated project/scenario inputs; retain its required evidence/provenance schema and default native-smoke compatibility. Do not remove PRD-056 prerequisite checks or count iOS as a required target for this non-iOS batch. Use actual signed Android artifact, correct applicationId and arm64 GPU device; record touch, back navigation, suspend/resume, cold restart, saves and telemetry. Measure the unmodified platformer reference against its existing performance budget, with default starter startup/steady-state recorded separately. Raw performance results update runtime-perf-state.md in a separate evidence-only checkpoint if the five-file budget is exhausted.

**Required test:** `packages/runtime-native/tests/physical-mobile-qualification.test.mjs`: should reject consumer qualification when device identity is an emulator or the scenario/project does not match the installed artifact.

**Observed-red / revert control:** Substitute an emulator identity, stale APK hash, absent lifecycle observation and false persisted-state assertion separately; collector rejects each rather than reusing a prior smoke record.

**Verification commands** (from repository root unless noted; proposed flags are explicitly identified):

```sh
pnpm --filter @threenative/runtime-native exec vitest run --config vitest.config.ts tests/physical-mobile-qualification.test.mjs
node packages/runtime-native/scripts/qualify-physical-mobile.mjs --help
```

**User verification:** Run the documented collector invocation on the selected physical phone after capturing its validated options from --help; archive exact expanded command. Measure sustained gameplay and background/resume on the artifact, not on a different installed package. Human inspection of input and performance traces remains required.

## Verification contract

Each phase edits its named pre-existing caller and includes the phase evidence record within the five-file budget. File lists are bounded implementation assignments, not permission for adjacent cleanup. If investigation needs more files, split the phase before implementing; do not silently widen it. Query `engine_search_capabilities` and inspect every hit before any qualifying package/helper work, as the repository requires.

Run the phase command, its observed-red control, restore the implementation and rerun green. Record exact candidate SHA, package versions/integrities, source and artifact hashes, platform/adapter/session, command, exit code, assertion count and artifact paths. A missing observation, skipped test, stale artifact or zero-assertion run is not PASS. Fixtures/local tarballs may prove mechanics; public-consumer acceptance requires registry packages and public runtime downloads with no engine checkout, source override or injected manifest.

For executable changes run `pnpm typecheck && pnpm lint && pnpm test`, `pnpm budgets`, and the affected real playtest/platform lane. Generate mirrors with `pnpm sync:agents` if AGENTS changes. Use platform-specific hosted runs for Windows/macOS, emulators for Android behavior, and physical Android only for claims that require hardware. Name unexecuted targets. A runtime change needs a real playtest scenario in the same implementation, not only the focused tests named below.

After every phase, an independent reviewer receives this PRD, diff, commands and artifacts and returns PASS / NEEDS CORRECTION / BLOCKED. It checks caller integration, negative controls, removed/delegating incumbent paths and the actual consumer outcome. No phase starts on a self-awarded PASS. Visual phases also require human inspection of captures; credentialed signing/submission and external-person checkpoints remain PENDING until executed. Do all authorized preparation before requesting any missing external authorization. This planning request does not authorize publishing packages, uploading to stores or contacting external people.

## Verification evidence

No implementation gate was run by this planning revision. Every new phase is **NOT RUN**. Write each phase to `docs/verification/prd-<id>-readiness-phase-<n>-<date>.md` (the evidence file listed in each phase); use the existing runtime performance ledger for new performance measurements. Fill actual results and non-test `file:line` callers at implementation time; a phase cannot close with placeholders. Acceptance boxes below remain unchecked until all phase checkpoints pass.

## Acceptance criteria

- [x] A normal consumer edit builds and plays from the **published** `@threenative/*@0.3.3` cohort
  in a real browser and on Linux x64 desktop with the same public candidate identity. proof:
  `docs/verification/prd-366-readiness-phase-3-2026-09-25.md` — a project scaffolded with
  `create-threenative@next` 0.2.6 and installed at `@threenative/*@0.3.3` (lockfile with zero
  `file:`/`link:` specifiers) ran `playtests/production-readiness.playtest.json`: browser
  `pass: true`, **5 assertions / 0 failures**, 941 frames; Linux x64 desktop `pass: true`, **5
  assertions / 0 failures**, `artifactHash 85a8202802e0a49f…`, `session wayland`, the same
  `scenarioHash 4edb52f1fb8d6ded…` and the same five assertion ids (2026-09-25). **Split per target
  under "one box, one claim" (2026-09-28):** the Windows, macOS and Android arms of this claim are
  not run; they are the physical-Android and Windows/macOS `## Blocked on` items. The phase-2 rows
  that passed against the candidate's local tarballs are not a published-cohort pass and are not
  counted here.
- [x] HUD state, input, scene restart, in-frame rendering, asset staging and offline native launch
  have nonzero real assertions plus false-value controls **on the desktop and Android-emulator rows
  this lane executed**. proof: the scenario's five assertion ids (`diagnostics`,
  `movement.axisDelta`, `resource.state.entityCount.atSteps`, `resource.state.score.atSteps`,
  `visibility.player`) are set-equal across every row phase 2 and phase 3 record — score 1 → 0 and
  entityCount 3 → 4 across the `KeyR` restart, `-z` delta 3.99997, player 3699.6 projected px, 0
  console errors with `runtimeReady` — now machine-checked by the wired `--qualify-existing
  --target desktop,android` gate rather than compared by hand; the native bundles stage the asset
  manifest beside the bundle and refuse startup rather than fall back to the network, and the
  desktop 300-frame gate reported `22504 colors, 335 asset pixels`; and
  `tests/physical-mobile-qualification.test.mjs` (**32 passed** at 2026-09-28) refuses absent,
  substituted, stale and false evidence by field. **What is not covered by this box:** physics and
  audio behaviour parity on a physical device, which is `docs/CURRENT-CHALLENGES.md` row 4 ("Native
  physics on device — backend proven, device scenarios open"), and the physical-Android arm of the
  same assertion set — both named under `## Blocked on`.
- [x] Unsupported codecs/browser globals/extensions and workload limits are explicitly inventoried;
  no absolute “any game” guarantee is made. proof: `docs/CURRENT-CHALLENGES.md` §8 (added
  2026-09-28) names the observed limitations and the supported envelope — mobile-native refusal of
  KTX2 and Meshopt/Draco (`TN_NATIVE_KTX2_UNSUPPORTED`, `TN_NATIVE_MESH_COMPRESSION_UNSUPPORTED`),
  native audio decoding Ogg Vorbis and RIFF/WAVE only (`audio_context.cpp:911`), the portable-graph
  DOM/WebView and mobile-WASM guards (`TN_NATIVE_WEB_ONLY_UI`, `TN_NATIVE_WASM_ON_MOBILE`), the
  refusal of software adapters and virtual displays as evidence (`TN_CAPTURE_SESSION_ADAPTER_REJECTED`,
  `TN_TRACE_SOFTWARE_ADAPTER`, `TN_TRACE_VIRTUAL_DISPLAY`), and the artifact and workload budgets
  (`TN_BUILD_ARTIFACT_BUDGET_EXCEEDED`) — and an audit of every tracked Markdown file outside
  `docs/PRDs/` found no "any game" claim.

## Blocked on

One line each, naming what unblocks it (R3, owner 2026-09-25). None of these is a code change and
none is reachable from this repository alone.

- **Physical Android evidence from the exact signed artifact on real hardware** (a Pixel 8 session,
  API 37): unblocked when a Pixel 8 is attached or loaned. This is the only unblocker for phase 3's
  collector row and for the Android arm of both acceptance boxes: `qualify-physical-mobile.mjs`
  refuses an emulator identity (`TN_QUALIFY_PHYSICAL_DEVICE_REQUIRED`), so its evidence document has
  only ever been built from fixtures. Emulator rows carry no physical performance credit, so this
  cannot be closed from the emulator lane.
- **A Windows host and a macOS host that can install the published cohort**: unblocked by a machine
  or CI job on those platforms running the registry install. The `native-platforms` Windows and
  macOS core jobs build local tarballs, which proves the source tree rather than the published
  cohort (run 36175962979, 2026-09-25). Evidence:
  `docs/verification/prd-366-readiness-phase-3-2026-09-25.md`.
- **A republished `@threenative/*` cohort**: unblocked by a release, which needs release
  credentials and an owner decision to cut one. The published `0.3.3` template still carries the
  `sharp ~0.34.5` pin that makes `npm install` fail (forward-fixed in #323; it reaches consumers on
  the next publish), and the published `@threenative/runtime-native@0.3.3` prebuilt APK crashes at
  activity startup with `UnsatisfiedLinkError` for `TnUiOverlay.nativeUiCompositePath(String)` until
  its native library matches its Java wrapper. Both are this one unblocker.
- **External developer/player acceptance**: PRD-060. No template, build or unit pass substitutes for
  it, and none of it is reachable from this repository.

## Decisions

- **2026-09-28 (agent) — R3/R6 applied, and the collector box split.** Boxes naming a physical
  device, a Windows host, a macOS host or a registry republish were moved out of the checkbox lists:
  R3 says hardware, credentials and owner calls are not boxes, and they were keeping this PRD at 75%
  while no agent could close them. Phase 3's collector box was split into its proven implementation
  (ticked) and its device run (blocked), because it conjoined two independent claims. The file moved
  to `BLOCKED/requires-physical-device/` under R6, as `PRD-443` and `PRD-445` did on 2026-09-25. No
  ticked box, its proof or its prose was removed, and the platform rows' evidence stays in place.
  Reversible: `git mv` the file back and restore the `- [ ]` brackets.
- **2026-09-25 (owner, R1) — proof inline from today.** Boxes opened from this date
  name their `proof:` on the box. Boxes ticked before this date cite their evidence in the lines
  beside them (command, test name, artifact path, CI run) and are left as they are.
- **2026-09-25 (owner, R2) — ceremony boxes deleted.** "Observed red recorded", "evidence record
  written" and "independent reviewer returned PASS" are PR-body concerns, not PRD work.
- **2026-09-24 (owner) — the PRD-080 (stranger test) half of the external-acceptance box is
  deleted.** PRD-080 was removed; external developer/player acceptance is PRD-060 alone and is now
  listed under *Blocked on*.
