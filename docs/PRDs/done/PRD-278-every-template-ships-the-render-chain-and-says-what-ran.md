---
prd_contract: v1
---

# PRD-278 — every template ships the render chain, and says which stages actually ran

**Status: DONE — 2026-09-04.** All seven templates ship the chain; the evidence, the numbers and
what was not verified are in
[docs/verification/prd-278-render-chain-in-every-template-2026-08-30.md](../../verification/prd-278-render-chain-in-every-template-2026-08-30.md).
AC1–AC8 were met on browser WebGPU on 2026-08-30. **AC9 closed 2026-09-04**: a `--target desktop`
run against a freshly built host reported `renderChain.tier: "high"` and the applied stage `bloom`
with `runtime: "native"`, so the stages apply there rather than reporting the WebGL refusal. The
run, the host's provenance and what it does not show are appended to the same record under
§"AC9 — native".

AC7's exposure question was settled before this landed
(`docs/verification/exposure-ab-2026-08-30.md`) and the shipped comment states the measured answer.

The port found and fixed an engine bug on the way: `renderChain` assertions could never pass,
because `dist/playtest.js` is its own `tsup` entry with its own copy of `chain.ts` and the report
lived in a module-scoped `WeakMap`. Red, fix and green are in the record above (`81f27f74`).

The original blocker below is discharged: the mined file landed in the starter at `b43b3f87`.

**Goal: a scaffolded game's first `pnpm dev` renders through a real chain, and a stage that could
not run says so by name.** Mined from `lumen-hall`. Sibling of
[PRD-276](./PRD-276-instanced-batch-assembly-is-mechanism.md), and the opposite verdict: that one
was mechanism and went into a package, this one decides how the game looks and can only ever ship
as generated source.

**Complexity:** a 412-line file copied into seven templates, plus a signature change in seven
`lighting.ts`, plus per-template tuning = **MEDIUM**. The copy is trivial; the six integration
problems below are the work.

**Scope grew 2026-08-30, by ruling.** The composer, the stage graph, the composite maths and the
tier→parameter table are this PRD's, not `packages/core`'s: the owner-delegated answer to
PRD-266's blocking
question was no. This file also gains the mapping from the framework's tier **ordinal** to which
stages run at which quality — the ordinal arrives as an argument, exactly as the platform decision
in §3 does. Sequenced in [useful-defaults](../useful-defaults/README.md); the batch this PRD was first filed under is kept as its origin memo.

## Where it goes, and why it is not a package export

`WorldEnvironment` picks the tone-mapping operator, the stage order, and the composite maths
(`exposed.mul(ao.r).add(exposed.mul(gi.rgb).mul(intensity))`), and it carries defaults —
`bloomStrength: 0.7`, `tonemapMode: "aces"`, `ssgiIntensity: 1` — that choose those things for the
game. Charter rule 3 names that case exactly: *any preset or default that picks one of them for the
game* ships as generated source in `templates/*/src/render/`, at any size. A game cannot add a
stage, reorder the chain, or change the composite without editing it, so the "can the game change
the appearance completely without editing package code?" test fails. It is a **floor the game
rewrites**, not a ceiling it reaches through config, and that is only true where the source is in
the user's repo.

For scale: every template's `postprocessing.ts` is 14–45 lines today — ACES, an exposure constant,
and one bloom on a scene pass. This replaces that with a five-stage chain that reports itself.

## The two halves that are not optional

Both survive into every template. Neither is boilerplate to be trimmed on the way in.

1. **The fail-closed constructor.** An unknown `ssgiQuality` or `tonemapMode` throws with the valid
   values named. A typo that silently became `"medium"` is a quality setting nobody can trust
   afterwards, and the repo's rule is that malformed input throws everywhere.
2. **The `TN_WORLD_ENVIRONMENT` per-stage report**, and this is the important one. Every stage
   reports `applied: true`, or `applied: false` with a **reason that is never blank** — `renderer
   kind is 'webgl2', not 'webgpu'`, `light 'sun' does not cast shadows`, `ssgiEnabled is false`.
   This is the repo's "turning a convention off must not turn its measurement off" clause made
   concrete: it is the difference between *GI is off because the game chose that* and *GI is off
   because a TSL node silently no-op'd*. Four of the seven traps now documented in
   `agent-docs/visual-baseline.md` are exactly that failure, and this line is what makes them
   visible without a debugger. It must be emitted even when every stage is off.

## Six integration problems, none of them the copy

### 1. `setupLighting` returns nothing in all seven templates

Godrays are raymarched against a light's **shadow map** — the shaft is the volume that map reports
as lit — so `apply()` needs the `DirectionalLight`. Every template has exactly one shadow-casting
directional light in `lighting.ts`, and every one of the seven signatures is
`setupLighting(scene, renderer): void`. All seven must return the light. A light with `castShadow`
false yields a black pass, which is why `WorldEnvironment` refuses it by name rather than rendering
nothing.

### 2. `minimal` composes something before bloom, and the chain would swallow it

`minimal` is the one template whose `setupPost` is already non-trivial: it takes an `Atmosphere`
and applies `aerialPerspective` to the scene pass before bloom. `WorldEnvironment` builds
`pass(scene, camera)` internally, so that composition has nowhere to go.

The fix is an ordering seam, not a special case: an optional game-supplied function that receives
the scene pass and returns the base colour node. The node is the game's; the chain only decides
where it is spliced in. Without it, `minimal` keeps a second `setupPost` and the promotion covers
six templates instead of seven.

### 3. The default must not breach the performance tiers

Measured on `lumen-hall` at 1600×900 on this machine's desktop GPU: `ssgiQuality: "high"` costs
more than every other stage combined — **42.9 fps with it against 107 without** — and full-resolution
SSR costs **56 fps → 34.5**. The templates' own Tier 1 table floors browser-Android at 30 fps and
native-Android at 55 fps. Enabling this chain unconditionally would blow those on every template.

`src/render/` may not import a framework package, so the platform decision cannot be made inside it
— it arrives as an argument from the scene, exactly as `createRandom` now does for the starter's
scenery. Proposed default:

| | desktop / browser-desktop | mobile |
| --- | --- | --- |
| tonemap + exposure | each template's current values, unchanged | unchanged |
| bloom | each template's current values, unchanged | unchanged |
| SSGI + denoise | `medium`, on | off |
| SSR | on, `resolutionScale: 0.5` | off |
| godrays | off | off |

Godrays stay off everywhere by default: a shaft needs a sun, an occluder and interior air to read,
and none of the seven templates is an interior. The option, its numbers and the comment explaining
what it is for still ship, so turning it on is one line rather than a research project.

### 4. None of the cathedral's numbers transfer

Every value in the mined `postprocessing.ts` is tuned to one building: `exposure: 0.98`
re-balanced for photographed limestone albedo, `godraysDensity: 0.7` for that nave's air,
`ssgiRadius: 8` for a 16 m-wide nave, `ssgiIntensity: 0.75` measured against a reference image's
quantiles. **The comments transfer and the values do not** — each comment states a tradeoff
("density raises the whole frame, not just the shafts"), which is what an agent needs, while the
number answers a question about a different building. Each template gets its own numbers, and any
value copied across must be re-justified against that template's scene or dropped.

### 5. One comment in the mined file contradicts `three@0.185.1` and must be re-measured

The file states that once `setOutputNode` installs a `RenderPipeline`, `renderer.toneMappingExposure`
no longer reaches the frame — *"Measured — moving it from 0.85 to 1.45 changed nothing at all on
screen"* — and applies exposure as a multiply on the scene pass instead.

Reading `three@0.185.1` does not support that as a general rule: `RenderPipeline.outputColorTransform`
defaults to `true`, so the pipeline applies `renderOutput(outputNode, toneMapping, outputColorSpace)`,
and `ToneMappingNode`'s default `exposureNode` is
`rendererReference('toneMappingExposure', 'float')` — a live renderer uniform. On that reading the
exposure scalar does reach the frame.

This matters because **all seven templates set `toneMappingExposure` immediately before calling
`setOutputNode` today.** Either they have been shipping a dead line, or the comment is wrong and
would teach seven scaffolds that a live line is dead. It is one A/B capture to settle and it must
be settled before the file ships, not after.

Applying exposure as a multiply on the scene pass is independently defensible — it is the shutter,
so it belongs before the tone curve, and it makes the bloom threshold mean the same thing at any
exposure. That reasoning survives either answer; the claim about the renderer scalar does not.

### 6. Budget and gate consequences, all expected

- All seven scaffold-tree hashes in `__tests__/scaffold.spec.ts` move.
- `pnpm budgets` template LOC report moves (it reports, it does not cap).
- The inline `AGENTS.md` pointer costs words, and `defense`, `shooter` and `platformer` currently
  run at **one word of headroom**. Each needs a measured limit raise in
  `scripts/instruction-budget.ts` with a stated reason, as `minimal` and `starter` just did for the
  TSL traps. The detail goes in a reference page, which the budget does not count.
- `scripts/check-core-boundary.ts` must stay green: the file imports only `three`, `three/tsl` and
  `three/addons/tsl/display/*`. All five addon nodes — `SSGINode`, `DenoiseNode`,
  `BilateralBlurNode`, `GodraysNode`, `SSRNode` — exist in `three@0.185.1`, which is the exact
  version all seven templates pin, so no dependency changes.

## The AGENTS.md prose to land, verbatim

Inline in each template's `## Visuals` section, kept to its shortest form because of the word
budget:

> `postprocessing.ts` builds a `WorldEnvironment`: which stages run, in what order, and an honest
> report of what happened. It decides no colour and no strength — those are arguments, in this file,
> yours. It prints `TN_WORLD_ENVIRONMENT` every run naming each stage as applied or refused **with a
> reason**, so a stage that silently no-op'd is not mistaken for one you turned off. An unknown
> quality tier throws rather than quietly becoming the default.

And in `agent-docs/visual-baseline.md`, beside the seven traps, the full page: the stage order and
why it is that order (AO and GI gathered before they are denoised, denoised before they are added to
the beauty pass, everything before tonemapping), what each option costs with the measured numbers
from §3, and the one-line enable for each stage that ships off.

## Acceptance criteria

- [x] **AC1 — every template reports.** A playtest on each scaffolded template asserts a
      `TN_WORLD_ENVIRONMENT` console line, and that every stage it names is either `applied: true`
      or carries a non-empty `reason`.
- [x] **AC2 — the report survives the stages being off.** With every optional stage disabled the
      line is still printed and every stage is named. Red-green: deleting the `console.info` fails
      it.
- [x] **AC3 — fail closed.** An unknown `ssgiQuality` and an unknown `tonemapMode` each throw,
      naming the valid values. Red-green: removing either guard silently selects the default.
- [x] **AC4 — godrays refuse a shadowless light** by name rather than rendering a black pass.
- [x] **AC5 — no performance regression.** Each template's `performance.playtest.json` passes at
      its current thresholds on the default (mobile-tier stages off) path.
- [x] **AC6 — desktop actually gained something.** A before/after capture per template, looked at,
      not just asserted.
- [x] **AC7 — §5 settled.** One A/B capture decides whether `toneMappingExposure` reaches the frame
      through `setOutputNode` on `three@0.185.1`, and the comment that ships states the measured
      answer.
- [x] **AC8 — the boundary holds.** `check-core-boundary.ts` green; no `@threenative/` import in any
      `src/render/`.
- [x] **AC9 — native.** The chain is WebGPU-only by construction and names that as its refusal
      reason on any other renderer; a `--target desktop` run must confirm the stages actually apply
      there rather than reporting the WebGL refusal.
