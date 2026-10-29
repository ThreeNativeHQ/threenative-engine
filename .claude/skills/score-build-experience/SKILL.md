---
name: score-build-experience
description: Score an executed sandbox build 0–100 across seven evidence-backed axes, including rendered visual quality and correct framework-abstraction leverage, then score the vanilla Three.js counterfactual. Use after a build-on-sandbox run, adopter pilot, or completed game build. Never score an unexecuted build.
---

# Scoring a build experience

You just built something. This turns that into two numbers that survive being read back in
three months: what the framework experience was worth, and what it would have been worth
without the framework.

**The score is worthless without the run.** No estimating from a code read, no scoring a build
someone else did and described to you, no scoring a plan. If nothing was executed, say so and
stop — an invented number outlives the caveat attached to it.

## The one rule that makes the number honest

**Every axis score cites observed evidence**: a command and exit code, error code, count,
measured LOC, timestamp, inspected source location, or captured frame from the executed build.
An axis you cannot attach evidence to is **unscored** — write `—` and reduce the denominator.
A score with citations is evidence; a score with opinions is a vibe with a decimal point.

## The axes

| # | Axis | Weight | What it measures |
|---|---|---|---|
| 1 | Setup → first rendered frame | 10 | Everything between "I want to build this" and a pixel on screen |
| 2 | Rendered visual quality | 20 | What the executed build actually looks like across representative states |
| 3 | Abstraction leverage and fit | 15 | Whether framework-owned plumbing used the right abstractions without wrapper theatre |
| 4 | Gameplay plumbing | 15 | Loop, input, state, restart, entities — the parts every game repeats |
| 5 | Proving it works | 20 | Whether you finished holding behavioural and visual evidence or holding a feeling |
| 6 | Iteration speed | 10 | The edit → observe → fix cycle, including how much it lies to you |
| 7 | Cognitive load | 10 | What you had to read, learn, route around, and delete before you could work |

Weights are fixed. Do not retune them per run — a rubric you adjust after seeing the result is
a rubric that always agrees with you. If a run genuinely has no work on an axis, mark it unscored rather than silently reweighting.
Rendered visual quality is unscored only when no renderable output exists; the absence of a
reference image does not make the build's composition, legibility, coherence, or defects
unscorable.

### Anchors

Score each axis against its full weight. These are the calibration points:

**1. Setup → first frame.** Full: one command, no hand-edits, frame on screen. Half: one known
workaround, documented, under ten minutes. Zero: it did not install, or you edited a manifest by
hand to get past a dependency that does not resolve.

**2. Rendered visual quality.** Score pixels, not source and not effort. Full: representative
captured states are coherent, intentional, legible, polished, and closely match the supplied
reference or brief; no obvious clipping, placeholder assets, broken camera framing, unreadable
HUD, lighting/material defects, or state-to-state visual regressions. Half: recognisably complete
but generic, materially behind the reference, or carrying visible defects. Zero: blank/black
capture, broken render, placeholders presented as finished work, or a frame that cannot show the
requested game. A beautiful static frame cannot earn full credit when the brief requires motion
or state changes: inspect at least three representative states and use a short gameplay capture
when animation, interaction, or feedback quality matters.

**3. Abstraction leverage and fit.** Full: the build uses the framework for the plumbing it owns
(bootstrap, lifecycle, loop/scheduling, input, state bridge, physics portability, scene changes,
proof hooks) and ordinary Three.js for game-owned rendering; each abstraction removes real code,
preserves web/native behaviour, or makes proof stronger. Half: useful abstractions are present,
but one framework-owned capability was rebuilt, routed around, or used with avoidable ceremony.
Zero: the build is effectively a vanilla Three.js app inside the scaffold, depends on `.raw` or
browser-only escape hatches for core behaviour, or adds wrappers that increase code without
improving portability, correctness, iteration, or proof.

Do **not** score import count, package reach, or abstraction density. More framework calls are not
automatically better. Reward the correct boundary and measured leverage. Penalise both failure
modes: rebuilding owned plumbing in user space, and wrapping game-owned Three.js merely to make
the framework appear used.

**4. Gameplay plumbing.** Full: loop, input, state and restart were there, correct, and cheaper
than writing them. Half: they were there but you paid a tax to use them — dead dependencies you
could not remove, generics to thread, an abstraction you routed around. Zero: you hand-rolled
what the framework claimed to own. **Score restart honestly**: a hand-written reset that quietly
misses the scheduler is the classic silent bug, and "I would have written it myself" should be
scored as the bug it usually becomes, not the fifteen lines it looks like.

**5. Proving it works.** Full: behaviour is asserted by a harness that fails closed, visual
evidence covers representative states, you ran both, and at least one instrument caught a real
mistake. Half: assertions and captures exist but are narrow, self-graded, or only run once. Zero:
you finished on a single screenshot and confidence. A screenshot proves pixels, not input or
gameplay; a passing state assertion proves behaviour, not visual quality. Require both when both
are in scope.

**6. Iteration speed.** Full: edit → observe took seconds and what you observed was true. Half:
fast but misleading — a throttled tab, a stale bundle, a screenshot that lies. Zero: you could
not see your change without a rebuild you had to babysit.

**7. Cognitive load.** Full: what you needed was where you looked. Half: real docs, with a
contract you only found by reading a failure. Zero: you read more than you wrote, or deleted
more scaffold than you kept.

## Required visual inspection

Axis 2 cannot be scored from the final screenshot alone unless the build itself has only one
meaningful state.

1. Capture at the requested viewport and at least one narrower viewport when UI is present.
2. Capture at least three meaningful states: opening/idle, active gameplay, and success/failure
   or the closest equivalents in the brief.
3. Compare against `reference.png` when supplied. Judge composition, palette/material coherence,
   hierarchy, camera/framing, lighting, depth/readability, HUD legibility, feedback, and visible
   defects. Do not reward superficial similarity that breaks gameplay readability.
4. Inspect motion or interaction with a short recording, deterministic frame sequence, or
   before/after captures when the quality depends on animation, physics, transitions, or input.
5. Prefer a fresh blind visual critic when available. Strip arm identity and source context.
   Record the critic rubric and artifact paths. The lead agent still checks for capture failures.

Never treat a black WebGPU capture as a bad-looking game until a headed/fallback capture confirms
the scene itself is broken. Never infer playability from attractive pixels.

## Required abstraction audit

Axis 3 needs a short source audit tied to the executed artifact:

1. List the framework-owned capabilities the build needed.
2. For each, cite the abstraction used or the user-space replacement, with file and line.
3. Name every escape hatch (`.raw`, direct DOM/browser global, parallel loop, hand-written scene
   reset, duplicated state bus) and verify whether it compromises portability or proof.
4. Measure leverage where possible: deleted/replaced LOC, avoided dependencies, fewer platform
   branches, stronger assertions, or removal of a workaround. Do not invent LOC savings.
5. Identify dead or ceremonial abstractions. A wrapper earns nothing unless it changes cost,
   correctness, portability, iteration, or evidence.

Summarise the audit as **used well**, **missed leverage**, and **over-abstraction**. The score is
based on the balance, not on framework reach rate.

## The counterfactual

Score the same seven axes for the same game built in plain Three.js. Rules:

- **Label it an estimate, every time it appears.** It was not run. n=1. It is a judgement about
  work you know how to do, not a measurement of work you did.
- **Assume competence, not heroics.** The vanilla arm writes the loop, the input map and the
  restart — those are cheap and known. It does **not** build a browser-driving assertion harness
  in an afternoon, and pretending it does is how the framework's real margin gets scored away.
- **Assume what actually happens.** If the honest answer is "in vanilla I would have shipped this
  with no automated proof", score axis 5 as the zero it is. Do not score the vanilla arm as the
  disciplined engineer nobody is at 1am.
- **Visual quality is measured, not assumed to tie.** Use the vanilla arm's actual captures when
  it ran. For a counterfactual-only estimate, assume the same competent rendering skill and call
  out that the visual score is especially uncertain.
- **Axis 3 is not “framework imports versus none.”** Vanilla can score for a simple, coherent
  architecture, but it pays for plumbing it actually has to own. The framework arm only wins
  when its abstractions demonstrably remove that work or improve portability/correctness/proof.

## The swing test — run it every time

Recompute both totals **with axis 5 (proof) removed**. Report both pairs. Then report a second
diagnostic with **axis 3 (abstraction leverage) removed**.

If the framework only wins with the proof axis included, that is the headline finding, not a
footnote: everything else it gave you was replaceable, and the harness is the product. If it
wins without proof too, name which axis carried it. If it only wins with abstraction leverage
included, verify that the leverage is measured rather than rewarded by definition. These checks
have more information than the totals do.

## Output

Lead with the two numbers and one-line verdict. Then the table, one row per axis, both columns,
with citations in the "why" cell. Include the visual artifact paths and the three-part abstraction
audit. Then the two diagnostics. End with at most two caveats about what the run did **not**
exercise — assets, save/load, hot reload, a native target, scale beyond a few hundred lines.

```
**Framework: NN/100. Vanilla (estimate): NN/100.**

| Axis (weight) | Framework | Vanilla (est.) | Why |
|---|---|---|---|
| Setup → first frame (10) | N | N | one fact |
| Rendered visual quality (20) | N | N | captures + visual finding |
| Abstraction leverage and fit (15) | N | N | source locations + measured leverage |
...
| **Total** | **NN** | **NN** | |

Visual artifacts: `<paths>`
Abstraction audit: used well — ...; missed leverage — ...; over-abstraction — ...
Diagnostics: without proof, framework NN, vanilla NN. Without abstraction leverage, framework NN, vanilla NN.
```

Keep it concise, but do not omit the visual evidence or abstraction audit to fit one screen.

## Two rules the sections above do not carry

Report the two totals side by side; they are two readings and the reader owns the decision.
Re-score every run — a score carried forward from an earlier run is stale, and say so if you
quote one.
