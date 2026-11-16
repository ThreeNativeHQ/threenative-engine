# PRD-893 — Racing kit: drift, nitro and race feel

**Status:** BLOCKED ON THE OWNER'S TEST DRIVE — every phase box is ticked and proven, and #680 merged
on 2026-11-16; what remains is the owner's confirmation drive (drift, nitro, smoke, skid marks, HUD,
sound, no shake, and a circuit that holds the car). The first drive found the left armco missing and
the grass drawn without a collider; the fix is in the follow-up PR and proved locally. Filed under
`docs/PRDs/BLOCKED/requires-owner-decision/` on 2026-11-15 under R6; the drive is owed again.

**Priority:** P2 — arcade-racing feature work: all three phases are in and proven; the one open item is
the owner's confirmation drive after the first drive's two fixes.

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
- [x] Visual judge on the drift and nitro pose. proof: a fresh read-only judge (it wrote nothing in this worktree) returned **IMPROVEMENT** on both sheets and overall, from two runs per arm on headed WebGPU against a real adapter (`webgpu:architecture=turing|vendor=nvidia`). The first pass returned **REGRESSION** on the drift frame — the smoke read as a detached foreground plume and the 0.26 m rubber strips were invisible under it — so the fix was in the look: skid strips widened to 0.34 m (`render/skids.ts`) and the smoke thinned to 0.3 opacity growing to 2.0 m (`render/effects.ts`). Re-judged frames: smoke puffs at the rear wheels, two dark parallel marks tracing the slide, `DRIFT +25` popup, gear and nitro readouts legible over both sky and road. Of the two nits the judge named, one is now fixed: a press of the drift popup outlived 1.6 s of *game* time in a capture because the HUD ran a `setTimeout` — the same wall clock also aged the popup while the race was paused, which a player sees. The clock moved to `DRIFT.popupSeconds`, counted down by the frame's own `dt` and published as `driftPopup`, so it freezes with the race and ends at exactly zero; `racing-feel.spec.ts` drives a drift past the bank threshold and holds the popup for its whole duration one tick at a time. The other is now fixed too, with its own judge pass: the spark trail read as two constant-width dotted rails down the road — at 110 km/h a 0.32 s life is seven metres, and the bursts were laid 0.5 m apart at 0.34 m wide, which is a dotted line by construction. The plume is 0.11 s long, stops where it was born (drag 6), leaves the nozzle at 0.55 m and dies at 0.08 m, three particles a tick. A fresh read-only judge on two runs per arm (same pose budget, `TIME 00:03.2`, `SPEED 110 KM/H`, `NITRO BURNING` in all four frames) returned **IMPROVEMENT** on both AFTER frames and C1/C2/C3 all MET: the two rails are gone, the effect is anchored at the exhausts and brightest at the nozzle, the car and HUD read unchanged. Its P2 note, recorded and not acted on: at 0.11 s the plume is near the edge of reading as a jet, and the two AFTER frames differ about 2× in visible tail (A2 is closer to a nozzle flash), so a longer life is the knob if it ever reads as a flash in play

### Phase 3 — HUD, sound, integration
- [x] HUD: the reference HUD from `/home/joao/Downloads/NEED.webp` replaces the old flat panels — top-left position + live six-row leaderboard (names, gaps, cyan player row), top-right `LAP n/3` + race clock + BEST/LAP, bottom-left circular circuit minimap, bottom-right 0–9 tach with the red 7–9 band, speed/gear, and the 12-segment nitro bar; the drift popup and outcome stay and the controls bar is gone because the reference has none. proof: `hud.playtest.json` on headed WebGPU — `gear` ≥ 3, `rpm` ≥ 0.3, `driftLast` ≥ 5, `driftsBanked` ≥ 1, `topSpeed` ≥ 15 m/s, and `driftPopup` 0 at `idle` / ≥ 0.3 after a drift, with the clock the drift's and not the HUD's; live runs on the scaffold gave `hud` 13/13, `drift-natural` 5/5, `rescue` 8/8 and `brake` 5/5. The `#boost` text is the DOM's `BURNING`/`ACTIVE`/`READY` again (uppercase, like the old HUD) because the `racing-shift-brakes-under-throttle` scenario asserts the text, not the CSS. The standings, minimap, lap panel and tach read live state (`rankings`, `CIRCUIT.at`, `gear`, `rpm`, `nitro`), and `src/gauges.ts` still carries the six bands with NFS's capped needle fall and 55/45 blend, proved as maths in `racing-feel.spec.ts`. A fresh read-only visual judge (two runs per arm, headed WebGPU, real adapter) returned **IMPROVEMENT** on the drift and rescue sheets and overall; its named nits were fixed in the same pass — minimap rival dots now visible with a cyan rim and a larger `N`, BEST cyan / LAP white with a divider and a larger lap count, a larger tach speed and thicker needle, mixed-case leaderboard names, and the drift popup back at `top-6`. Scene, car, opponents and camera are unchanged between the arms.
- [x] Sound through `AudioBus`, with CC0 clips from the asset MCP recorded in `CREDITS.md`: an engine loop pitched by rpm, a tire squeal by drift angle, and a nitro burst. proof: `racing-feel.spec.ts` runs the shipped clips through `audioPass` with the config's own declarations — both beds declared `loop: { crossFadeMs: 0 }` and the burst not a loop — and requires `seamRatio` ≤ 1 on the **cooked** bytes (Vorbis round trip: engine 0.05); the cook in `pnpm build:web` prints `bytesBefore` 176444 → `bytesAfter` 15148 with `crossFadeMs: 0`. `hud.playtest.json` sees the engine rate rise with speed: 0.692 at idle, `engineRate` ≥ 1 at the end (1.98–2.05 measured, `ENGINE_SOUND` maps the needle 0.62× → 2.05× geometrically). Two findings to record rather than bury: **(a)** the asset MCP's catalogue carries no engine, tyre or boost clip (Kenney's curated packs are CC0 UI and jingles; the Sonniss bundles are multi-gigabyte archives under the Sonniss bundle licence), so the three clips are **synthesised** by `tools/make-racing-audio.mjs` and `CREDITS.md` says so with that evidence; an engine bed pitched 0.62× → 2.05× has to be tonal and exactly periodic, which a recording is not. **(b)** the native host binds a source's `playbackRate` as a *passive* parameter, so on native the bed plays at rate 1 with the same volume, squeal and burst — named in `src/audio/engine.ts`, and no native pitch is claimed here
- [x] All racing playtests pass and the rival and autopilot laps do not change. `kit-racing.md` lists the new controls. proof: **17 of 17** scenarios pass in one run of the scaffolded template (`pnpm test`, headed WebGPU, real adapter), the two new ones included; `outcome.playtest.json` is the 3-lap autopilot race and still finishes P6 of 6 with 0 rescues, and `performance.playtest.json` still holds its 10 ms bound. `kit-racing.md` names `gauges.ts`, `audio/engine.ts`, the bake tool, the native pitch gap and the HUD; the template `AGENTS.md` mirror carries the new `src/` entries and the new scenario count from `pnpm sync:agents`; `pnpm scaffold:pin` moved racing's `kit` pin; `scaffold.spec.ts` 79/79. One red the previous commit left behind, fixed here: `racing.spec.ts` still read the two-car `GRID_DISTANCE`/`GRID` API that the six-car grid replaced, so two grid tests failed on `develop`'s tip — rewritten against `GRID_SLOTS`/`PLAYER_SLOT` (six slots, staggering, pole-to-player pitch, every slot short of the line), 17/17. **Re-run twice after the last code change**: from a fresh scaffold once the per-frame iterator fixes below landed
(17 of 17, `hud` and `nitro` included, `pnpm test` exit 0), and again after merging `origin/develop` into the branch
(17 of 17 again on the merged engine, and CI's own `golden-path-template (racing)` lane green on the same head), and a third full run on the head `f6b778462` after the nitro plume change (`pnpm test` in the scaffolded kit, 2026-11-15, exit 0, 17 of 17, every scenario `pass:true`). A fourth full run on 2026-11-16 after the reference HUD and the `#boost` text fix: `pnpm test` in the scaffolded kit, exit 0, 17 of 17 scenarios, 0 `pass:false`; the packaged build loads the grass through the compiled manifest (`grass/Grass004_color.0b7cd3c6.ktx2`, `_normal.923e2989.ktx2`, `_roughness.f71023ef.jpg`). develop's `ad057b044` merged in after that run and moves only renderer sources, so the merged candidate's own `golden-path-template (racing)` CI lane is the evidence that the kit still runs on the merged engine
- [x] The frames the template's own cost gate measures stay allocation-free, and the gates on this branch are green. proof: `template-runtime-cost.spec.ts` 10/10 — this branch had added ten array iterators per frame, found by that gate, all now indexed reads (two `for...of` over the field in `Race.ts`, `.entries()` over the ranking inputs, and the `gearBand`/`NITRO.refillBand` tuple destructures), and the scene's published rank reads P6 because six cars put the player on the back row and the fixture never touches the input. `pnpm lint` exit 0 (the bake tool had one template literal with no interpolation and a formatting drift — the same file still reproduces the committed clips, `--check` reports they match), `pnpm typecheck` exit 0, `pnpm quality` exit 0, `pnpm budgets` exit 0. The budgets gate had been red since phase 1: the native bindings edit moved the native coverage source digest, so `pnpm native:build` then `pnpm --filter @threenative/runtime-native native:coverage` re-measured the record (53 contract targets executed) and restamped it — `src/physics/native_bindings.cpp` is `TN_ENABLE_NATIVE_PHYSICS=OFF` in the coverage configuration, so the tables are unchanged and only the digest moves. A second restamp on 2026-11-16 after merging develop's `ad057b044` (it edits `src/engine/renderer/render_database.cpp` and `renderer_material.cpp`, both native coverage inputs): the merged digest moved to `f73780e2…`, the same command executed 53 contract targets with the same 3 disabled, the tables moved by at most 0.49 pp (`src/engine/` 83.86% unchanged, `src/webgpu/` 76.81 → 76.93%, `src/workers/` 85.69 → 85.20%, total 81.94 → 81.95%), every floor still passes, and `pnpm budgets` exits 0 on the merged tree

- [x] Owner-drive fixes: the natural slide is eased, and a car that leaves the surface is caught the tick it falls. proof: the owner drove it and reported two things — the no-Shift slide read as a snap (too intense, rough) and a car that got onto the grass fell out of the world. **Feel:** the rear grip changed in a single tick whenever the target flipped between `holdGrip` 0.35, `recoverGrip` 2.6 and `catchGrip` 4.5 as the steering crossed centre, which sawtooths a bristle tyre; both directions now ease, the rise over `GRIP_RETURN_SECONDS` 0.3 s as before and the fall over `GRIP_FALL_SECONDS` 0.05 s, and `racing-feel.spec.ts` measures the biggest single-tick grip change against the whole range it used to jump (**14/14**). **Void:** the grass is drawn and never collided (`Track.ts` says why: a 5 m grid under a banked 11 m ribbon is a ridge the car beaches on), so anything past the armco had nothing under its wheels. `TrackSector` now takes `groundAt` — the same `terrainHeight` the ground is drawn from — and rescues the tick the car is `fallDepth` 1.2 m below it, instead of waiting out the 0.65 s run-wide delay. Proved on headed WebGPU: `drift-natural`, `drift`, `hud`, `rescue` and the 11k-tick autopilot `outcome` all pass, so the tighter trigger does not fire on a crest, a banked corner or a berm

- [x] Owner-drive fix, round 2: the armco exists on both sides and the grass is solid. proof: the first drive after #680 left the start's **left** side (the grandstand side) onto the grass and fell out of the world. `barrierOffset` returns a distance, not a signed offset, and every caller had forgotten `side *`: both rails were built on the right and the left was open, which the "impossible to leave" comment had hidden. The rails are now one strip per side (alternating the sides in one strip would stitch a deck across the circuit) and their profile closes with a fifth point, so the inner face exists; the collider is an invisible wall from below the drawn grass to the rail's top, doubled with the opposite winding, because the rail floats 40 cm up and the chassis is lower than that. The drawn grass is a `Heightfield` collider sharing its grid (`@threenative/core/world`), lowered 0.4 m under the 12 m corridor so the 5 m grid cannot ride the banked ribbon, on `LAYER.field` so `TrackSector`'s road probe still sees only road; the `groundAt`/`fallDepth` rescue stays as the net for a jump or a gap. Proved on headed WebGPU: `pnpm test` **17/17** on the scaffold (`racing-rescue-transform`, `steady-camera`, `survives` and the rest, exit 0); `racing-rescue-transform` now ends with the car stopped against the left armco on the run-off, not on the grass; and a local drive with the off-road rescue delayed put the car on the grass at **67 km/h**, upright at the drawn surface, then back at the wall with the rescue restored. The one `TN_PLAYTEST_PAGE_CLOSED` in an earlier run was the browser, not an assertion; the clean rerun is 17/17

## Acceptance criteria

Every automated proof above is green; the acceptance judgement itself is the owner's, and it is
filed under Blocked on. The kit is accepted when the owner drives it on the dev URL and confirms,
on #680, every item below:

- **Drift** — Shift with the wheel turned at speed swings the tail out and a slide banks a score;
  full lock above 16 m/s lets it go with no handbrake; counter-steer catches it and no slide spins
  the car.
- **Nitro** — Space burns the tank, the lens widens and pulls back, the flame blooms, and drifting
  refills it about four times faster than cruising.
- **Smoke and skid marks** — two dark parallel strips under the rear wheels for the length of the
  slide, smoke from the rear wheels only, nothing on the grass.
- **HUD** — speed, gear climbing 1..6 with a rev bar, nitro BURNING/ACTIVE/READY, and `DRIFT +n`
  popping under the panel on a banked slide.
- **Sound** — an engine bed that rises in pitch with the revs, a tyre squeal in a slide, a burst on
  the nitro button, all silencing on pause.
- **Feel** — no camera or body shake while steering or after a long drive, and no shake at a rescue.

Controls: WASD or arrows drive, Shift drifts and brakes, Space is nitro, P is the autopilot, R
restarts.

## Blocked on

- **The owner's test drive on the dev URL** — the scaffolded kit is served at
  `http://127.0.0.1:5273` (`/tmp/racing-scaffold/racing`, `pnpm exec vite --host 127.0.0.1 --port
  5273`), built from the follow-up fix; `pnpm test` passes 17 of 17 there (2026-11-16). Unblocked by
  the owner driving it and reporting acceptance on the follow-up PR; no agent can make the feel call.

## Risks

- A low rear grip on a ray-cast vehicle can spin the car instead of drifting it. Phase 2 tunes the
  rear grip and the counter-steer help from measurements, and the playtest fails on a spin.
- Sound needs licensed clips. If no CC0 clip passes the loop-seam check, the sound box in phase 3
  stays open with the reason. (Settled: no catalogue clip fits, so the three are synthesised and `CREDITS.md` says
  so; the loop-seam check is a spec, not a hope.)
