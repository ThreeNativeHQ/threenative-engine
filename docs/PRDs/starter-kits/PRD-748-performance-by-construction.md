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

### Phase 2 — The engine decides

- [ ] Static meshes merge by material and repeated meshes instance automatically at scene build, each with a named opt-out on the same object that the engine reports. Kits then call no mechanism from `src/render/`, which also removes the conflict with the portability boundary (`scripts/check-core-boundary.ts` blocked `InstancedBatch` in the shooter). proof: the shooter town reaches its merged draw count with `collapseTown` deleted, adventure (331 renderables, 0 batches) batches, and a judge reads NEUTRAL.
- [ ] Every material and variant compiles before the first presented frame, including the scene pass, and one-shot builds over a frame's budget run sliced. proof: the Phase 1 hitch gate stays silent after frame 1 in every kit.

- [ ] Opt-in perf mechanisms the engine can decide become default-on (owner, 2026-10-26: "think about new engine_capabilities (especially performance) that could be added by default, so user dont need to care"). Audit the 81 perf capabilities in `capabilities.json` and turn on each one the engine can measure where it is used, with a named opt-out and a report. Candidates: `markStatic` for subtrees whose transforms stop changing, `addInSlices` for a scene build over a frame's budget, `BudgetLadder` and `ShadowFilterBudget` on every costly post and shadow stage, `prewarm` for every transient surface, `ClusteredBatch` and the automatic LOD chain for repeated detailed bodies, `FrameCounters` in dev so a hitch names its uploads, and HUD state coalesced to one React commit per frame. proof: each turned-on capability's `capabilities.json` entry says default-on with its opt-out, a spec per default, and the kits' budgets green with the manual calls deleted.

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

- 2026-10-26 (owner): option 1, the engine decides and fails closed, over guards-only or more AGENTS.md rules.
