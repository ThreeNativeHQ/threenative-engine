---
prd_contract: v1
---

# PRD-273 — the three effects with no upstream node ship as template source, not as package code

**Status:** PROPOSED — filed 2026-08-30, measured at `1eeecf1e`. Depends on
PRD-266 for the chain
seam these attach to. Batch: [docs/PRDs/realism-effects](./README.md).

**Goal: every covered effect `0beqz/realism-effects` exports has a working equivalent here.** Ten
of its fourteen exports map to a `three@0.185.1` TSL node already installed. This PRD is the three
template-source effects; `HBAOEffect` remains explicitly uncovered under PRD-274.

**Complexity:** three fragment shaders totalling 273 lines of GLSL, rewritten as TSL and placed in
generated template source = **LOW**. The work is small; the placement is the whole point.

## The problem, measured at `1eeecf1e`

### 1. Three exports have no upstream counterpart

`src/index.js` of `0beqz/realism-effects` exports fourteen names. The coverage table in
[the batch README](./README.md) maps each one. Three have nothing in
`three/addons/tsl/display/` that does the same job:

| Export | Source | Size | What it does |
| --- | --- | --- | --- |
| `LensDistortionEffect` | `src/lens-distortion/LensDistortionEffect.js` | 75 lines | Radial lens undistortion with a per-channel chromatic offset |
| `SparkleEffect` | `src/sparkle/SparkleEffect.js` | 129 lines | Screen-space glints on bright highlights |
| `GradualBackgroundEffect` | `src/gradual-background/GradualBackgroundEffect.js` | 69 lines | Distance-graded background tint |

`ChromaticAberrationNode` is the nearest upstream neighbour and is not a substitute: it offsets
channels uniformly and performs no radial undistortion, which is the entire content of
`LensDistortionEffect`'s shader.

### 2. All three are pure appearance, which decides where they go

Charter rule 3 is a veto over rule 1: anything that decides how the game looks ships as generated
source in `templates/*/src/render/`, **at any size**. These three fail the mechanism test
completely. There is no pooling, no lifetime, no dispatch, no platform seam — each is a single
fragment function whose every parameter is a look choice: distortion coefficients, aberration
strength, glint threshold, tint colour and falloff.

The test from the charter — *can a game change the appearance completely without editing package
code?* — is unanswerable for these, because appearance is all they are. Putting any of them in
`packages/core/src/` would be the clearest possible rule-3 violation in the repository.

So "support all the effects" is satisfied here by **shipping them where the game can edit them**,
not by exporting them from a package.

### 3. Written in GLSL against `WebGLRenderer`, they reach no native target as they stand

All three are `postprocessing`-package `Effect` subclasses with `mainImage` GLSL bodies. The native
runtime is `WebGPURenderer`-only and its post-processing contract is a TSL node graph installed as
`RenderPipeline.outputNode` — conformance case `62-postprocessing-pass`
(`packages/runtime-native/conformance/registry.json:589`, `required: true`) asserts exactly that,
and `packages/core/src/renderer.ts:310` throws for any renderer whose `kind !== "webgpu"`. Copying
the GLSL across would produce three effects that work in a browser and nowhere else, which the
charter calls unfinished.

They are rewritten in TSL. At 69–129 lines each that is a translation, not a project.

## What ships

Three TSL effect functions as **generated template source**, in the render directory of the
templates that want them:

- `templates/*/src/render/effects/lensDistortion.ts` — radial undistortion plus per-channel offset,
  with the distortion coefficients and aberration strength as plain named constants at the top of
  the file, edited in place by the game.
- `templates/*/src/render/effects/sparkle.ts` — highlight glints, with threshold, count, length and
  colour as named constants.
- `templates/*/src/render/effects/gradualBackground.ts` — distance-graded background tint, with
  colour and falloff as named constants.

Each is an ordinary TSL function taking the chain's colour node and returning a colour node, so it
composes into the template's existing `setupPost` expression the way `bloom(...)` already does at
`templates/starter/src/render/postprocessing.ts`. **No package export, no registry, no preset
system** — a template that does not want one deletes the file.

The header comment of each names its source: the algorithm and the `0beqz/realism-effects` file it
was read from, MIT, with the original's own upstream citation preserved where it has one
(`LensDistortionEffect` cites `marcodiiga.github.io/radial-lens-undistortion-filtering`).

**Which templates get which effect is a look decision made per template**, alongside the choices
[PRD-267](../../useful-defaults/PRD-267-screen-space-gi-ships-in-the-templates.md) makes. Not every template
gets all three.

## Acceptance criteria

1. **Each effect changes the frame, and its named constant changes it differently.** A visual spec
   per effect renders a fixture with the effect off, on at its default constant, and on at a
   changed constant, and asserts all three differ beyond tolerance. *Mutation:* return the input
   colour unchanged and the off-vs-on comparison fails; ignore the constant and the
   default-vs-changed comparison fails.

2. **A game can change the appearance completely without editing package code.** A spec asserts
   that no file under `packages/` is imported by any of the three effect modules beyond `three` and
   `three/tsl`. *Mutation:* move any of the three into `packages/core/src/` and export it, and the
   spec fails naming the package import — this is the charter rule-3 guard, and it is the reason
   this PRD exists as a separate file.

3. **Each runs on every target the framework ships.** One conformance case per effect in
   `packages/runtime-native/conformance/registry.json`, executed on desktop, Android and iOS under
   [PRD-275](./PRD-275-every-effect-runs-on-every-target-or-it-does-not-ship.md)'s gate.
   *Mutation:* register a case without a scene and the registry's own validation fails closed
   rather than reporting a passing case that ran nothing.

4. **Deleting an effect file leaves the template building.** A scaffold spec removes one effect
   module from a generated project and asserts `pnpm build` still succeeds in it. *Mutation:*
   import the effect unconditionally from a shared barrel and the deletion spec fails — proving
   these are files a game owns, not a registry it must satisfy.

## Out of scope

`HBAOEffect`, whose equivalent is a measurement question rather than a translation — see
[PRD-274](./PRD-274-every-export-has-a-named-tested-equivalent.md). The ten exports upstream
already covers. Any preset or genre system that would choose these effects on a game's behalf,
which the charter closes with evidence.

## Verification

`pnpm typecheck && pnpm lint && pnpm test`; `pnpm visuals:ab` on each affected template with the
before/after pasted; `pnpm test:templates` proving each scaffolded template still builds and plays;
the three conformance cases green on desktop and on a device under
[PRD-275](./PRD-275-every-effect-runs-on-every-target-or-it-does-not-ship.md).
`scripts/__tests__/primary-docs.spec.ts` must stay green — a template `AGENTS.md` that does not name
a shipped effect means, per the charter, that the effect does not exist.
