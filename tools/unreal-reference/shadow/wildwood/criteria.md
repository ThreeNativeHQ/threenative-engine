# wildwood: what the judge looks for

Judge UNREAL against ENGINE per cell. Answer MATCH, CLOSE or MISMATCH per item, then overall.
The scene holds real vegetation, three Fab wildwood GLBs, in both engines: a broadleaf tree, a bush
and a fern clump on a flat floor. Each pose runs at two suns: `sun60-*` and `sun15-*`. The sun is on
+x, so shadows fall to the left. Every column header names the layer. The layers are L5 (sun and sky
shadows), L7 (global illumination) and L9 (global illumination and reflections).

Poses: `closeup` (the trunk base and the ground under the crown, with the fern and the bush) and
`medium` (the whole tree, the bush, the fern and the length of the shadows).

1. **Same scene.** Before any lighting judgement, check that the same objects stand in the same
   places with the same silhouettes. The ID IoU table in the report gives the number per object.
   An object whose IoU is under the gate is a scene mismatch, not a lighting one.
2. **Leaf-shaped shadow** (`closeup`, `medium`). The ground shadow of the tree is dappled. It holds
   gaps between the leaf cards and gaps inside each card. A solid card-shaped shadow is a MISMATCH:
   it means the shadow pass ignores the alpha mask.
3. **Gap size** (`closeup`, `medium`). The lit share of the tree shadow and the size of the gaps match
   Unreal's within a factor of about 1.5. The exact position of a gap is not judged: it moves with the
   shadow filter.
4. **Shadow on the trunk and on the understory** (`closeup`). Leaves above the trunk shade it in
   leaf-shaped spots. The fern and the bush are shaded in the same way. The spots have no hole where a
   card faces away from the light.
5. **Low sun** (`sun15-medium`). The shadow is long and stays continuous to the frame edge, with the
   same chain of gaps stretched along the sun direction. No band where it stops or changes softness.
6. **Understory shadow** (`closeup`, `medium`). The bush and the fern cast thin leaf-shaped shadows on
   the floor. The fronds keep their shape. No halo and no speckle inside the lit gaps.
7. **Leaf look.** The leaf cards are cut by the same masks as Unreal's. Their colour and brightness are
   close to Unreal's. Back-lit leaves in the shade are not black. At L7 and L9 this item is the light
   on the leaves: a crown that is brighter or darker than Unreal's by more than about 25 percent is a
   MISMATCH.
8. **Darkness.** A shadowed floor is lit by the sky alone at L5. Its brightness relative to the
   lit floor matches Unreal's within the PRD-631 thresholds.

Regions in the report: `Floor`, `GreenTree_1`, `Bush_1` and `Fern_1`.

Not judged here: wind, the two-sided foliage shading model (PRD-643), bloom and exposure (L9 only,
informative).
