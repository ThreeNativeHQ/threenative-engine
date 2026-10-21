# wildwood: what the judge looks for

Judge UNREAL against ENGINE per cell. Answer MATCH, CLOSE or MISMATCH per item, then overall.
The scene holds real vegetation, the Fab wildwood GLBs, in both engines: a pine and a broadleaf
tree, a bush, two ferns, three grass clumps and two flower clumps on a flat floor. Each pose runs at
two suns: `sun60-*` and `sun15-*`. The sun is on +x, so shadows fall to the left. Every column
header names the layer.

Poses: `canopy` (both trees and the ground under them), `shrub` (bush and ferns), `ground` (grass and
flower clumps).

1. **Same scene.** Before any lighting judgement, check that the same objects stand in the same
   places with the same silhouettes. The ID IoU table in the report gives the number per object.
   An object whose IoU is under the gate is a scene mismatch, not a lighting one.
2. **Leaf-shaped shadow** (`canopy`). The ground shadow of each tree is dappled. It holds gaps
   between the leaf cards and gaps inside each card. A solid card-shaped shadow is a MISMATCH: it
   means the shadow pass ignores the alpha mask.
3. **Gap size** (`canopy`). The lit share of the tree shadow and the size of the gaps match
   Unreal's within a factor of about 1.5. The exact position of a gap is not judged: it moves with the
   shadow filter.
4. **Both faces cast** (`canopy`, `shrub`). Cards that face away from the sun still cast and still
   shade. The shadow has no hole where a card faces away from the light.
5. **Low sun** (`sun15-canopy`). The shadow is long and stays continuous to the frame edge, with the
   same chain of gaps stretched along the sun direction. No band where it stops or changes softness.
6. **Understory shadow** (`shrub`, `ground`). The bush, ferns and grass cast thin leaf-shaped
   shadows on the floor. The blades keep their shape. No halo and no speckle inside the lit gaps.
7. **Leaf look.** The leaf and grass cards are cut by the same masks as Unreal's. Their colour and
   brightness are close to Unreal's. Back-lit leaves in the shade are not black. At L9 only, this
   item is informative.
8. **Darkness.** A shadowed floor is lit by the sky alone at L5. Its brightness relative to the
   lit floor matches Unreal's within the PRD-631 thresholds.

Regions in the report: `Floor` and one region per instance (`Pine_1`, `GreenTree_1`, `Bush_1`,
`Fern_1`, `Fern_2`, `Grass_1` to `Grass_3`, `Flower_1`, `Flower_2`).

Not judged here: wind, the two-sided foliage shading model (PRD-643), bloom and exposure (L9 only,
informative).
