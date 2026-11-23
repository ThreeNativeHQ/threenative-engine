---
prd_contract: v1
---

# PRD-910 — A running character proves its cape and hair in one scene

**Status:** PARTIAL — the scene and its cape probe run (2026-11-22); hair probe, Unreal reference and owned-engine bind-group fix are open.
**Priority:** P1 — PRD-911, PRD-912 and PRD-909 cannot claim a result until this scene measures hair and holds an Unreal reference.
**Complexity:** 6 (HIGH) — new example and probe (+2), Unreal reference scene with Chaos Cloth and a groom (+2), owned-engine bind-group bug (+2)
**Owner:** João
**Depends on:** none. Epic: [character dynamics](README.md).

## Context

The owner does not trust the cloth and hair code because nothing validated it on a moving body. The incumbent proof, `examples/prd243-cloth`, is a flag on a pole. A flag never tests skinned pins, inertia, body collision or teleport, which are the cases that break a cape. The baseline run on 2026-11-22 (see the epic README) shows `SoftBody3D` stretching to 2.4× its length and passing through the legs.

## Solution

`examples/character-dynamics` is the one proof scene for the epic. The CC0 mannequin (`examples/abyss-framework/assets/mannequin.glb`, an Unreal-Manny bone layout with idle, walk, jog, sprint and jump clips) runs a fixed script on the fixed step:

| Phase | Ticks | Motion |
|---|---|---|
| settle | 90 | idle |
| jog | 90 | 3.4 m/s straight |
| jogTurn | 120 | 3.4 m/s, yaw 1.5 rad/s |
| sprint | 90 | 5.6 m/s |
| hardStop | 60 | 0 m/s in one tick |
| jump | 75 | 4.2 m/s up, ballistic |
| snapTurn | 45 | 180° in one tick |
| teleport | 45 | 8 m in one tick |

The probe prints one `TN_CHARACTER_DYNAMICS:` line per run. For the cape, it records per phase the hem offset in the body frame, the hem trail angle from world down, the max edge stretch, and the cape vertices inside a torso capsule. For hair, it records the tip offset from the head frame, the max segment stretch, and the hair vertices inside a head sphere. `?arm=` picks the implementation, so every later PRD adds an arm, and the incumbent stays the control. The owned Wasm engine renders by default. `TN_ENGINE=threejs` is the upstream control.

The Unreal reference is the same experiment in UE 5.8.3 with stock Chaos Cloth and groom defaults: the same mannequin skeleton (Manny), the same cape grid and pin row, the same script and camera, and the same probe numbers from an editor Python export. The numbers are compared, not the pixels.

## Acceptance Criteria

- [ ] AC-1: Each arm prints a finite `TN_CHARACTER_DYNAMICS` line for all eight phases on the owned engine, with no console error. proof: `node packages/playtest/dist/runner/cli.js examples/character-dynamics/playtests/baseline.playtest.json --url http://127.0.0.1:5291 --server-command "pnpm --filter character-dynamics dev --host 127.0.0.1 --port 5291 --strictPort" --browser-recipe webgpu --headed`
- [ ] AC-2: The Unreal reference record exists for the same eight phases, with its run spread over 3 runs. proof: `tools/unreal-reference/character-dynamics/reference.json`, read by `examples/character-dynamics/__tests__/reference.spec.ts`

## Execution Phases

#### Phase 1: The scene measures the cape

- [x] The mannequin runs the eight-phase script with a cape, and the probe prints cape metrics per phase. proof: the AC-1 command — 2026-11-22: 640 frames, all phases finite, owned engine on NVIDIA Turing (adapter checked). Hem offset 0.42–0.75 m, stretch up to 141%, up to 29 vertices in the torso (table in the epic README).
- [x] The upstream three.js arm runs the same scene and gives the same numbers within noise. proof: `TN_ENGINE=threejs` + the AC-1 command — 2026-11-22: max stretch 135% against 141% on the owned engine.
- [ ] The owned engine renders the scene with no `createBindGroup` error. Today it logs `Failed to read the 'resource' property from 'GPUBindGroupEntry': Required member is undefined` 3 times from `WebGPURenderer.render` (`packages/three-native/src/browser-renderer.ts:555`). Name the layer, fix it in the engine, and add a conformance case. proof: `pnpm parity --only-tests softbody-character` plus the AC-1 command with `noConsoleErrors` green.

#### Phase 2: The scene measures hair and fails closed

- [ ] A hair arm puts a ponytail chain and a fringe of cards on the head, and the probe prints hair metrics per phase. proof: the AC-1 command.
- [ ] The playtest asserts the per-phase bounds that PRD-911 and PRD-912 set, read from `GameState.phases`. The incumbent arm fails them. proof: `examples/character-dynamics/playtests/acceptance.playtest.json` (red on `?arm=softbody`, green on the new arms).
- [ ] The probe math has a unit check: a known cape pose gives a known stretch, trail and penetration count. proof: `pnpm --filter character-dynamics exec vitest run`

#### Phase 3: The Unreal reference

- [ ] The UE 5.8.3 scene is built with stock defaults: Manny, a Chaos Cloth cape with the same grid and pin row, physics-asset capsules, a groom or a SpringBone ponytail, and the same script. proof: `tools/unreal-reference/character-dynamics/build_scene.py` runs in the 5.8.3 editor and writes `scene.json`.
- [ ] The editor export writes the same per-phase metrics over 3 runs. proof: AC-2.

## Blocked on

- none.

## Decisions

- 2026-11-22 (agent): the incumbent gets its best chance in the baseline. Its frame follows `spine_03` by hand and its gravity turns into that frame, because `SoftBody3D` cannot be parented under a bone. A worse baseline would prove nothing.
- 2026-11-22 (agent): the metrics are behavioural numbers, not pixels, because the claim is about motion. A visual judge still runs on the PRD-911 and PRD-912 captures.
