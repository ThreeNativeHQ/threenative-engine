# Value proposition — "would I use this instead of vanilla Three.js?"

> **Open limitations live in [`CURRENT-CHALLENGES.md`](../CURRENT-CHALLENGES.md).** This document
> is a strategy record; it is not the place to look for what is currently broken or unproven.

*Last measured 2026-09-20.* **The distribution clause is rewritten rather than re-scored.** The chain
this file named as the first thing blocking everything else has fired: every package is on the
registry, the native prebuilt release exists, and `main` has green CI runs. Axes 1, 2 and 4 moved;
axis 3 was re-evidenced without moving; axis 5 did not move because the paired round that would move
it — round 14 — is still `pending` on disk. **Standing total 75/100** (was 72 on 2026-08-30). Two
claims from the 2026-08-30 pass that had lost their command were replaced there rather than softened:
`scripts/count-loc.ts` stopped printing the ratio this file quoted (it writes
[LOC.md](../benchmark/LOC.md) now), and `SceneCollapse` is called `SceneRenderProjection`.

This is the only place that answers the title question. It owns the score — the five axes,
what measures each one, the number it last returned, and whether the claim is earned yet.
The roadmap used to carry a copy of that table; it was deleted there rather than kept in
sync.

Two rules, and they are the whole point of the file:

1. **Every claim cites a run.** A row with no verification file or command behind it gets
   deleted, not softened.
2. **The charter wins any disagreement.** Nothing here changes what the framework is.

Neighbours: [POSITIONING.md](POSITIONING.md) is what we'd tell a buyer,
[BUSINESS-MODEL.md](BUSINESS-MODEL.md) is what we'd charge them. Both are untested
2026-08-02 proposals, and where they claim more than this file does, this file is right.

## The short answer

> **Today: use it if you are shipping a Three.js game to the browser, a desktop binary and
> an Android phone, you want an agent to author the content, and you want the result
> asserted rather than eyeballed. Install it from npm — 0.3.2 is published for every package —
> or take the workspace if you are working on the engine itself. Vanilla Three.js is still the
> defensible choice for a browser-only one-off, and for anything that must ship to iOS hardware.**

**The registry clause is now earned, and it was the whole of the last pass's blocker.** It installs:
`npx create-threenative@0.2.5` scaffolds a project that pins `@threenative/core`, `physics` and `ui`
at `0.3.2` from `registry.npmjs.org` with zero `file:` or `link:` specifiers, and that project
installs and builds — verified here on 2026-09-20. `pnpm alpha:bar` reports A1 green live: *"All 11
publishable package(s) are on the registry at their workspace versions."* The two packages that had
never been published at all are published: `@threenative/assets@0.3.2` (2026-09-12) and
`threenative-engine-mcp@0.2.2` (2026-09-12), and `@threenative/core@0.3.2` followed the same day.
The workspace and the registry now read the same version.

**The chain this file used to list ran, in order, over two weeks.** One green CI run on `main`
(2026-09-12, run `34679507300`) unblocked the native release; `runtime-native-v0.3.2` published
2026-09-12 carrying `prebuilt-lock.json`, `threenative-runtime-linux-x64` and
`threenative-tools-linux-x64`; `scripts/release.ts` then published the JS cohort as one set. The
2026-09-19 and 2026-09-20 scheduled `main` runs are fully green, including the advisory
`native-platforms` rows (Android emulator visual parity, desktop web/native parity, Windows and
macOS desktop core) that were red a week earlier.

**Three residual clauses, so the sentence above is not read wider than it is:**

1. **The native prebuilt release is Linux x64 only.** Windows, Android and iOS prebuilts are not
   published, so a clean install on those hosts builds the host from source or waits. The
   toolchain-free consumer proof is [PRD-078](../PRDs/done/PRD-078-toolchain-free-consumer-proof.md).
2. **`main`'s newest *push* run is red, on two advisory rows.** The 2026-09-13 run for PR #229
   (`34737932197`) failed only `native-platforms / Windows desktop core` and `native-platforms /
   Android V8 source payload`; every merge-verdict job — `typecheck`, `test`, `lint`, `build`,
   `budgets`, `supply-chain`, `golden-path`, `template-nonvisual` — passed, and `ci-required` passed.
   So "CI has never been green" is retired, and "the last main push run is green" is not true either.
3. **The npm lane is unrefreshed at 0.2.5.** A2's evidence is the 2026-08-16 run at
   `create-threenative@0.2.2`. A fresh attempt here with `npm install` failed inside a transitive
   `sharp@0.34.5` postinstall (it fell back to a source build and asked for `node-addon-api`), while
   the scaffold's own documented path — the `pnpm install` the CLI runs, and what `starter`'s README
   says — installed and built cleanly against the published 0.3.2 packages. The npm install lane
   needs one run on a machine with build tools before A2 can be quoted at the current version.

That sentence is narrower than [POSITIONING.md](POSITIONING.md)'s *"Build real games with
TypeScript and AI. One project. Web, iOS, Android."* — the gap is iOS, and it is the honest
subject of this document.

```mermaid
flowchart TD
    start["Shipping a Three.js game"] --> size{"Browser only,<br/>one-off, &lt;500 LOC?"}
    size -->|yes| vanilla["**Vanilla Three.js.**<br/>The starter costs more<br/>than it saves at this size"]
    size -->|no| plat{"Ship target?"}
    plat -->|browser + desktop<br/>Linux/macOS/Windows| ok["**ThreeNative.** Proved. Go"]
    plat -->|Android| android["**ThreeNative.**<br/>One physical Pixel 8, measured:<br/>~106 fps median, 0 of 253<br/>windows below 60, ~2× the<br/>same build in Chrome.<br/>One device, no store release yet"]
    plat -->|iOS| caution["**Not qualified.**<br/>Simulator only. No Apple<br/>hardware exists here.<br/>Do not plan a store release"]
    ok --> src
    android --> src
    src["**Install from npm.** 0.3.2 is published<br/>for all 11 packages and the golden path<br/>builds; the native prebuilt release is<br/>Linux x64 only, so other hosts build from source"]
```

## The score — axis by axis

**Out of 100, five axes of 20, each tied to an instrument that already exists.** No axis
scores on opinion; if the instrument has not run, the axis does not move.

The axes measure **what a user gets**, not the delta against a vanilla control. That is a
deliberate change from the previous version of this file, which scored all five axes as
"beats vanilla" and so could never exceed a tie: the paired benchmark hands the vanilla arm
our own scaffolding *and* `playtest` on purpose, which is correct benchmark design and a
useless value ledger. **Standing total: 75/100** (was 72 on 2026-08-30: axis 1 +1, axis 2 +1,
axis 4 +1; was 67 on 2026-08-12), on a scale that is not comparable to the ~60/100 the old axes
reported.

| # | Axis | The claim a user would care about | Instrument | Measured | Score |
|---|---|---|---|---|---|
| 1 | **Start a project** | "There is something to run in a minute, and an agent can find what already exists" | CI `template-nonvisual` + `golden-path-template`, `pnpm test:templates`, [default-retention measurement](../verification/scaffold-default-2026-08-12.md), `packages/create-threenative/capabilities.json` | **Ten templates** — `action-rpg`, `defense`, `minimal`, `platformer`, `puzzle`, `racing`, `runner`, `sailing`, `shooter`, `starter` — each carry a green `template-nonvisual` job on the 2026-09-20 `main` CI run (`35500166719`), which also passes `golden-path`; `sailing`, `puzzle` and `runner` are new since the last pass. Every template ships a quality switch ([PRD-304](../PRDs/done/PRD-304-every-template-ships-a-quality-switch.md)) and is playable with the input the device has ([PRD-291](../PRDs/done/PRD-291-a-template-is-playable-with-the-input-the-device-has.md)). The capability manifest is **341 entries** — 269 functions and 72 classes, up from 194 — regenerated by `pnpm build` and reachable from a project through `engine_search_capabilities` on the shipped `threenative-engine-mcp`; `npx threenative doctor` now also predicts a requested build's missing prerequisite ([PRD-374](../PRDs/done/PRD-374-doctor-predicts-the-requested-build-prerequisite.md)). The small endless-runner arm retained 15/18 starter source paths (83.33%), so starter remains the default — that measurement has **not** been re-run since 2026-08-12 | **18/20** — **+1** for three more scaffolded-and-playtested templates and a manifest that nearly doubled; still docked because 42.89% of original starter lines survive as rewrite cost and that retention number is five weeks old |
| 2 | **Author the content** | "An agent can find and make my assets" | the four pinned MCP servers, `asset-mcp-tools.json`, [the 2026-08-30 rerun](../verification/prd-032-rerun-2026-08-30.md) | **Four MCP servers now launch in every template, out of the installed package**: `threenative-assets` (**44 tools**, pinned `0.9.1`, up from 32 at `0.4.0`), `threenative-sculpt` (5 tools + 31 technique-safe resources, `0.1.1`), `threenative-engine` (2 tools, `0.2.2`) and `threenative-blender` (5 tools, `0.1.2`), wired by the `.mcp.json` that installing `@threenative/core` writes and launched as `./node_modules/@threenative/core/mcp/*.mjs`. They are dependencies of `@threenative/core`, not vendored copies — still separately published MIT packages on their own release lanes. New since the last pass: auto-rig, retarget, rig inspection and preview ([PRD-383](../PRDs/done/PRD-383-rig-and-retarget-humanoids-through-the-asset-mcp.md)), a downloaded .fbx becoming a running character ([PRD-346](../PRDs/done/PRD-346-a-downloaded-fbx-becomes-a-running-threenative-character.md)) and the Fab/Unreal import path ([PRD-295](../PRDs/done/PRD-295-fab-unreal-to-threenative-assets.md), [PRD-320](../PRDs/done/PRD-320-the-fab-import-replays-without-a-fab-account.md)). **The quality claim did not move**: it still rests on the sealed scenery brief, MCP arm 4/4/4/4 against the no-MCP control 2/3/2/2 | **14/20** — **+1 for the surface**, not for quality: 44 tools against 32, four servers against two, and a rig/retarget/import path that did not exist. The caveats are unchanged — one brief, one critic, a typecheck precondition compromised by a template defect, sculpt preference and token telemetry still unavailable, and the 2026-08-09 crate failure (2/5 against 5/5) unreversed |
| 3 | **Know it works** | "My game is asserted, not eyeballed" | `@threenative/playtest`, exit codes, alpha-bar row A3 | Fails closed: malformed assertion throws, missing bridge exits `2`, a pre-satisfied assertion reports `TN_PLAYTEST_ASSERTION_TRIVIAL`. **Re-proved 2026-08-29 against the shipped runner**: an empty assertion set exits `1` with `TN_PLAYTEST_SCENARIO_NO_ASSERTIONS` while the true-positive control passes on the same runner, project and browser recipe. The runner now also refuses to grade a lane it cannot observe, names each scenario's verdict as it finishes, carries tick counts in the summary, and declares a software adapter out loud instead of silently accepting SwiftShader. Same scenario runs on device with `--target android` or `--target ios` | **18/20** — score unchanged, evidence stronger; still docked only because a plain Three.js project can install the same bridge |
| 4 | **Run it natively** | "It ships where vanilla can't, and faster" | the device matrix, `pnpm native:verify:desktop`, `pnpm parity:ledger` | Browser, Linux/macOS/Windows desktop, iOS **simulator**, and a **physical Pixel 8**: 2,282-mesh platformer, **~106 fps median, 0 of 253 windows below 60**, ~2× the same build in Chrome on the same phone. On an identical-scene load test, **3.0–3.9× Godot 4.7.1** on web, desktop and the same phone, all three pairs `GATE PASS`. **Tier 1's newest ledger is still 2026-08-29** ([tier-1-2026-08-29.md](../verification/tier-1-2026-08-29.md)): browser **73 pass / 0 fail / 1 blocked**, desktop **71 / 1 / 2**, Android emulator **0 executed of 74** — blocked before Gradle on a stale SDL3 pin. **The lane has since gone green while the ledger stayed still**: the 2026-09-20 `main` CI run executes `native-platforms / Android emulator visual parity`, `Desktop web/native parity`, `Windows desktop core` and `macOS desktop core` successfully, so what is owed there is one ledger refresh, not a fix. Newly proved: the native prebuilt release exists (`runtime-native-v0.3.2`, Linux x64), a consumer builds desktop and Android with no native toolchain ([PRD-078](../PRDs/done/PRD-078-toolchain-free-consumer-proof.md)), Android ships a signed release APK/AAB ([PRD-212](../PRDs/done/PRD-212-published-install-builds-android.md)), V8 is 16 KB-page clean ([PRD-221](../PRDs/done/PRD-221-android-v8-is-16kb-clean.md)), and the desktop UI overlay runs on Windows and macOS as well as Linux ([PRD-217](../PRDs/done/PRD-217-webview-ui-layer.md)). Measured and unmet: the Android launch reaches playable in **~10.9 s, 8,513 ms of it Mali shader compilation** ([PRD-360](../PRDs/done/PRD-360-android-launch-is-playable-within-eight-seconds.md), closed 2026-09-08) | **16/20** — **+1**: the emulator conformance lane executes on CI again and the release chain now ships a prebuilt native runtime; still **one phone, one thermal state, no iOS hardware, no store release**, and a launch cost the framework does not own |
| 5 | **Write less code** | "You will write less than vanilla" | `pnpm sweep:pair` → `authoredLoc`, `pnpm tsx scripts/count-loc.ts` | Wins 2 of 5 genres on the corpus measure: platformer **−187**, topdown **−695**; loses endless **+442**, exploration **+95**, open-world **+8**. **The owner settled the cost column on authored lines on 2026-08-15**, and on that measure the framework won both rounds that have run since — round 9's platformer pair **authored 379 fewer lines** while shipping 162 more. `count-loc`'s newest kill-switch row: cloth is **46 framework lines against 761 hand-written** (713 implementation + 48 callers) across flag, cape and curtain — **94.0% smaller**, and the script throws if that margin ever falls below 2× | **9/20** — unchanged: no paired round has been measured since round 9, and round 14 sits `pending` on disk with every arms cell `unmeasured`; the mechanism still clears the kill switch by 16×, and the frozen-source ratchet is where it was (below) |

Evidence: [phase-1-2026-08-08.md](../verification/phase-1-2026-08-08.md) (axis 5, four
genres), [round-3-2026-08-09.md](../verification/round-3-2026-08-09.md) (open-world),
[runtime-perf-state.md](../verification/runtime-perf-state.md),
[native-visual-parity-2026-08-11.md](../verification/native-visual-parity-2026-08-11.md),
[cold-start-and-hitches-2026-08-11.md](../verification/cold-start-and-hitches-2026-08-11.md)
and
[runtime-perf-state.md](../verification/runtime-perf-state.md)
(axis 4, physical device, plus the browser and Godot comparison),
[tier-1-2026-08-29.md](../verification/tier-1-2026-08-29.md) (axis 4 reliability — it supersedes
the 08-10 and 08-15 ledgers, whose `--out` reports name a checkout that no longer exists on this
machine and so cannot be recomputed at all),
[PRD-032](../PRDs/done/PRD-032-asset-discovery-mcp.md) and
[PRD-049](../PRDs/done/PRD-049-sculpt-from-reference-mcp.md) (axis 2),
[round-9-2026-08-15.md](../verification/round-9-2026-08-15.md) and
[LOC.md](../benchmark/LOC.md) (axis 5),
[alpha-a3-2026-08-29.md](../verification/alpha-a3-2026-08-29.md) and
[prd-265-unobservable-lanes-2026-09-04.md](../verification/prd-265-unobservable-lanes-2026-09-04.md) (axis 3),
[alpha-bar.md](../verification/alpha-bar.md) and `pnpm alpha:bar` (A1 and the install clause above),
[PRD-078](../PRDs/done/PRD-078-toolchain-free-consumer-proof.md),
[PRD-212](../PRDs/done/PRD-212-published-install-builds-android.md),
[PRD-262](../PRDs/done/PRD-262-the-runtime-native-prebuilt-release-exists.md),
[PRD-217](../PRDs/done/PRD-217-webview-ui-layer.md) and
[PRD-360](../PRDs/done/PRD-360-android-launch-is-playable-within-eight-seconds.md) (axis 4 distribution and launch),
and [PRD-304](../PRDs/done/PRD-304-every-template-ships-a-quality-switch.md),
[PRD-291](../PRDs/done/PRD-291-a-template-is-playable-with-the-input-the-device-has.md) and
[PRD-374](../PRDs/done/PRD-374-doctor-predicts-the-requested-build-prerequisite.md) (axis 1).

The 2026-08-30 pass's install clause is retired: [ci-has-never-been-green-2026-08-29.md](../verification/ci-has-never-been-green-2026-08-29.md)
described a chain that has since completed, and the A1 row of [alpha-bar.md](../verification/alpha-bar.md) is
the live reading that replaces it.

### Why LOC cannot get us to 80 on axis 5

Plumbing is ~30% of a game and is **already halved** — 138 → 74 on the static control, **53.6%** —
and gameplay is permanently the user's to write. **The ceiling on the cost axis alone is roughly
40/100.** No amount of further framework code moves it, so a proposal justified by "it will
save the user lines" is arguing against arithmetic.

The cloth number is the exception that proves the shape of the rule, not a counter-example: 46
against 761 is a **94.0%** cut because a soft body is repeated mechanism a game writes three times
and never wants to own, which is exactly the narrow band the ceiling argument leaves open. It moved
the axis by one point when it landed, not by ten, and a second such win would move it by one more.

The win condition on that axis is the paired arm, agent against agent (`pnpm sweep:pair`),
not the static `abyss` ratio. That ratio is a **regression ratchet** against frozen
hand-written source — see `docs/benchmark/PROTOCOL.md` — and `scripts/count-loc.ts` no longer
prints it, it writes [LOC.md](../benchmark/LOC.md). Vanilla still wins it on the total at **93.2%**
(plumbing **53.6%**), which is where the 2026-08-30 pass left it — re-run here and unchanged, and
still the reason axis 5 sits at 9 rather than higher. The paired measure did not advance either:
round 14 ([the ledger](../verification/round-14-2026-09-04.md)) is `pending` on disk with every arms
cell `unmeasured`, because the owner capped it at framework-arm builds.

### What the paired benchmark cannot show

The benchmark deliberately gives the vanilla arm the scaffolding and the `playtest` bridge,
so **axes 1 and 3 win no benchmark column by construction**. That is a scoring artifact, not
a verdict on their worth, and it is recorded as one in OPPORTUNITY-AREAS.md #2. Read the
benchmark for what it is: a control on cost and polish, not a census of what ships.

## The seven claims that are actually defensible

Each has a run behind it.

**1. Your game gets asserted, not eyeballed.** `@threenative/playtest` drives the real build
and fails closed: a malformed assertion throws, a missing bridge exits `2`, an assertion
already satisfied before the scenario ran reports `TN_PLAYTEST_ASSERTION_TRIVIAL` rather than
passing. The same scenario runs on device. A plain Three.js project can install the same
bridge, so it wins no benchmark column and is still the strongest reason to adopt.

**2. One source runs on web and on an owned native runtime.** The same `src/game.ts` runs in
the browser, in a desktop binary, and on a physical Android phone, with physics agreeing
across the C ABI. No WASM on native; the native bundle is one import-free ESM file, asserted
on every build by `examples/native-smoke`. Since the last pass that runtime gained a shipped
prebuilt release ([PRD-262](../PRDs/done/PRD-262-the-runtime-native-prebuilt-release-exists.md),
`runtime-native-v0.3.2`, Linux x64), a desktop UI overlay on Windows and macOS as well as Linux
([PRD-217](../PRDs/done/PRD-217-webview-ui-layer.md)), a signed Android release path
([PRD-212](../PRDs/done/PRD-212-published-install-builds-android.md)) and 16 KB-page-clean V8
([PRD-221](../PRDs/done/PRD-221-android-v8-is-16kb-clean.md)) — and, on the render side, virtual
geometry that is on by default above 65,536 triangles
([PRD-279](../PRDs/done/nanite-like/PRD-279-geometry-the-camera-cannot-resolve-is-never-submitted.md)–[PRD-285](../PRDs/done/nanite-like/PRD-285-clusters-arrive-when-the-camera-asks-for-them.md)).

**3. The same Three.js game runs at roughly half the frame cost of the same game in a browser
on the same phone.** This is the cleanest comparison the project has, because both arms are
the *identical codebase* — only the runtime under it differs. On a physical Pixel 8, a
2,282-mesh platformer runs **~106 fps median uncapped with 8–9 ms frames, minimum 83.4, 0 of
253 rolling windows below 60**. The same build in Chrome on that phone is pinned at 60 fps
with worst frames of **19.6–22.5 ms** — past the 16.7 ms budget. Chrome cannot be uncapped at
all (`requestAnimationFrame` is bound to the display refresh), so its ceiling is structural,
not a tuning choice. Against its own past, the same game went from **21.8 fps to ~106 fps**.

**And the game contains no code that makes that happen.** The old in-game hack cost ~600
lines plus scene-graph annotations and lost the sky, clouds, HUD, animation and toon shading;
`SceneRenderProjection` in the framework keeps all of them with **zero game-side lines**. That is
the engine-bug/game-bug rule paying out in a measurement. (It was called `SceneCollapse` when this
file last measured; the rename came with the fix for it eating the scene it was optimising, and
with picking being preserved through it.)

**4. The scaffold hands an agent four working servers, out of one install.** Every template
launches `threenative-assets` (44 tools, pinned `0.9.1`, surface recorded from the published
package by `scripts/capture-asset-mcp-tools.ts`), `threenative-sculpt` (5 tools, 31
technique-safe resources, `0.1.1`), `threenative-engine` (2 tools, `0.2.2`) and
`threenative-blender` (5 tools, `0.1.2`) — all four by path out of `@threenative/core`, which
depends on them, so installing the engine wires them. The generated `AGENTS.md` routes
conventional assets, trivial geometry, bespoke objects, landmarks and scenery to the right
one, and the asset server now rigs and retargets a humanoid
([PRD-383](../PRDs/done/PRD-383-rig-and-retarget-humanoids-through-the-asset-mcp.md)) and
imports Unreal/Fab content ([PRD-295](../PRDs/done/PRD-295-fab-unreal-to-threenative-assets.md)).
They remain separately published MIT packages on their own release lanes — carried as
dependencies, never vendored. **This is a capability claim, not a quality claim:** see the next
section.

**5. The plumbing you would rewrite each time is halved.** Framework plumbing is **53.6%** of
the frozen hand-written control's — 74 lines against 138 (`pnpm tsx scripts/count-loc.ts`, which
writes [LOC.md](../benchmark/LOC.md)). Total ratio **93.2%**, and **vanilla still wins the total** —
the regression ratchet working, not a win being hidden. Both numbers are re-run on 2026-09-20 and
unchanged from the 2026-08-30 pass, which is why this claim carries no new point.

The same script carries a second, larger measure: **cloth costs 46 framework lines against 761
hand-written** (713 implementation + 48 callers) across a flag, a cape and a curtain, and the script
*throws* if that margin ever narrows to less than 2×. That is the kill switch running as a gate
rather than as an argument.

**6. Against Godot 4.7.1, on an identical scene, on all three platforms.** This was the open
question the fox platformer could not answer — different codebases, different scenes, so
"indicative" at best. PRD-117 built the workload that settles it: the same procedurally placed
cubes, the same triangle counts to the unit, both engines uncapped on the same display, and
every pair run through the scorer's equivalence gate before it was quoted.

| L2, instanced | ThreeNative | Godot 4.7.1 | margin |
|---|---|---|---|
| Web, 16 384 | **4.60 ms** | 17.95 ms | **3.9×** |
| Desktop, 16 384 | **3.49 ms** | 10.37 ms | **3.0×** |
| Pixel 8, 65 536 | **12.51 ms** | 40.02 ms | **3.2×** |

Knee at ≤20 ms p95 is **65 536 against 16 384** on desktop and on the phone. All three pairs
report `GATE PASS`. The record is
[runtime-perf-state.md](../verification/runtime-perf-state.md).

**And against vanilla Three.js, 11.6× on the same authored scene** — 20.90 ms to 1.80 ms at
4 096 objects, because `SceneRenderProjection` turns 9 400 draw calls into 3. `defineGame`
constructs it unconditionally (`packages/core/src/game.ts:752`), so a game gets that without
asking, which is claim 3's "zero game-side lines" showing up a second time. Since the last pass it
also culls its projection batches by camera, and `InstancedBatch` gives a game the same collapse
deliberately — placements first, count after — for the repeated shapes it authors itself.

**7. An agent can ask what already exists before it writes it.**
`packages/create-threenative/capabilities.json` — **341 entries** (269 functions, 72 classes),
regenerated by `pnpm build` and searchable by plain-words situation — is nearly twice the 194 it held
when this file was last measured. A project reaches the same manifest through
`engine_search_capabilities` and `engine_capability_detail` on `threenative-engine-mcp`, wired by the
`.mcp.json` that installing `@threenative/core` writes. The failure it exists to prevent is measured:
a game once hand-wrote 446 lines that were already installed and ran at 9 FPS.

**The caveat from the last pass is retired, and this is the cleanest example of the distribution
change:** `threenative-engine-mcp` was absent from the registry on 2026-08-30 and is published at
`0.2.2` today, so a project installing from npm now gets both the manifest and the server that serves
it. What has *not* been re-measured is whether an agent uses it better — the manifest grew, the
routing was not re-scored.

**Where it loses, stated plainly:** unbatched per-object rendering on the web, where Godot is
~1.5× ahead on frame time. That is JavaScript issuing thousands of draw calls against compiled
C++, not a framework defect and not a Three.js defect either — a standalone plain-three page
shows Three's WebGPU backend already beating its own WebGL backend on that case. It is also the
path `defineGame` collapses away, so a normally written game does not sit on it. See
[runtime-perf-state.md](../verification/runtime-perf-state.md).

## Where the claim is not earned — read before quoting any of the above

| Not earned | Why, precisely |
|---|---|
| **"You can install the engine this file measures, for every target"** | The JS packages install: all 11 publishable package(s) are on the registry at their workspace versions — A1 green, read live by `pnpm alpha:bar` on 2026-09-20 — and a scaffolded project pins them and builds. The **native prebuilt release is Linux x64 only**: `runtime-native-v0.3.2` carries `prebuilt-lock.json`, `threenative-runtime-linux-x64` and `threenative-tools-linux-x64`, so Windows, Android and iOS consumers build the host from source. The npm *install* lane is also unrefreshed: A2's evidence is the 2026-08-16 run at `create-threenative@0.2.2`, and a fresh `npm install` at 0.2.5 failed here inside a transitive `sharp` postinstall that fell back to a source build |
| **"A heavy authored game holds 60 fps on a phone"** | The 2,282-mesh platformer does. Bayview — 830 meshes, ~818 draws — reaches **63.45–72.52 fps only on the 120 Hz arm**; on the acceptance baseline decided 2026-08-28 (60 Hz panel, `maxFps: 60`, accept at presented p95 ≤ 14 ms) SurfaceFlinger measured **49.932 fps** and it does not pass. Both numbers are real and they are not interchangeable |
| **"Ships to iOS"** | **iOS-simulator evidence exists from the hosted `macos-15` lane.** No arm64-device, Metal-driver, signing, touch-hardware, thermal or battery evidence follows, so this is not a physical-device or mobile-readiness claim ([PRD-045](../PRDs/done/PRD-045-playtest-on-device.md), [PRD-065](../PRDs/BLOCKED/requires-ios-ecossystem/PRD-065-ios-evidence-lane.md)) |
| **"Ships to Android"** as a *product* claim | One physical Pixel 8 (`shiba`, arm64-v8a, Android 17), one thermal state, no second device, no Play Store release. The frame-rate numbers are real; the fleet claim is not. What *is* newly proved is packaging, not reach: a signed release APK/AAB at targetSdk 36 ([PRD-212](../PRDs/done/PRD-212-published-install-builds-android.md)) and a V8 that is 16 KB-page clean ([PRD-221](../PRDs/done/PRD-221-android-v8-is-16kb-clean.md)). The emulator conformance lane is worse than it was: on 2026-08-29 it executed **0 of 74 rows**, blocking before Gradle on a stale SDL3 pin |
| **"The asset MCP improves your game"** as a *general* claim | Earned for **scenery only**, on one sealed brief: [the 2026-08-30 rerun](../verification/prd-032-rerun-2026-08-30.md) went to the MCP arm on all four criteria at high confidence. It is one brief, one scene, one critic, and its typecheck precondition was compromised by a template defect predating both arms. The 2026-08-09 crate gate **failed** and stands — the no-MCP control produced the better frame there, and nothing about the scenery win reverses it. PRD-049 still ships with preference and token telemetry **unavailable** |
| **"Less code than vanilla"** as a general claim | True in 2 of 5 genres. Gameplay is permanently the user's to write, so that axis tops out near 40/100 — a ceiling, not a backlog item |
| **"Better looking"** as a general claim | Phase 1's own ledger forbids it: *"should not claim universal visual superiority from the two winning genres."* Wins platformer 3.8 vs 2.4 and exploration 4.4 vs 2.8; **loses** topdown 3.2 vs 3.8 on HUD hierarchy |
| **"Production ready"** | Beta rows 3–5 are open. Tier 1 is not reached, on the newest ledger there is, recomputed 2026-08-29 from reports that exist on this machine: browser `73/0/1`, Desktop Linux `71/1/2` (the one real failure is `25-camera-parented-overlay`), Android emulator `0/0/74`. **That ledger is now behind the lane**: the 2026-09-20 `main` CI run executes the Android emulator and desktop parity rows successfully, so the emulator number is stale rather than representative, and no refreshed ledger has been filed to replace it |
| **Any adoption claim at all** | **No stranger has ever played a ThreeNative game for five minutes.** That is the project's own decisive test and it is still open. [METRICS.md](METRICS.md) is right that until it closes, every other metric is a plan to measure something. A6 is still printed as `deferred` by the owner's 2026-08-29 decision, but the reason that decision states — *"a stranger cannot use what is not published"* — expired when A1 went green, so the row is now unmeasured in substance and stale in its stated reason; nothing has been filed for it |

## Who should not use this

- **A one-off browser demo under ~500 lines.** The starter costs more than it saves; the
  endless-runner arm is the measured case (+442 LOC).
- **Anyone planning an App Store release.** Nothing here qualifies iOS hardware at all.
- **Anyone planning a Play Store release on one device's numbers.** One Pixel 8 is evidence;
  it is not a fleet.
- **Anyone who wants an editor, a scene format or visual scripting.** Each was closed with
  evidence and is not coming back.
- **Anyone needing navmesh pathfinding on native.** Browser-only by decision (PRD-052), and
  re-declined in Phase 0 on 2026-08-29 after `navcat` was evaluated as a pure-JavaScript backend
  ([PRD-260](../PRDs/done/PRD-260-standard-navigation-reaches-native-without-webassembly.md)) — no
  product code and no dependency were added.
- **Anyone who needs a native prebuilt on Windows, Android or iOS from a clean install.** The
  prebuilt release is Linux x64; every other host builds the runtime from source and needs a
  toolchain. The JS packages themselves install everywhere.

## What would change the answer

Ranked by how much the sentence at the top would move, cheapest first.

| # | Change | Moves | Blocked on |
|---|---|---|---|
| 1 | **A stranger plays for five minutes** | Every adoption claim, and the project's decisive test. It is no longer *unmeasurable* — that was the 2026-08-29 reason and A1 went green on 2026-08-31 — so this is now an afternoon and one external person, and it is the cheapest item on the list | One external person, and a filed A6 evidence block |
| 2 | **One refresh of the tier-1 ledger** | The Android emulator rows are green on the 2026-09-20 CI run while the newest ledger still records `0 of 74`; recomputing it is what turns a green lane into an axis-4 number, and it is the only item here that needs no new capability | A conformance run with `--out` into a path that still exists, then `pnpm parity:ledger` |
| 3 | **A second physical Android device** | Turns one device into a fleet claim; axis 4 → 18 | Hardware |
| 4 | **The scenery rerun repeated on a template that typechecks** | Removes the one documented weakness in the 2026-08-30 result and would license the rest of axis 2 | 14 type errors in the starter's render chain, unrelated to the MCP |
| 5 | **A five-genre re-measure on authored lines** | Axis 5's corpus number still reports the retired measure; only platformer has been run on the settled one, and it wins. Round 14 was cut to framework-arm-only and sits `pending`, so nothing has advanced since round 9 | `pnpm sweep:pair` across the corpus |
| 6 | **An A2 refresh at `create-threenative@0.2.5`** | The install clause is the one part of the distribution sentence still resting on a 2026-08-16 run at `0.2.2`; the npm lane needs a machine where `sharp` finds a prebuilt binary, or a scaffold that does not run its postinstall | One run on a host with build tools |

The chain this table used to open with — *one green CI run on `main`* — is done: it landed 2026-09-12,
the native release and the npm cohort followed it, and the rows below are what is left.

Below the cut, unchanged from the last pass and still true: two consecutive green iOS-simulator
lanes (lets us say *iOS simulator*, never *iPhone*;
[PRD-045](../PRDs/done/PRD-045-playtest-on-device.md)), tier 1 aggregate green
([PRD-064](../PRDs/production-readiness/critical/PRD-064-tier-1-native-reliability.md)), and a controlled engine benchmark with
everything moving so no pass can fold it — the last of which
[the benchmark record](../verification/runtime-perf-state.md) already specifies.

## The one-line claim, in two versions

| Version | Text | Status |
|---|---|---|
| Buyer-facing ([POSITIONING.md](POSITIONING.md)) | *Build real games with TypeScript and AI. One project. Web, iOS, Android. You own the code.* | **Proposal.** "iOS" is not executable evidence today |
| Evidence-bound (this file) | *Write the game once in TypeScript; install it from npm at 0.3.2; run it on browser WebGPU, a desktop binary and an Android phone at roughly twice the frame rate of the same build in Chrome, with an agent authoring your assets against a 341-entry capability manifest and four MCP servers that arrive with the engine, and a harness that fails closed asserting your gameplay. iOS is simulator-only, and the native prebuilt release is Linux x64 only.* | Every clause traces to a verification file above |

**Use the second one in anything a stranger reads** until the first is earned.
