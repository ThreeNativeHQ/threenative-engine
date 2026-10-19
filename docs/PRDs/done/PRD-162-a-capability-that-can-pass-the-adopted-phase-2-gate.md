---
prd_contract: v1
---

# PRD-162 — Ship one capability that can actually pass the adopted Phase 2 gate

**Status:** PROPOSED, 2026-08-19. Nothing below has executed. The red recorded in §1 is
[`phase-2-2026-08-19.md`](../../verification/phase-2-2026-08-19.md)'s result, not this PRD's.

**Closed 2026-08-20 — RED with attribution, the permitted ending in §8.** The capability shipped
and both consumer legs executed to `stateHash = 1884960806`; the gate is red on the instrument
condition, because a plain-Three.js arm has no desktop runtime and lending it the framework's host
voids the run. Evidence: [phase-2-2026-08-20](../../verification/phase-2-2026-08-20.md). The
desktop instrument's flake is filed as
[PRD-167](PRD-167-desktop-playtest-mailbox-goes-silent.md).

**Outcome:** beta row 3 has a **post-adoption** capability shipped, proven by an outcome a consumer
observes, on an instrument that does not hand the control arm the capability, with a same-subject
negative control observed red — or a written, evidenced statement of exactly which of the three
conditions the attempt failed and why. Both are results; only silence is not.

**Depends on:** nothing external. The whole subject runs on this machine: browser WebGPU under
`sh scripts/xvfb.sh`, and the native desktop host via `pnpm native:build` and
`pnpm native:verify:desktop`.

**Blocks:** beta row 3 — the only one of the three beta blockers that is open to *work* rather than
to an owner decision or a hosted run. Row 5 needs a release run; row 4's Android half is
[PRD-160](PRD-160-android-emulator-lane-repair-and-parity-adjudication.md).

**Complexity: 8 → LARGE mode.** One capability shipped across a web/native seam, one honest vanilla
arm, one instrument that does not cheat, three phases that can each end the PRD.

**Blast radius: ~25 files.** `packages/core/src/`, `packages/runtime-native/`,
`packages/playtest/src/` if the instrument needs an assertion it lacks, one template or example as
the consumer subject, a conformance case, and `docs/verification/phase-2-<date>.md`.

---

## 1. Why the last execution was red, precisely

The owner adopted the replacement gate on 2026-08-19 and executed it once. The execution was **RED**
on two rows, and neither was a harness fault:

| Criterion | Why it failed |
|---|---|
| New capability after adoption | The subject — the platformer's `settled` physics assertion — was already shipped and measured by PRD-081 on 2026-08-12. Reproducing shipped work is consumer evidence, not post-adoption shipping evidence. |
| Instrument boundary | The control removed `rapier()` from the scaffold. **Deleting a framework plugin is not a vanilla arm.** A control that can only fail because the framework was cut proves the plugin is load-bearing, not that vanilla has no answer. |

So the gate does not need a better write-up. It needs **something new to be shipped**, and it needs
a control arm that is a genuine plain-Three.js attempt.

## 2. Phase 0 — choose the subject, and write the litmus down first

Before a line is written, record in the verification file, in this order:

1. **The capability sentence.** One sentence, phrased as what a *player or consumer observes*, not
   as what a package exports. "The desktop build replays the run the browser recorded" is a
   capability. "`createReplayDriver` is exported" is not.
2. **Question (a).** Could the game write this portably itself? It qualifies only if the answer is
   no *because* it needs a browser global, a platform seam, or a backend the game must not know it
   got.
3. **Question (b).** Does it decide how anything looks? If yes, it ships as generated `src/render/`
   source and **is not a gate subject.** (b) vetoes (a).
4. **Post-adoption test.** Does this capability exist on `HEAD` today, in any working form? If yes,
   pick another. Grep and say what you grepped.
5. **Vanilla-arm test.** Can a competent agent implement it in plain Three.js given a bounded
   budget? Write the budget down *before* running it, so the arm cannot be quietly starved.

### Recommended subject, not binding

**The desktop build replays a run the browser recorded, tick for tick, and both report the same
state hash.** It is recommended because:

- `createReplayDriver` and `replay` exist in `packages/core/src/replay.ts` for the **web**. Whether
  a web-recorded recording replays on the **native host** to an identical hash is, on inspection,
  unverified — Phase 0 must confirm that by execution, not by reading this paragraph.
- It passes (a): determinism across two runtimes needs a fixed-step clock, a seeded random source,
  and an owned host. A game cannot write the C++ half of it portably.
- It passes (b): it decides nothing about how anything looks.
- Its vanilla arm is honest to run: plain Three.js can record inputs in a browser, and then has
  nowhere to replay them. That failure is *observed*, not asserted, and it is the exclusivity claim
  the last execution could not make.

If Phase 0 finds this already works end to end, **that is a good outcome** — record the evidence,
then pick the next subject from the same litmus rather than forcing this one.

## 3. Phase 1 — ship it

Ordinary work, in the ordinary places. Where it lands is decided by the table in the root
instructions, not by convenience: plumbing every game repeats goes in `packages/core/src/`, the C++
half in `packages/runtime-native/`, anything a screenshot shows in generated template source.

Two rules apply with no exceptions:

- **A feature that works on web only is unfinished.** The native half ships in the same commit as a
  conformance case or a `--target` playtest, and no result claims a platform it did not execute on.
- **Red-green, bugfixes included.** The failing test lands before the fix, and both land together.

## 4. Phase 2 — build the instrument, and let the control arm actually try

The instrument is a **consumer-scoped** proof: a scaffolded project or example that uses only the
public surface, driven by `packages/playtest`. Three properties, all mandatory:

| Property | What it means here |
|---|---|
| Consumer scope | The subject is a scaffolded project. No repo-internal import, no workspace link that a user would not have. |
| The control arm is vanilla | The control is a plain-`three` implementation of the same outcome, written against the same brief, within the budget declared in Phase 0. **Not** the scaffold with a plugin removed. |
| The instrument does not hand over the capability | If the harness itself supplies the thing under test to both arms, the run is void. The paired sweep gives both arms the `playtest` bridge, which is exactly why the adopted gate does not use it. Say in writing how this instrument avoids the same defect. |

Record the vanilla arm's result whatever it is. If vanilla matches the capability, **the gate fails
and the capability was not exclusive** — write that down; it is a real finding about the framework
and worth more than a green nobody believes.

## 5. Phase 3 — execute, with the same-subject negative control observed red

1. Positive run: the consumer subject, unmodified, producing the observed outcome. Paste it.
2. Same-subject negative control: break the capability at its source — not by deleting a plugin —
   and observe the run go red with a named diagnostic. Paste it. A control that skips, passes
   vacuously, or errors before assertion evaluation is not a control.
3. Native leg: the same subject on the native desktop host. Paste `adapter`/host identity.
4. Write `docs/verification/phase-2-<date>.md` in the shape the 2026-08-19 file already uses:
   criteria table, evidence commands with pasted output, and a "claims deliberately not made"
   section.
5. Update `docs/strategy/ROADMAP.md` row 3 to whatever the run actually produced.

## 6. Negative controls, each observed red

| Control | Deliberate defect | Required result |
|---|---|---|
| Capability removed at source | Break the mechanism under test in the shipped code | consumer run red with a named diagnostic |
| Vacuous pass | Run the assertion against a subject that never reaches the capability | fails closed, never "passed with 0 observations" |
| Instrument leakage | Give the vanilla arm the framework bridge on purpose | the run is rejected as void by this PRD's own rule |
| Native claimed but not run | Record a native row without executing the host | rejected; the row reads UNVERIFIED |
| Adapter identity | Run the browser leg without naming the adapter | rejected; a SwiftShader adapter voids the leg |

## 7. Acceptance criteria

| # | Criterion | Evidence |
|---|---|---|
| 1 | The subject capability did not exist on `HEAD` before this PRD | Phase 0 record, with the greps that established it |
| 2 | It passes question (a) and does not decide how anything looks | Phase 0 record |
| 3 | It ships with a web leg and a native leg in the same commit | conformance case or `--target` playtest, pasted |
| 4 | A consumer-scoped positive run is observed | pasted output from a scaffolded project |
| 5 | The control arm is a genuine plain-Three.js attempt with a pre-declared budget, and its result is recorded whatever it was | vanilla arm source plus its run |
| 6 | A same-subject negative control is observed red with a named diagnostic | pasted output |
| 7 | All five controls in §6 observed red | pasted output |
| 8 | `pnpm typecheck && pnpm lint && pnpm test` green, `pnpm budgets` reported, and the capability manifest regenerated if the public surface changed | pasted output |
| 9 | Roadmap row 3 states the executed result, green or red | diff |

## 8. Permitted endings

This PRD may honestly end in any of these states, and each is written up rather than retried
blindly:

- **GREEN.** All three gate conditions hold. Phase 2 exits. This has never happened; do not round up
  to it.
- **RED with attribution.** One condition failed, and the file names which and why.
- **PARTIAL.** The capability shipped, the instrument is built, and one leg did not execute in the
  night. The unexecuted leg reads UNVERIFIED — never "expected to pass".

**Forbidden endings:** a green claimed from a control that removed a framework plugin; a native row
claimed from a web run; a capability declared exclusive without an attempted vanilla arm.

## 9. Deliberately out of scope

- Beta row 5, the release lane, and anything needing npm publication or CI minutes.
- Any physical-device, iOS or mobile-readiness claim.
- Re-litigating the gate itself. The owner adopted it on 2026-08-19; this PRD executes it.
