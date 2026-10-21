# cornell: what the judge looks for

Judge the engine against Unreal per pose. The scene is a closed white box with a red left wall, a green
right wall, a tall box and a short box, and one lamp on the ceiling. Every photon that does not come
straight from the lamp is bounced light. The regions are `Floor`, `Ceiling`, `Back`, `Wall_Red`,
`Wall_Green`, `Box_Tall`, `Box_Short` and `Shade`.

## Pose `cornell` (the camera at the open front, looking at the back wall)

1. **Colour bleeding on the back wall.** The `Back` wall takes a pink tint beside the red wall and a green
   tint beside the green wall, and both fade to neutral white toward the middle. The tint reaches about as
   far from each side wall as it does in Unreal. A grey or white back wall with no tint is FAR.
2. **Colour bleeding on the boxes.** The side of `Box_Tall` that faces the red wall is red-tinted. The side
   of `Box_Short` that faces the green wall is green-tinted.
3. **Floor.** The `Floor` carries a red cast near the red wall and a green cast near the green wall. The soft
   dark patches beside the boxes (bounce-lit shadow) have the same depth as in Unreal.
4. **Ceiling.** The `Ceiling` is lit by bounce only, apart from the lamp pocket. It is brightest near the lamp
   and falls off smoothly. It shows no blotches, no stripes and no black corners that Unreal lacks.
5. **Faces that look away from the lamp.** The front of `Box_Short` is dim and warm grey in Unreal: lit by
   bounce only. It must read dim and warm too, darker than the top of the box and not as bright as a face
   that the lamp lights directly.
6. **No noise.** `Back` and `Ceiling` are smooth. Speckle, grain, tiling or blotches that Unreal's frame
   lacks are a fault at any strength a player can see at full size.
7. **Contact darkening.** Where the boxes meet the floor and where the walls meet each other the frame
   darkens softly, with no dark band and no bright halo along the crease.

## Pose `corner` (a close view into the gap between the red wall and the tall box)

8. **Floor strip.** The floor in the gap has a red-brown cast and darkens toward the back corner. The dark
   fades smoothly, with no band.
9. **Back corner.** The back wall at the end of the gap is pink-grey and darker than the open back wall in
   the first pose. It is not black and not as bright as the open wall.
10. **Red bounce.** The side of `Box_Tall` that faces the red wall shows red bounce light. The shadow of the
    box on the red wall is dark red, not black.
11. **Exposure of the whites.** The white surfaces in both poses sit at about the same brightness as
    Unreal's. A frame that is clearly brighter or darker overall is CLOSE at best.

Not judged here: bloom and exposure adaptation (L9), how sharp the shadow edges are (PRD-650), the shape of
the lamp (PRD-634), reflections.
