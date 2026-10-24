# wildwood-backlit: what the judge looks for

Judge UNREAL against ENGINE per cell. Answer MATCH, CLOSE or MISMATCH per item, then overall.
The scene is `wildwood` (one tree, one bush, one fern clump on a flat floor, real Fab GLBs, Nanite off in
Unreal) with the leaf materials on Unreal's Two Sided Foliage shading model, each with a Subsurface Color.
The camera is on the side away from the sun and looks up into the crown, so it sees the leaf undersides.
Each pose runs at two suns: `sun60-*` and `sun15-*`. The sun is on +x. Every column header names the layer.
The layers are L5 (sun and sky shadows, no GI), L7 (global illumination) and L9 (global illumination and
reflections).

Poses: `under` (looking up into the crown, toward the sun) and `toward` (the whole tree, the sun behind it).

1. **Same scene.** Before any lighting judgement, check that the same objects stand in the same places
   with the same silhouettes (the ID IoU table in the report). A low IoU is a scene mismatch.
2. **Leaf undersides are lit.** In both engines the leaves seen from below are not black. At L7 and L9 the
   brightness of the crown (`GreenTree_1`, `Bush_1`, `Fern_1`) is within about 25 percent of Unreal's and
   its hue is the same green. A crown that is brighter or darker than that is a MISMATCH.
3. **Sky through the card.** The light that reaches a leaf's back face from the sky above the crown is the
   subsurface term of L7. Compare L5 with L7: the step between them (what the bounce light adds) has the
   same size and the same colour in both engines.
4. **Sun through the card** (`sun15-under`, `sun15-toward`). Leaves the sun shines through, seen from the
   shade side, glow brighter than the lit leaves around them in Unreal. Judge whether the engine shows the
   same bright leaves, within a factor of about 1.5 in brightness.
5. **No holes.** A card that faces away from the sun is not black where Unreal's is lit.

Regions in the report: `Floor`, `GreenTree_1`, `Bush_1` and `Fern_1`.

Not judged here: wind, bloom and exposure (L9 only, informative), the shadow shape on the floor (see
`wildwood`).
