# Engine bug hunt — 2026-10-23

✅ **14 confirmed findings: 4 P1, 7 P2, 3 P3. No P0 established.** Seven retained DeepSeek scout findings were independently checked by the main agent, including direct reproductions. Two scout claims were excluded.

**Fix first:** desktop save isolation, reliable-message loss, stale scene entry, and bounded network setup.

**Revision reviewed:** `e5ff6509a2ba820598163cb1430a664ceba00882`, local `develop`. Existing unrelated working-tree edits were preserved. The audit itself changed no engine code. All 14 findings below are now fixed with red-green regression tests in `fix/engine-bug-hunt-2026-10-23`.

ThreeNative runs shared game code in browsers and a native host. This review assumes ordinary single-player game loads, scene changes, physics bodies, saved progress, and optional multiplayer connections. It does not assume a hostile game script or multiple processes writing one game's save simultaneously.

## Priority definitions

| Priority | Meaning |
| --- | --- |
| P0 | Immediate stop: verified catastrophic failure with broad exposure. |
| P1 | Fix first: saved-data loss or a core operation that can remain broken indefinitely. |
| P2 | Normal bug: incorrect behavior, resource leakage, or a narrower reliability failure. |
| P3 | Minor defect with limited impact. |

| Priority | Confirmed findings |
| --- | --- |
| P0 | ✅ 0 established |
| P1 | ⚠️ 4 — F01–F04 |
| P2 | ⚠️ 7 — F05–F11 |
| P3 | ⚠️ 3 — F12–F14 |

No P0 has been established. This targeted review is not an exhaustive guarantee. All reported defects belong to the engine layer; examples and controlled fixtures supply reproductions.

## P1 — fix first

### F01 — Separate desktop games share and overwrite saved progress

**Source:** [runtime.cpp](../packages/runtime-native/src/runtime.cpp), lines 2226–2231; [local_storage.cpp](../packages/runtime-native/src/storage/local_storage.cpp), `getStorageDirectory()` and `deriveStorageFilename()`.

**Trigger:** Run two different games whose directories have the same final name, such as `/games/puzzle/game` and `/games/racing/game`. Desktop storage uses a shared platform directory and derives its filename from only `current_path().filename()`. Both games select `game.json`.

**Expected / actual:** Each game owns separate saves. Instead, game B reads game A's existing keys; writing the same key replaces A's progress. Reopening A returns B's value. Launching different entry files from one working directory has the same namespace problem.

**Verification:** Compiled a temporary C++ probe against the actual `local_storage.cpp`. A wrote `save=puzzle-level-40`; B read it and wrote `save=racing-lap-2`; reopening A returned `racing-lap-2`. Assertions passed. No real user save directory was touched.

**Smallest fix:** Namespace desktop storage with a stable game identity or canonical game root, rather than a directory basename. Preserve existing saves through an explicit migration. Android's app-specific directory reduces cross-app exposure; the full desktop host launch was not exercised.

### F02 — A superseded or stopped scene still enters when its load finishes

**Source:** [game.ts](../packages/core/src/game.ts), lines 908–913, 931–937, and 955–959.

**Trigger:** Start `game.goto("slow")`, switch to another scene before `slow.load()` resolves, then finish that load. Alternatively, call `game.stop()` while the destination is loading.

**Expected / actual:** The obsolete transition should stop before calling game code. Instead, `#enterTransitionScene()` calls `#enterScene()`, which invokes `scene.enter(ctx)` **before** checking whether that scene is still current. The check blocks assignment of the stale update callback, but it cannot undo `enter()` side effects.

**Verification:** A temporary TypeScript probe used real `defineGame()` with the existing tests' renderer stub. The observed order was `fast.enter`, then `slow.enter`, while `game.sceneName` remained `fast`. The stale entry mutated the current Three.js scene. A separate stop-during-load case invoked `slow.enter` once against the disposed context after `game.ctx` became `undefined`.

**Smallest fix:** Check transition ownership, context, and cancellation before invoking `enter()`. Retain the existing check after `enter()` because an entry hook can itself navigate. This affects both runtimes' shared lifecycle code; no GPU or device run was used.

### F03 — Network setup can ignore its timeout and cancellation indefinitely

**Source:** [net-session.ts](../packages/core/src/net-session.ts), lines 58–76, 96, and 128–132.

**Trigger:** The transport becomes ready, but opening a bidirectional stream or writing a handshake frame remains pending. An unavailable stream or a backpressured handshake write is enough.

**Expected / actual:** `connectTimeoutMs` and the caller's abort signal should end connection establishment. The readiness race finishes first, its abort listener is removed, and the handshake uses a separate abort controller. That controller is checked by `FrameReader`, but stream creation and `writeAll()` are awaited without cancellation. The caller's signal is not forwarded to the handshake controller.

**Verification:** Called the real public `connect()` with a ready transport whose stream-opening promise never resolved. With `connectTimeoutMs: 20`, then an explicit caller abort, the connection was still unsettled after 85 ms and `close()` had not been called. Explicitly rejecting the fake stream ended the probe and triggered cleanup. The transport seam was mocked; no QUIC server was exercised.

**Smallest fix:** Apply one bounded cancellation/deadline path to the entire establishment sequence, including stream opening and writes, and close the owned transport on failure. Cleanup must also complete without waiting forever for a stalled operation.

### F04 — The reliable receive queue silently loses legal messages

**Source:** [net-session.ts](../packages/core/src/net-session.ts), lines 230–269; [net-session.spec.ts](../packages/core/__tests__/net-session.spec.ts), line 547.

**Trigger:** The receive queue has some space, but less than the next legal reliable message needs. For example, use a 10-byte queue, a 6-byte message limit, and messages of 6, 6, and 3 bytes.

**Expected / actual:** Reliable messages remain ordered and are retained until the caller polls them. `pumpReliable()` pauses only when the queue is already full. When the next frame crosses the limit, `enqueueReceived()` silently returns, discarding it. The later, smaller frame can still be delivered.

**Verification:** A direct `connect()` probe with standard streams and a mock transport sent message IDs `[1, 2, 3]`. Polling returned `[1, 3]`, with no disconnection and `droppedDatagrams: 0`. The existing test explicitly expects the second reliable frame to be lost; it encodes the defect rather than protecting the advertised delivery behavior. The source comment says reliable saturation never drops.

**Smallest fix:** Keep the already-read reliable frame pending until enough capacity is available, or reserve capacity before consuming it. Preserve bounded memory across channels. Replace the loss-expecting test with a saturation test that eventually delivers every accepted message in order.

## P2 — correctness and reliability

### F05 — Explicit body mass is added to the collider's mass

**Source:** [simulation.ts](../packages/physics/src/simulation.ts), line 813; native counterpart [lib.rs](../packages/runtime-native/native/physics/src/lib.rs), lines 530–531. [VehicleBody3D.ts](../packages/physics/src/VehicleBody3D.ts), line 33, describes the option as chassis mass in kilograms.

**Trigger:** Construct a dynamic body with an explicit nonzero `mass` and a collider that has nonzero volume.

**Expected / actual:** `mass: 2` describes a 2 kg body. The wrapper calls Rapier's `setAdditionalMass(2)` while retaining the collider's default density. A 2 × 2 × 2 box contributes another 8 kg, giving a 10 kg body. Its public `mass` field still reports 2.

**Verification:** Ran the real web physics plugin and Rapier WASM. For that box, `body.body.raw.mass()` returned `10`; a 2-unit impulse produced velocity `0.20000000298023224`, rather than `1`. Assertions passed. The native implementation repeats `additional_mass`; native execution of this case is unverified.

**Impact / smallest fix:** Impulses, forces, suspension, and mass-based coupling disagree with authored values. The [fluid coupling example](../examples/prd476-fluid-particles/src/coupling.ts), line 70, supplies `density * volume` as the intended total mass. Assign explicit mass to the collider without also adding it to the body; preserve automatic collider mass when the option is omitted or zero.

### F06 — A transport that times out before readiness is left open

**Source:** [net-session.ts](../packages/core/src/net-session.ts), lines 30–62.

**Trigger:** `transport.ready` remains pending until `connectTimeoutMs` expires.

**Expected / actual:** `connect()` rejects and releases the transport it created. It rejects with `TN_NET_TIMEOUT`, but its `finally` only clears the timer and removes an abort listener. No failure branch calls `transport.close()` before `establishSession()` is reached.

**Verification:** A real `connect()` call with a never-ready mock transport rejected at its 20 ms timeout; the transport's `close()` call count remained `0`. Assertions passed.

**Impact / smallest fix:** Repeated connection retries can leave pending transports alive. Close the transport when the readiness race rejects, preserving the original error. This is separate from F03: this timeout rejects correctly but misses resource cleanup.

### F07 — A new audio cue inherits a stopped, paused voice's playhead

**Source:** [audio.ts](../packages/core/src/audio.ts), lines 697–715 and 740–743. Origin: assets/audio DeepSeek scout; independently reproduced by the main agent.

**Trigger:** Play a cue, advance playback by 3 seconds, then call `pause()`, `stop()`, `resume()`, and play a new cue using the same voice pool.

**Expected / actual:** The new cue starts at offset zero. `#retire()` calls Three.js `Audio.stop()` only when the voice is playing. A paused voice therefore keeps Three.js's internal playback progress when returned to the pool. Reuse starts the new cue at the old offset.

**Verification:** Ran the real `AudioBus` and installed Three.js audio classes against a controlled audio context. The same pooled voice was reused; the new 1-second cue's source received start offset `3`. Assertions passed. Actual speaker output and the native audio host were not exercised.

**Smallest fix:** Reset playback progress when retiring a paused voice, while avoiding an invalid second stop of its already-stopped source. Extend the paused-stop test to replay a different cue and assert its starting offset is zero. The shipped rain audio code uses pause and stop paths.

### F08 — Game shutdown does not release its KTX2 decoder worker pool

**Source:** [assets.ts](../packages/core/src/assets.ts), lines 779–790 and 1030–1034; [game.ts](../packages/core/src/game.ts), asset-loader construction at 1087 and teardown at 2313 onward. Origin: assets/audio scout; independently checked.

**Trigger:** A browser game uses its loader's KTX2 worker pool, then stops or restarts.

**Expected / actual:** The asset loader created by the game should release its decoder resources at final shutdown. Its `clear()` releases cached assets only, its interface exposes no final `dispose()`, and game teardown never disposes the KTX2 loader. Each restart constructs another asset loader.

**Verification:** A real `defineGame()`/KTX2Loader lifecycle probe allocated one worker through the installed Three.js `WorkerPool`, using a fake worker with a termination counter. After `game.stop()`, the pool still contained that worker and its termination count was `0`. Explicit pool disposal terminated it once. Real Basis transcoding, actual browser worker growth, and memory consumption were not measured.

**Smallest fix:** Give the game-owned asset loader an idempotent final disposal path and invoke it during teardown. Release its decoder pools there; keep ordinary cache clearing reusable. The scout's related per-model Draco cleanup claim was source-reviewed but not separately reproduced.

### F09 — One CSS transition leaves hit-region measurement running every frame

**Source:** [ui-hit-regions.ts](../packages/core/src/ui-hit-regions.ts), line 129 and lines 241–257. Origin: UI/input scout; independently reproduced in Chromium.

**Trigger:** An ordinary CSS transition emits `transitionrun`, `transitionstart`, and `transitionend`.

**Expected / actual:** The registry measures each frame while movement is active and returns to idle afterward. It counts both `transitionrun` and `transitionstart` as starts, then subtracts only one on `transitionend`. The remaining count keeps its animation-frame pump alive.

**Verification:** Bundled the actual registry into a headless Chromium page and ran a 60 ms button transition. Chromium emitted the three events above. After the transition settled, the registry still ran **10 document measurements in the next 160 ms**. No further transition was active. Snapshot deduplication prevents repeated identical bridge messages; the proven problem is repeated UI work.

**Smallest fix:** Count each transition once and balance its end/cancel events. Cover the browser's complete event sequence, rather than the existing test's single `transitionrun` event. Infinite animations that legitimately keep moving must remain tracked.

### F10 — Scrolling a browser HUD also changes the game's zoom input

**Source:** [input.ts](../packages/core/src/input.ts), lines 272–273 and 561–568; default window input target in [game.ts](../packages/core/src/game.ts), lines 1062–1068. Origin: UI/input scout; independently reproduced in Chromium.

**Trigger:** A game binds `scroll: true` and displays a scrollable HUD over the canvas. A wheel event over that HUD bubbles to the window-level game listener.

**Expected / actual:** Scrolling the HUD should not also zoom the game camera. The shared listener accumulates the event as game input. The shipped snow template combines a scroll-based zoom binding with an `overflow-y-auto` settings list.

**Verification:** In headless Chromium, created a canvas, a scrollable overlay, and the real `InputMap`. One wheel gesture scrolled the HUD by `100` pixels; the following input tick also returned zoom axis `-1`.

**Smallest fix:** Keep UI-consumed browser wheel events out of game input, or scope browser wheel handling to the game surface. Preserve the native host's existing UI wheel routing. Add a real overlay-scroll regression case.

### F11 — Navigation accepts elevated targets and reports arrival underneath

**Source:** [NavigationAgent3D.ts](../packages/physics/src/navigation/NavigationAgent3D.ts), lines 193–209, 238–285, and 325–347. Origin: navigation/terrain scout; its trigger was corrected and independently reproduced.

**Trigger:** Target a point above a connected floor, or follow an available partial ground path under an unreachable elevated target.

**Expected / actual:** An agent must not claim an off-mesh elevated point is reachable merely because the straight path includes the requested endpoint. Arrival must also respect vertical tolerance. The cross-polygon reachability branch checks the path's final point, which Recast can return at the raw requested height; completion then checks only horizontal distance.

**Verification:** Used real Recast and the existing platformer fixture, starting at `(7.5, 0.75, 0)`. Target `(18, 3, 0)` returned reachable **true** and final waypoint `(18, 3, 0)`, although the nearest walkable floor is near `y = 0.1`. Following the horizontal waypoints at character ground height fired `targetReached` once at `(18, 0.75, 0)`, **2.25 metres below** the target. Assertions passed.

A separate target `(0, 3.75, 0)` correctly returned unreachable, but following its partial path still fired `targetReached` with a 3-metre vertical gap. The scout's claim that this original fixture incorrectly reports reachability was rejected; the connected-floor case above independently establishes that part of the defect. Locomotion was represented by waypoint movement, not a full game playtest.

**Smallest fix:** Judge reachability against the projected navmesh endpoint in both polygon branches. Distinguish path completion from actual arrival, and use the existing three-dimensional target-matching helper before firing `targetReached`.

## P3 — limited impact

### F12 — Disposing an old navigation region destroys the active region's agents

**Source:** [NavigationRegion3D.ts](../packages/physics/src/navigation/NavigationRegion3D.ts), lines 164–180. Origin: navigation/terrain scout; independently reproduced with Recast.

**Trigger:** Construct two regions in one navigation context, create an agent using the second, active mesh, then dispose the first, superseded region. Existing tests allow both region disposal orders.

**Expected / actual:** Removing the inactive region should preserve the active mesh's agent. `dispose()` first disposes every context-wide agent and obstacle, before checking which mesh it owns.

**Verification:** Used the existing platformer geometry fixture and real Rapier/Recast WASM. After disposing the first region, the second mesh was still active and one region remained, but agent count changed from `1` to `0`. Retargeting the agent threw `NavigationAgent3D cannot target after dispose.`

**Smallest fix:** Dispose context-wide agents/obstacles only when disposing their active navigation mesh. A superseded region should release only its own resources. Simply deleting all agent cleanup would be unsafe when the active crowd is actually destroyed.

### F13 — Stopping before startup readiness leaves a false failure timer

**Source:** [game.ts](../packages/core/src/game.ts), lines 1232–1254 and teardown at 2313 onward; [launch-diagnostics.ts](../packages/core/src/launch-diagnostics.ts), `watchStartupStall()`.

**Trigger:** Start a game and stop it before startup readiness resolves, including leaving the page's game view during loading.

**Expected / actual:** `stop()` cancels the game's diagnostics work. The startup watchdog is stopped only by `whenReady()`, and its returned cleanup function is not registered with teardown. The stopped game can emit `TN_STARTUP_STALLED` 45 seconds later.

**Verification:** A real game start/stop probe with a controlled interval registry left one interval both before and after `stop()`. Advancing its clock to 46 seconds and dispatching the surviving callback reported `stalled`. The earlier real-time lifecycle probe also emitted the false 45-second report after stopping.

**Smallest fix:** Register `stopStallWatch` in the existing teardown cleanup list, while retaining cancellation at successful readiness. The direct reproduction used a renderer stub; no claim is made about platform-specific UI presentation of the error.

The watchdog stops itself after its false report. This limits the defect to temporary retained diagnostics work and a misleading failure notification; it is not an indefinite timer leak.

### F14 — Releasing a skinned model omits its allocated skeleton texture

**Source:** [assets.ts](../packages/core/src/assets.ts), lines 1213–1221. Origin: assets/audio scout; independently reproduced with Three.js objects.

**Trigger:** A loaded skinned model has a `Skeleton.boneTexture`, as on the supported Three.js/WebGL2 fallback, then `assets.release("model", path)` releases it.

**Expected / actual:** Releasing the model frees that model's allocated skeleton texture along with its other GPU resources. `disposeModel()` disposes geometry and materials, but never disposes the skeleton.

**Verification:** Constructed a real `SkinnedMesh` and `Skeleton`, called `computeBoneTexture()`, loaded it through the normal custom-model loader hook, then released it. Geometry emitted one disposal event; the bone texture emitted **zero**, and remained attached to the skeleton. Explicit skeleton disposal then released it. Actual GPU memory was not measured.

**Smallest fix:** Dispose owned skeleton resources once per distinct skeleton during model release, with the same shared-resource care as existing geometry/material disposal. This specifically concerns renderer paths allocating bone textures; the default owned renderer's bone-texture allocation was not established.

## Regression coverage

Every finding has a test that failed on the reviewed revision and passes after the fix. The branch is `fix/engine-bug-hunt-2026-10-23`; the pull request is [#564](https://github.com/ThreeNativeHQ/threenative-engine/pull/564).

| Finding | Regression test |
| --- | --- |
| F01 | `packages/runtime-native/tests/local_storage_test.cpp`: entry identity and legacy migration |
| F02 | `packages/core/__tests__/game.spec.ts`: newer goto and stop during load |
| F03 | `packages/core/__tests__/net-session.spec.ts`: stalled stream timeout and caller abort |
| F04 | `packages/core/__tests__/net-session.spec.ts`: reliable saturation keeps order |
| F05 | `packages/physics/__tests__/rigidbody.spec.ts` and the Rust `explicit_mass_is_the_total_body_mass_not_added_to_the_collider` |
| F06 | `packages/core/__tests__/net-session.spec.ts`: readiness timeout closes the transport |
| F07 | `packages/core/__tests__/audio.spec.ts`: reused paused voice starts at zero |
| F08 | `packages/core/__tests__/assets.spec.ts` and `game.spec.ts`: decoder pool disposal |
| F09 | `packages/core/__tests__/ui-layer.spec.ts`: one browser transition is counted once |
| F10 | `packages/core/__tests__/input.spec.ts`: a HUD wheel does not zoom the game |
| F11 | `packages/physics/__tests__/navigation-agent.spec.ts`: elevated target rejected and never reached underneath |
| F12 | `packages/physics/__tests__/navigation-region.spec.ts`: superseded disposal keeps active agents |
| F13 | `packages/core/__tests__/game.spec.ts`: stall watch cancelled on stop |
| F14 | `packages/core/__tests__/assets.spec.ts`: released skinned model frees its bone texture |

Red run on the reviewed revision: 4 network, 9 core and 3 physics tests failed. Green run after the fixes: 288 test files and 4172 tests pass across `packages/core` and `packages/physics` (4 skipped), plus the C++ storage test, the Rust mass test, 269 documentation/CI contract tests, `pnpm check:docs`, package typechecks and Biome.

## Verification performed

✅ **354 focused engine tests passed across 11 files.** The first command ran 155 tests in 5.77 seconds; the second ran 199 in 2.19 seconds.

```sh
pnpm exec vitest run \
  packages/core/__tests__/game.spec.ts \
  packages/core/__tests__/net-session.spec.ts \
  packages/core/__tests__/loop.spec.ts \
  packages/physics/__tests__/rigidbody.spec.ts \
  packages/physics/__tests__/collision.spec.ts

pnpm exec vitest run \
  packages/core/__tests__/assets.spec.ts \
  packages/core/__tests__/audio.spec.ts \
  packages/core/__tests__/ui-layer.spec.ts \
  packages/core/__tests__/input.spec.ts \
  packages/physics/__tests__/navigation-agent.spec.ts \
  packages/physics/__tests__/navigation-region.spec.ts
```

✅ **269 documentation/CI contract tests passed across 6 files**, in 12.87 seconds.

```sh
pnpm exec vitest run \
  scripts/__tests__/check-doc-links.spec.ts \
  scripts/__tests__/evidence-budget.spec.ts \
  scripts/__tests__/evidence-citations.spec.ts \
  scripts/__tests__/sync-agent-docs.spec.ts \
  scripts/__tests__/ci-structure.spec.ts \
  scripts/__tests__/ci-needs.spec.ts
```

✅ The existing C++ `local_storage_test.cpp` was compiled with `local_storage.cpp` using `c++ -std=c++17`; all assertions passed. This direct build did not enable the optional wrapped `fsync` failure-injection cases.

✅ Temporary probes independently exercised all retained findings: real lifecycle code with renderer stubs; real network framing/queues with mock transports; actual Rapier/Recast WASM; actual C++ storage; Three.js audio/resource classes with controlled dependencies; and real headless Chromium CSS/wheel events. The KTX2 lifecycle check used an instrumented fake worker inside the actual worker pool. Each finding states its limits.

⚠️ Existing green tests do not establish the absent edge-case behavior. In F04, one existing test explicitly expects the reported reliable-message loss and must change with the fix.

❌ `pnpm check:docs` exited 1 because the already-deleted tracked file `artifacts/engine-load-test/prd-449/holdout/README.md` is missing. That deletion was present before this audit and was left untouched. The command stopped before its Unreal port-status check. The separate 269 passing contract tests do not replace this failed repository-wide check.

## Secondary scouts and false-positive checks

Three read-only OpenCode scouts used **`opencode-go/deepseek-v4.1-flash`**, reasoning variant **`max`**, through the installed `save-tokens` wrapper. They investigated assets/audio, UI/input, and navigation/terrain. Two additional fresh read-only DeepSeek reviews challenged the candidates and their priorities. Final inclusion required the main agent's own source check and reproduction, rather than agreement between models.

| Scout scope | Proposed | Retained after main-agent verification | Excluded or corrected |
| --- | --- | --- | --- |
| Assets/audio | 3 | F07, F08, F14 | Restricted decoder proof to verified lifecycle behavior; no measured real-worker memory-growth claim. |
| UI/input | 3 | F09, F10 | Excluded the claim that automatic left-stick movement is an accidental binding bug. |
| Navigation/terrain | 3 | F11, F12 | Corrected the elevated-target trigger; excluded the tile-boundary claim; downgraded old-region disposal to P3. |

**Excluded U3 — keyboard-only `move` plus gamepad input:** The automatic left stick for the action named `move` is explicitly described in [gameplay-recipes.md](../packages/create-threenative/agent-docs/references/gameplay-recipes.md), line 13, and covered by [input.spec.ts](../packages/core/__tests__/input.spec.ts), line 266. The observed behavior is intentional. A deadzone or opt-out discussion is outside this bug list.

**Excluded N3 — exact outer terrain boundary throws:** The tile lookup maps the exact positive edge to the adjacent tile, using half-open ownership. No public closed-outer-boundary promise was established. A closed individual `Heightfield` does not prove that `TerrainTiles` must also accept a nonresident neighbor's boundary. This is not counted as a confirmed defect.

**Excluded additional hypothesis — shared solid-body shape overrides:** Per-body collision overrides do mutate a reused shape's descriptor. However, support for reusing one solid-body shape with conflicting per-body overrides was not established. The already-created first collider is not retroactively changed. This ambiguity was kept out of the confirmed findings.

## Scope and remaining limits

The primary review focused on scene/start/stop ownership, the fixed-step path, shared physics construction, native save persistence, and connection framing/lifecycle. Scouts covered selected asset/audio, input/UI, navigation, and terrain-query paths. This is a targeted sample, not a file-by-file audit.

⚠️ Full CI, live QUIC interoperability, actual decoder-worker memory growth, GPU memory consumption, full game playtests, visual parity, full native host launches, Android, iOS, Windows, and macOS were not run. The native renderer, shaders, render graph, broad filesystem/network attack surfaces, and complete asset-compiler pipeline were not exhaustively reviewed.

✅ All 24 report-local links resolve, finding IDs and priority order were checked, and whitespace checks passed. Temporary scout outputs, prompts, probes, binaries, and test save data were removed after their results were recorded here.

**Follow-up:** `fix/engine-bug-hunt-2026-10-23` fixes every confirmed finding with a test that failed on this revision and passes after the fix. No pushes, merges or deployments were made by the audit itself; the pre-existing repository-wide docs-check failure above was left untouched.
