---
name: prd-creator
description: Plan new ThreeNative games only, after kit selection plus mechanics-reference and built-in capability discovery; hand approved plans to texture selection, execution and verification.
---

# ThreeNative game PRD

Use this for new games only, at step 4 of `threenative-capabilities`, after kit selection and both
mechanics-reference and built-in capability discovery. Existing-game changes search per
change (existing-game route in `threenative-capabilities`) and keep their context; do not invoke
this skill to restart whole-game planning.
The outcome is a small, distinctive, playable plan grounded in both discovery passes.

## Plan

1. Inspect the existing game, its instructions, and the capability discovery record. If discovery
   is missing or the requested mechanics changed, invoke `threenative-capabilities` before drafting.
2. Preserve the request's fantasy. Define the smallest playable loop that depends on its setting,
   traversal, combat, or simulation rather than reskinning a generic character game.
3. Specify controls, camera, core mechanics, win/loss states, game state, progression, visual and
   audio direction, asset needs and licences, target platforms, performance risks, and non-goals.
4. Define fail-closed playtest acceptance criteria for the loop, including observable state and a
   real capture for visible changes. Unexecuted platforms remain unverified.
5. Record prerequisites: required tools/MCPs, service access, test users, and environment variable
   names. Use placeholders only; never read or write real secrets into planning artifacts.

Copy the three completed discovery sections into `.agent/prd/PRD.md`: **Kit**, **Mechanics**
and **References**. Each needs a value or explicit `none` with a reason; a blank or missing
section blocks approval. Required texture search/download is step 5, after plan approval;
record planned asset needs here without claiming assets have already been selected or downloaded.

List every asset under **Asset slots** in `.agent/prd/PRD.md`, one row each: name, route, status
(`placeholder` or `final`), and scale with bounding box. Pick the route per slot:

- `procedural` (default): terrain, vegetation, simple or repeated shapes, and every first version.
- `pre-made`: a generic prop that looks the same in any game, such as a wooden chair. Record its licence.
- `custom`: an identity asset the player remembers this game by, such as the hero or a signature
  vehicle. It is generated, then cleaned up, rigged and baked before it is `final`.

The code loads each slot from one stable path, so a swap replaces the file and leaves gameplay code
alone. Phase 1 (first playable) uses `procedural` and `pre-made` slots only. Phase 2 (polish) replaces
identity slots with `custom` ones, one at a time, after the user approves the gameplay or when the
judge's top gap is a placeholder. The visual judge does not score a `placeholder` slot on its looks.

Write the concise plan to `.agent/prd/PRD.md`, its short player-facing summary to
`.agent/prd/SUMMARY.md`, and implementation tasks to `.agent/tasks.json`. Tasks must be ordered,
bounded to about 10 minutes each, carry a concrete pass check, and start with `"passes": false`.
The first task verifies prerequisites and selects/downloads required textures from the mechanics
matches and supplied reference. Step 6 delegates to subagents focused on specific areas: every
bounded task names its area, file ownership and acceptance check. The coordinator reviews and
integrates all returned changes before step 7 mechanics playtests; do not use a catch-all worker.
Later tasks playtest mechanics with real actions and assertions, then require the reference-image
visual judge gate from `threenative-capabilities`. Preserve the pre-planning capability decisions
in the relevant task checks.

## Approval gate

Present the plan and direct the user to approve it or request changes. Do not edit game source,
download assets, authenticate services, or begin implementation while planning. Revise the plan
when the user gives feedback.

Start implementation only after explicit approval and a clear execution instruction such as
"execute", "implement", "build it", or an equivalent phrase. One message may contain both. After
that handoff, execute the approved tasks without silently expanding the scope; repeat capability
discovery only when the requested mechanics or target platforms change.

## Execution goal

At the handoff, start a `/goal` (or the host's persistent-goal equivalent) so execution continues
across turns. The goal text always carries both conditions:

- **Done:** every task in `.agent/tasks.json` has `"passes": true`.
- **Stop:** the first of these ends the goal: the visual judge passes its bar, three judge rounds in a
  row show no score gain, the cost cap is reached, or the user says stop or accepts the result.

Start a goal only with its Stop condition. A goal without one keeps working after the user is done.
