---
name: prd-creator
description: Turn a ThreeNative game idea or change into an approved game plan and implementation tasks before authoring code. Use after threenative-capabilities has recorded a capability or no-match for every mechanic, and before any game source is written.
---

# ThreeNative game PRD

Use this after `threenative-capabilities` completes the six-section discovery record. The outcome is a small, distinctive, playable plan grounded in the
engine surface and explicitly approved by the user, not a generic genre template.

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

Copy the six discovery sections verbatim into `.agent/prd/PRD.md`: **Kit**, **Mechanics**,
**References**, **Assets and audio**, **Look**, **Proof**. Each needs a value or explicit `none`
with a reason. A blank or missing section blocks approval.

Write the concise plan to `.agent/prd/PRD.md`, its short player-facing summary to
`.agent/prd/SUMMARY.md`, and implementation tasks to `.agent/tasks.json`. Tasks must be ordered,
bounded to about 10 minutes each, carry a concrete pass check, and start with `"passes": false`.
The first task verifies prerequisites; later tasks include implementation, playtest proof, and
visual inspection. Preserve the pre-planning capability decisions in the relevant task checks.

## Approval gate

Present the plan and direct the user to approve it or request changes. Do not edit game source,
download assets, authenticate services, or begin implementation while planning. Revise the plan
when the user gives feedback.

Start implementation only after explicit approval and a clear execution instruction such as
"execute", "implement", "build it", or an equivalent phrase. One message may contain both. After
that handoff, execute the approved tasks without silently expanding the scope; repeat capability
discovery only when the requested mechanics or target platforms change.
