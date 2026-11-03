---
prd_contract: v1
---

# PRD-789 — The other five Ultra Elements spells, on our engine

**Status:** NOT STARTED — split from PRD-777 on 2026-11-03, when its Fireball port merged.
**Priority:** P2 — Thunderstrike, Glacial Spike, Arcane Barrage, Aegis and Inferno still use the from-scratch spells that the owner rejected; every box below is open.
**Complexity:** 7 (HIGH) — five upstream spell files plus their VFX services (+3), GLSL to TSL for each (+2), and native, budget and judge proof (+2). Risk override: none.
**Owner:** unassigned
**Depends on:** [PRD-777](../done/PRD-777-a-spell-is-a-timeline-that-changes-the-world-it-lands-in.md) for the port foundation under `packages/core/src/spells/ultra/` and the Fireball. [PRD-527](../native-engine/N14-native-render-chain-and-advanced-visuals/PRD-527-n14e-particles-and-fluids-run-native.md) for the desktop box only.

## Context

PRD-777 ported the Ultra Elements foundation and the Fireball (upstream `src/spells/fire.js` @698b720, MIT) to TSL, on the owned engine's Wasm build over WebGPU. The owner rules hold here unchanged: "its a MIT project, just copy" (JavaScript verbatim, GLSL transliterated to TSL line by line), 60 FPS or more and smooth in the Chrome DevTools MCP, and perf never costs the look. The services Fireball needs (`Particles`, `FluidVolume`, `GroundField`, `Ribbons`, `Shockwaves`, the camera rig) are ported. The other spells also need `Bolts`, `Spikes`, `Sigils` and `Refraction`.

## Decisions

- 2026-11-03 (owner, on PR #598): "just wrap up this PR and merge". PRD-777 shipped the Fireball port and the engine fixes it needed. The other five spells, the deletion of the from-scratch spells, and the native, budget and six-spell judge boxes moved here.

## Execution Phases

#### Phase 1: The other five spells are upstream's code

**Files:** `packages/core/src/spells/ultra/spells/{lightning,ice,arcane}.ts`, `ultra/vfx/{Bolts,Spikes,Sigils,Refraction}.ts`, the `createFx` seams in `ultra/main.ts`, `examples/spell-lab/src/scenes/Lab.ts`.
**Implementation:** Copy each upstream file as PRD-777 did. Inferno (fire.js) reuses the ported fluid. Remove the remaining `ENGINE-GAP` workarounds as the engine closes each gap.

- [ ] Thunderstrike, Glacial Spike, Arcane Barrage, Aegis and Inferno are upstream's code and pass an Opus visual judge against upstream's five beats per spell. proof: Opus visual judge, headed, `--browser-recipe webgpu`, real-time captures
- [ ] The from-scratch spell files (`spells/spells.ts`, `spell.ts`, `mechanisms.ts`, `particle-kinds.ts`) are deleted, and the capability entries point at the ported factories. proof: `pnpm capabilities:sync && pnpm caps:recall` exits 0 and recalls each spell first
- [ ] All six spells hold 60 FPS and stay smooth while cast, on a quiet host. proof: Chrome DevTools MCP rAF probe plus `TN_FRAME_BUDGET` (presented p95, worst frame, frames over 20 ms)

#### Phase 2: The remaining engine gaps the port hit

**Files:** `packages/runtime-native/src/engine/`, `packages/three-native/src/`.

PRD-777 closed `normalNode`/`normalLocal`, int `assign`/`max`/`min`, `ivec3`/`ivec4`/`bool()` (engine-gaps commits 3016d53d6, 787988bbd, 181359acd). Remove their `// ENGINE-GAP:` workarounds in the port code.

- [ ] The engine draws `Points` with a size (gap 13), or the particle ground paint draws as an instanced quad mesh. proof: a conformance row, 0 mismatched pixels, native and web
- [ ] A RenderTarget accepts a scissor, so `GroundField` stops drawing the whole target. proof: a conformance row and `ctest`
- [ ] `getTextureNode("normal")` read directly in `outputNode` returns the normal, not the scene colour. proof: a conformance row, 0 mismatched pixels
- [ ] `GroundField` uses its MRT path (`groundfield-mrt.patch`), the world JS helpers (`wireHalfWidth`, `RibbonPath`, `arenaImpacts`) are `Fn` again, and the dead frame-gate retry guard is gone. proof: `pnpm --filter @threenative/core exec vitest run` and the Fireball judge still passes
- [ ] Cast-time update spikes (45 to 54 ms, our code) are found and cut. proof: DevTools trace, no frame over 20 ms in 15 s of casts on a quiet host

#### Phase 3: It holds on native, on budget and to the eye

**Files:** `examples/spell-lab/playtests/spell-lab.playtest.json`.

- [ ] All six spells cast on the desktop host. proof: `node packages/playtest/dist/runner/cli.js examples/spell-lab/playtests/spell-lab.playtest.json --target desktop`
- [ ] Casting all six in sequence from a cold start stays inside the frame budget of the kit's `performance.playtest.json`. proof: `TN_FRAME_BUDGET` presented p95 and worst frame in `spell-lab.playtest.json`

## Acceptance criteria

- [ ] AC-1 [local]: all six spells in spell-lab are upstream's code, each passes its Opus judge, and the lab holds 60 FPS while casting them. proof: the Phase 1 boxes
