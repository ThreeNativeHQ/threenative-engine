# PRD-469 — ICEFIELD snow abstractions and starter kit

**Status:** COMPLETE
**Complexity:** 9 (HIGH); risk override: none.
**Owner:** Engine implementation agent
**Depends on:** None
**Progress:** 8/8 required boxes verified

## Context

Extract the working raw snow code from `/home/joao/Downloads/ICEFIELD.html` into reusable ThreeNative abstractions, expose them through the engine capability manifest and MCP tools, and ship a snow starter template. This request currently authorizes the PRD only. Implementation, runtime verification, and publication have not started.

The supplied HTML is 85,296 bytes, SHA-256 `85b170815f8f149a9bea757f80d4362cb5e0cc6b2e33dbf5ab1efab9a4dd02f7`. Recover and type its working algorithms rather than redesigning the demo or adding a snow dependency. The Downloads file is an input, never a runtime dependency; implementation must retain the relevant source-derived regression fixtures in the repository.

### What already works in the source

| Source location | Existing behavior | Extraction destination |
| --- | --- | --- |
| `ICEFIELD.html:85–98` | Approximate load-dependent penetration, snow-dependent walking speed, fixed-step accumulation | Penetration becomes numeric snow response; movement tuning stays in the game; reuse the engine loop |
| `ICEFIELD.html:113–193` | Bilinear sampling; indentation, banks, compaction and disturbance; active-cell recovery; reset/depth updates | Public `SnowField` numerical abstraction using existing heightfield storage |
| `ICEFIELD.html:135–168` | Rounded boot sole, chevrons, groove and raised rim | Game-supplied contact profile; boot design belongs to the starter |
| `ICEFIELD.html:205–271`, `599–709` | Snow shading, snowfall, wind drift, powder bursts and particle pooling | Editable render source plus the existing `GPUParticles3D` mechanism |
| `ICEFIELD.html:513–570`, `711–739`, `890–914` | Manual explorer movement, planted-foot stamps, snow sound and demo loop | Starter gameplay, portable audio/input, engine lifecycle and fixed-step wiring |

The HTML's snow physics is approximate: `sinkDepth` assumes a fixed 0.074 m² boot area, `stamp` hardcodes a sole shape, and the explorer resolves scenery obstacles manually. There is no Rapier world or sphere contact path. The source also uses WebGL `onBeforeCompile`/GLSL, DOM canvas textures and raw Web Audio; these cannot be copied unchanged into the portable starter.

Complexity: 3 for an estimated 11+ implementation files, 2 for a new public snow abstraction, 2 for persistent contact/deformation state, and 2 for the independently built native physics boundary. Tests, generated files and this PRD are excluded.

### Existing mechanisms to reuse

Capability search and detail inspected `Heightfield`, `CollisionShape3D`, `RigidBody3D`, `rapier`, `afterPhysics`, `GPUParticles3D`, and the standalone playtest initializer. The snow-specific search returned an unrelated asset result, not an installed snow solver. Particle search returned no match, but direct inspection confirmed `GPUParticles3D` exists: improve snow-related recall rather than inventing another particle pool. `FluidField2D` is not a snow substitute.

- `packages/core/src/world.ts:94`: `Heightfield` owns canonical samples, geometry and transposed collider export. Its `heights` getter returns a copy; there is no public mutation path. Add the smallest validated dirty-region update contract rather than editing a returned copy.
- `packages/physics/src/CollisionShape3D.ts:100`, `:140`, `:170`: sphere, heightfield and mesh collider creation already exist. Reuse shape descriptors and physical bodies.
- `packages/physics/src/simulation.ts:191`: the shared backend seam exposes collision start/stop records, not persistent contact points, normals or loads. Continuous stamping needs a portable contact observation seam, not repeated collision-enter events.
- `packages/physics/__tests__/native-contract.spec.ts:132`: native heightfields currently throw. Native trimesh support already exists. Prefer a canonical-sample trimesh adapter on native before adding another shape ABI.
- `scripts/build-capability-manifest.ts`: generates both `packages/create-threenative/capabilities.json` and `packages/core/capabilities.json` from public exports and documentation. Never hand-edit those JSON files.

## Solution

### Ownership and public abstractions

The Charter says: “The framework may own the mechanism that puts something on screen” provided every appearance parameter comes from the game. This PRD admits numerical snow storage/contact response as mechanism; implementation updates the Charter and core ownership list explicitly. It does not admit a genre system or a package that owns snow's look.

Use the existing `@threenative/core/world` subpath for a renderer-independent `SnowField`, and `@threenative/physics` for a small `attachSnowPhysics` binding to existing bodies. These names are proposed public class/function names, not a new physics node type. Do not create `@threenative/snow`, a second terrain representation, or a second particle pool.

| Surface | Contract |
| --- | --- |
| `SnowField` | Owns indentation, bank, compaction and disturbance channels; exposes `sample`, `heightAt`, `normalAt`, `stamp`, `recover`, `setDepth`, `reset`, dirty/version information and retained-byte measurement |
| Snow contact input | World position/orientation, footprint bounds/profile, supported area, normal load in newtons and duration in seconds; pressure is load/area, not a fixed boot constant |
| `attachSnowPhysics` | Registers selected sphere, box and capsule bodies with a snow field, observes supported contacts, updates deformation and collision, and returns an idempotent cleanup function |
| Existing particle mechanism | `GPUParticles3D` owns storage/dispatch/lifetime; recovered snowfall and powder behavior supply game-owned start/process functions and materials |
| Starter helpers | Reusable snow materials, boot profiles, weather controller, powder and sound hooks are generated editable source; capability guidance directs appearance work to these files |

Exact declarations are finalized during Phase 1 against the source and incumbent APIs. Preserve the useful source algorithm; generalize only the hardcoded terrain function, sole profile, pressure area, renderer encoding and physics wiring.

The game supplies terrain heights, material response coefficients, snow depth and any profile that determines an imprint's appearance. The initial kit supplies ICEFIELD-derived values. Core stores numerical values and never chooses boot geometry, tread pattern, scenery, particle colours, lighting, sparkle, fog or camera framing. GPU encoding belongs in render source; simulation does not depend on a lossy 8-bit texture or on the source's fixed 0.5/0.12 encoding scales.

### Snow state and deformation

1. Compose snow with the existing canonical heightfield. Final surface height is base terrain plus snow depth plus displaced banks minus indentation. Geometry, queries and collision consume that surface; no independent terrain sampler runs after construction.
2. Preserve the source's sparse active-cell recovery and bounded indentation/compaction. Generalize stamping to a game-supplied bounded contact profile. The starter supplies the original sole and tread; the physics binding derives a sphere footprint from radius/contact geometry and boxes/capsules from their supported geometry.
3. Validate finite values, positive dimensions and area, nonnegative loads/depth/rates, normalized orientation and allocation limits before mutation. Out-of-region queries follow `Heightfield`'s explicit error contract; stamps clip at the boundary and an entirely outside stamp is a reported no-op. Zero depth is valid bare ground with no snow indentation.
4. Make reset and depth changes update the canonical surface and dirty collision/render regions. Deposition reduces depressions and buries compaction; wind erodes banks. Recovery acceleration changes deposition time only, never gravity, movement, falling flakes or physics timestep.
5. Expose effective resolution, cell spacing, dirty region, active cells, version and memory bytes. Derive contact sampling and collider refresh from the actual grid and contact bounds; named fidelity overrides must report their effect. Do not silently discard contacts or disguise a lower-resolution physics surface.

This is a heightfield snow approximation, not granular snow, exact displaced-volume conservation, avalanche simulation, melting or a calibrated material law. No terrain streaming, ski/sled system, voxel snow or arbitrary convex/mesh contact support is required. Unsupported automatic contact shapes throw with the supported list; custom game-authored profiles still use the numerical stamp API.

### Two-way physics support

Consumer flow: a generated snow game starts `rapier()` → creates a snow surface and real bodies → attaches the snow binding → a solved contact compresses snow → the dirty surface reaches render and collision → subsequent physics uses the changed surface.

Use persistent solved contacts, including resting/sleeping support where relevant, with body/collider identity, world contact point, normal, and load or impulse/time data. Implement only the minimal missing backend operations, in bulk records shared by web and native. Collision enter/exit events and body centre projection alone are insufficient proof of contact. If an approximate load estimate is needed, name/report it and cover resting support and impact separately; never describe it as measured contact force.

Only supported, downward-loaded contacts deform snow. Airborne bodies, side contacts with scenery and unrelated colliders do not. Sphere stamps are circular/geometry-derived, never boot-shaped. A dropped sphere must settle on the deformed surface; a pushed sphere must rotate and create a connected track without copying scripted transforms onto the physical body. Capsule footfall events originate in actual grounded movement, then apply the game's foot profile.

Follow the engine's existing phase ordering: solve physics, consume its observations once, accumulate deformation/recovery, publish render changes before drawing, and install dirty collision changes before the next fixed step. Surface lag is at most one fixed step. Loaded recovery and depth changes must wake affected bodies. Collider updates preserve body ownership, filters and scene cleanup; stale collider identities cannot leave bodies unsupported or route a contact to another field.

Reuse heightfield collision where supported and native trimeshes where needed. Both derive from the same samples with verified axes, scale and triangulation. Add a minimal shape refresh seam only if required; do not recreate every terrain collider every frame or add native heightfield support merely to achieve identical API internals. Any reduced collision resolution is an explicit override with reported spacing/error; default fidelity must satisfy the surface-agreement test.

Numerical acceptance uses a 0.28 m deep test patch, a 0.25 m radius/10 kg sphere, gravity 9.81 m/s² and a 1/60 s fixed step. After settling, sphere underside versus the updated surface differs by at most 0.02 m. Rendered vertices and collider source samples differ from canonical heights by at most 0.001 m; triangle-interior surface agreement is within 0.01 m. Repeat equivalent fixed-tick contact/recovery runs under 30/60/120 Hz presentation; indentation differs by at most 0.001 m. These tolerances are proposed acceptance limits, not source measurements. Same-runtime determinism is tested; cross-runtime bitwise identity is not claimed.

### Starter kit and discovery

Ship `packages/create-threenative/templates/snow/`, selectable through the existing `--template snow` flag. Reuse the starter's portable `src/game.ts`, scene/input/playtest wiring, React/Tailwind controls and `src/render/` ownership. The kit starts in a playable snow glade with walking/running footprints and a drop/push sphere interaction. A box/capsule fixture exercises shared physics without requiring another game mode.

Preserve ICEFIELD's recognizable snow relief, compaction view, snowfall/blizzard, wind, powder bursts, reset and depth/hardness/deposition controls as editable source. Port snow shading to ordinary Three.js node materials/TSL for WebGPU; do not add a WebGL-only startup path. Use existing portable audio/input for optional crunch/wind and keyboard/touch controls, with accessible labels and a mute option. The procedural explorer and environment remain game code, never a framework character/weather preset.

The capability manifest must expose the new numerical and physics abstractions with actual imports, signatures, examples, constraints, named overrides and tested platform status. Add situations for deformable snow, footsteps, compaction, deposition, a sphere rolling through snow and supported body shapes. Extend existing particle situations for snowfall/powder. Use the existing not-owned guidance for materials and starter render helpers rather than advertising template-only code as package imports. Add snow queries to the existing recall corpus. A documentation mention alone does not satisfy discovery.

Update template discovery/audits, generated instructions and MCP configs through the existing generators. Generated games must work from locally packed dependencies outside the workspace, without the Downloads file, CDN imports or repo-relative modules.

## Acceptance Criteria

The eight countable criteria live in the owning phases below; this table maps proof scope without duplicating checkboxes. Every actor is the implementation agent.

| Criterion | Lane | Observable result |
| --- | --- | --- |
| AC-1 / AC-2 | local | Source-derived snow state and generalized contacts work through the public import |
| AC-3 / AC-4 | local | Real browser physics handles sphere and box/capsule snow contacts |
| AC-5 | local | The generated game demonstrates the same contact/surface contract on native Linux desktop |
| AC-6 / AC-7 / AC-8 | local | Packed starter works, MCP discovers the abstractions, and repository gates pass |

- [x] Browser WebGPU lane: the packed kit's physics, footsteps, weather and touch scenarios pass on a real GPU adapter. proof: `TN_TEMPLATE_ONLY=snow pnpm test:templates` — exit 0, 7 scenarios, NVIDIA Turing (AC-3, AC-6)
- [x] Native Linux desktop lane: the same snow-physics contract passes on the native host. proof: `pnpm exec threenative-playtest --scenario native-playtests/snow-physics.playtest.json --target desktop` in the packed `snow-proof` — 4/4 on the merged tree, 5/5 before the merge (AC-5)

Browser and native desktop behavior are required here. Android/iOS use the same portable source/backend seam and receive build checks where their SDKs are available; this PRD makes no mobile runtime claim without a target run. During implementation, record any unavailable required qualification under `Blocked on` with the actual attempted command and missing SDK/device. Build success cannot substitute for physics execution. Do not tick an unreachable proof or mark the PRD complete with a required platform result pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Numerical snow field | Proposed `templates/snow/src/scenes/Snow.ts` imports the public world subpath | Source `SnowField` math is extracted; boot-specific masks remain template source | AC-1, AC-2 |
| Physical snow contacts | Snow scene → `rapier` bodies → proposed physics binding → canonical surface/collider refresh | Replaces the HTML's manual obstacle push-out; no game access to `body.raw` | AC-3–AC-5 |
| Weather and powder | Snow scene → extracted game-owned effects → `GPUParticles3D` | Replaces source-local pooling; appearance remains under `src/render/` | AC-6 |
| Starter generation | Existing scaffolder `packages/create-threenative/src/index.ts` → `--template snow` | Adds one source template; no new CLI command or genre registry | AC-6 |
| Capability discovery | Existing generator → both shipped manifests → MCP search/detail in a generated project | New exports and focused situations; no handwritten manifest entries for real APIs | AC-7 |

Proposed file paths become actual entry-point references when their owning phase lands.

## Decisions

- 2026-09-30 (João): extract the HTML's existing raw snow code into abstractions and include them in engine capability discovery; write the PRD now.
- 2026-09-30 (planning): physics acceptance explicitly includes spheres, not just character steps. Reuse the existing terrain, bodies, particles and scaffold mechanisms; the snow starter owns its look.
- 2026-10-01 (implementation, measured): native snow surfaces are Rapier heightfields, not the planned canonical-sample trimesh. The trimesh adapter worked (web/native surfaces agreed within 1e-4 m) but rebuilding it on native took 101 ms at 321 samples and 179 ms at 401 (cargo micro-benchmark), so every footstep hitched the desktop host; a heightfield rebuild copies samples only (0.24 ms / 0.38 ms). Native now receives the same column-major samples the web backend hands Rapier, so both runtimes build one surface by construction.
- 2026-10-01 (implementation, measured, withdrawn): powder takes no energy from what moves through it. Building the sandbox demo showed a 10 kg ball at rest on the kit's 7% glade slope rolls about 4 m off its tee, and a pushed ball is still moving at 0.7 m/s four seconds later. Three rolling-resistance models were added to `attachSnowPhysics` and measured on real Rapier (soft-ground `sqrt(sinkage/width)` drag at the centre, the same at the rolling lever, compaction work), plus a force-couple torque swept headless; none held on both backends (native desktop over-spun, roll ratio 5.9, reach 0.47, so the kit's native scenario failed 3/3), so the feature was reverted rather than shipped half-right. The binding deforms snow without taking energy; snow rolling resistance is open engine work. The attempt surfaced a real seam bug, now fixed on web and native with tests: `applyForceAtPoint`'s torque was never cleared, so it kept spinning a body up after its step.
- 2026-10-01 (merge of develop PRD-470/471/472/474, root-caused and fixed): after the merge the kit's `production-performance` read frame p95 39.9–44 ms against its 33 ms ceiling. Develop's loop now leaves boot frames out of the window, which exposed an existing cost. The slow frames are the runner's `waitTicks` bursts, about 8–10 fixed steps per presented frame, and each step cost about 2.5–3 ms on web. Most of that was the explorer's `CharacterBody3D`: Rapier sweeps a character capsule against every collider triangle under it, so one capsule `castShape` costs 0.04 ms on a 51² heightfield and 0.63 ms on the kit's 401² (6 cm) snow. Squeezing 401² into 6 m costs 8 ms, and splitting it into 8×8 tiles changes nothing, so the cost is triangles under the sweep, not collider size. Disabling the explorer's movement alone took the physics step from about 1.3 to 0.4 ms. Fix, in the kit: the explorer collides with a coarse walk surface (ground plus fresh snow, 101², 24 cm; `walkSurface`/`WALK_SAMPLES` in `src/terrain.ts`), on its own collision layers that leave the snow collider to the ball, crate and log. Its drawn height and boots already came from the canonical snow, so nothing visible changes. Engine: the binding now compares only the window written since its last collider rebuild, through the new `Heightfield.trackChanges()`, instead of the whole field each step. Result, threshold unchanged: the scenario's p95 is 27.5 and 30.0 ms (27.8 on the first run); `TN_TEMPLATE_ONLY=snow pnpm test:templates` exit 0 with all 7 scenarios; native `snow-physics` 3/3 and `survives` pass.
  - What a player gets, as distinct from the runner's tick bursts: a wall-clock run (`__THREENATIVE_PLAYTEST_CLOCK__ = "wall-clock"`, 10 s of walking at 1920×1080, NVIDIA Turing). Before: 130–195 fps, per-frame p95 14.2–17.1 ms, update p95 2.8–3.8 ms, 1,024-sample p95 16.7 ms. After: 158–248 fps, per-frame p95 12.8–14.3 ms, update p95 1.7–2.3 ms, 1,024-sample p95 15.2 ms. Both were already above 60 fps on this desktop; the step cost matters most on slower devices.
  - Trade-off: the explorer's capsule no longer drops into its own prints or the ball's crater; it walks at fresh-snow level over a 24 cm surface. Its drawn body and boots never followed the capsule (they come from the canonical snow and the gait's IK), so the frame does not change. A re-capture of the walking kit (`snow-kit-webgpu-1440x900.jpg`, `snow-kit-webgpu-surface-view-1440x900.jpg`, refreshed) shows the same prints, and the boots plant in them. AC-3/AC-4 are untouched: the ball, crate and log still press the 6 cm snow through `attachSnowPhysics` (`snow-contacts.spec.ts` 14/14 unchanged), and footfalls still stamp it.
  - `Heightfield.trackChanges()` stays because it is not a micro-win. On a kit-sized 401² field where the surface changes every step (a rolling ball), the binding cost 1.29–1.45 ms per step comparing the whole field and 0.89–0.91 ms comparing only the changed window, about 0.4 ms a step (node, real Rapier). Existing callers see no behaviour change: `updateHeights` only unions into live trackers, and `takeDirtyRegion` is untouched. Unit-tested in `world-heightfield.spec.ts`; the class's capability entry names it.
- 2026-10-01 (implementation, unexplained engine issue): in the snow kit a bloom threshold of 0.92 left the native Linux desktop frame blank behind the HUD (Dawn/Vulkan, RTX 2080) while the web rendered it correctly; thresholds 0.2 and 0.7 rendered on native. Not root-caused. The kit ships with bloom off (its glints come from the snow material), recorded in `templates/snow/src/render/quality.ts`; the coordinator shared the finding with the rain lane, which also uses bloom natively.

## Current state (this branch)

Phases 1 and 2 are complete and verified. Phase 2 landed the persistent-contact and in-place
collider-refresh operations on both backends (`readContacts`, `setColliderShape`; Rust
`tn_physics_read_contacts`/`tn_physics_set_heightfield_shape`), `attachSnowPhysics` with
`observe()`/`loadOf()`, and the generated snow game's `snow-physics.playtest.json` passing on
browser WebGPU and on the native Linux desktop host. Phase 3's kit passes all seven packed web
scenarios, capability discovery is verified through the shipped MCP server, and the repository
gates pass on the final branch. The rain kit (PRD-473) is merged into this branch.

Visual record, `docs/verification/PRD-469/` (JPEG, about 0.7 MB for the kit set): the kit at
`snow-kit-webgpu-1440x900.jpg`, `-1024x768.jpg`, `-390x844-touch.jpg`, `-blizzard-1440x900.jpg`
and `-surface-view-1440x900.jpg`; physics proof at
`physics-sphere-track-box-capsule-dents-webgpu.jpg`, `physics-compaction-view-webgpu.jpg` and
`physics-sphere-track-native-desktop-1280x720.jpg`; the supplied ICEFIELD document at the same
three viewports as `reference-icefield-*.jpg`.

## Sandbox demo

**Snow Putt**, a small game built cold on the kit: `sandbox/snow-demo` in the shared sandbox
repository, commit `08b84cb1ee55691a242aadee463123aa034dc295` (local, not pushed), scaffolded with
`--template snow` from this branch's packed tarballs. Push the ball into a cup pressed into the
`SnowField`, within six pushes, before a 90 s clock runs out; the cup and the tee lie are
`snow.stamp` calls, the ball's roll and crater come from `attachSnowPhysics`.

| Scenario | Target | Result |
| --- | --- | --- |
| `playtests/putt-win` | browser WebGPU (NVIDIA Turing) | pass, holed in 2, identical across 3 runs |
| `playtests/putt-lose` | browser WebGPU | pass: clock runs out (lost, reason time), R opens a fresh round |
| `survives`, `footsteps`, `weather`, `touch-controls`, `performance` | browser WebGPU | pass |
| `native-playtests/putt-win` | native Linux desktop | pass 6/6 (holed in 3–5) |
| `native-playtests/survives` | native Linux desktop | pass |

Friction (the demo's `FRICTION.md`): powder takes no energy from a rolling ball (open engine work,
see Decisions); `applyForceAtPoint` left its torque behind (fixed, `f2812dd60`); native runs of one
build vary; the kit's own ball leaves its tee at load. Captures:
`sandbox-snow-putt-won-webgpu-1280x720.jpg`, `sandbox-snow-putt-mobile-webgpu-390x844.jpg`,
`sandbox-snow-putt-won-native-desktop-1280x720.jpg` (0.19 MB).

## Execution Phases

### Phase 1: Source-derived numerical snow abstractions

**Status:** COMPLETE

**Files:** proposed `packages/core/src/snow-field.ts`; existing `packages/core/src/world.ts` and `world-package.ts`; focused `packages/core/__tests__/snow-field.spec.ts`; `docs/architecture/CHARTER.md` and core ownership instructions.

**Implementation:** Recover/type the source's state, sampling, deformation and sparse recovery. Add the smallest canonical heightfield mutation path. Separate boot geometry, movement tuning, texture encoding and weather appearance from numerical response. Preserve a minimal source-derived regression fixture. Add public export metadata with compilable examples; do not invent a new GPU solver.

- [x] AC-1 [local, actor: implementation agent]: Public `SnowField` reproduces the source's footprint-state and deposition behavior, including reset, depth changes and invalid-input rejection. proof: `pnpm exec vitest run packages/core/__tests__/snow-field.spec.ts packages/core/__tests__/world-heightfield.spec.ts` — Evidence: 32/32 pass (18 snow-field, 14 world-heightfield). `packages/core/__tests__/fixtures/snow-field-source.json` was produced by evaluating the supplied document's own `SnowField` (lines 85–193, sha256 `85b1708…02f7`) over one deterministic scenario; the public `SnowField` replays it to within 1e-9 on all four channels at 672 sample points with an identical active-cell count at every stage (995 stamps → 875 recovered → 875 depth-changed → 0 reset). Includes penetration equality per contact, reset/depth behaviour, canonical-surface composition, render/collider agreement < 0.001 m, and rejection of malformed area/load/duration/extent/depth.
- [x] AC-2 [local, actor: implementation agent]: Generalized pressure/profile input produces distinct boot and circular imprints with area-dependent response and presentation-rate-independent integration. proof: `pnpm exec vitest run packages/core/__tests__/snow-field.spec.ts -t "contact profiles"` — Evidence: 5/5 pass. A source boot print and a `snowDiscFootprint` of equal area leave measurably different imprints; a `π/2` rotation transposes the boot's long axis; the same load concentrated over 0.02 m² digs > 0.05 m deeper than over 0.4 m² and > 0.02 m deeper than an eighth of the load; one 0.3 s contact equals eighteen 1/60 s contacts to 1e-6; a rotated box footprint leaves a rectangular print; and a rolling sphere leaves a connected track rather than one repeated hole.

**Verification:** Tests invoke the exported abstraction, compare source-derived expectations, and assert dimensional/edge handling and canonical-surface invariants. Write test-first missing-behavior assertions during implementation, not artificial failures during this planning task.

### Phase 2: Physical bodies deform and collide with the same snow

**Status:** COMPLETE

**Files:** proposed `packages/physics/src/snow.ts`; existing physics exports, `simulation.ts`, `plugin.ts`, native `host.ts` and relevant runtime-native physics bridge/Rust implementation if the missing bulk operations require them; `packages/physics/__tests__/snow-contacts.spec.ts`; shared snow scene and `snow-physics.playtest.json` fixtures introduced for the starter.

**Implementation:** Wire solved supported contacts to `SnowField`; add minimal persistent-contact and dirty-collider refresh operations at the shared backend seam. Reuse native trimesh support first. Preserve ordering, collision filters, body identity, wakeup and cleanup. Exercise real Rapier with source-derived material values; do not mock the solver for acceptance. Include an airborne interval, drop, rest, lateral push, loaded recovery and a field reset.

- [x] AC-3 [local, actor: implementation agent]: A real sphere falls, settles within the stated surface tolerance and rotates through a continuous circular snow track; airborne intervals do not stamp. proof: `pnpm exec vitest run packages/physics/__tests__/snow-contacts.spec.ts -t sphere` plus the browser `snow-physics.playtest.json` included in AC-6's generated-project run — Evidence: 6/6 sphere tests pass against real Rapier 0.19.3 (no solver mock): 0 loads during 15 airborne steps, settled underside within 0.02 m of the surface it pressed, push rolls ≥ 1 m with turn×r/distance in 0.8–1.2 and every sample along the path pressed (connected, circular, nothing beyond 1.6 r), collider within 0.001 m of canonical after every step and ≤ 1 step behind a game-side reset, triangle interiors within 0.01 m by ray cast, a sleeping sphere re-seats after `setDepth`, 30/60/120 Hz presentation within 0.001 m, a sideways shove digs no pit. Browser: `TN_TEMPLATE_ONLY=snow pnpm test:templates` exit 0 (2026-10-01, NVIDIA Turing adapter on every run) — `snow-physics` passes: airborne at `falling`, settled at `settled`, 0 airborne loads, reach ≥ 1 m, roll ratio in band, 0 track gaps, `colliderError`/`renderError` ≤ 0.001, `loadProvenance` `solver-impulse-per-step`.
- [x] AC-4 [local, actor: implementation agent]: Box/capsule support uses shape-appropriate contacts and survives recovery/reset without stale colliders or cross-field deformation. proof: `pnpm exec vitest run packages/physics/__tests__/snow-contacts.spec.ts -t "box|capsule|lifecycle"` — Evidence: 8/8 pass. A yawed box presses its own rotated face (1.0 m side along z, untouched 0.4 m off its 0.25 m half-width); a fallen capsule presses a trough along its spine and an upright one a disc; x- and z-sloped fields hold a box at surface + half-height/cos within 0.03 m (a transposed collider is > 0.09 m off); recovery and `reset` keep the same collider identity with the sphere re-seated within 0.02 m; two fields in one world route contacts only to the touched field (the other: 0 steps, 0 active cells, 0 contacts); scenery-supported bodies press nothing and a removed body stops stamping; unsupported shapes throw naming sphere, box, capsule.
- [x] AC-5 [local, actor: implementation agent]: The generated snow game meets the sphere/contact and canonical-surface assertions on the native Linux desktop host. proof: `pnpm build:desktop && pnpm exec threenative-playtest --scenario playtests/snow-physics.playtest.json --target desktop --executable dist-native/snow-proof` from the packed generated project named `snow-proof` — Evidence: exit 0 on 5/5 consecutive runs (2026-10-01, after the native heightfield change; 3/3 before it) from a `snow-proof` scaffolded outside the workspace from packed tarballs; `runtime: native`, NVIDIA RTX 2080 via Vulkan; `native-playtests/survives.playtest.json` exit 0 on the same build. The packed runtime ships no prebuilt host, so `THREENATIVE_RUNTIME_BINARY` pointed `build:desktop` at this branch's `pnpm native:build` output (exit 0). Below the game: `cargo test --release` in `runtime-native/native/physics` green including `tests/snow_contacts.rs` (heightfield create/refresh, airborne → 0 records, resting load within 2× of m·g, sleeping → 0, a lowered surface wakes and re-seats the ball, malformed refreshes refused); `native-contract.spec.ts` 23/23 (heightfields cross as their own column-major samples; old runtimes fail closed). Native frame: `docs/verification/PRD-469/physics-sphere-track-native-desktop-1280x720.jpg`.

**Verification:** Use the same physics scenario/telemetry on browser and desktop, with captured nonblank frames and solver-derived poses. Report canonical/render/collider versions, maximum surface error, load provenance and supported-contact counts through the existing registry/state observation bridge. A changed snow surface alone does not prove physical support; assert both deformation and the sphere's actual solved height/rotation. Native behavior proof lands with its portable seam changes.

### Phase 3: Discoverable, packed snow starter kit

**Status:** COMPLETE

**Files:** `packages/create-threenative/templates/snow/` with portable scene/entities, editable `src/render/`, controls, instructions and playtests; existing scaffold/playtest/look/convention tests and `scripts/visual-gate.ts` template inventory; manifest/reference generators, existing MCP search/server tests and recall corpus. Generated mirrors/manifests follow their generators.

**Implementation:** Recover the supplied scene/effects into the smallest useful kit, reusing the new public snow APIs rather than copying their implementation back into the template. Install local tarballs through the existing template harness. Extend capability situations and constraints, synchronize instructions/MCP files, and inspect browser/native captures against the supplied snow appearance. Keep weather transitions and sound/game feel editable in source.

- [x] AC-6 [local, actor: implementation agent]: A packed `--template snow` game boots and plays on browser WebGPU with source-derived footsteps/weather/powder controls and the sphere physics scenario. proof: `TN_TEMPLATE_ONLY=snow pnpm test:templates` — Evidence: exit 0 (2026-10-01, on the rain + snow merge; the kit is byte-identical to the final branch), NVIDIA Turing adapter on every scenario: `snow-real-frame-boot`, `survives`, `snow-footsteps`, `snow-weather`, `snow-touch-controls`, `snow-physics` and `production-performance` all pass. Native re-run on the merged tree: `native-playtests/snow-physics` 4/4 and `survives` exit 0 from a freshly packed `snow-proof`. Captures inspected: see the visual record above.
- [x] AC-7 [local, actor: implementation agent]: Snow mechanic queries discover the public field/binding through actual MCP search/detail, and returned examples compile against packed exports. proof: `pnpm build && pnpm capabilities:check && pnpm caps:recall` and `pnpm exec vitest run packages/engine-mcp/__tests__/search.spec.ts packages/engine-mcp/__tests__/server.spec.ts packages/engine-mcp/__tests__/capability-examples.spec.ts` — Evidence: `pnpm build` 0; `pnpm capabilities:check` fresh (374 entries, 362/362 package-backed entries resolvable from scaffolds); `pnpm caps:recall` 0 (83 rows, recall 0.916, 9 snow rows); engine-mcp search/server/capability-examples 71/71. In the packed `snow-proof`, the shipped server (`node_modules/@threenative/core/mcp/engine.mjs` over stdio, as its `.mcp.json` launches it) answers "leave footprints in deep snow that stay where the player walked" with `attachSnowPhysics`, `SnowField` first and "drop a heavy ball into powder snow so it sinks and carves a track" with `attachSnowPhysics`, `SnowField`, `GPUParticles3D`, `snowDiscFootprint`; `engine_capability_detail` returns both with their `@threenative/core/world` / `@threenative/physics` imports, and the kit that calls both type-checks and builds against the packed exports.
- [x] AC-8 [local, actor: implementation agent]: The completed implementation passes repository checks without changing unrelated games or weakening native/assertion guards. proof: `pnpm typecheck && pnpm lint && pnpm test && pnpm budgets && pnpm check:docs` — Evidence: all exit 0 on `de581effa` (2026-10-01, rain + snow merged). `pnpm test`: root 526 files / 6,567 tests passed (9 skipped), runtime-native 132 files / 1,558 tests; `pnpm budgets` includes the 72 MB evidence cap (docs/verification 67.4 MB before this PRD's 0.77 MB of captures) and the regenerated native coverage report; `pnpm sync:agents --check` and the MCP config check are clean. No other template's scaffold hash moved; no assertion or native guard was relaxed (the powder-resistance attempt that would have widened the kit's roll-ratio band was reverted, see Decisions).

**Verification:** Before runtime claims, scaffold `snow-proof` with the existing local-package overrides and run its browser/native scripts. Check source-independent installation and default-exported native game entry. Run `pnpm sync:agents` and `pnpm sync:mcp` for changed generated instructions/configs. Keep routine results beside these boxes; create no separate verification report. Run `pnpm prd:progress` after each phase; finish the implementation in one PR targeting `develop`, and move this PRD to `done/` only when every required result is verified.

## Planning validation

2026-09-30: `pnpm check:docs` passed (2,370 relative links); the six required prose-lane Vitest files passed (180 tests); `git diff --check` passed. `pnpm prd:progress` reports 0/3 phases, 0/8 boxes, `prd:0%`. Only this new PRD was authored for this request. All implementation acceptance remains unticked.
