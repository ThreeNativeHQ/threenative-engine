---
name: native-performance-loop
description: Run an autonomous ThreeNative native-performance optimization loop using existing harnesses, quick synthetic load tests, and representative real games. Profile bottlenecks, make focused changes, accept or reject measured experiments, and maintain an HTML benchmark dashboard. Use for sustained native runtime optimization, frame pacing, startup, memory, or thermal efficiency campaigns, including the Tempest (rain) campaign where the web Wasm engine must beat stock three.js with the same image.
---

# Native performance loop

Make native games faster without changing the game the player receives. Own workload selection,
profiling, implementation, measurement, keep/reject decisions, and the next experiment; do not ask
the developer to supervise each iteration. Creating or editing this skill does not start a campaign.

## Start or resume

1. Read the owning repository's instructions and inspect current Git state. Resolve the primary
   checkout before using its worktree manager. Reuse this campaign's owned checkout; never reset
   shared work or read other agents' worktrees. In ThreeNative, start from the current integration
   branch and obey engine/game boundaries. Keep uncertain implementation work in a compact PRD,
   updated with actual results; do not create parallel prose verification reports.
2. Read [benchmarks.md](references/benchmarks.md). Discover existing harnesses and real game
   scenarios before building anything. Search `engine_search_capabilities`, then inspect every
   hit with `engine_capability_detail` before adding helpers or changing rendering stages. Reuse
   installed meters, runners, scenarios, parsers, comparators, and profiling tools. If a necessary
   observation is missing, add the smallest harness extension with a runnable check, then measure
   a fresh baseline with identical instrumentation on both arms.
3. Choose the primary native platform and available hardware from the experiment. Start with a
   usable native desktop lane when no platform was requested. Use emulators for functional
   diagnosis; use real hardware for claims about that hardware's performance, drivers, or heat.
   Browser results are comparison or diagnosis, never substitute native evidence. Read the local
   `measure-steady-state-fps` and `probe-android-startup-and-heat` skills when their lanes apply.
4. Create or resume `<primary>/artifacts/native-performance-loop/<campaign-id>/`. Record the
   contract and results described in [dashboard.md](references/dashboard.md), and create
   `index.html` immediately, including an honest empty state. Choose workloads and targets
   autonomously and state them. Default to a two-hour invocation budget, including setup and
   verification, unless the user supplied another duration or experiment limit. Reserve the last
   20 minutes for confirmation, restoration, and delivery; do not launch work that cannot finish
   inside the remainder. A later invocation resumes the campaign instead of starting over.
5. Freeze the evaluator, workload/asset/scenario hashes, seeds, quality, render dimensions, frame
   pacing, thresholds, and allowed edit surface. Record exact build, runtime, package, hardware,
   driver, instrumentation, cache, and thermal identities. Select one primary scalar per
   experiment; default to native gameplay frame-time p95 in milliseconds, lower is better.
   Keep separate goals for frame tails, startup, memory, and energy. Never optimize a blended
   score that can conceal one game's regression. Run the unchanged baseline before editing.

## KPIs and named campaigns

- Score every campaign on [engine-kpis.md](references/engine-kpis.md) as well as on its primary
  scalar. Keep a lever only if it moves at least one engine KPI and the sentinel game does not
  regress. A lever that helps one game only is `provisional`.
- For the Tempest sample (the `rain` template, web Wasm engine against stock three), read
  [tempest.md](references/tempest.md). It sets goals T1 to T3, the image-identity rule, the arms,
  the capture recipe and the known state.

## The experiment loop

Repeat without asking for a new task after each result:

1. **Find the next bottleneck.** Profile the current accepted build under representative input.
   Rank measured costs by impact on the player's frame or startup, then uncertainty and cost of
   testing. CPU work, GPU work, queue waits and presentation waits can overlap: do not sum them
   into invented frame time. Keep a short ranked hypothesis queue. After a win, profile again;
   the bottleneck may have moved.
2. **Screen cheaply.** Use a small primitive/load test when it isolates the suspected mechanism.
   Record the predicted effect and falsifying result before making one conceptual change. Test
   more than one relevant load level, including a normal load and a stress load; capacity gains
   must not hide normal-load overhead. A synthetic win is provisional. A cheap clear loss can be
   rejected immediately without spending a full game run. If the issue is asset streaming, UI,
   startup, or scene-specific, go straight to the relevant real game.
3. **Change the owner once.** Name engine or game and why. Shared host, transfer, allocation,
   dispatch and resource-lifetime fixes belong in the engine; appearance belongs in game-owned
   render source. Inspect callers before fixing a shared function. Rebuild the candidate and
   install it through the supported sandbox/package path; verify the executed binary and game
   bundle hashes. Never patch an installed dependency and mistake that for an engine fix.
   Preserve a reproducible candidate commit or patch. Behavior changes need the repository's
   red-green check and a meaningful native playtest.
4. **Confirm in gameplay.** Run promising candidates against the incumbent on at least one real
   game exercising the mechanism, with a second materially different game as a regression
   sentinel for shared engine changes. Match inputs, seed, viewport, content, quality, build
   mode, caches, thermal state and measurement budget. Use at least three valid paired runs,
   alternating baseline-first/candidate-first order. Profile captures diagnose; make final timing
   comparisons with equivalent, low-overhead instrumentation. Follow the measurement and
   acceptance rules below. Synthetic-only results remain provisional, never accepted game gains.
5. **Decide, persist, continue.** Record every attempt and its evidence before updating the
   dashboard. `keep` promotes the candidate to the campaign's incumbent; it does not mean merged.
   On `reject`, `invalid`, crash or timeout, restore only experiment-owned changes to the last
   accepted state, using the exact saved patch or a revert of the owned commit. Preserve rejected
   patches and explanations. Re-rank the queue and continue while the budget permits.

## Measurement and acceptance

Keep the original campaign baseline immutable and the latest accepted incumbent separate. Compare
new candidates against the incumbent; show cumulative progress against the original baseline.
Never compare different machines, resolutions, game revisions or measurement definitions as if only
code changed. An intentional environment/evaluator change starts a new comparison series.

Use real wall-clock or presentation samples. A fixed simulation tick is not a frame-time sample.
Separate startup, first-use hitches, and steady state; wait for readiness and a clean sample window.
Measure at least 1,000 steady frames or 30 seconds, whichever takes longer. A parser dropping its
first window is only a minimum: it does not prove a 104-second game launch has settled. Report
sample count, elapsed time, p50/p95/p99, worst frame, and over-budget/hitch counts when observable.
Missing measurements are unavailable with a reason, never zero. Missing required measurements,
empty assertions, software GPU substitutions, wrong binaries, thermal confounds and unequal
workloads invalidate the comparison.

Calibrate repeatability before searching for wins. Prefer an existing calibrated lane policy. If
none exists, predeclare a conservative screening margin: the larger of 3% of the baseline metric
and twice the largest absolute deviation of valid baseline repeats from their median. Apply the
same method to hard regression metrics, recording any existing stricter limits. This is a noise
screen, not a statistical confidence interval. If baseline variation makes the experiment
uninformative, repair the lane before optimizing. Do not tune margins after seeing a candidate.

Keep only when the median paired improvement clears that margin, the direction is consistent
across pairs, the real-game primary metric improves, and every correctness, visual, memory,
startup and relevant platform gate passes. An equivalent-looking result with fewer draws can be a
win; deleting shadows, enemies, effects, AI work or pixels is not. In capped games, explicitly
select measured active CPU/GPU cost or energy as the primary metric before the experiment;
unchanged presented FPS alone neither proves nor disproves reclaimed headroom.

Reject a clear loss or failed correctness/visual gate. Treat a tie as inconclusive; simplify tied
code only as a separately identified maintenance change, never as a speedup. An unstable or
incomplete comparison is `invalid` or `provisional`, with its reason. Do not weaken a required
platform gate because that platform is unavailable; retain the candidate without promoting it.
Confirm apparent wins with a fresh replay/seed or held-out scene before final delivery, and rerun
the original baseline after three experiments to detect drift. Avoid retesting known losers unless
new evidence changes the hypothesis.

## Guardrails and stopping

Do not buy speed by altering gameplay, appearance, time scale, measurement boundaries, validation,
error handling or platform support. Do not bypass thermal controls, change system power settings,
clear user data, or kill unrelated GPU jobs. Respect existing permissions for physical devices.
A harness repair is a separate change followed by new baselines, never part of a winning candidate.
Keep shared mutable GPU/device measurements serial, even if builds or analysis could run in parallel.

Two failures with the same cause trigger a re-plan and a named doubtful assumption, not another
blind edit. Stop the affected lane if it cannot produce valid evidence; continue another useful
lane when possible. Stop the invocation on its deadline, user interruption, lost evaluator
integrity, or lack of a safely testable next hypothesis. Record the precise stop reason and next
hypothesis; reaching a target does not establish a hardware limit. Do not install a background
scheduler or claim work continues after the agent stops.

Before delivery, reproduce the best accepted build, rerun affected repository checks and native
scenarios, refresh `index.html`, and record unrun platforms honestly. Preserve the dashboard and
raw artifacts outside a disposable task checkout. Follow the repository's PR and worktree cleanup
rules within the session's existing authorization; no implicit push, merge or publication. Report
any retained worktree's exact path, size and cleanup blocker. Finish with the dashboard link,
best measured change, accepted/rejected counts, and one resumable next action.
