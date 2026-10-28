# penumbra-lab: what the judge looks for

Judge UNREAL against ENGINE per cell. Answer MATCH, CLOSE or MISMATCH per item, then overall.

1. **Penumbra grows with the gap** (`heights`). The box on the floor has a hard shadow edge.
   The shadows of the boxes at 0.25, 1, 4 and 10 m soften in that order. Compare the edge width
   of each shadow, not its darkness.
2. **Contact** (`contact`). The resting box's shadow meets its base with no lit gap
   (peter-panning) and no dark halo. The edge is sharpest at the contact line.
3. **Thin caster.** The 2 cm pole casts a continuous shadow line, as long as Unreal's.
4. **Acne** (`ramp`). The 15 degree ramp shows no stripes, moire or speckle in its lit area.
   Its self-shadow starts where Unreal's starts.
5. **Step edge.** The 1 m step's shadow on the floor is straight and attached to the step.
6. **Low sun** (`sun4-*`). Long shadows stay continuous to the frame edge; no band where
   a shadow stops or changes softness (a clip-level seam).
7. **Darkness.** At L5 a shadowed floor is lit by the sky alone; its brightness relative to the
   lit floor matches Unreal's within the PRD-631 thresholds.

Not judged here: GI, AO and fog (off at L5); bloom and exposure (L9 only, informative).
