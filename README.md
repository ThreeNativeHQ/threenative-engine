# PRD-600 captures

Frozen route pose (`?arm=virtual&mode=pose&frame=120`), quarry example, 1920x1080, WebGPU adapter
`google/swiftshader` (this machine has no working GPU). `viewCull=off` reproduces the old unpruned
cut on the same build, so the pair differs only by the cull.

| File | What it is |
| --- | --- |
| `before-rim-viewCull-off.png` | the unpruned cut: 3,959,710 clustered triangles submitted, 1,113,876 of them outside the view |
| `after-rim-viewCull-on.png` | the view-pruned cut: 2,982,454 submitted, 148,766 outside |
| `first-round-after-missing-cliff.png` | **the bug this PRD found**: before the quantization fix, the same pose lost its cliff face entirely |
| `first-round-before.png` | the same round's unpruned arm, for comparison |

The independent visual judge scored the final pair NEUTRAL: 98.37% of pixels bit-identical, every
non-banner difference confined to four clusters of ray-traced shadow speckle, no visible geometry
missing. The first round scored REGRESSION and its SM hashed the missing cliff face.
