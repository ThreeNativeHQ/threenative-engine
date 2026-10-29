# Blind instrument rubric

The judge scores game builds it cannot identify, against a reference image it can see. It
is an **instrument**: it drives the loop and it never satisfies `CHARTER.md` §12 criterion 2
or a non-VOID `docs/benchmark/RESULTS-<date>.md`. Those still require a human blind session,
per `docs/benchmark/PROTOCOL.md`.

## What the judge receives

- the sealed `reference.png` for the genre, and the sealed `brief.md`;
- the shuffled samples, named `sample-01`, `sample-02`, … — screenshots, and where available
  a short capture sequence;
- this rubric;
- nothing else. No source, no arm names, no LOC, no proof results, no build transcript.

## What voids the judgment

State `VERDICT: BLOCKED` and stop if any of these is true — never score around it:

- a sample is missing, unreadable, or a uniform frame (a black canvas is a capture failure,
  not a game that renders nothing);
- any sample, filename, or metadata field contains an arm identifier — `@threenative`,
  `threenative`, `vanilla`, `framework`, `control`, `arm a`, `arm b`;
- the reveal mapping was supplied to you;
- fewer samples arrived than arms were built.

## Scoring

Score every sample independently, before comparing them. Same scale as
`docs/benchmark/PROTOCOL.md`, so instrument scores and human scores stay on one axis.

| Score | Playability | Visuals |
|---:|---|---|
| 1 | Does not start or cannot be controlled | Broken, blank, or unusable |
| 2 | Starts but interaction is substantially broken | Default/debug output with major defects |
| 3 | Complete loop with friction | Coherent presentation with visible rough edges |
| 4 | Comfortable to play and understand | Deliberate composition, hierarchy, and feedback |
| 5 | Immediately playable and satisfying | Polished, distinctive, and internally consistent |

Judge visuals against the **reference**, not against your taste: palette, light direction,
silhouette scale, camera height and angle, prop density, and whether the brief's named
elements are present and readable. A sample that is prettier than the reference but does not
match it is not thereby better — say both things.

Also record, per sample: **would a player screenshot this?** `yes` or `no`, with one
sentence of evidence.

## Anti-gaming rules

- Judge pixels and behaviour, never plausibility. If you cannot see it, you did not observe
  it.
- A sample that matches the reference framing but is empty of gameplay scores low on
  playability. Framing is not content.
- Do not reward code you cannot see, or infer effort from polish.
- Do not average away a hard difference: if one sample renders and one does not, say so
  plainly rather than splitting the score.
- One largest gap per sample. Not a wishlist.

## Required response

Return the `gauntlet-critic` structure, once per sample, then one comparison block:

```text
SAMPLE: sample-01
PLAYABILITY: <1-5>
VISUALS: <1-5>
SCREENSHOT_WORTHY: yes | no
EVIDENCE: <what you actually observed, per score>
BIGGEST_GAP: <single highest-impact difference from the reference>
```

```text
VERDICT: PASS | FAIL | BLOCKED
SCOPE: <genre> pair
BAR: matches the sealed reference and the brief's named elements
COMPARISON: <winning sample label, or TIE>
BIGGEST_GAP: <the difference that decided it>
NEXT_ACCEPTANCE_CHECK: <observable check that would close it>
CONFIDENCE: HIGH | MEDIUM | LOW
NOTES: <brief caveats only>
```

`PASS` means the better sample meets the reference bar, not merely that it beat the other
sample. Two bad games still fail.
