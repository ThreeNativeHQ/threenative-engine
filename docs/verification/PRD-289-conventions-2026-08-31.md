# PRD-289 verification — conventions in generated templates

Date: 2026-08-31

## Applicability table

The PRD baseline names seven templates. The current repository also contains `sailing`, which was
added after that baseline; it is included here so every template currently scaffolded by the
repository remains covered by the drift gate.

Each source cell resolves to the named call in the generated source. An `N/A` cell records why the
convention is not applicable to that template. `scripts/check-template-conventions.ts` parses this
table, reads each template's `AGENTS.md`, and checks the TypeScript AST for the matching call.

| Template | GroundSnap | normaliseToMetres | attachToBone | AnimationPlayer |
| --- | --- | --- | --- | --- |
| action-rpg | `src/conventions.ts:33` | `src/conventions.ts:28` | `src/conventions.ts:32` | N/A — the mannequin's clips play through `SkeletalMesh3D` (`src/entities/Fighter.ts`), which extends AnimationPlayer |
| minimal | `src/conventions.ts:15` | `src/conventions.ts:14` | N/A — the template has no held object or character hand | N/A — no skinned or animated asset is loaded |
| platformer | N/A — the fox run places every body through its own physics character and keeps no generated conventions module | N/A — every model is authored in metres already and no generated conventions module rescales it | N/A — the template has no held object or character hand | N/A — procedural rig motion has no AnimationClip asset |
| puzzle | N/A — the vault keeps its own sandbox look and places crates and the warden through physics, with no generated conventions module | N/A — every model is authored in metres already and no generated conventions module rescales it | N/A — the claw carries crates through physics velocity, not a bone attachment | N/A — no skinned or animated asset is loaded |
| racing | N/A — vehicle suspension and snap-to-ground own floor contact | `src/conventions.ts:5` | N/A — the template has no held object or character hand | N/A — no skinned or animated asset is loaded |
| rain | N/A — the camera flies; no walking actor needs floor contact | N/A — procedural geometry is authored in metres; no imported model needs scaling | N/A — there is no held object or character hand | N/A — no skinned or animated asset is loaded |
| rts | N/A — every unit is placed by the simulation at its own ground height, so there is no rendered body to keep on a floor | N/A — every model is procedural in metres already, so no authored asset needs normalising | N/A — the template has no held object or character hand | N/A — no skinned or animated asset is loaded |
| runner | `src/conventions.ts:19` | `src/conventions.ts:18` | N/A — the runner carries nothing and has no character hand | N/A — the jump is an authored arc, not an AnimationClip |
| sailing | N/A — the ship is waterborne and uses buoyancy, not floor grounding | `src/conventions.ts:9` | N/A — the template has no held object or character hand | N/A — no skinned or animated asset is loaded |
| shooter | N/A — the soldier's floor contact is measured against the town's own collider boxes, and a corpse is settled onto the deck it fell on | `src/entities/Enemy.ts:848` | `src/entities/Enemy.ts:854` | `src/entities/Rifle.ts:136` |
| snow | N/A — the procedural explorer plants each boot on the canonical snow surface (`src/entities/Explorer.ts`), and no authored model is grounded | N/A — every body is built from primitives in metres; no authored model is loaded | N/A — the template has no held object | N/A — the gait is procedural IK, not an AnimationClip |
| starter | `src/conventions.ts:15` | `src/conventions.ts:14` | N/A — the template has no held object or character hand | N/A — the native proof asset is static and has no AnimationClip |
| tower-defense | N/A — every tower, walker and pad is placed by the simulation at ground level, so there is no rendered body to keep on a floor | N/A — every model is procedural in metres already, so no authored asset needs normalising | N/A — the template has no held object or character hand | N/A — no skinned or animated asset is loaded |

Updated 2026-09-02: the `shooter` kit became first person. Its `GroundSnap` now measures the legs
the player sees when they look down rather than a third-person body, and `normaliseToMetres` and
`attachToBone` size and hold the camera-space viewmodel. Same three calls, same file, new lines.

Updated 2026-09-28 (PRD-470): the `shooter` kit became the Bayview town firefight. The generated
`src/conventions.ts` is gone with the arena: the first-person player has no skinned body to ground,
and the three calls that remain moved to the rig that does — the Quaternius mannequin normalised
at its `Head` joint, the procedural rifle welded to `hand_r`, and the mixer beside the entity.

## Observable call evidence

`pnpm exec vitest run packages/create-threenative/__tests__/template-conventions.spec.ts scripts/__tests__/check-template-conventions.spec.ts --reporter=dot`
passed 2 files and 14 tests. The template suite checks finite non-unit normalization factors,
finite `GroundSnap.clearance` whose magnitude decreases after correction, and `RightHand` being
reported by `skeletonBones` and resolved by `attachToBone` in both held-object templates.

The generated `minimal` playtest also reports the disabled-correction case: `groundCorrectionEnabled`
stays `false`, `groundClearance` remains finite (`-0.0493` to `-0.0401` in the observed run), and
`normaliseFactor` is `1.1`.

Mutation evidence was observed before restoring the calls:

```text
action-rpg spec with normaliseToMetres replaced by `1`:
expected 0 to be greater than 0.0001

defense normaliseToMetres call removed:
Template 'defense' convention 'normaliseToMetres' has no call in src/
```

After restoration, the focused suite and `pnpm exec tsx scripts/check-template-conventions.ts`
both passed; the latter printed `Template convention applicability and source-call checks passed.`

## Commands and run record

The generated projects scaffolded and run were `action-rpg`, `defense`, `minimal`, `platformer`,
`racing`, `sailing`, `shooter`, and `starter`. The repository currently has ten templates; the
PRD baseline names seven because `sailing` was added after that baseline.

| Template | Scenarios | Isolated scaffolded playtests |
| --- | ---: | --- |
| action-rpg | 7 | PASS |
| defense | 7 | PASS on retry; aggregate run had one transient `leaks: 1` result |
| minimal | 3 | PASS |
| platformer | 22 | PASS |
| racing | 8 | PASS |
| sailing | 5 | PASS |
| shooter | 6 | PASS |
| starter | 23 | PASS |

Commands and observed results:

```text
pnpm typecheck
PASS, exit 0

pnpm lint
PASS, exit 0; Biome reported 496 existing warnings

pnpm test
FAIL, exit 1; 305 test files passed, 2 pre-existing fake-device files failed (3,038 tests passed)
  device-playtest.spec.ts and ios-device-playtest.spec.ts ask for `multitouch-player`,
  while both fake bridges expose `player` and `cube`

pnpm test:templates
FAIL, exit 1; all 8 templates were scaffolded and executed, with only the concurrent
  defense `defense-survive-ten-waves` assertion observing `leaks: 1` instead of `0`.
  Each template passed when rerun with `TN_TEMPLATE_ONLY=<template>`; the defense retry
  passed all 7 scenarios.

pnpm visuals
FAIL, exit 1 after structure and capture; all 8 frames were nonblank and captured.
  TN_VISUAL_SCORE_TEMPLATES_MISMATCH: missing sailing; stale none

pnpm budgets
FAIL, exit 1 after the new convention check passed; the pre-existing native coverage report
  is stale because its source digest changed
```

The visual capture files were refreshed for the current generated source, including the new
`sailing.png`. The expected frame changes are the convention effects: normalized model scale,
feet corrected to the floor where `GroundSnap` is enabled, and held weapons attached under
`RightHand` in action-rpg and shooter. The score file remains the pre-existing seven-template,
model-only baseline, so it was not fabricated or edited to conceal the missing `sailing` score.

The fresh worktree also required the repository-native setup before the root test could run:
`pnpm --filter @threenative/physics build`, `pnpm native:build`, and the documented V8/QuickJS
native test targets all completed successfully. The remaining root-test failures are the
unrelated fake-device fixture mismatch recorded above.

## Repair evidence — recovery review 1 — 2026-08-31

The applicability table above, its eight current template rows, the convention names, and the
measurement-when-disabled case are unchanged. This addendum records the three review defects and
their red-green evidence.

### GroundSnap airborne and elevated-platform regression

The red controlled mutation replaced the repaired post-physics block in
`platformer/src/entities/Character.ts` with the former `applyGrounding(0, dt)` call. `TN_TEMPLATE_ONLY=platformer pnpm test:templates`
exited 1: `platformer-one-way` failed
`component.player.groundCorrectionEnabled.value.atSteps` (airborne observed `true`) and
`component.player.groundSurfaceY.value` (surface remained `0`). The mutation therefore left the
render correction targeting world zero while the body was in the jump/elevated transition.

The green rerun of the restored source passed all 22 platformer scenarios. In
`platformer-one-way`, that review run reported correction disabled while airborne,
`groundSurfaceY: 2.075813856124878` at the elevated landing, and `visualAttached: true` both
airborne and landed. The `2.075813856124878` value was the defect: it was derived from the
character's current body position rather than the authored `2.6` support plane. The follow-up
below retains the earlier airborne and attachment observations while repairing that target.

### Template-owned AC1 mutation proof

The red mutation deleted the starter generated call to `applyGrounding` and ran
`TN_TEMPLATE_ONLY=starter pnpm test:templates`. It exited 1 in the generated project's own
`survives` scenario: `component.player.groundClearance` observed `before=null after=null`.
This is the template-level failure required by AC1, rather than a package-side convention test.
After restoring the call, the same command exited 0 with all 23 starter scenarios passing. The
other applicable convention cells now have generated `survives` component assertions for
grounding, normalization, and held-bone attachment where applicable; the package-side 2-file,
14-test suite remains a fast supplemental check.

### Visual capture regression

The bad capture was reproduced from the committed frame: `defense.png` was 17,423 bytes with SHA
`86b6da236b4ff790c30d71303e59d144c76925a808f1592e9564736248f5ed80`, while the valid parent board
frame was 755,372 bytes with SHA
`ed4acd8e856d2d933a2333448e0f6a1977e804ce4d4db07db3242eade0d03a3e`. ImageMagick reported
`compare -metric AE` as `104430 (0.113314)`. The committed frame had sampled the opaque startup
layer: the capture waited for a canvas and a fixed delay, not for the engine's startup readiness.

The repair publishes `ctx.startup.phase` as `data-threenative-startup` from `GameCanvas`, and the
visual gate waits for `data-threenative-startup="ready"` on hosted templates while retaining the
bounded delay for vanilla `minimal`. The rerun captured all eight templates as nonblank and
restored the board/world geometry in `defense.png`; the retained frame is 754,688 bytes with SHA
`2ffb593d7e5c27caae73f0939dee1940d6e1fb71fb397ca865b6870d0a4c4295`, and its delta against the
valid parent is `3014.61 (0.00327106)`. The expected convention-only visual differences remain
normalised model scale, grounded feet, and held weapons under `RightHand`; the board is present.
The remaining frame-state differences (for example wave/credits at capture time) are recorded as
runtime timing, not mislabelled as convention effects.

`pnpm visuals` still exits 1 after the successful captures because the pre-existing human score
file has no `sailing` entry (`TN_VISUAL_SCORE_TEMPLATES_MISMATCH: missing sailing; stale none`).
No score or baseline was edited.

The clean full generated rerun after the repair covered 81 scenarios: action-rpg 7, defense 7,
minimal 3, platformer 22, racing 8, sailing 5, shooter 6, and starter 23; every scenario and all
eight scaffolded template projects passed.

### Repair changed-file set

The repair commit changes only these in-scope paths:

- `docs/verification/PRD-289-conventions-2026-08-31.md`
- `docs/verification/visuals/defense.png`
- `packages/create-threenative/__tests__/scaffold.spec.ts`
- `packages/create-threenative/templates/action-rpg/playtests/survives.playtest.json`
- `packages/create-threenative/templates/defense/playtests/survive.playtest.json`
- `packages/create-threenative/templates/minimal/playtests/survives.playtest.json`
- `packages/create-threenative/templates/platformer/playtests/oneway.playtest.json`
- `packages/create-threenative/templates/platformer/playtests/survives.playtest.json`
- `packages/create-threenative/templates/platformer/src/entities/Character.ts`
- `packages/create-threenative/templates/platformer/src/level/Platform.ts`
- `packages/create-threenative/templates/platformer/src/scenes/Level.ts`
- `packages/create-threenative/templates/racing/playtests/survives.playtest.json`
- `packages/create-threenative/templates/sailing/playtests/survives.playtest.json`
- `packages/create-threenative/templates/shooter/playtests/survives.playtest.json`
- `packages/create-threenative/templates/starter/playtests/survives.playtest.json`
- `packages/create-threenative/templates/starter/src/entities/Goal.ts`
- `packages/create-threenative/templates/starter/src/entities/Player.ts`
- `packages/create-threenative/templates/starter/src/scenes/Play.ts`
- `packages/ui/src/GameCanvas.tsx`
- `scripts/visual-gate.ts`

No PRD, `postprocessing.ts`, applicability-table, or convention-name path was changed.

## Repair evidence — contract-preserving follow-up — 2026-08-31

The follow-up strengthened the template-owned `platformer-one-way` assertion before changing
the implementation. Its `groundSurfaceY` assertion now requires `gte: 2.55`, `lte: 2.65`, and
`changed: true`, and samples exactly `2.6` at `elevated-landing`, matching the elevated platform
authored at `y: 2.6` in `platformer/src/scenes/Level.ts`.

The required red run was:

```text
TN_TEMPLATE_ONLY=platformer pnpm test:templates
FAIL, exit 1; platformer-one-way failed only
  component.player.groundSurfaceY.value
  component.player.groundSurfaceY.value.atSteps
  reason: the reviewed current-y-minus-offset target left the elevated measurement below 2.55
```

The implementation then stores the resolver's `supportingSurfaceY` directly in
`platformer/src/entities/Character.ts` when the body is grounded, moving downward, and the resolver
returns a support. GroundSnap remains invoked on every update; while airborne its correction is
disabled (`groundCorrectionEnabled: false`) but its finite clearance measurement is still collected.
`visualAttached` is a separate body-relative measurement: it compares visual and collider world
positions against a stable baseline captured once per grounded contact, recapturing only when a new
grounded support contact begins. It never compares the visual with the support plane.

The focused green run was:

```text
TN_TEMPLATE_ONLY=platformer pnpm test:templates
PASS, exit 0; all 22 generated platformer scenarios passed, including platformer-one-way.
```

The final generated observations for `platformer-one-way` were:

```text
airborne-visual: groundCorrectionEnabled=false, groundSurfaceY=0,
  visualAttached=true, visualAttachmentDrift=0.04591029882431019
elevated-landing: groundCorrectionEnabled=true, groundSurfaceY=2.6,
  groundClearance=-4.440892098500626e-16, visualAttached=true,
  visualAttachmentDrift=0.008790969848632812
```

The generated project ran on WebGPU (`target: web`, NVIDIA/Turing adapter) and all diagnostics,
movement, component, and resource assertions passed.

The body-relative attachment mutation was:

```text
temporary generated-source mutation: offset sampled visual Y by 0.2m before the body-relative drift check
TN_TEMPLATE_ONLY=platformer pnpm test:templates
FAIL, exit 1; platformer-one-way failed only
  component.player.visualAttached.value.atSteps
  airborne-visual=false, elevated-landing=false (expected true at both labels)
```

The mutation was removed before the green run. This proves a visual/body detachment is caught by
the body-relative assertion independently of the `groundSurfaceY` support-plane measurement.

### Follow-up gate results

The first full generated-template sweep executed all eight templates but had a transient defense
failure in `defense-survive-ten-waves` (`resource.state.leaks`). An isolated retry passed all 7
defense scenarios. A second complete sweep then passed:

```text
pnpm test:templates
PASS, exit 0; all 81 audited scenario files across action-rpg (7), defense (7), minimal (3),
platformer (22), racing (8), sailing (5), shooter (6), and starter (23) were covered; every
scaffolded project passed.
```

The convention checks remained green:

```text
pnpm exec tsx scripts/check-template-conventions.ts
PASS, exit 0; Template convention applicability and source-call checks passed.

pnpm exec vitest run packages/create-threenative/__tests__/template-conventions.spec.ts \
  scripts/__tests__/check-template-conventions.spec.ts --reporter=dot
PASS, exit 0; 2 files and 14 tests passed.
```

The PRD's repository chain was run exactly. Typecheck exited 0, lint exited 0 with the existing
496 Biome warnings, and the chain stopped at the native package tests with exit 1: 90 test files
passed and 4 failed because six required CMake executables were not built. The documented native
bootstrap was attempted with `pnpm native:build`; it exited 1 when dependency downloads returned
`fetch failed` for `wgpu`, `sdl3`, `dawn`, `v8`, `skia`, and `swc`. This is an environment/setup
block on the unrelated native lane, not a failure in the changed template source.

```text
pnpm typecheck && pnpm lint && pnpm test
FAIL, exit 1 at @threenative/runtime-native test; typecheck passed, lint passed with 496 warnings,
and runtime-native reported 90 passed / 4 failed test files (640 passed, 39 skipped tests).
```

The visual gate captured all eight frames as nonblank and passed structure, then exited 1 on the
pre-existing score manifest mismatch (`TN_VISUAL_SCORE_TEMPLATES_MISMATCH: missing sailing; stale
none`). It regenerated the eight tracked captures; they were restored because the follow-up changes
only affect post-jump platformer state, not the static visual-gate frame. No visual baseline was
re-baselined.

### Follow-up changed-file set

- `docs/verification/PRD-289-conventions-2026-08-31.md`
- `packages/create-threenative/templates/platformer/playtests/oneway.playtest.json`
- `packages/create-threenative/templates/platformer/src/entities/Character.ts`

## Missing-baseline contract — 2026-08-31

The template-owned `player.visualAttached` measurement now fails closed. Its body-relative baseline
is `#visualBodyOffsetY`; before that value is captured, `visualAttachmentDrift` is `null` and
`visualAttached` is `false`. Once captured, the existing stable offset compares the visual and
collider world positions. This remains independent of `groundSurfaceY`, and the existing
`groundCorrectionEnabled` behavior is unchanged.

The required pre-fix mutation removed the baseline assignment from
`platformer/src/entities/Character.ts` and ran:

```text
TN_TEMPLATE_ONLY=platformer pnpm test:templates
PASS, exit 0; all 22 generated platformer scenarios passed, including platformer-one-way.
Despite the absent baseline, platformer-one-way's visualAttached assertions stayed green at both
airborne-visual and elevated-landing because the old missing-baseline drift fallback was 0.
```

After changing the fallback to `null` and requiring a non-null drift for `visualAttached: true`, the
same temporary assignment omission produced:

```text
TN_TEMPLATE_ONLY=platformer pnpm test:templates
FAIL, exit 1; platformer-one-way failed only at component.player.visualAttached.value.atSteps.
The generated observation was visualAttached=false and visualAttachmentDrift=null; all other
platformer scenarios passed.
```

The assignment was restored before the green focused scaffolded run:

```text
platformer playtests/oneway.playtest.json: PASS, exit 0, target web, NVIDIA/Turing WebGPU
airborne-visual: groundCorrectionEnabled=false, groundSurfaceY=0,
  visualAttached=true, visualAttachmentDrift=0.045610249042510875
elevated-landing: groundCorrectionEnabled=true, groundSurfaceY=2.6,
  visualAttached=true, visualAttachmentDrift=0.008790969848632812
```

The generated source therefore reports airborne correction disabled while retaining the independent
authored support-plane measurement near `2.6`, and it cannot report attachment success before a
body-relative baseline exists.

## Final gate record — missing-baseline follow-up — 2026-08-31

The clean generated-template sweep was rerun after restoring the baseline assignment:

```text
TN_TEMPLATE_ONLY=platformer pnpm test:templates
PASS, exit 0; all 22 platformer scenarios passed.

pnpm test:templates
PASS, exit 0; 77 scenario summaries passed across action-rpg, defense, minimal, platformer,
racing, sailing, shooter, and starter. Every one of the eight templates was scaffolded and run.
```

The convention, type, and lint checks passed:

```text
pnpm exec tsx scripts/check-template-conventions.ts
PASS, exit 0; Template convention applicability and source-call checks passed.

pnpm exec vitest run packages/create-threenative/__tests__/template-conventions.spec.ts \
  scripts/__tests__/check-template-conventions.spec.ts --reporter=dot
PASS, exit 0; 2 files and 14 tests passed.

pnpm typecheck && pnpm lint
PASS through both phases; the combined chain then reached the test phase.
```

The native setup required by the root test suite also completed: `pnpm native:build` exited 0,
then the three default Linux contract targets and two QuickJS targets were built with CMake. The
final exact repository chain still exited 1 in unrelated baseline/device checks:

```text
pnpm typecheck && pnpm lint && pnpm test
FAIL, exit 1; 304 test files ran, 3 failed, 3037 tests passed, 1 skipped.
The failures were the existing platformer scaffold hash (expected
b94eebc08211647f24f30ca2eaa7958c9e655ebeac71fe2d41eb2e1af541f2c4, received
d475be03c2e3f1494d59cf2475bad66de46f77774a4706643fa04f29ccd60523) and Android/iOS device-smoke
fixtures whose result.pass was false without those device lanes. The permitted follow-up file set
does not include the scaffold test or device fixtures, so neither was changed.
```

The visual gate captured nonblank frames and passed visual structure for all eight templates, then
exited 1 on the existing score-manifest check:

```text
pnpm visuals
FAIL, exit 1; TN_VISUAL_SCORE_TEMPLATES_MISMATCH: missing sailing; stale none.
```

The eight regenerated PNGs were restored to their committed baselines. No platformer frame change
was attributed to this post-jump measurement-only fix, and no visual baseline was re-baselined.
`git diff --check` exited 0 after the record update.

## Recovery verification — 2026-09-02

The recovered commits were cherry-picked onto the current local `main` and the convention
applicability/source-call checks were rerun:

```text
pnpm exec tsx scripts/check-template-conventions.ts
PASS, exit 0; Template convention applicability and source-call checks passed.

pnpm exec vitest run packages/create-threenative/__tests__/template-conventions.spec.ts \
  scripts/__tests__/check-template-conventions.spec.ts --reporter=dot
PASS, exit 0; 2 files and 14 tests passed.

TN_TEMPLATE_ONLY=platformer pnpm test:templates
PASS, exit 0; all 22 platformer scenarios passed, including the independent airborne support-plane
and body-relative attachment measurements.
```

The generated scaffold stability hashes were refreshed after PRD-292's convention guidance landed;
the focused scaffold suite then passed all 49 tests. The recovery did not change the visual
baseline: the convention measurements are reported independently when a correction is disabled.

## Recovery repository gates — 2026-09-02

The required repository gates were rerun after all four recovery groups were integrated:

| Command | Result |
| --- | --- |
| `pnpm sync:agents` and `pnpm sync:agents --check` | PASS; generated mirrors were refreshed, then all 17 `CLAUDE.md` mirrors were in sync. |
| `pnpm typecheck && pnpm lint && pnpm test` | PASS; typecheck and lint passed (522 warnings only); 340 test files passed, 1 skipped; 3406 tests passed, 2 skipped. |
| `pnpm budgets` | PASS; all budget and freshness checks passed. The informational LOC triggers reported 51,192 framework lines and 117,105 native-runtime lines. |
| `pnpm test:playtest` | PASS; movement, camera, movement-axis, zoom-input, and navigation scenarios passed on NVIDIA/Turing WebGPU with no diagnostics. |
| `PLAYWRIGHT_BROWSERS_PATH=<isolated /home cache> pnpm test:templates` | PASS; 87 scenarios across all 8 templates passed. The first bare invocation waited on an unrelated global Playwright install; the isolated-cache invocation ran the same repository script successfully. |
| `pnpm check:docs` | PASS; 1277 relative links across 944 Markdown files. |

The full template run included the convention-bearing platformer scenarios and all generated
`AGENTS.md`/`CLAUDE.md` guidance. No visual baseline was changed; convention measurements remain
independent when a correction is disabled.

## Repair evidence — boot-error mutation control — 2026-09-02

The generated-source look test now extracts the `[data-threenative-canvas-error="true"]` rule and
checks its concrete full-screen, centered-layout, wrapping, background, and text-colour
declarations in every current template. This keeps the visual proof template-owned while making an
empty or missing rule fail independently of the nonblank-pixel scenario assertion.

The required mutation emptied the starter rule body. The focused test went red:

```text
pnpm exec vitest run packages/create-threenative/__tests__/looks.spec.ts --reporter=dot
FAIL, exit 1; 1 test failed, 11 passed. The failure was
starter boot-error position: expected undefined to be 'fixed'.
```

After restoring the generated declaration block, the focused generated-source and scaffold suites
went green:

```text
pnpm exec vitest run packages/create-threenative/__tests__/looks.spec.ts \
  packages/create-threenative/__tests__/template.spec.ts \
  packages/create-threenative/__tests__/scaffold.spec.ts --reporter=dot
PASS, exit 0; 3 test files and 96 tests passed.
```

This repair does not change the visual score manifest. `pnpm visuals` remains unresolved for this
PRD because it requires eight template scores and `docs/verification/visuals/scores.json` still has
seven: `TN_VISUAL_SCORE_TEMPLATES_MISMATCH: missing sailing; stale none`. No human score or visual
baseline was invented.

Updated 2026-09-28 (PRD-470): `minimal` and `starter` load the rigged Quaternius mannequin, so their
convention calls moved to lines 14–15 and the AnimationPlayer column names `SkeletalMesh3D`.
