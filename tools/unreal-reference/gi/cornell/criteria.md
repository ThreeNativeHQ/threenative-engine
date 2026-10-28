# cornell: what the judge looks at (PRD-647)

Reference: Unreal 5.8.3 `L7-Epic` (tier `high`), `L7-Medium` (tier `medium`) and `L7-Low` (tier `low`).
Frames: `tools/unreal-reference/captures/unreal/cornell/<variant>/<pose>.png`. Regions and ID masks:
`reference-stats.json` and `id/`. Read `../judge-brief.md` first.

The room is a box open at the camera side, with a red left wall, a green right wall, white floor, ceiling and
back wall, a tall box and a short box, and one lamp in a recess of the ceiling. There is no sky. The lamp lights
the top of each box and part of the floor. Everything else is lit by bounce.

## What every pose must show

1. **Colour bleeding.** The red wall tints the white surfaces near it (floor, back wall edge, the tall box's left
   face). The green wall does the same on its side. The tint fades smoothly.
2. **Soft contact.** Boxes and walls meet the floor with a soft dark crease. No black line and no bright line at
   any junction.
3. **Smooth surfaces.** No grain, speckle, streaks or blotches on any wall, the ceiling or the boxes.
4. **Dark faces stay dark.** A face that the lamp does not reach and that looks at the open side gets only weak
   bounce. In Unreal the front face of the short box is dark and warm.

## Per pose

- **cornell.** The whole box. The ceiling is white with a soft tint at each side and a recess that is darker than
  the ceiling, with a darker crease under its rim. The back wall is nearly uniform white. The tall box has a
  red-tinted left face. The short box has a bright top, a dark warm front face (about a third of the brightness
  of its top), and a green-tinted right face. Each box casts a soft shadow away from the lamp.
- **corner.** The red wall, the back wall and the floor at the left corner, close up. The red wall is saturated
  and darkens toward the far corner. The floor is pink from the red wall. The face of the tall box at the right
  is a light grey with only a weak red tint. Junctions are soft.

## Regions that matter most

`Box_Short`, `Box_Tall`, `Back`, `Ceiling`, `Floor`, `Wall_Red`, `Wall_Green`. A region p50 outside 10 percent of
Unreal needs a named reason in the verdict.
