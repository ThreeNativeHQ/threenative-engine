# PRD-748: Performance by construction — the engine decides the fast path and fails closed

**Status:** NOT STARTED — evidence in, Phase 1 lane starting
**Priority:** P1 — starter kits keep shipping draw-call, hitch and skinned-crowd bugs that no default prevents (all phases open)
**PR:** #574 (owner rule: one PR for related work)
**Owner ask (2026-10-26):** "we must structure our architecture/abstractions/whatever in a way that makes these performance bugs on simple FUCKING STARTER KITS, almost impossible to happen". Chosen option (owner, 2026-10-26): "1)" — the engine decides, and dev time fails closed.

## Why

Every kit assembles its scene by hand, so every kit can repeat the same mistake. The fast paths (`mergeByMaterial`, `InstancedBatch`, pipeline warm-up) are opt-in calls an agent forgets. The guards mostly warn, or run only in CI on Xvfb where absolute frame times are noise. Shipped examples this week: the shooter town drew 375 draws until a manual merge (PRD-746), the action RPG ghosted every raider that shared a material (one skeleton's previous bones) and hangs while moving.
The repo rule "auto by default: if the engine can measure a value where it is used, it decides" already says the engine owns these choices. This PRD makes it true for performance.

## Shape

- **Mechanism in core, never the look.** Batching, instancing, warm-up and the detectors live in `packages/core`. Every appearance parameter still comes from the game.
- **Each default has a named override on the same object, and the override is reported** (repo convention).
- **Measure against the frame's own median, not absolute ms**, so a guard stays valid on Xvfb and on a loaded host.
- **Fail closed in dev and in playtests, and name the fix.** A guard that only warns in CI does not count.

## Phases

### Phase 1 — Detect and fail closed

- [ ] Hitches fail by default: `TN_FRAME_HITCH` (core/src/frame-budget.ts:1024) becomes a default-on assertion in every scenario, startup included, and each hitch names its cause (pipeline compile, upload, GC, script call site). proof: a spec in `packages/playtest/__tests__`, and the collectathon `skyTexture` 7.7 s hitch commit reads red.
- [ ] Cost per stage: `TN_FRAME_BUDGET` attributes GPU ms to the shadow, main, post-stage (GTAO, SSR, bloom, motion blur, TAA) and present passes, and a failing frame bound names its top stage and the override that cuts it. proof: a spec, and the runner GTAO arm (51 ms) reads red with "GTAO" named.
- [ ] Allocation guard: after warm-up, a JS heap growth or GC rate above a bound fails the scenario, naming the top allocation site. proof: a spec, and the adventure "one material per tick" commit reads red.
- [ ] The frame, draw and triangle bounds also run on the `explore` and `controls` gates, not only the scripted pose. proof: a spec, and the shooter's pre-merge town reads red on `explore`.
- [ ] Tick cost per entity class: the engine times each entity `update` it calls and each `ctx` query, and `TN_HOT_CALL` names the class, method and ms per second over a bound; a kit contract row fails every kit that has one. proof: a spec, and the shooter at 384e311e0 reads red with `Enemy.update` (401 ms/s) and `boneContact` (192 ms/s) named.

### Phase 2 — The engine decides

- [ ] Sim budget governor: the fixed-step loop times its steps, and when catch-up would exceed the frame budget it runs at most two steps and slows game time (UE 5.8.3 `MaxDeltaTime`), while the render keeps the display rate with interpolation; `maxSteps` and a named `simBudget` override stay, and the slowdown is reported. Today `core/src/loop.ts:377` runs up to 5 full steps after a slow frame, so a 33 ms frame doubles the AI cost. proof: a red-green `loop.spec.ts` case, and the shooter under a stated CPU load holds p95 with the old loop reading red.
- [ ] Engine queries cost the same however a game calls them: `raycastAll` keeps a bounds hierarchy per target set and tests only the meshes on the ray, and `boneContact` caches a rigid target's local bounds. proof: specs with call counts, and the shooter's sight ray (197 ms/s) and contact check (192 ms/s) at 384e311e0 drop with no game edit.
- [ ] Tick significance: off-screen and far entities tick at a lower rate by default, as `updateRate: "auto"` already does for mixers (UE 5.8.3 Significance Manager), with a named full-rate override and a report. proof: a spec, and a 32-enemy crowd scenario holds its budget.
- [ ] `useUiState()` with no selector re-renders only when a field the component read changes. proof: a `packages/ui` spec counting renders, and the shooter HUD at 384e311e0 drops from one render per frame.
- [ ] Static meshes merge by material and repeated meshes instance automatically at scene build, each with a named opt-out on the same object that the engine reports. Kits then call no mechanism from `src/render/`, which also removes the conflict with the portability boundary (`scripts/check-core-boundary.ts` blocked `InstancedBatch` in the shooter). proof: the shooter town reaches its merged draw count with `collapseTown` deleted, adventure (331 renderables, 0 batches) batches, and a judge reads NEUTRAL.
- [ ] Every material and variant compiles before the first presented frame, including the scene pass, and one-shot builds over a frame's budget run sliced. proof: the Phase 1 hitch gate stays silent after frame 1 in every kit.

- [x] Sibling renderers no longer hand a texture change back and forth (render cost, shooter, 2026-10-26: render phase 420 ms/s). `Renderer` saw a newer shared texture generation and bumped it again, so the main renderer and every RenderTarget sibling dropped all map groups and bundles on every frame: 54 byte-identical bind groups and 26 bundles recreated per frame. proof: `f66681f7a`; `native_engine_renderer_sibling_texture_change` red on old code (`renderer_caches_test.cpp:383`), green after; shooter bind groups 54 to about 0 per frame, bundles 26 to about 1; paired steady profiles, 3 alternating rounds: onRender 445/442/373 to 348/378/337 ms/s (mean 420 to 354), busy mean 931 to 813 ms/s.
- [x] A render target's renderer skips its output pass (the image nothing reads; the target is read as linear scene colour). proof: `a0ecc6f0d`; `native_engine_render_target` red on `render_database_test.cpp:1538`, green after; reflector, probe, float-target and post-addon tests pass; passes per frame 57 to 33. The CPU effect is below the host noise (4 alternating rounds: onRender mean 362 to 327 ms/s, spread 274-406), so no ms/s is claimed.
- [x] `RenderCameraCull.apply` does not re-walk the camera's children when the engine culls. proof: `aec24ba06`; `render-camera-cull.spec.ts` red on `camera.traverse` called, green after; shooter `get Mesh.children` 41 to 20 crossings per frame.
- [ ] Uniform callbacks run only for the nodes a draw uses. `liveUniforms.sync` (`three-native/src/tsl-uniforms.ts`) runs every `onRenderUpdate` callback on every render call, and the post chain makes about 25 render calls per frame, so the shooter's backlight callbacks cost about 850 crossings per frame (`DirectionalLight.intensity` 444, `.color` 222). The engine has to report which nodes a scene draws, or three-native has to update lazily per draw. A ceiling test that ran each callback once per frame read -41 ms/s in one in-page interleaved run (80 pairs) and +4 ms/s in another, so the host noise hides it; measure by instruction count on a quiet host. proof: a `tsl-uniforms.spec.ts` case counting callbacks per render call, and the shooter crossing census with no kit edit.
- [ ] `RenderCameraCull.prepareAnimation` costs about 81 ms/s on the shooter (three walks per rate rig, about 65 bones each, through `__walk`, `fromEngine` and wrapping). Move rate observation into the engine as `__cullProjected` does, or cache the walk by a topology epoch. proof: a spec with crossing counts per rig, and the shooter profile with `prepareAnimation` under 20 ms/s.
- [ ] The kit's `backlightControls.ts` reads about 15 engine properties per callback (`validateControls`, `resolveKey`): 23-28 ms/s. Memoize per frame, or move the check to the engine. Owner layer: kit now, engine when the box above lands. proof: the shooter crossing census, `DirectionalLight.intensity` under 50 per frame.

- [ ] Opt-in perf mechanisms the engine can decide become default-on (owner, 2026-10-26: "think about new engine_capabilities (especially performance) that could be added by default, so user dont need to care"). Audit the 81 perf capabilities in `capabilities.json` and turn on each one the engine can measure where it is used, with a named opt-out and a report. Candidates: `markStatic` for subtrees whose transforms stop changing, `addInSlices` for a scene build over a frame's budget, `BudgetLadder` and `ShadowFilterBudget` on every costly post and shadow stage, `prewarm` for every transient surface, `ClusteredBatch` and the automatic LOD chain for repeated detailed bodies, `FrameCounters` in dev so a hitch names its uploads, and HUD state coalesced to one React commit per frame. proof: each turned-on capability's `capabilities.json` entry says default-on with its opt-out, a spec per default, and the kits' budgets green with the manual calls deleted.

- [ ] Page UI stays hidden behind the loading cover by default: the UI bridge reports the startup phase, and `useUiState` returns `undefined` until the cover lifts, with a named per-hook override for a UI that draws the loading screen itself (rain's `LoadingOverlay`), reported when used. Today each kit re-implements it (kart and adventure write a `loaded` field, the shooter forgot and drew its HUD over the loading bar, owner 2026-10-26). proof: a `packages/ui` spec, the shooter HUD hidden until reveal with its own gate deleted, and rain's overlay still shown through the override.
- [ ] Debug-only work costs nothing while it is off: `DebugOverlay` polled every entity's `debug()` 10 times a second with the panel closed, which was 63% of sampled main-thread time in the shooter (fixed in 453193d3e, red: the overlay spec). A per-step game meter in the kart walked every vertex of a hit kart (105 ms a step, hung every hit; fixed to 8 box corners). The frame budget's `update` phase read 0.1 ms through that hang under counted ticks, so no playtest could see it. proof: a frame-budget spec that charges fixed-step game time to a phase a scenario can bound, and the kart hit scenario red on the vertex walk.

- [ ] A material the game holds stays the material that draws: `createMaterialLighting` (generated `src/render/materialAssignments.ts`, all 12 kits) swaps each mesh to a converted copy made at enable time, so a game that caches `mesh.material` writes to a material nothing draws. The shooter's vase shards drew at opacity 0 for this reason (fixed game-side in 2cc1c6629: `breakable-shatters` `drawnShards` red 0, green 9). proof: the swap either keeps the source and copy in step or reports a write to a swapped-out source (a `TN_*` marker), with a kit spec red on the cached-reference shape.

### Phase 3 — Every kit on the default

- [ ] Every kit drops its manual mechanism calls that a default now covers, and all 16 kits pass their budgets and the hitch gate. proof: `pnpm test:templates`.
- [ ] A cold agent build of a naive scene (500 static props, a crowd of one rig, no perf code) passes the budgets. proof: `pnpm sandbox` run.

## Acceptance criteria

- [ ] No starter kit holds a hand-written batching, instancing or warm-up call that a default covers. proof: `rg` over templates, plus the Phase 3 box.
- [ ] Each bug class in the evidence table has a guard that reads red on the commit that shipped it. proof: the evidence table below.

## Evidence

perf-inventory, 2026-10-26 (commit messages and PRD text, no kit re-run): about 24 shipped kit perf bugs in 9 classes. Full report: lead scratch `perf-inventory.md`.

| Class | n | Kits | Example | Fixed in | Guard that would have caught it |
|---|---|---|---|---|---|
| Unmerged geometry (too many draws) | 6 | shooter, action-rpg, adventure, collectathon, kart | 08310c739 (draws 417 to 207), 20df34f75 | kit (the engine had `mergeByMaterial`, opt-in) | `TN_PLAYTEST_PERF_WARNING` in part; loose `maxDrawCalls` (600 on four kits) |
| Triangle waste | 3 | collectathon, action-rpg, adventure | 20df34f75 | kit | `maxTriangles` set at the measured value plus 10%, or raised |
| Post-chain cost per tier | 5 | runner (51 ms GTAO), rts, shooter, kart, adventure | PRD-723:169, 226, 248; PRD-734:327 | kit and engine | frame bound (symptom only, no stage) |
| Per-pixel kit TSL cost | 1 | rain | c21a8bffe | kit (deferred) | frame bound (symptom only) |
| Shadow settings | 1 | kart (course-wide VSM) | PRD-734:195 | kit | frame bound |
| Startup and one-shot CPU | 3 | collectathon (7.7 s `skyTexture`), adventure (800 ms), shooter (sync town) | PRD-732:629, PRD-733:532 | kit | `TN_FRAME_HITCH` prints; no assertion reads it |
| Per-frame allocation, step spiral | 2 | adventure | PRD-733:532-538 | kit | none |
| Skinned crowd cost | 1 | shooter and others | e639ded74 | engine (default on) | engine default |
| Author-picked frame budgets | 1 | all kits | 268b1c5f5 | harness | fixed |

Top gaps, ranked by shipped bugs prevented: opt-in geometry mechanisms (about 9), no per-stage attribution (7), ungated startup hitches (3), no allocation guard (2), bounds checked only on the scripted pose (about 5 earlier catches). Phase 1 and Phase 2 close them in that order.

## Decisions

- 2026-10-26, owner: "What can I change on the engine, that even if a dumbfuck dev wants to do some shitty code on the game side, we're still high performance?" The four boxes for the governor, queries, tick significance and HUD fields came from that question and the shooter profile (frame median 33 ms, p95 100 ms, main thread 100% busy, NVIDIA, no DevTools). A worker (PRD-573 v5) moves this cost to another thread but does not cut it.

- 2026-10-26 (owner): option 1, the engine decides and fails closed, over guards-only or more AGENTS.md rules.
