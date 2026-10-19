# Wildwood contact-shadow grain correction

**Superseded 2026-09-05 by [BUG-contact-noise-and-texture-blur.md](BUG-contact-noise-and-texture-blur.md),
which names the cause.** Read that first. This page is kept for the attribution work it did record
and for the two conclusions it got wrong, both of which are instructive.

## What this page originally concluded, and why it was wrong

It reported the fix as "denoise GTAO before the colour multiply, and change RCAS sharpening from
0.28 to 0.9". The owner rejected the second half on the matched screenshots: 0.9 hid the speckle by
softening every ground and leaf texture in the game.

The actual cause was `SSGINode.useTemporalFiltering`, which ships `true` and, per three's own
documentation on the property, *"requires the usage of `TRAANode`"*. Wildwood's chain has none, so
the node rotated its sample pattern every frame and nothing ever averaged the result. Two errors
followed from not knowing that:

1. **"Aggressive sharpening amplified the residual high-frequency grain" identified an amplifier,
   not a source.** It is true, and it is why turning sharpening down worked; it is also why turning
   sharpening down was the wrong place to act. The grain was one term of one stage.
2. **The matched captures were not matched.** Wind and dust are vertex programs driven by TSL
   `time`, so two captures taken at two wall-clock instants hold two different sets of plants.
   [historical noise-before.png](https://github.com/ThreeNativeHQ/threenative/blob/4ce93bcd7e2568746b86564bcd4238111833d01e/docs/verification/wildwood-shadow-cache/noise-before.png) and [historical noise-after.png](https://github.com/ThreeNativeHQ/threenative/blob/4ce93bcd7e2568746b86564bcd4238111833d01e/docs/verification/wildwood-shadow-cache/noise-after.png) in this directory differ in foliage pose as well as in
   shading, and crop-level reading of them is unsound. The replacement harness pins `time`.

The deeper reason no screenshot pair could have settled it: **two captures of the same build
differed by 5.2/255 of mean luminance, against 7.5 between the arms being compared.** The
comparison had no noise floor because no same-arm repeat was ever run, so 70% of what it was
reading was its own churn — and that churn *was* the artifact.

## What this page got right and still stands

- Increasing SSGI sampling quality did not remove the artifact.
- Increasing shadow normal bias did little, and disabling the sun's shadows left it visible. Shadow
  mapping was correctly ruled out.
- Earlier SSGI-off comparisons changed brightness and did not prove SSGI was the main source. That
  caution was right: those arms are exposure-confounded and cannot attribute. What settled it was
  temporal variance, which is brightness-independent.
- Filtering the contact term genuinely helps and is kept — `GTAONode` defaults the same temporal
  property to `false`, so its grain was static and spatially filterable all along. That is exactly
  why filtering it helped and never closed the gap.

## Regression protection

The seven tests described here have been replaced by eleven, and the two mutation controls by five.
The current set, its results, and the gates run are in the report linked at the top. Notably, the
controls this page recorded — raw AO and changed sharpening — proved that the *pinned settings*
were detected, not that the look was desirable. The suite now also pins the temporal-filtering
setting on both gathers and asserts that no TRAA stage is requested, so adding one flags the test
for revision rather than silently freezing today's answer.
