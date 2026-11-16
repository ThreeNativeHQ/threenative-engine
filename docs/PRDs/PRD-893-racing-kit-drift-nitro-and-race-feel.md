# PRD-893 — Racing kit: drift, nitro and race feel

Status: IN PROGRESS, owner approved all three phases on 2026-11-15. PR: #680 (one PR for this session's racing work).

**Priority:** P2 — drift, nitro, tire effects and the six-car field are in; the gear HUD, sound and the visual judge are open.

## Goal

The racing kit gets the main features of an arcade racing game: a handbrake drift, a nitro tank
that drifting fills, tire smoke and skid marks, a nitro camera kick, a speed, gear and nitro HUD,
and engine sound. Each feature is shared by the player car and keeps the rival and the autopilot
working.

Owner, 2026-11-15: "add effects like dift etc, check reverse engineering MCP. nitro etc. all major
racing game features". Later the same day: "space to nitro pleaes", "should be realistic like drift
leave marks on the ground", "i feel car still a bit slow", "sometimes it should skid by itself on
sharp curves (not necessarely pressing Shft)" and "make sure we're balanced with competitors, add
other competitors".

## References (mechanics only, no code)

- Drift detection and score: VDrift `src/game.cpp:2595-2637`, `src/timer.h:158,212`. The drift
  starts when the angle between heading and velocity passes 0.2 rad and ends below 0.1 rad. Past
  90° the slide is a spin and scores nothing. The score is the drift distance plus 0.5 × peak speed
  plus 40 × peak angle / π. A drift that scores under 5 points is not banked.
- Nitro tank: NFS Most Wanted `EngineRacer.cpp:926-976`. The tank (capacity 1) drains over a
  discharge time. Nitro engages at 10 mph or more and stays on down to half that speed. A
  disengage delay runs before the refill starts.
- Gear and rpm display: NFS Most Wanted `EngineRacer.cpp:606-907`. The rpm falls at a capped rate,
  and each update blends 55% new rpm with 45% old rpm.
- Slide feel: NASCAR 98 `lateral-slide` (counter-steer bleeds the slide off faster), and OpenNFS
  `chassis-stabilizers` (`src/Physics/NFS4VehiclePhysics.cpp:876`).
- Kart kit, the code to clone: `render/skids.ts` (instanced skid marks), `render/effects.ts`
  (pooled `GPUParticles3D` dust and sparks), `render/camera.ts` (boost FOV +8°).

## Built-ins

- `VehicleBody3D` (`@threenative/physics`): `engineForce`, `brake`, `steering` and
  `wheelContact(i)`. It has no runtime setter for wheel grip, so a handbrake cannot lower the rear
  grip. Phase 1 adds that setter to the engine, because every car game needs it.
- `GPUParticles3D` (`@threenative/core`) draws the smoke. `AudioBus` (`@threenative/core`) plays
  the sound, and `audioPass` (`@threenative/assets`) checks the loop seams.
- The existing boost (`FEEL.boostForce`, `FEEL.boostTopSpeed`, boost pads) is the nitro thrust.
  Nitro reuses it and adds no second boost path.

## Phases

### Phase 1 — Handbrake drift
- [x] Engine: `VehicleBody3D.setWheelFrictionSlip(index, value)`, because no setter exists for wheel grip. It throws on an index out of range or a value that is not finite. proof: `vehicle-body.spec.ts` + `native-contract.spec.ts` 41/41, `cargo test --lib` 25 passed (`a_rear_grip_drop_lets_the_tail_slide_and_bad_grip_is_refused`), `native_bindings.cpp` `-fsyntax-only` exit 0
- [x] Shift (the brake key, gamepad button 1, the touch brake) with the wheel turned at speed is the handbrake drift. It lowers the rear grip, the grip comes back over 0.3 s, and counter-steer catches the slide. The VDrift hysteresis and score are in the state as `drifting`, `driftAngle` and `driftScore`. proof: `drift.playtest.json` passes on WebGPU: 1 banked drift, 0 spins, `drifting` true during the hold; headless sweep at 15 and 24 m/s: 29-30° held slide, 0 spins

- [x] Owner additions: top speed 26 m/s (nitro 34) on a flat-then-fading torque curve; full lock above 16 m/s lets the tail go with no handbrake; five rivals on a staggered six-car grid at fixed paces 25 to 21.8 m/s, the player last. proof: `drift-natural.playtest.json` (banked drift, no Shift, 0 spins) and `outcome.playtest.json` (3 autopilot laps, P6 of 6, 0 rescues) pass on WebGPU; `performance.playtest.json` passes at 10 ms frames, triangle cap 105,000 -> 135,000 for the four extra cars (measured 126,202)

### Phase 2 — Nitro and effects
- [ ] Nitro tank 0..1 held on Space (and gamepad button 0), with the NFS Most Wanted engage, drain, delay and refill rules. Drifting refills it faster. The thrust is the existing boost. proof: `nitro.playtest.json` asserts that a drift fills the tank, nitro drains it, and the top speed goes past `FEEL.topSpeed`. Open: the drain and the top speed pass on WebGPU; the drift refill is not asserted yet
- [ ] Nitro FOV +10° and a 0.8 m pull-back that ease back, and an exhaust flame. proof: `nitro.playtest.json` asserts that the FOV rises, then returns. Open: the flame is asserted (`flameTicks` ≥ 60), the FOV is not yet
- [x] Tire smoke and skid marks from the rear wheels only, and only while they slide on the road. Cloned from the kart kit's `SkidMarks` and dust emitter. proof: `drift.playtest.json` passes on WebGPU: 0 skid marks after the straight, 42 after the drift, smoke on 33 ticks
- [ ] Visual judge on the drift and nitro pose. proof: a fresh judge returns IMPROVEMENT on headed WebGPU, two runs per arm

### Phase 3 — HUD, sound, integration
- [ ] HUD: speed in km/h, gear and rpm (display only, NFS Most Wanted rpm smoothing), a nitro bar and a drift score popup. proof: the visual judge on the HUD frame, and a playtest of the HUD state
- [ ] Sound through `AudioBus`, with CC0 clips from the asset MCP recorded in `CREDITS.md`: an engine loop pitched by rpm, a tire squeal by drift angle, and a nitro burst. proof: `audioPass` checks the loop seam, and a playtest sees the engine rate rise with speed
- [ ] All racing playtests pass and the rival and autopilot laps do not change. `kit-racing.md` lists the new controls. proof: the 13 racing scenarios plus the new ones, `pnpm scaffold:pin`, `pnpm sync:agents`, and `scaffold.spec.ts`

## Acceptance criteria

- [ ] Owner test drive on the dev URL: drift, nitro, smoke, skid marks, HUD and sound all work, with no camera or car shake. proof: owner confirmation on #680

## Risks

- A low rear grip on a ray-cast vehicle can spin the car instead of drifting it. Phase 2 tunes the
  rear grip and the counter-steer help from measurements, and the playtest fails on a spin.
- Sound needs licensed clips. If no CC0 clip passes the loop-seam check, Phase 6 stays open with
  the reason.
