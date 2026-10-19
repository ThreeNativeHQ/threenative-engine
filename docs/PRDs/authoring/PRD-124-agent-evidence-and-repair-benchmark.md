---
prd_contract: v1
---

# PRD-124 — One agent evidence manifest and a closed-loop game-repair benchmark

**Status:** PROPOSED, 2026-08-15. Planning only; no latency, autonomous-repair, or performance
result is claimed by this document.

**Priority:** P2 — Planning-only: agentEvidenceV1 schema and closed-loop repair benchmark unbuilt.
**Outcome:** after an edit, one bounded machine-readable report tells an agent what project ran,
what the runtime can observe, what failed, what changed in the game, whether visual/gameplay gates
passed, how performance moved, whether hot reload preserved state, and exactly how to rerun the
proof. Studio and terminal workflows consume the same report. A disposable real-game benchmark
then proves an agent can diagnose and repair a seeded performance regression without changing the
player-visible outcome.

**Depends on:** shipped state-preserving HMR (PRD-035), semantic playtests (PRD-033), Studio
(PRD-084/085 and standing PRD-086), performance samples from PRD-073, the shipped render-workload
advisor (PRD-075), screenshot/capture guards, and ordinary git status/diff. It composes those
surfaces; it does not reopen their implementation scope. PRD-123's ecosystem corpus is independent
and may run in parallel.

**Complexity: 8 → high mode.** The new code is an evidence compositor and benchmark, not another
runtime. Correctness is difficult because fragmented observations have different evidence classes,
freshness, failure semantics, and payload limits.

## 1. Why this exists

ThreeNative already exposes most of the facts an agent needs, but through separate entry points:

- playtest JSON reports runtime diagnostics, semantic assertions, components, resources,
  performance series, screenshots, traces, and deterministic input;
- Studio inspects project files, scenarios, preview status, console tail, git state, agent steps,
  and proof runs;
- hot-reload diagnostics report reload count, entity/scene/canvas counts, and runtime ownership;
- profiling scripts and the render-workload advisor report frame cost and safe optimization
  opportunities;
- git records changed files and checkpoints.

An agent must currently discover, invoke, and reconcile those independently. A missing observation
can look like an absent problem; Studio's standing brief explicitly says its probe does not observe
the rendered preview game, hot-reload state preservation, agent cost, real devices, or sessions
over 15 minutes. There is no one project-local artifact that answers “what does this runtime know,
what changed, and is the result better?”

The missing capability is a report contract and one consumer proof. It is not a new scene format,
MCP vocabulary, editor mutation API, profiler, agent provider, or runtime abstraction.

## 2. Public shape

Add no fifth top-level command. The public CLI remains `dev`, `build`, `test`, and `ship`.

A generated project can request the report through the existing test path:

```sh
threenative test --scenario playtests/stress.playtest.json \
  --agent-report artifacts/agent-report.json --json
```

The exact flag may be adjusted to existing parser conventions, but the operation remains a mode of
`test`, not `doctor`, `inspect`, `repair`, or another bespoke command. Studio invokes the same
library/CLI path when its user runs proof. `@threenative/playtest` remains directly usable for
advanced scenarios.

The report is local evidence. It does not send source, screenshots, telemetry, prompts, or metrics
to a hosted service.

## 3. `agentEvidenceV1` contract

One versioned, bounded JSON object contains these sections:

### Identity

- schema version;
- project root as a project-relative marker, never the operator's home path;
- package and exact Three.js/ThreeNative versions;
- project git HEAD and dirty-state hash;
- target, evidence class, adapter/device identity, run id, timestamps, and exact rerun command.

### Capabilities and prerequisites

- capabilities advertised by the playtest bridge;
- required observations for the selected scenario;
- unavailable observations with named reasons;
- preview/build/runtime readiness;
- missing package, browser, native host, device, asset, or scenario prerequisites.

Unavailable is not false and is never pass. A report with no assertions reached is
`not_observed`, matching the existing runner's exit-2 semantics.

### Runtime and game observations

- allowed console, network, and runtime diagnostics;
- scene/entity/component/resource snapshots already exposed through the bridge;
- labeled before/after samples and deterministic input steps;
- HMR diagnostics: reload observed, state keys carried/defaulted/rejected, entity/scene/canvas
  deltas, and full-reload fallback reason.

The compositor does not walk or serialize arbitrary `THREE.Scene` state. It carries only existing,
bounded, JSON-safe observations.

### Performance

- warm-up policy and sample count;
- frame-time median and p95;
- draw calls, triangles, passes, and available renderer counters;
- adapter class and software/hardware authority;
- render-workload advisor findings with compatibility/skip reasons;
- baseline, candidate, absolute delta, and percentage delta when a paired run exists.

Inclusive experimental timings are labeled and never summed into a fake total. A missing baseline
produces current metrics, not an improvement claim.

### Visual and behavioral proof

- playtest assertion results and whether any assertion executed;
- screenshot/video paths and hashes;
- canvas crop, dimensions, distinct colors, luminance spread, bright-pixel ratio, and capture-guard
  verdict;
- optional reference/perceptual result with declared tolerance;
- runtime diagnostics and frame evidence tied to the same run id.

A nonblank screenshot is presentation evidence, not gameplay proof. Gameplay requires the semantic
or input-driven assertion declared by the scenario.

### Change and rerun

- project-relative changed files and before/after content hashes;
- whether changes existed before the run;
- executed commands with exit codes and durations;
- generated artifact paths;
- one exact rerun command;
- final verdict: `pass`, `fail`, or `not_observed`.

Do not embed source files, environment variables, prompts, credentials, registry configuration,
absolute home paths, or arbitrary process output. Preserve existing output/payload caps.

## 4. One owner, multiple producers

The report model and validator live in `@threenative/playtest`, because that package already owns
the scenario, observation, report, and fail-closed semantics. Other tools contribute typed sections
through narrow inputs:

- core bridge → capabilities and game observations;
- HMR diagnostics → reload/state ownership;
- playtest runner → input, assertions, performance series, screenshots, traces;
- workload advisor → read-only findings;
- Studio/test host → project identity, git diff hashes, command durations, and rerun command.

Studio does not define a second report schema. Performance scripts do not grow agent behavior. The
report does not edit files or tell the agent which patch to make.

Expected paths:

- `packages/playtest/src/agentEvidence.ts` — schema, builder, validation, and redaction;
- `packages/playtest/src/report.ts` — reference the evidence artifact/run id without duplicating it;
- `packages/playtest/src/runner/` — collect existing observations into the new contract;
- `packages/create-threenative/src/` — `test` flag and generated-project wiring;
- `packages/studio/src/server.ts` — invoke/stream the same report path;
- `packages/playtest/__tests__/agent-evidence.spec.ts` — fail-closed contract controls;
- `scripts/agent-repair-benchmark.ts` — disposable end-to-end benchmark only;
- `docs/verification/agent-repair-<date>.md` — executed evidence.

If implementation shows the CLI parser lives elsewhere, move only that file ownership. Do not add
a package or duplicate the report model.

## 5. Phases

### Phase 0 — Measure the feedback loop before changing it

Against a freshly scaffolded real template under headed WebGPU, run at least 20 warmed edits that
change one visible, runtime-observed value. Record separate timestamps for:

1. file write complete;
2. Vite invalidation received;
3. HMR accept/dispose complete;
4. first rendered frame carrying the changed value;
5. selected playtest assertion complete;
6. report flushed.

Report median and p95 for:

- edit → HMR complete;
- edit → changed frame;
- changed frame → proof complete;
- full edit → proof;
- provider sentence → edit separately when a live agent is used.

Framework feedback has an initial budget of **≤1,000 ms median and ≤2,000 ms p95 from local file
write to the first observed changed frame** on the reference host after warm-up. Provider generation
time is reported separately and cannot fail the runtime budget. If the budget is already met, do
not invent hot-reload optimization work. If it fails, attribute the delay before authorizing a fix.

Required controls:

- remove `acceptHotUpdate` → full reload and state-loss observation;
- make the visible value unchanged → the “changed frame” detector must not fire;
- remove the playtest bridge → verdict `not_observed`, never pass.

### Phase 1 — Evidence model and deterministic composer

Define `agentEvidenceV1`, size limits, redaction rules, freshness/run-id binding, and deterministic
JSON ordering. Compose existing fixture reports without launching a browser first. A malformed,
oversized, stale, cross-run, or assertion-empty input fails closed.

### Phase 2 — Generated-project terminal path

Wire the existing `test` command to build the manifest from a scenario run. Prove it in a packed,
freshly scaffolded consumer, not from workspace links. Running without the flag retains current
stdout, artifact, and exit behavior.

### Phase 3 — Studio consumes the same artifact

Studio's proof action invokes the same path and displays only observed sections. A missing profiler,
scenario, bridge, preview, screenshot, or baseline is shown as unavailable/not observed with the
reason. No panel synthesizes a pass from preview readiness.

### Phase 4 — Closed-loop repair benchmark

Create a disposable scaffolded game with a seeded, player-visible stress scenario: at least 100
enemy-like repeated meshes are emitted as independent compatible draws, producing a declared
frame/draw-call failure while movement/gameplay and the reference capture are otherwise valid.

Give one bounded agent this outcome:

> Improve the failing performance budget without changing gameplay behavior or the visible
> composition. Use only the report and ordinary project files. Stop after one verified patch.

The agent must:

1. run the baseline and read the manifest;
2. identify an evidence-backed bottleneck or advisor finding;
3. edit only generated/user-owned game or render source unless the report proves an engine bug;
4. rerun the same scenario;
5. produce a paired candidate manifest;
6. leave a reviewable diff and stop without push, publish, or deployment.

A separate read-only verifier reruns the scenario and checks the report, diff, visual artifact, and
behavioral assertions. It may return only `PASS`, `REQUEST_CHANGES`, or `NOT_OBSERVED`. The
benchmark may reuse PRD-122 roles if they are implemented, but it does not depend on them.

The benchmark passes only when:

- median frame time improves by at least 20% **or** the predeclared frame budget turns green;
- draw calls fall by at least 50% for the seeded compatible workload;
- the deterministic movement/gameplay assertions remain green;
- the before/after visual comparison remains within its declared tolerance;
- no new console, network, or runtime diagnostic appears;
- the verifier reaches assertions and returns `PASS`;
- the evidence manifest alone contains the metrics/artifacts needed to audit those claims.

The target is the seeded benchmark, not a promise that every performance problem is autonomously
repairable.

## 6. Acceptance criteria

- [ ] `agentEvidenceV1` has one authoritative schema, deterministic serialization, payload caps,
      run-id/freshness checks, and tests for every required section.
- [ ] The report distinguishes `pass`, `fail`, and `not_observed`; missing observations, empty
      assertions, unavailable tools, and stale artifacts cannot pass.
- [ ] Identity and changed-file fields expose no credentials, environment variables, prompts,
      registry configuration, or absolute operator-home paths.
- [ ] Existing playtest capabilities, semantic observations, performance series, screenshot
      guards, HMR diagnostics, and advisor findings are composed rather than reimplemented.
- [ ] A generated project's existing `test` command can write the report as JSON; no fifth
      top-level command, package, scene format, mutation API, or provider dependency is added.
- [ ] Studio invokes and displays the same report contract instead of defining a second schema.
- [ ] Running test/playtest without the report option preserves existing output and exit behavior.
- [ ] Phase 0 records 20 warmed edit runs and separates runtime/HMR/proof latency from provider
      generation time.
- [ ] Local edit → changed-frame latency is ≤1,000 ms median and ≤2,000 ms p95, or the PRD records
      the attributed blocker and does not claim the feedback budget.
- [ ] The disposable repair benchmark produces paired baseline/candidate reports tied to the same
      scenario, source subject, adapter class, and evidence policy.
- [ ] The benchmark meets its performance threshold while gameplay and visual gates remain green,
      and an independent read-only verifier returns `PASS` after rerunning it.
- [ ] Removing the report feature leaves runtime output and game behavior unchanged.
- [ ] Targeted package tests, packed-consumer proof, `pnpm typecheck`, `pnpm lint`, `pnpm test`,
      Studio probe, and `git diff --check` pass.

## 7. Negative controls

| Control | Mutation | Expected |
|---|---|---|
| empty proof | scenario reaches no assertions | verdict `not_observed`, command exits 2 |
| cross-run evidence | combine screenshot from run A with metrics from run B | report validator rejects run-id mismatch |
| stale baseline | change source hash after baseline | improvement section is unavailable, never green |
| screenshot theater | replace capture with blank/uniform image | visual guard fails while gameplay remains separately reported |
| performance theater | report fewer draws without matching samples/adapter identity | paired-report validation fails |
| HMR false claim | remove `acceptHotUpdate` | full reload/state loss reported; preserved-state claim fails |
| unchanged-frame false signal | edit/rewrite without changing the observed value | changed-frame timestamp remains unavailable |
| secret leakage | inject token-like env/config values into process context | report contains none of them |
| source mutation | invoke report generation on a clean project | project source hashes and git state remain unchanged |
| verifier self-repair | give verifier a seeded red candidate | it returns `REQUEST_CHANGES`/`NOT_OBSERVED` and leaves tree byte-identical |
| visual-only success | remove movement assertion but keep screenshot valid | report cannot claim gameplay passed |
| software overclaim | mark SwiftShader metrics hardware | evidence validator rejects the report |

## 8. Non-goals

- No `tn doctor`, `tn inspect`, `tn repair`, or other new top-level CLI noun.
- No generic scene serialization, IR, runtime mutation API, or agent-only scene vocabulary.
- No custom profiler, renderer fork, native scene graph, command-stream optimization, or automatic
  instancing in framework code.
- No hosted telemetry, model gateway, prompt storage, autonomous swarm, planner, router, or
  provider-specific report schema.
- No claim that a green screenshot proves gameplay, that one benchmark proves general autonomy, or
  that emulator/simulator evidence proves physical-device behavior.
- No automatic commit to the framework repository. Studio may checkpoint the disposable consumer
  through its existing git path; the benchmark never pushes or publishes.

## 9. Kill switches and rollback

- If the report duplicates more than a thin composition layer over existing observations, cut the
  duplicated section and link its existing artifact by hash/run id.
- If HMR already meets the latency budget, close that lane with evidence; do not optimize it for the
  sake of the PRD.
- If the seeded repair requires framework code despite a game-owned compatible-draw regression,
  the benchmark design is wrong. Reset the disposable subject and keep the framework unchanged.
- Stop if any report field requires arbitrary scene traversal, source embedding, environment dumps,
  or unbounded console/process output.
- Drop any advisor-driven benchmark whose visual or behavior controls cannot turn red when the
  candidate changes semantics.
- The report feature remains opt-in. Rollback removes its flag/compositor/Studio display and leaves
  existing test, playtest, HMR, profiling, and game runtime behavior intact.