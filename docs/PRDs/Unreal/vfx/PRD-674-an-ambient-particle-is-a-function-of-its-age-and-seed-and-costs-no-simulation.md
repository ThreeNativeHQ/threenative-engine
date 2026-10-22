---
prd_contract: v1
---

# PRD-674 — An ambient particle is a function of its age and seed, and costs no simulation

**Status:** NOT STARTED
**Priority:** P3 — Phase 1 is open: `GPUParticles3D` has no tier without storage buffers and a per-frame compute, and the rain template hand-writes 299 lines to work around that. No measurement yet says the compute costs enough to matter.
**Complexity:** 5 (MEDIUM) — 1–5 implementation files: `particles.ts`, a spec, the rain template, a conformance scene (+1), a new emitter tier with its own spawn arithmetic (+2), bounds measured once by a one-off compute (+1), native proof (+1); risk override: none
**Owner:** João
**Depends on:** None. Respects the culling and budget contract of the shipped [PRD-569](../../done/PRD-569-gpu-particle-emitters-cull-and-yield-to-the-frame-budget.md) and the "generated render source" rule of [PRD-316](PRD-316-forty-six-vfx-are-generated-render-source-not-an-engine-inside-the-engine.md). Independent of [PRD-611](PRD-611-a-gpu-effect-that-starts-hidden-draws-its-first-frame-with-its-pipeline-built.md): a stateless emitter has no compute pipeline to warm.

## Context

**Unreal LOC:** the feature map counts the whole Niagara runtime at 255,512 lines. The stateless
emitter is a small part of it: `Niagara/Internal/Stateless/` and `Niagara/Private/Stateless/` hold
19,837 lines, most of them modules this PRD does not port. **Port estimate:** about 350 to 500
ThreeNative lines: about 200 in `packages/core/src/particles.ts`, about 150 of specs, and a rain
template that gets shorter, not longer.

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

- **A stateless emitter keeps no per-particle state between frames.** Each frame, it writes every
  live particle's attributes again from the emitter age, into a buffer it reuses only as an
  allocation. `UE 5.8.3: Engine/Plugins/FX/Niagara/Source/Niagara/Private/Stateless/NiagaraStatelessComputeManager.cpp:41-47, 87-101`.
- **The live set is arithmetic.** Spawn is a burst (a time and a count) or a rate (particles per
  second), each with a lifetime range. `UE 5.8.3: Engine/Plugins/FX/Niagara/Source/Niagara/Internal/Stateless/NiagaraStatelessSpawnInfo.h:30-41, 68-78`.
  For a rate, the first live index is the floor of `(age − start − longest lifetime) × rate`, and
  the count runs to the floor of `(age − start) × rate`. So the work is the live window, not the
  pool. `UE 5.8.3: Engine/Plugins/FX/Niagara/Source/Niagara/Private/Stateless/NiagaraStatelessEmitterData.cpp:62-110`.
- **A particle's age is the emitter age minus its spawn time,** where the spawn time is the start
  plus its index times the spawn interval. Its lifetime is a random draw keyed by its unique index.
  A probability draw can kill it. A particle with negative age or with age past its lifetime is
  skipped. `UE 5.8.3: Engine/Plugins/FX/Niagara/Source/Niagara/Private/Stateless/NiagaraStatelessParticleSimContext.cpp:168-208`.
- **Randomness is a PCG hash** of the particle index, the emitter seed and a per-attribute channel.
  `UE 5.8.3: Engine/Plugins/FX/Niagara/Source/Niagara/Private/Stateless/NiagaraStatelessParticleSimContext.cpp:10-20`.
  The seed is fixed only when the emitter is marked deterministic, which is off by default.
  Otherwise the seed mixes in a CPU cycle count.
  `UE 5.8.3: Engine/Plugins/FX/Niagara/Source/Niagara/Internal/Stateless/NiagaraStatelessEmitter.h:186, 208` and
  `UE 5.8.3: Engine/Plugins/FX/Niagara/Source/Niagara/Private/Stateless/NiagaraStatelessEmitterInstance.cpp:137-142`.
- **Motion is closed form.** With drag, position is the start velocity less the terminal velocity,
  times `(1 − e^(−age·drag)) / drag`, plus the terminal velocity times age. Without drag, it is
  ballistic. `UE 5.8.3: Engine/Plugins/FX/Niagara/Source/Niagara/Private/Stateless/Modules/NiagaraStatelessModule_SolveVelocitiesAndForces.cpp:39-51`.

### ThreeNative today

- `GPUParticles3D` (`packages/core/src/particles.ts:209`) has two tiers: closed form and spawn.
  Both allocate `positions` and `velocities` storage buffers (`particles.ts:27-32`), both run a
  `process` compute every rendered frame, and the material's `positionNode` reads the buffer
  (`particles.ts:338`). The closed-form tier is closed form in name only: `start` seeds the buffers
  and `process` still writes them each frame (`particles.ts:92-102`).
- Bounds come from a GPU reduction and a readback every 8 frames by default (`particles.ts:366-381`).
- The rain template draws 299 lines of its own instanced quads, because `GPUParticles3D` overwrites
  `positionNode` with a storage buffer and gives no stateless vertex stage
  (`packages/create-threenative/templates/rain/src/render/rain.ts:112-122`).
- The capability manifest lists `createStormRain` as "stateless by design", a template helper. No
  engine emitter offers it (`rg -i stateless packages/create-threenative/capabilities.json`, 2026-10-21).

## Solution

**The tier is mechanism. Every appearance value stays the game's.**

| Unreal piece | ThreeNative module | Layer |
| --- | --- | --- |
| Spawn info: burst or rate, lifetime range, loop | A third `GPUParticles3D` options shape, `stateless: { rate?, bursts?, lifetime: [min, max], loop? }` | `packages/core/src/particles.ts` |
| Live window arithmetic | The CPU computes the first live index and the live count each frame. The draw's instance count is the live count, so dead particles cost nothing | `particles.ts` |
| Per-particle age, lifetime, seed | TSL nodes handed to the game: `particle.index`, `particle.age`, `particle.normalizedAge`, `particle.lifetime`, `particle.random(channel)` | `particles.ts` |
| Closed-form modules (velocity, drag, curl noise, size and colour over life) | The game's `position(particle)` and material nodes. The engine ships no modules: they decide the look | the game's `src/render/` |
| Deterministic seed | The seed is the game's, or a hash of the emitter id. It is never a clock read, so captures repeat | `particles.ts` |
| Bounds | Auto by default: a one-off compute evaluates the game's `position` over the live window at 8 ages across one loop and reuses the existing reduction. A game may still pass `bounds` | `particles.ts` |

The tier has no storage buffers and no per-frame compute. The game's `position` node runs in the
vertex stage. A game that needs its own vertex stage, like the rain streaks, reads
`particle.position` in its own material and the engine leaves that material alone.

PRD-569 culling and budget shedding apply unchanged. A paused stateless emitter freezes its clock, so
it resumes where it stopped and holds no stale state.

Risks:

- The rain template projects two streak endpoints by hand. If the tier cannot carry that vertex
  stage, Phase 3 adopts it in another emitter that fits, and the rain template keeps its own path.
- Sorting for transparent effects (PRD-VQ-12) needs a buffer. A sorted stateless emitter is out of
  scope here.

## Acceptance Criteria

- [ ] AC-1 [local]: The rain template's `storm` scenario passes on the stateless tier, and a fresh visual judge returns NEUTRAL or IMPROVEMENT against the current hand-written rain at the same pose. proof: `node packages/playtest/dist/runner/cli.js packages/create-threenative/templates/rain/playtests/storm.playtest.json --browser-recipe webgpu`, plus headed captures, 2 runs per arm, judged by a fresh read-only subagent — Evidence: pending.
- [ ] AC-2 [local]: 32 ambient emitters on the stateless tier cost less CPU and GPU time than the same 32 on the closed-form tier, at the Phase 1 thresholds. proof: `node packages/playtest/dist/runner/cli.js perf` with `TN_FRAME_BUDGET`, tier against tier, 3 runs — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| `GPUParticles3D` stateless tier | rain template `src/render/rain.ts` → `new GPUParticles3D({ stateless, position, material })` | Replaces the template's hand-written instanced draw if AC-1 holds | Phase 3, AC-1 |
| Capability search | `engine_search_capabilities "stateless particles"` | New entry on `GPUParticles3D` with the Unreal term as `@alias` | Phase 2 |

## Execution Phases

#### Phase 1: Does the per-frame compute cost enough to matter?
**Status:** NOT STARTED
**Files:** `examples/vfx-gallery/src/scenes/Gallery.ts` (a measurement scene, no shipped change)
- [ ] 32 closed-form ambient emitters are measured against 32 hand-written vertex-only twins of the same effect: compute GPU ms, CPU ms per frame, and readbacks per second, on the RTX 2080 browser WebGPU lane and the desktop native host. proof: `node packages/playtest/dist/runner/cli.js perf` with `TN_FRAME_BUDGET`, 3 runs per arm and lane.
- [ ] The gate verdict is recorded under `## Decisions`. Gate: continue when the twins save at least 0.2 ms CPU or GPU p50 on either lane, or when at least 3 shipped emitters (templates and `examples/vfx-gallery`) read no previous-frame state. Otherwise defer, and revisit when a template ships 16 or more ambient emitters at once, or a mobile frame shows particle compute at 0.5 ms or more. proof: the Phase 1 perf runs and `rg -n "new GPUParticles3D" packages/create-threenative/templates examples/vfx-gallery`.

#### Phase 2: The stateless tier
**Status:** NOT STARTED
**Files:** `packages/core/src/particles.ts`, `packages/core/__tests__/particles.spec.ts`
- [ ] The live-window arithmetic matches a brute-force count over every index for rates, bursts, loops and lifetime ranges, including the frame a loop wraps. proof: `pnpm exec vitest run packages/core/__tests__/particles.spec.ts`.
- [ ] A stateless emitter allocates no storage buffer, dispatches no per-frame compute, and draws its live count as its instance count. Its measured bounds contain the game's `position` at every sampled age. proof: `pnpm exec vitest run packages/core/__tests__/particles.spec.ts`.
- [ ] A capability search for "stateless particles" returns `GPUParticles3D`. proof: `pnpm exec vitest run packages/engine-mcp/__tests__/search.spec.ts`.

#### Phase 3: Rain adopts it, judged, and native
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/rain/src/render/rain.ts`, `packages/create-threenative/templates/rain/AGENTS.md` (and mirror), `packages/runtime-native/conformance/scenes/shared/vfx-stateless.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] The rain template draws its rain through the stateless tier, and its template gate passes. proof: `pnpm test:templates` (rain).
- [ ] The visual judge verdict of AC-1 is recorded. proof: the AC-1 judge report.
- [ ] The conformance row `vfx-stateless` passes on the desktop lane within its tolerance. proof: `pnpm parity --target desktop --only-tests vfx-stateless`.
**Verification:** AC-1 and AC-2.
