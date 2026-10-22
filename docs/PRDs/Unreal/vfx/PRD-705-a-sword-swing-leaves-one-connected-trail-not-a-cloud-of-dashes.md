---
prd_contract: v1
---

# PRD-705 — A sword swing leaves one connected trail, not a cloud of dashes

**Status:** NOT STARTED
**Priority:** P3 — Phase 1 is open: the action-rpg attack arc is 180 short line sprites on a fixed one-metre segment, so the slash does not follow the swing, and no gate has measured whether a connected trail reads better.
**Complexity:** 6 (MEDIUM) — 6–10 files: `particles.ts`, its spec, the index tags, the gallery prototype, the action-rpg template, a conformance scene and registry row (+2), a new draw mode and a request field on a public class (+2), a link state per ring slot that carries across frames (+1), native proof (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-609](../../done/PRD-609-a-gpu-burst-starts-where-and-when-it-is-asked-and-live-particles-stay-put.md) (done): its ring of spawn slots is the ribbon's order. Respects [PRD-316](PRD-316-forty-six-vfx-are-generated-render-source-not-an-engine-inside-the-engine.md) (§3): width, colour, texture and fade stay the game's.

## Context

**Unreal LOC:** 5,436 lines for ribbons (`NiagaraRendererRibbons.*`,
`NiagaraRibbonRendererProperties.*`, `NiagaraRibbonVertexFactory.*`, `NiagaraRibbonCompute.*`). The
ribbon shaders live in the Niagara `Shaders/` folder, which the local sparse clone does not hold.
**Port estimate:** about 400 to 550 ThreeNative lines: about 220 in `packages/core/src/particles.ts`,
about 200 of specs, and a conformance scene of about 80.

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

- **A ribbon links particles in an order.** The order is a link-order attribute when the emitter
  writes one, else the particle's unique ID, which follows spawn order
  (`UE 5.8.3: Engine/Plugins/FX/Niagara/Source/Niagara/Private/NiagaraRendererRibbons.cpp:717-726`,
  default `bLinkOrderUseUniqueID` true at
  `Engine/Plugins/FX/Niagara/Source/Niagara/Private/NiagaraRibbonRendererProperties.cpp:73`). A
  ribbon ID splits one emitter into several ribbons (`NiagaraRendererRibbons.cpp:1832-1855`).
- **The defaults.** The ribbon faces the screen
  (`Engine/Plugins/FX/Niagara/Source/Niagara/Public/NiagaraRibbonRendererProperties.h:262`), its
  shape is a flat plane one segment wide, and GPU init is off
  (`NiagaraRibbonRendererProperties.cpp:66, 70, 74`).
- **UVs follow length.** The default U distribution stretches once over the whole ribbon by
  accumulated segment length, and both the leading and trailing edges are locked
  (`NiagaraRibbonRendererProperties.cpp:42-45`). Tiling modes repeat U every 100 cm instead
  (`NiagaraRibbonRendererProperties.cpp:48`).
- **Tessellation follows curvature.** The default mode is automatic, with a curve tension of 0, a
  maximum factor of 16 and a minimum angle of 15° (`NiagaraRibbonRendererProperties.cpp:77-80`,
  `NiagaraRendererRibbons.cpp:66, 74`). A segment is split by its measured curvature against an
  allowed displacement error. The error is at least 0.5 cm and grows with view distance by a
  screen fraction of 0.002, so a far ribbon gets fewer splits. The result is clamped to the maximum
  factor (`NiagaraRendererRibbons.cpp:84, 93, 1929-1981`).
- **Short segments merge, and tangents average.** A point closer than 1 cm to the last kept point is
  skipped. The tangent at a point is the normalised sum of the directions to its neighbours, scaled
  by one minus the tension (`NiagaraRendererRibbons.cpp:102, 1641-1645`).
- **A GPU-simulated emitter builds its ribbon on the GPU.** The CPU never reads its particles
  (`NiagaraRendererRibbons.cpp:999-1003`).

### ThreeNative today

- The action-rpg attack arc spawns 180 line sprites between two fixed points 1 m apart, with a
  `ribbonWidth` of 0.05 (`packages/create-threenative/templates/action-rpg/src/render/vfx.ts:263-285`).
  The Arcane Surge uses the same line shape (`vfx.ts:310-334`). Each particle is its own quad, so the
  slash is a cloud of dashes in one place, not a trail along the blade's path.
- The gallery's "ribbon" layers are stretched sprites
  (`examples/vfx-gallery/src/render/fireSmokeWeather.ts:379-395`).
- `TracerPool3D` (`packages/core/src/tracers.ts:97`) draws straight tracers. It does not follow a
  curve.
- `GPUParticles3D` spawns into a ring of slots in spawn order (`packages/core/src/particles.ts:551`,
  PRD-609). Consecutive slots are consecutive spawns, so the ring already holds Unreal's default link
  order without a sort.
- `engine_search_capabilities` for "sword swing leaves a ribbon trail behind the blade" returned no
  trail mechanism (2026-10-21).

## Solution

| Unreal piece | ThreeNative module | Layer |
| --- | --- | --- |
| Link order by unique ID | The ring order of a spawn-driven `GPUParticles3D`. A segment joins slot `i` to the next slot in spawn sequence. It never joins the newest slot to the oldest | `packages/core/src/particles.ts` |
| Separate ribbons (ribbon ID) | `emitParticle({ ribbonStart: true })` breaks the link to the previous slot. One emitter per concurrent ribbon | `particles.ts` |
| Dead particles | A segment with a dead end collapses to zero area. Ribbon mode requires the `lifetime` option and throws without it | `particles.ts` |
| Screen facing, flat plane | Option `drawPass: "ribbon"` (Godot's draw pass, Unreal's ribbon renderer). The emitter draws an internal strip mesh. Each vertex reads its slot and both neighbours from `positions` and offsets sideways across the view by the game's `widthNode` | `particles.ts` |
| U by accumulated length | TSL nodes for the game's material: `ribbon.u` (0 at the head, 1 at the tail by length) and `ribbon.age` | `particles.ts` |
| Automatic tessellation | A fixed split count chosen per frame from Unreal's rule: measured curvature against an error of `max(0.5 cm, 0.002 × distance)`, clamped to 1..16 | `particles.ts` |
| Width, colour, texture, fade | The game's material nodes | the game's `src/render/` |

- **Auto by default.** The engine measures curvature and distance where it builds the strip. The
  game sets no split count.
- **Deferred, not built:** tube and multi-plane shapes, custom facing, twist and per-particle UV
  overrides. Revisit when a template asks for a round trail or a trail that faces a surface.

Risks:

- `GPUParticles3D` extends `Sprite`. Ribbon mode draws through an internal `Mesh` child and sets the
  sprite count to 0. Phase 2 must keep PRD-569's cull and PRD-611's warm-up working on that child.
- If Phase 1 shows only one consumer, the strip stays template source and core gains nothing (the
  kill switch in the root `AGENTS.md`).

## Acceptance Criteria

- [ ] AC-1 [local]: A fresh visual judge rates the ribbon attack arc as an IMPROVEMENT over the current line-sprite arc. Criteria: one continuous trail follows the swing path, it has no gaps or kinks at segment joins, its tail fades by age, and it shows no stray segment between two swings. proof: same pose and swing frame before and after, headed `--browser-recipe webgpu`, two runs per arm, fresh read-only judge subagent — Evidence: pending.
- [ ] AC-2 [local]: A 256-slot ribbon costs at most 0.1 ms GPU at 1920 × 1080 on the RTX 2080 browser WebGPU lane. proof: `node packages/playtest/dist/runner/cli.js perf` with `TN_FRAME_BUDGET`, ribbon on against off — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| `drawPass: "ribbon"` | action-rpg attack path, `emitParticle` each frame of the swing at the blade tip | Replaces the 180 line sprites of `createAttackArc` | Phase 3, AC-1 |
| `ribbonStart` | the first emit of each swing | None (new) | Phase 2 spec |
| Capability search | `engine_search_capabilities "sword trail ribbon"` | New `@alias ribbon, trail, RibbonTrailMesh` on `GPUParticles3D` | Phase 2 |

## Execution Phases

#### Phase 1: Does a connected trail read better, and who else needs it?
**Status:** NOT STARTED
**Files:** `examples/vfx-gallery/src/render/ribbonPrototype.ts` (new), `examples/vfx-gallery/playtests/ribbon-prototype.playtest.json` (new)
**Implementation:** a game-owned prototype in the gallery: a 256-slot spawn emitter whose own vertex stage draws a strip over the ring, swept along the action-rpg swing path. Count its lines that are plumbing (ring order, break, dead-end collapse, screen facing) and not look. **Gate:** continue only if the judge returns IMPROVEMENT and at least two shipped effects would use the strip (the attack arc, the surge, or another template effect named under `## Decisions`). Otherwise record the result, keep the prototype as gallery source, and delete Phases 2 and 3 (R4).
- [ ] The prototype arc and the current arc are captured at the same pose and judged against the AC-1 criteria, with the verdict under `## Decisions`. proof: `node packages/playtest/dist/runner/cli.js examples/vfx-gallery/playtests/ribbon-prototype.playtest.json --url http://127.0.0.1:5188 --server-command 'pnpm --filter vfx-gallery dev --host 127.0.0.1 --port 5188 --strictPort' --browser-recipe webgpu --headed`, two runs per arm.
- [ ] The prototype's GPU cost at 256 slots is recorded under `## Decisions`. proof: `node packages/playtest/dist/runner/cli.js perf` with `TN_FRAME_BUDGET`, prototype on against off.

#### Phase 2: Core draws the ring as a strip
**Status:** NOT STARTED
**Files:** `packages/core/src/particles.ts`, `packages/core/__tests__/particles.spec.ts`, `packages/core/src/index.ts`, `packages/engine-mcp/__tests__/search.spec.ts`
- [ ] The strip joins consecutive spawns, never joins the newest slot to the oldest, breaks at `ribbonStart`, collapses a segment with a dead end, and throws in ribbon mode without `lifetime`. proof: red-green `pnpm exec vitest run packages/core/__tests__/particles.spec.ts`.
- [ ] The split count follows the curvature rule: 1 on a straight ribbon, more on a tight curve, fewer at a larger distance, never above 16. `ribbon.u` runs from 0 to 1 by length. proof: red-green `pnpm exec vitest run packages/core/__tests__/particles.spec.ts`.
- [ ] A capability search for "sword trail ribbon" returns `GPUParticles3D`. proof: `pnpm exec vitest run packages/engine-mcp/__tests__/search.spec.ts`.

#### Phase 3: The attack arc adopts it, and native
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/action-rpg/src/render/vfx.ts`, `packages/create-threenative/templates/action-rpg/src/scenes/Play.ts`, `packages/create-threenative/templates/action-rpg/AGENTS.md` (and mirror), `packages/runtime-native/conformance/scenes/shared/vfx-ribbon.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] The attack path emits one slot per frame at the blade tip, the combat scenario stays green, and the AC-1 judge verdict is recorded. proof: `pnpm test:templates` (action-rpg) and the AC-1 judge report.
- [ ] The conformance row `vfx-ribbon` passes on the desktop lane within its tolerance. proof: `pnpm parity --target desktop --only-tests vfx-ribbon`.
**Verification:** AC-1 and AC-2.

## Decisions

- 2026-10-21 (filing): no GPU sort for link order. The ring is already in spawn order, which is Unreal's default link order. Revisit when an effect writes its own link order.
- 2026-10-21 (filing): Godot's per-particle trails (`trail_enabled`, a trail per particle) are a different feature. Velocity streaks from [PRD-704](PRD-704-a-spark-streaks-along-its-own-motion-and-a-far-spark-does-not-flicker.md) cover short spark trails. Revisit when a particle needs a curved trail of its own.
