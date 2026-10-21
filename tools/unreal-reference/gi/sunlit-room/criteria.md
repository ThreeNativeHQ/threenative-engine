# sunlit-room: what the judge looks for

Judge the engine against Unreal per pose. The scene is a closed room with one window, a door to a dark
hall, a floor, a ceiling and four walls. The sun comes in through the window and lands as a patch on the
floor. Every other surface is lit by bounced light and by sky light that enters through the window. The
regions are `Floor`, `Ceiling`, `Wall_Left`, `Wall_Right`, the front wall pieces `Front_*`, the back wall
pieces `Back_*`, `Hall_Back` and `Ground`. Two suns are captured: `sun60` (a high sun, a neutral grey room)
and `sun15` (a low sun, a warm brown room and a long warm patch).

## Poses `sun60-window` and `sun15-window` (the camera looks at the window wall)

1. **Bounce around the sun patch.** The sunlit floor patch is the brightest area. Around it the floor is
   lifted softly, and the wall below the window takes a soft glow. The glow has the same size and the same
   falloff as in Unreal. A patch with no light around it is FAR.
2. **Tint of the room.** At `sun60` the walls and the ceiling are dim neutral grey. At `sun15` they are dim
   and warm brown, like the patch. A neutral grey room at `sun15`, or a warm one at `sun60`, is FAR.
3. **Walls and ceiling.** They are lit by bounce and sky light only. They are brighter toward the window end
   of the room and darker near the camera. The ceiling is lighter above the window wall.
4. **Dark areas.** The floor away from the patch and the corners are dark but never pure black. The dark
   fades out smoothly, with no band along the creases.
5. **Smoothness.** The walls and the ceiling show no blotches, banding, probe cells or stripes that
   Unreal's frame lacks.

## Poses `sun60-leak` and `sun15-leak` (a corner away from the window)

6. **No light leak.** No bright line, glow or bright patch sits on the seam between two walls, a wall and
   the floor, or a wall and the ceiling. The corner darkens smoothly into the seam.
7. **Level and tint.** The walls carry the same tint and about the same brightness as Unreal's: cool dim
   grey at `sun60`, warm brown at `sun15`. A wall that is clearly brighter or darker is CLOSE at best.
8. **Gradient.** Each wall shows the same soft gradient as Unreal's, with no flat uniform ambient.

## Poses `sun60-door` and `sun15-door` (the camera looks across the room at the door)

9. **The hall.** The opening shows a dark hall. It is darker than the room walls. No light leaks through
   the frame or glows in the hall.
10. **Beside the opening.** The walls next to the door darken softly toward the opening. The frame edges
    are clean, with no bright or dark halo.
11. **Level.** The room walls are dim and keep the tint of the room for that sun, at about Unreal's
    brightness.

Not judged here: the sky and the clouds in the window (L2 to L4), how sharp the edge of the sun patch is
(PRD-650), bloom and exposure adaptation (L9), reflections.
