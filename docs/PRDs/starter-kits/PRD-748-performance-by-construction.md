# PRD-748: Performance by construction — the engine decides the fast path and fails closed

**Status:** NOT STARTED — evidence inventory running
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

- [ ] Hitch detector: after warm-up, a frame over 2x the running median that creates a pipeline, uploads above a size threshold, or allocates above a rate threshold prints `TN_HITCH` with the cause and call site, and any playtest fails on it by default. proof: a unit spec in `packages/core/__tests__`, and a red run on a kit build that compiles a pipeline mid-play.
- [ ] Budget contract: `kit.json` declares draws, triangles, pipelines and hitch count. The engine measures them live, shows a dev overlay and fails the playtest when a budget breaks, naming the capability that fixes it. proof: a spec, and the pre-merge shooter town (375 draws) reads red.

### Phase 2 — The engine decides

- [ ] Static meshes merge by material automatically at scene build, with a named opt-out. proof: the shooter town reaches its merged draw count with `collapseTown` deleted, and a judge reads NEUTRAL.
- [ ] Repeated meshes (same geometry and material) instance automatically, with a named opt-out. proof: a spec, and a kit's prop field reads one draw per material.
- [ ] Every material and variant in the scene compiles before the first presented frame, including the scene pass. proof: zero pipeline creations after frame 1 in every kit (`TN_HITCH` silent).

### Phase 3 — Every kit on the default

- [ ] Every kit drops its manual mechanism calls that a default now covers, and all 16 kits pass their budgets and the hitch gate. proof: `pnpm test:templates`.
- [ ] A cold agent build of a naive scene (500 static props, a crowd of one rig, no perf code) passes the budgets. proof: `pnpm sandbox` run.

## Acceptance criteria

- [ ] No starter kit holds a hand-written batching, instancing or warm-up call that a default covers. proof: `rg` over templates, plus the Phase 3 box.
- [ ] Each bug class in the evidence table has a guard that reads red on the commit that shipped it. proof: the evidence table below.

## Evidence

(filled from the perf-inventory report)

## Decisions

- 2026-10-26 (owner): option 1, the engine decides and fails closed, over guards-only or more AGENTS.md rules.
