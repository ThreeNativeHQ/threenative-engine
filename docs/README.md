# Docs map

This directory holds product constraints, work specifications, architecture notes, measured
verification, and experiments; [`architecture/CHARTER.md`](architecture/CHARTER.md) is the
binding document, and [`CURRENT-CHALLENGES.md`](CURRENT-CHALLENGES.md) is the one place open
limitations are recorded.

## Start here

- [CURRENT-CHALLENGES](CURRENT-CHALLENGES.md) is the **single record of every known limitation**,
  what is being done about it, and the evidence behind each. Limitations belong there, not
  scattered across the docs that describe what the framework does.
- [ROADMAP](strategy/ROADMAP.md) explains the product path and the claims that still need
  evidence.
- [CONFLICTS](strategy/CONFLICTS.md) records decisions where strategy and the binding document
  disagree.
- [Latest round ledger](verification/round-14-2026-09-04.md) gives the current self-improvement
  state. The [Studio hosting series](PRDs/studio-hosting/README.md) describes the proposed
  container, session broker, and production path — for the private Studio repository, not this one.
- [Engine-load comparison](verification/runtime-perf-state.md#prd-117-browser-comparison-2026-08-14)
  is the current external performance comparison; [per-object cost](verification/runtime-perf-state.md#prd-117-browser-detail-2026-08-14)
  records the Three.js submission-cost finding.

| Folder | Holds | Status of contents |
|---|---|---|
| `PRDs/` | Numbered work specs, active proposals, and archived delivery records | Status follows the owning folder; `pnpm budgets` reports counts but does not enforce a PRD-file cap |
| `bugs/` | One file per root-caused defect | Historical record; the open ones are indexed in `CURRENT-CHALLENGES.md` |
| `verification/` | Gate results per PRD, dated, plus round ledgers | Historical record |
| `benchmark/` | Protocol, sealed prompts, dated results | Binding protocol, VOID result |
| `strategy/` | Market position, roadmap, money, metrics | **Proposal.** Nothing here is committed |
| `architecture/` | Shape of things not yet built | **Proposal**, except where it records shipped behaviour |
| `product/` | Constraints that will bind the product later | Mixed — store policy is external fact, the rest is proposal |
| `spikes/` | Throwaway de-risking experiments and their results | Not binding, not shipped. Results amend the binding document |

## PRDs

- **Active work:** concern-specific folders under `PRDs/` hold active proposals; direct-child
  `PRD-*.md` files are a filing error. `pnpm budgets` reports the active PRD count recursively.
- **Done work:** completed PRDs live in [`done/`](PRDs/done/).
- **Blocked work:** PRDs blocked on a named external dependency live in
  [`BLOCKED/<reason>/`](PRDs/BLOCKED/), where blocked is not done.
- **Archive rule:** a PRD moves to `done/` in the same commit that finishes its acceptance
  evidence.

Active PRD categories are [`animation/`](PRDs/animation/), [`assets/`](PRDs/assets/),
[`authoring/`](PRDs/authoring/), [`CI/`](PRDs/CI/), [`native/`](PRDs/native/),
[`networking/`](PRDs/networking/), [`open-world/`](PRDs/open-world/),
[`performance/`](PRDs/performance/), [`production-readiness/`](PRDs/production-readiness/),
[`rendering/`](PRDs/rendering/), [`studio-hosting/`](PRDs/studio-hosting/),
[`tech-debt-code-quality/`](PRDs/tech-debt-code-quality/), [`tooling/`](PRDs/tooling/),
[`useful-defaults/`](PRDs/useful-defaults/), and [`website/`](PRDs/website/).
The asset-pipeline series closed on 2026-08-22 as
[`done/asset-pipeline/`](PRDs/done/asset-pipeline/README.md).
Dated batch folders (`batch-*`, `fps-friction-26-08-17/`, `refactor-2026-08-28/`) were
flattened into `done/` on 2026-10-03; new active PRDs use the concern-specific folders above.

**Studio is no longer in this repository.** It is the local agent-and-preview surface — a server
plus one self-contained page — and on 2026-08-16 it became the paid product and moved to a private
repository, along with the `hosting/` service that serves it (PRD-129). Nothing in this repository
is anything but MIT. The Studio PRDs stay here as the record of how it was built:
[PRD-084](PRDs/done/PRD-084-threenative-studio.md),
[PRD-085](PRDs/done/PRD-085-studio-wiring.md),
[PRD-086](PRDs/done/PRD-086-studio-self-improvement-loop.md), and the
[Studio hosting series](PRDs/studio-hosting/README.md) — all of them now describing work that
lives elsewhere.

## Verification

A verification file is dated evidence for a gate, PRD, device run, or benchmark; it records what
was executed and what remains unproven. Native claims are evidence-bound: hosted `macos-15`
execution can produce iOS-simulator evidence, while physical-device, signing, thermal, battery,
and performance-parity claims remain open.

The [technical-debt audit](verification/tech-debt-audit-2026-08-20.md) is a dated sweep of the whole
repository rather than of one PRD: measured gate state, the code the gates do not fail, the friction
recorded in builder sessions, and the defect shapes reviewers keep re-finding.

A round ledger records one self-improvement round's inputs, decisions, evidence, and resulting
state. `pnpm round:next` resumes from the latest ledger, and `pnpm round:deletions` reports
persistent unused-export evidence. The [newest ledger is round 14](verification/round-14-2026-09-04.md);
[the earlier rounds](verification/) sit beside it.

## Benchmark

The [benchmark protocol](benchmark/PROTOCOL.md), [sealed genre briefs](benchmark/genres/), and
[LOC report](benchmark/LOC.md) define the comparison. The dated result remains
[VOID](benchmark/RESULTS-2026-08-02.md); it is a measurement result, not a product claim.

Genre sweeps live under [`benchmark/sweeps/`](benchmark/sweeps/). Each archive retains the
built source, playtests, package manifest, sealed sweep manifest, and framework declarations
used by the measurer. Every run has a matching [sweep ledger](verification/SWEEP-TEMPLATE.md)
with the brief hash, reach rate, used and unused exports, and blocking APIs. `Round` distinguishes
a baseline from a re-measure.

Compare archives with `pnpm sweep:delta <round-1-archive> <round-2-archive>`; pair completed
framework and vanilla archives with `pnpm sweep:pair <framework-archive> <vanilla-archive>`.
Proof sets under `benchmark/genres/<genre>/proof/` run with
`pnpm sweep:proof <sandbox-or-archive>`. The [round-2 delta](benchmark/DELTA-2026-08-05.md)
and [caller census](verification/arm-census-2026-08-08.md) are the current supporting records.
Vendored package tarballs under each archive's `vendor/` directory are not archived; they are
reproducible with `pnpm pack`, and sweep tests build their own temporary fixtures.

## Strategy

- [VALUE-PROPOSITION](strategy/VALUE-PROPOSITION.md) — the framework's earned and unearned
  claims compared with vanilla Three.js
- [POSITIONING](strategy/POSITIONING.md) — Runtime, Studio, Cloud, audience, and refusals
- [ROADMAP](strategy/ROADMAP.md) — production path and evidence-bound status
- [BUSINESS-MODEL](strategy/BUSINESS-MODEL.md) — open-core and pricing hypotheses
- [METRICS](strategy/METRICS.md) — north star and supporting measures
- [CONFLICTS](strategy/CONFLICTS.md) — resolved disagreements with the binding document

## Architecture

- [ENTITY-MODEL](architecture/ENTITY-MODEL.md) — the ECS question and its closed decision
- [THREEJS-CONSTRAINTS](architecture/THREEJS-CONSTRAINTS.md) — Three.js gaps and framework
  ownership
- [NATIVE-RUNTIME](architecture/NATIVE-RUNTIME.md) — device path, owned runtime, and physics ABI
- [AGENT-INTERFACE](architecture/AGENT-INTERFACE.md) — how an agent drives a project
- [NATIVE-PERF-BOTTLENECKS](architecture/NATIVE-PERF-BOTTLENECKS.md) — performance hypotheses
- [NATIVE-RENDER-TRANSPORT](architecture/NATIVE-RENDER-TRANSPORT.md) — proposed render-thread
  layers and why they are not a roadmap
- [CHARTER-HISTORY](architecture/CHARTER-HISTORY.md) — how the binding document changed, so the
  Charter itself does not carry its own diff

Write-once/run-anywhere is owned as a gate by
[PRD-054](PRDs/BLOCKED/requires-parity-rerun/PRD-054-write-once-run-anywhere.md); it remains
blocked at acceptance criterion 1.

## Product

- [PERFORMANCE-BUDGETS](product/PERFORMANCE-BUDGETS.md) — frame budgets as test assertions
- [ASSET-PIPELINE](product/ASSET-PIPELINE.md) — deferred build-time pipeline and its triggers
- [STORE-POLICY](product/STORE-POLICY.md) — Apple and Google constraints
- [STRANGER-TEST-PROTOCOL](product/STRANGER-TEST-PROTOCOL.md) — the single definition of the
  five-minute player experiment

## Bugs, audits and reports

Three folders hold dated technical write-ups. They are the detail behind
[CURRENT-CHALLENGES](CURRENT-CHALLENGES.md), which is the summary and the index:

- [`bugs/`](bugs/) — one file per root-caused defect, with the reproduction and the fix.

## Spikes

- [0a-mobile-render](spikes/0a-mobile-render.md) — closed mobile-render question and retained
  evidence
- [studio-loop-2026-08-12](spikes/studio-loop-2026-08-12.md) — Studio-loop de-risking experiment

A spike buys an answer and ships nothing; it is not a PRD. Its result remains here when later
documents still cite it.
