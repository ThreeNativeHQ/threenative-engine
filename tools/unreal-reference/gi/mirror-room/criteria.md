# mirror-room: what the judge looks for

Judge ENGINE against UNREAL per pose and layer. Answer MATCH, CLOSE or MISMATCH per item, then overall.
The scene is the `cornell` room closed at the front, with one polished chrome block (`Mirror`). Every photon
comes from the lamp under the ceiling. There is no sun and no sky, so a reflection ray that finds nothing
shows black: the room is the only thing a mirror can show.

## Pose `chrome` (camera 1.1 m from the mirror, beside the green wall)

1. **The room behind the camera.** The mirror shows the green wall, the white front wall and the floor that stand
   behind the camera, in the same places as Unreal's. A mirror that
   shows black, or only what the camera also sees ahead, is a MISMATCH.
2. **Wall colours in the mirror.** The green wall reads green, as bright as in Unreal's mirror within the
   PRD-631 thresholds. A grey or tinted image of the wall is a MISMATCH.
3. **Mirror edge.** The mirror's silhouette against the floor and the walls is clean: no painted band, no
   stair-stepped seam where a screen trace ended and a scene trace began.
4. **Contact.** The floor next to the mirror's foot is as dark as Unreal's, in the mirror as well as outside it.

## Pose `room` (camera looking down the room from the green side, mirror in the left third)

5. **Reflected blocks.** The tall white block and the lamp's shade show in the mirror, at the angle Unreal shows
   them. A block that is missing, doubled or lit on the wrong side is a MISMATCH.
6. **Reflected light.** The mirror's reflection of the ceiling and the lamp's pool is as bright as Unreal's. A
   reflection that is brighter than the surface it shows (the hit lit twice) is a MISMATCH.
7. **No speckle.** The mirror carries no dashes, dots or axis-aligned dark blocks that Unreal's frame lacks.

Not judged here: bloom and exposure (L9 only, informative), shadow softness (PRD-650), rough reflections.
