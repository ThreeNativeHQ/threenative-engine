# foliage: what the judge looks for

Judge UNREAL against ENGINE per cell. Answer MATCH, CLOSE or MISMATCH per item, then overall.
Each pose runs at two suns: `sun60-*` and `sun15-*`. The sun is on +x, so shadows fall to the left.

1. **Leaf-shaped shadow** (`canopy`). The ground shadow of the tree is dappled. It holds gaps
   between the leaf cards and gaps inside each card, where the leaflets part. A solid rectangle
   per card is a MISMATCH: it means the shadow pass ignores the alpha mask.
2. **Gap size** (`canopy`). Compare how much of the shadow area is lit. The lit share and the
   size of the gaps match Unreal's within a factor of about 1.5. Do not compare the exact
   position of a gap: it moves with the shadow filter.
3. **Both faces cast** (`canopy`). Cards that tilt away from the sun still cast. The shadow has
   no hole where a card faces away from the light.
4. **Low sun** (`sun15-canopy`). The shadow is long and stays continuous to the frame edge. It
   shows the same chain of gaps, stretched along the sun direction. No band where it stops or
   changes softness (a clip-level seam).
5. **Card grass** (`grass`). The grass blades cast thin leaf-shaped shadows on the floor near
   the pawn. The blades keep their shape in the shadow. The pawn shadow starts at its feet.
6. **Edge** (`grass`). The edge of a blade shadow is as sharp as Unreal's, with no halo and no
   speckle inside the lit gaps of the grass cards.
7. **Darkness.** At L5 a shadowed floor is lit by the sky alone. Its brightness relative to the
   lit floor matches Unreal's within the PRD-631 thresholds.
8. **Leaf look.** The leaf and grass cards are cut by the same masks as Unreal's. Their colour
   and brightness are close to Unreal's. At L9 only, this item is informative.

Regions in the report: `Floor`, `Trunk`, `Pawn`, `Leaves` (all leaf cards) and `Grass` (all
grass cards). The `Leaves` and `Grass` ID IoU shows whether the cut matches.

Not judged here: GI, AO and fog (off at L5), bloom and exposure (L9 only, informative), wind
(the `wind` run is a separate cell), and the two-sided foliage shading model (PRD-643).
