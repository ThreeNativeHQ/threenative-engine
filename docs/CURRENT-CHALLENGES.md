# Current challenges

**One place for everything ThreeNative does not yet do well.** Every limitation the project knows
about lives here, with where it stands and what is being done about it. The README, the
[Charter](architecture/CHARTER.md) and the package docs describe the framework. Nobody has to
reconstruct the honest picture from a dozen scattered caveats.

Nothing here is hidden elsewhere, and nothing elsewhere contradicts it. If you find a limitation
this file does not name, that is a bug in this file. Please
[open an issue](https://github.com/ThreeNativeHQ/threenative/issues).

**Last reviewed:** 2026-11-26.

## At a glance

| # | Challenge | Status | Next step |
| --- | --- | --- | --- |
| 1 | Android and iOS do not run the owned C++ engine | ⚠️ Web and desktop only since 2026-10-15 | No owner yet |
| 2 | Mobile frame rate on physical hardware | ⚠️ One 2026-08 number, taken on the legacy host | Run the `platformer` kit on a Pixel 8 (PRD-366, blocked on hardware) |
| 3 | iOS is not a supported target | ⚠️ Owner decision, 2026-09-23 | PRD-065 stays blocked until an iOS ecosystem exists |
| 4 | Native physics on device | ⚠️ Backend proven, hardware scenarios open | Run the shared conformance suite on a phone |
| 5 | The full CI board is slow | ⚠️ Median 55.3 min, Android emulator job 34 to 44 min | PRD-904 (not started), PRD-550 |
| 6 | No measured agent benefit | ❌ Six-repeat benchmark void, one paired build went against the framework | Execute the sealed benchmark, then measure tokens |
| 7 | The Unreal look is CLOSE, not MATCH | ⚠️ GI judged CLOSE, three kits opt out | PRD-723 (in progress) |
| 8 | Performance evidence rests on two GPUs | ⚠️ RTX 2080 and one Intel laptop, run-to-run spread | Add GPUs and a vanilla arm for the heavy scene |
| 9 | Nobody outside the project has played a game for five minutes | ❌ Protocol written, never run | Run the stranger test |
| 10 | The API is `0.x` | Alpha, deliberately | Freeze after the Charter's §12 criteria are met |
| 11 | The supported envelope is narrower than "any game" | Inventoried below, enforced by failing-closed guards | Keep the inventory true to the guards |

---

## 1. Android and iOS do not run the owned C++ engine

**Where it stands.** The owned C++ engine is the default on web and desktop since 2026-10-15.
Android and iOS still run the legacy host with upstream Three.js
([NATIVE-ENGINE-DECISION](architecture/NATIVE-ENGINE-DECISION.md), amendment of 2026-10-15). The
engine speedups in the README therefore do not apply on phones. Those numbers are desktop and web
only: the R ladder in [`verification/runtime-perf-state.md`](verification/runtime-perf-state.md)
(R5 frame p50 2.80x over legacy on an RTX 2080) and the stress-scene pair in item 8.

**Open qualification.** The PRD-624 plan records that the Android instrumented receipt and pump
qualification, and one host-projection intermittency, are unverified, and it grants no waiver
([PRD-624](PRDs/done/PRD-624-release-the-new-native-engine.md)).

**The plan.** No owner yet. I found no open PRD that ports the engine to Android (unverified: a
search of PRD titles only).

## 2. Mobile frame rate on physical hardware

**Where it stands.** The README states "60 fps sustained on a Pixel 8 (fox platformer)". The source
is one record dated 2026-08-11: 253 windows with zero below 60 fps while played, on the legacy host
([`runtime-perf-state.md:3778`](verification/runtime-perf-state.md)). That record says it "must not
be quoted as an engine comparison". The other phone number is the native smoke scene at 41 fps with
0.19 ms of GPU time on a Pixel 8 (Mali-G715, 2026-09-01, `runtime-perf-state.md:1506`), which places
the cost on the CPU side of the frame.

**What is not measured.** The Charter's reference workload, the unmodified `platformer` kit, has no
phone result in the record. I did not verify whether the fox game is the same content as that kit.
The mobile budget is written against that workload, so the claim stays open. Every number above
predates the 2026-10-15 engine change and the kit rework, and no phone has been measured since.

**Why it stays open.** An emulator fakes the GPU driver, so an emulator frame rate is not a frame
rate. The project keeps the physical-device lane as the only source of a mobile fps claim.
[PRD-366](PRDs/BLOCKED/requires-physical-device/PRD-366-one-consumer-game-proves-supported-platforms.md)
and [PRD-056](PRDs/BLOCKED/requires-physical-device/PRD-056-physical-mobile-qualification.md) wait
in `BLOCKED/requires-physical-device/` for devices and signing credentials.

## 3. iOS is not a supported target

**Where it stands.** iOS evidence comes from a hosted macOS runner against the simulator. The
runtime builds, boots and renders there. That lane is a regression signal, not a support claim.
The owner decided on 2026-09-23 that iOS is not a supported target for the preview, the beta or
1.0. The README platform table says "Simulator only, unsigned. No iOS hardware is qualified yet".
The `ios_only` input of `.github/workflows/native-platforms.yml` runs that lane alone. I did not
read the latest iOS job result (unverified).

**The plan.** [PRD-065](PRDs/BLOCKED/requires-ios-ecossystem/PRD-065-ios-evidence-lane.md) is
blocked on an iOS ecosystem. Adding iOS as a target needs a physical-device lane and a store-shaped
build. The Charter's release ladder still refuses to call a platform ready while its hardware row is
open.

## 4. Native physics on device

**Where it stands.** Physics has two backends behind one API: Rapier WASM on the web, and Rapier
compiled into the native runtime behind a coarse typed-array ABI. Web physics calls Rapier without
JavaScript glue since [#690](https://github.com/ThreeNativeHQ/threenative-engine/pull/690)
(PRD-899). One conformance suite runs the same scenarios against every backend. The open row is
the Charter's release-ladder row 3: those scenarios on physical hardware.

**One rule worth flagging.** Android moved from QuickJS to V8 on 2026-08-16 (PRD-130), so the
original reason for compiling Rapier into the runtime, no WebAssembly on Android, is gone. The
build guard still rejects Rapier WASM on Android V8 (`TN_NATIVE_WASM_ON_MOBILE`,
`packages/runtime-native/AGENTS.md:84`). The remaining reason is per-object call cost. I found no
measurement of it (unverified). It is an open question, not a settled one.

## 5. The full CI board is slow

**Where it stands.** The native platform lane is now a required job of the primary board in
`ci.yml` ([header of `native-platforms.yml`](../.github/workflows/native-platforms.yml)). The last
two standalone runs on `develop` (2026-11-01) passed in about 48 minutes each. The 2026-09-23 run
took 2h35m, so the earlier cost is cut. The latest CI speed record
([`ci-speed/ledger.json`](ci-speed/ledger.json), row 42, 2026-11-18, provisional) reads a full
board median of 55.3 minutes and a longest leg of 45.3 minutes. The Android emulator parity job
takes 34 to 44 minutes and sets the wall-time floor of every full board
([PRD-904](PRDs/CI/PRD-904-android-conformance-runs-in-two-shards-on-one-apk.md)).

**The plan.** PRD-904 (status NOT STARTED) shards the Android conformance run on one APK.
[PRD-550](PRDs/CI/PRD-550-a-change-merges-within-30-minutes.md) sets the goal of a merge in 30
minutes, and [PRD-782](PRDs/CI/PRD-782-a-merge-reaches-npm-as-fast-as-the-work-allows.md) covers
the path from merge to npm. The older red-run analysis stays at
[`verification/native-platforms-red-2026-09-02.md`](verification/native-platforms-red-2026-09-02.md).

## 6. No measured agent benefit

**Where it stands.** The README claims that an agent starts from a kit and "fewer tokens go to
plumbing". No document in the repository measures that claim. Three records exist:

- The six-repeat head-to-head of PRD-005 is **void**. It was specified and wired, and never run
  ([`benchmark/RESULTS-2026-08-02.md`](benchmark/RESULTS-2026-08-02.md): "Model: not run").
- One paired build ran: PRD-137, 2026-08-17, n=1 per arm. The framework arm had 19 friction rows
  against 13 for the control, and +149 authored lines. The visual result stayed unresolved inside
  the instrument's noise floor
  ([`verification/agent-test-fps-2026-08-17.md`](verification/agent-test-fps-2026-08-17.md)).
- A blind judge of the saved round-9 bundle chose a vanilla sample as the closest to the reference
  (`benchmark/rounds/round-9/judge.json` and `reveal.json`).

The paired builds predate the starter kits of the last three months. The weak-model loop of
[PRD-881](PRDs/PRD-881-weak-model-benchmark-loop.md) (status PARTIAL) counts friction rows for a
cheap model, not tokens. A search of the agent-test report and `strategy/METRICS.md` finds no token
count.

**The plan.** Execute the sealed six-repeat benchmark and add a token and cost column to it
([`benchmark/PROTOCOL.md`](benchmark/PROTOCOL.md)). A void is neither a win nor a loss. The
project carries a void before it carries a result it cannot defend. No owner yet for the token
measurement.

## 7. The Unreal look is CLOSE, not MATCH

**Where it stands.** A fresh visual judge rated the sky, foliage and shadow work an improvement
toward Unreal ([#541](https://github.com/ThreeNativeHQ/threenative-engine/pull/541)). It rated
every global-illumination pose **CLOSE** to Unreal, not equal
([#634](https://github.com/ThreeNativeHQ/threenative-engine/pull/634)). The README images show
calibration scenes, not full games. The port order lives in the
[Unreal feature map](PRDs/Unreal/research/unreal-visuals-and-performance-feature-map.md).

**Defaults.** A `WorldEnvironment` with no options starts from the `high` render tier, which turns
metered auto exposure on (`packages/core/src/look/quality.ts:88`). The raw option fallback is
`false` (`packages/core/src/look/world-environment.ts:876`), so a caller that bypasses the tier
gets constant exposure. Three of the 21 kits opt out of the Unreal look by owner request: `action-rpg`,
`shooter` and `rts` use ACES and a fixed exposure
(`packages/create-threenative/__tests__/kit-look-defaults.spec.ts:57`). The phone cost of the
exposure meter is unmeasured
([PRD-571](PRDs/BLOCKED/requires-physical-device/PRD-571-exposure-meters-a-histogram-and-ignores-the-sun.md)).

**The plan.** [PRD-723](PRDs/Unreal/look/PRD-723-every-template-game-looks-like-unreal-on-the-engine-defaults.md)
is in progress. Each kit override leaves the list only after a visual judge returns IMPROVEMENT.

## 8. Performance evidence rests on two GPUs

**Where it stands.** The README stress pair is a same-window result: 96.65 fps with 57 draws for
ThreeNative against 75.32 fps with 1,109 draws for plain Three.js (RTX 2080, 2026-11-11, window
`range-score`, [`stress-loop/ledger.json`](stress-loop/ledger.json)). Two later vanilla windows on the
same day read 65.97 and 84.15 fps, so one vanilla arm moves by about 12 percent either side of
the pair. The only other GPU is an Intel Gen12 laptop (64.3 against 53.5 fps). Phone results are in
items 1 and 2.

**The heavy scene has no vanilla arm.** The realistic `?stress&systems` scene reads 59.17 fps
in the vsync pass and 84.31 fps uncapped after PRD-775 (window `prd-775-ac1`, 2026-11-25). The
ledger holds no plain Three.js row for that scene. It started at 14.49 fps in the PRD-898 baseline
(2026-11-17). The Unreal rows in the ledger come from a different scene, so I make no Unreal
speed comparison.

**The plan.** Keep the paired fair-window method. Add a second desktop GPU and a vanilla arm for
the systems scene before any claim about heavy scenes.

## 9. The stranger test

**Where it stands.** The Charter's fourth success criterion is that one game is played by a
stranger for five minutes, with a transcript. It is the one criterion the team that wrote it cannot
game. The protocol is written
([`product/STRANGER-TEST-PROTOCOL.md`](product/STRANGER-TEST-PROTOCOL.md)). I found no result
record, so the test has not been run.

## 10. The API is `0.x`

**Where it stands.** Packages publish at `0.x` (the cohort is at 0.3.24, released 2026-11-26 in
[#738](https://github.com/ThreeNativeHQ/threenative-engine/pull/738)). The API is still settling.
Breaking changes ship in minor versions and appear in [`../CHANGELOG.md`](../CHANGELOG.md).

**The plan.** The Charter's §12 sets the bar for a stable release: the port reads as Three.js and
does not look worse than the vanilla control, one codebase runs on web, desktop and a physical
phone, the native arm is not slower than the browser arm, and a stranger has played it. Items 2, 4
and 9 hold three of those open. A `1.0` follows those criteria, not a calendar.

## 11. What "portable" does not mean

**Where it stands.** ThreeNative is an alpha general-purpose framework with useful game systems. It
does not promise that every browser library, asset codec, extension, workload or third-party SDK is
portable. The claims this project makes are the games it ran, and **no document claims "any game"**.
The envelope, as the code enforces it today:

- **Targets.** Web (WebGPU, with a WebGL2 path where the render path allows it) and desktop
  (Linux, Windows, macOS) run the owned C++ engine. Android `arm64-v8a` and `x86_64` run the legacy
  host (item 1). iOS is not a supported target (item 3). None of this is a store-readiness claim:
  signing, store listings and game-specific SDKs stay with the developer.
- **Web threads.** The web engine uses worker threads only on cross-origin-isolated pages. A host
  that sends no isolation headers gets a fallback, and a game that cannot isolate loads
  single-threaded with a warning
  ([#639](https://github.com/ThreeNativeHQ/threenative-engine/pull/639),
  [#640](https://github.com/ThreeNativeHQ/threenative-engine/pull/640)).
- **Compressed assets on mobile native.** Android V8 admits KTX2 and Meshopt. Draco stays a
  refusing stub on Android. Android QuickJS (the documented rollback) and iOS JSC have no
  WebAssembly engine and no decoders. `threenative build` refuses a bundle that needs a missing
  decoder before one exists: `TN_NATIVE_KTX2_UNSUPPORTED` and
  `TN_NATIVE_MESH_COMPRESSION_UNSUPPORTED`. Desktop keeps the real decoders. Web refuses with
  `TN_ASSETS_KTX2_UNSUPPORTED` when the renderer supports no compressed format. Android Draco
  qualification and iOS artifact resolution remain open
  (`packages/runtime-native/AGENTS.md:88`, `packages/create-threenative/src/build.ts:537`).
- **Native audio codecs.** Native `decodeAudioData` sniffs the container. `OggS` goes to
  stb_vorbis (Ogg Vorbis). Everything else goes to RIFF/WAVE through SDL. Opus, FLAC, MP3 and AAC
  are not implemented. An Ogg that carries Opus or FLAC is refused, not mis-decoded, and arrives as
  the same rejected promise a corrupt WAV produces
  (`packages/runtime-native/src/audio/audio_context.cpp:1000`).
- **Browser globals in the portable graph.** The owned runtime shims the browser globals a game
  reaches for. A global it does not shim breaks native, so the shim list is the contract.
  `TN_NATIVE_WEB_ONLY_UI` rejects DOM or React mounting in `src/game.ts`.
  `TN_NATIVE_WASM_ON_MOBILE` rejects WebAssembly imports there on Android and iOS, and
  `TN_NATIVE_WASM_UNSUPPORTED` does the same on desktop. DOM work belongs in `src/main.ts`.
  Web-only WASM needs a `threenative-native` conditional backend. See
  [THREEJS-CONSTRAINTS](architecture/THREEJS-CONSTRAINTS.md).
- **Software adapters and virtual displays.** WebGPU on SwiftShader, llvmpipe or another CPU
  rasterizer answers normally, so its numbers look healthy while describing software rendering. The
  runner reads `adapter.info`, names the software adapter and refuses the result unless the caller
  opts in (`TN_CAPTURE_SESSION_ADAPTER_REJECTED`, `TN_TRACE_SOFTWARE_ADAPTER`). A virtual display
  is blocked for frame-rate claims because it has no vsync (`TN_TRACE_VIRTUAL_DISPLAY`). An
  emulator frame rate is therefore not a frame rate (item 2).
- **Workload and artifact limits.** `threenative build` fails closed on an artifact over its size
  budget instead of replacing a good artifact (`TN_BUILD_ARTIFACT_BUDGET_EXCEEDED`). The
  render-workload advisor reports draw-call and texture-memory targets as a verdict, and the
  playtest `performance` assertion checks them. The framework does not enforce them. See
  [PERFORMANCE-BUDGETS](product/PERFORMANCE-BUDGETS.md).

**The plan.** The platform claim is the per-target consumer rows this project ran: browser on
Linux, Linux x64 desktop, and Android on a Pixel 8 and an emulator. Keep this section true to the
guards, and add a row whenever a guard moves in either direction. A limitation missing from this
list is a bug in this file.

---

## How this file is maintained

- A limitation belongs here, not in the README, the Charter, or a package doc. Those describe what
  the framework does. This file describes what it does not do yet.
- Every entry states **where it stands** and **the plan**, and links to the run or record that backs
  it. An entry with no evidence link is incomplete.
- Deep technical write-ups stay in their own dated files under [`verification/`](verification/) and
  [`bugs/`](bugs/). This file is the index and the summary, not a replacement for them.
- When an item is fixed, delete the row and let the release notes carry it. This file tracks the
  present, not the past.
