// Generated for you. Keep these roles coherent when you change the look.
// The AstraCraft battlefield: the painted ground lives in `ground.ts`; these are the few colours
// other files share, plus the three faction colours the simulation owns (`STARTS` in src/sim/terrain.ts).
export const palette = {
  /** The skirt under the map edge: the plain a wide zoom sees past the mesas. */
  cliff: 0x353f38,
  /** Ground nobody has ever seen, and the dark backing behind rings and bars. */
  unseen: 0x060f16,
  /** Distance haze: the fog colour the far battlefield fades into. */
  horizon: 0x31464a,
  /** The order marker ring: the one saturated colour, what the player just touched. */
  accent: 0xffffff,
} as const;
