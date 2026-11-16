# PRD-893 — Racing kit: drift, nitro and race feel

Status: IN PROGRESS, owner approved all three phases on 2026-11-15. PR: #680 (one PR for this session's racing work).

**Priority:** P2 — drift, nitro, tire effects, the six-car field, the gear HUD, the car's sound and the
visual judge are in. Open: the owner's test drive.

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
- [x] Nitro tank 0..1 held on Space (and gamepad button 0), with the NFS Most Wanted engage, drain, delay and refill rules. Drifting refills it faster. The thrust is the existing boost. proof: `nitro.playtest.json` on headed WebGPU passes on every bound: the tank is 0.265 at the `coast` sample (≤ 0.35, so it was burned down before the slide), `nitroDriftGain` 0.125 after the drift (≥ 0.1 — the drift path is the only writer), top speed past `FEEL.topSpeed`, and `drifting` true at the `hold` sample with 0 spins. The rate claim is proved where it can be measured exactly: `racing-feel.spec.ts` runs both fill paths for three seconds at the same speed and requires the drift to add more than four times the passive refill (0.75 against 0.09 a tank), and pins NFS's engage at 4.5 m/s, stay-on down to half of it, and the disengage delay
- [x] Nitro FOV +10° and a 0.8 m pull-back that ease back, and an exhaust flame. proof: `nitro.playtest.json` on headed WebGPU: `fovPeak` 65.99 against the 56° base lens, and `fov` 56.38 at the `coast` sample, so the lens came back; `flameTicks` ≥ 60. The reading is the camera's own `camera.fov`, published as `fov`/`fovPeak`, so a lens that stops widening fails the scenario rather than being restated from a constant (`BASE_FOV` is now exported rather than copied)
- [x] Tire smoke and skid marks from the rear wheels only, and only while they slide on the road. Cloned from the kart kit's `SkidMarks` and dust emitter. proof: `drift.playtest.json` passes on WebGPU: 0 skid marks after the straight, 42 after the drift, smoke on 33 ticks
- [x] Visual judge on the drift and nitro pose. proof: a fresh read-only judge (it wrote nothing in this worktree) returned **IMPROVEMENT** on both sheets and overall, from two runs per arm on headed WebGPU against a real adapter (`webgpu:architecture=turing|vendor=nvidia`). The first pass returned **REGRESSION** on the drift frame — the smoke read as a detached foreground plume and the 0.26 m rubber strips were invisible under it — so the fix was in the look: skid strips widened to 0.34 m (`render/skids.ts`) and the smoke thinned to 0.3 opacity growing to 2.0 m (`render/effects.ts`). Re-judged frames: smoke puffs at the rear wheels, two dark parallel marks tracing the slide, `DRIFT +25` popup, gear and nitro readouts legible over both sky and road. What the judge still names, and this PRD does not claim fixed: the spark trail reads as two constant-width rods rather than tapering flame, and a press of the popup outlives 1.6 s of *game* time in a capture because the timer runs on wall clock while the harness advances ticks faster than real time (a player sees 1.6 s)

### Phase 3 — HUD, sound, integration
- [x] HUD: speed in km/h, gear and rpm (display only, NFS Most Wanted rpm smoothing), a nitro bar and a drift score popup. proof: `hud.playtest.json` on headed WebGPU — `gear` ≥ 3 (it reaches 6 through the box), `rpm` ≥ 0.3 (it reaches 1.0), `driftLast` ≥ 5 and `driftsBanked` ≥ 1, with `topSpeed` ≥ 15 m/s so the car demonstrably drove; and the visual judge saw criterion C MET on both sheets (`SPEED 67 / GEAR 5 /6` with a filled rev bar, `NITRO READY` and bar, `DRIFT +25` popup, all legible over road and sky). `src/gauges.ts` is six bands with NFS's capped needle fall and 55/45 blend, proved as maths in `racing-feel.spec.ts` (the whole box is climbed on one pull, the needle never leaves 0..1, a closed throttle falls no faster than the cap and settles at idle in first, reverse reads as idle rather than a negative band)
- [x] Sound through `AudioBus`, with CC0 clips from the asset MCP recorded in `CREDITS.md`: an engine loop pitched by rpm, a tire squeal by drift angle, and a nitro burst. proof: `racing-feel.spec.ts` runs the shipped clips through `audioPass` with the config's own declarations — both beds declared `loop: { crossFadeMs: 0 }` and the burst not a loop — and requires `seamRatio` ≤ 1 on the **cooked** bytes (Vorbis round trip: engine 0.05); the cook in `pnpm build:web` prints `bytesBefore` 176444 → `bytesAfter` 15148 with `crossFadeMs: 0`. `hud.playtest.json` sees the engine rate rise with speed: 0.692 at idle, `engineRate` ≥ 1 at the end (1.98–2.05 measured, `ENGINE_SOUND` maps the needle 0.62× → 2.05× geometrically). Two findings to record rather than bury: **(a)** the asset MCP's catalogue carries no engine, tyre or boost clip (Kenney's curated packs are CC0 UI and jingles; the Sonniss bundles are multi-gigabyte archives under the Sonniss bundle licence), so the three clips are **synthesised** by `tools/make-racing-audio.mjs` and `CREDITS.md` says so with that evidence; an engine bed pitched 0.62× → 2.05× has to be tonal and exactly periodic, which a recording is not. **(b)** the native host binds a source's `playbackRate` as a *passive* parameter, so on native the bed plays at rate 1 with the same volume, squeal and burst — named in `src/audio/engine.ts`, and no native pitch is claimed here
- [x] All racing playtests pass and the rival and autopilot laps do not change. `kit-racing.md` lists the new controls. proof: **17 of 17** scenarios pass in one run of the scaffolded template (`pnpm test`, headed WebGPU, real adapter), the two new ones included; `outcome.playtest.json` is the 3-lap autopilot race and still finishes P6 of 6 with 0 rescues, and `performance.playtest.json` still holds its 10 ms bound. `kit-racing.md` names `gauges.ts`, `audio/engine.ts`, the bake tool, the native pitch gap and the HUD; the template `AGENTS.md` mirror carries the new `src/` entries and the new scenario count from `pnpm sync:agents`; `pnpm scaffold:pin` moved racing's `kit` pin; `scaffold.spec.ts` 79/79. One red the previous commit left behind, fixed here: `racing.spec.ts` still read the two-car `GRID_DISTANCE`/`GRID` API that the six-car grid replaced, so two grid tests failed on `develop`'s tip — rewritten against `GRID_SLOTS`/`PLAYER_SLOT` (six slots, staggering, pole-to-player pitch, every slot short of the line), 17/17

## Acceptance criteria

- [ ] Owner test drive on the dev URL: drift, nitro, smoke, skid marks, HUD and sound all work, with no camera or car shake. proof: owner confirmation on #680. **Not claimable from here** — every automated proof above runs, and `steady-camera.playtest.json` still holds the shake meter, but the drive is the owner's

## Risks

- A low rear grip on a ray-cast vehicle can spin the car instead of drifting it. Phase 2 tunes the
  rear grip and the counter-steer help from measurements, and the playtest fails on a spin.
- Sound needs licensed clips. If no CC0 clip passes the loop-seam check, Phase 6 stays open with
  the reason.
