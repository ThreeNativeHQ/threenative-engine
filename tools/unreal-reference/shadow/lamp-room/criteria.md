# lamp-room: what the judge looks for

Judge UNREAL against ENGINE per cell. Answer MATCH, CLOSE or MISMATCH per item, then overall.

1. **Spot, radius 0** (`spot`). The table's shadow on the floor has a hard edge. The cone's edge on
   the floor and walls falls off as Unreal's does. Compare the edge width, not the darkness.
2. **Spot, radius 10 cm** (`spot-soft`). The same table's shadow is visibly softer than in `spot`,
   and its penumbra grows with the distance from the table to the floor. The width is within 25%
   of Unreal's.
3. **Point, radius 5 cm** (`point`). The crate casts a shadow on the floor and the back wall with a
   soft edge that is narrow at the base of the crate and wider away from it. No gap at the base.
4. **Thin caster** (`rod`). The 1 cm rod casts a continuous, unbroken shadow line on the back wall
   5 cm behind it. It does not break into dashes and does not vanish.
5. **No acne, no leak.** No stripes on the walls or floor in the lit area, and no lit line along a
   seam of the room.
6. **Darkness.** At L5 the unlit part of the room is as dark as Unreal's (no GI, no sky).

Not judged here: GI and AO (off at L5); bloom and exposure (L9 only, informative).
