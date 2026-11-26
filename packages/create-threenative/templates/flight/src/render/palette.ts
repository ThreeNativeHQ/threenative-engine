// Keep these roles coherent when you change the look.
// Neutral greys carry the light; one saturated blue marks what you fly, aim at or land on.
export const palette = {
  /** Light grid: the island and the pad's white rings. */
  floor: 0xb4b1ae,
  /** Dark grid: towers, the launch ramp, the glider's frame. */
  structure: 0x747578,
  /** The metre line both grids are drawn in. */
  gridLine: 0x3a3a3c,
  /** The one saturated colour: the glider's sail, the pad's target and the ring you fly at next. */
  accent: 0x2a6cf0,
  /** The sea, a cool grid under the same sky. */
  sea: 0x56697c,
  /** A ring flown through, and a ring missed. */
  passed: 0x59c46b,
  missed: 0xd0532a,
  /** The sky's own horizon: distance fades into this, and it is the loading backdrop. */
  horizon: 0xacb1c1,
} as const;
