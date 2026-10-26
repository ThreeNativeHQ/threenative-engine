// Generated for you. Keep these roles coherent when you change the look.
// Neutral greys carry the light; one saturated blue marks what you can touch.
export const palette = {
  /** Light grid: room floors and the ground the dungeon stands on. */
  floor: 0x98948e,
  /** Dark grid: walls, door lintels, pillars — anything structural. */
  structure: 0x747578,
  /** The metre line both grids are drawn in. */
  gridLine: 0x3a3a3c,
  /** The one saturated colour: chests, dropped loot, and anything else you can touch. */
  accent: 0x2a6cf0,
  /** The sky photograph's own horizon: distance fades into this, and it is the loading backdrop. */
  horizon: 0x8f9ab0,
} as const;

// The hostile tint, the torch flame and the blade steel are not roles of their own — they are
// materials, so `materials.ts` owns them next to the surfaces that use them.
