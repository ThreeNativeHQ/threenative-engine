# Visual judgement: racing-kit grass + shared sky, 2048->1024 and 4096->2048

Four contact sheets, `/tmp/ckt/sheet/*.png`. Each burns its arm into the image: BEFORE is the
asset as it is on `develop`, AFTER is the candidate.

| sheet | what changed |
| --- | --- |
| `grass-color.png` | `Grass004_color.jpg` 2048x2048 q100 4:4:4 -> 1024x1024 q90 4:2:0, progressive |
| `grass-normal.png` | `Grass004_normal.jpg` 2048x2048 q100 4:4:4 -> 1024x1024, renormalised, q88 4:4:4 |
| `grass-roughness.png` | `Grass004_roughness.jpg` 2048x2048 grayscale q92 -> 1024x1024 grayscale q88 |
| `sky.png` | `sky.jpg` (shared by 9 of 29 templates) 4096x2048 q85 4:2:0 -> 2048x1024 q90 4:4:4 |

Grass rows: BEFORE and AFTER at the size the screen draws them, a 1:1 close-up of the same physical
area (the AFTER one upscaled nearest-neighbour so you see its real pixels), and - on the right - the
tile's **wrap corner at 1:1**, where the right/bottom edges meet the left/top ones at the centre of
the panel. A tiling seam would show as a straight line through that centre.

The normal row is **Lambert-lit by one fixed directional light** in both arms, because a
tangent-space normal map's stored RGB says nothing about the shading it produces.

Sky rows: both arms at one output size, the cloud band at matched output (no pixel doubling), and
the whole frame contrast-stretched to expose gradient banding.

Intended effect: **no visible change**. This is a performance change - the racing kit's cold asset
cook drops from 64.1 s to 16.2 s and the shared sky is cooked by 9 of the 29 templates - so the look
must not move.

Acceptance criteria, from the task:
1. **Crispness** - grass detail survives at the pixels the ground actually shows. No mushiness,
   no JPEG blocking, no ringing/haloing at the leaves.
2. **Seamless tiling** - the wrap edge is no more visible than an interior edge.
3. **Normal-map accuracy** - the lit shading matches in direction and contrast; no flattening,
   no plateaued or stepped blocks, no inverted tilt.
4. **Sky gradient and cloud fidelity** - no banding in the smooth gradient, cloud structure and the
   horizon transition intact.
