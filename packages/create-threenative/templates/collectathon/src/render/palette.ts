// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// `palette` is the six roles the render layer shares: the two sky bands (also the loading
// screen's track), the horizon distance fades into, the two colours the island is made of, and
// one saturated `accent` for everything the player can collect. `C` is the per-part colour table
// for the procedural models: a hero, a walker and a gem need more than six colours.

export const palette = {
  grass: 0x64b43c,
  /** Distance fades into this; also the loading screen's background. */
  horizon: 0xb9d8ee,
  /** A warm sandstone at about half albedo: lighter reads as grey card under the sun. */
  rock: 0x927b62,
  /** The loading screen's progress track. */
  skyHigh: 0x1c5cc6,
  skyLow: 0x5c9de2,
  /** The one saturated role: coins, gems, Sunseeds. */
  accent: 0xffc93a,
} as const;

/** Colours by part. Albedo, not light: the sun and the sky bring the brightness. */
export const C = {
  grass: 0x5fae35,
  grassDark: 0x478a28,
  dirt: 0x8a6a48,
  sand: 0xd8c08c,
  rock: 0xa89580,
  rockDark: 0x7d6c5c,
  water: 0x2f86b8,
  wood: 0xa8743f,

  // Pip: a teal cap with a leaf badge, a rust shirt, mustard overalls, cream gloves, brown shoes.
  cap: 0x169c94,
  shirt: 0xc8562a,
  overalls: 0xd9a42c,
  button: 0xfff1d0,
  gloves: 0xfff3dc,
  boots: 0x6a4126,
  skin: 0xf2b48c,
  nose: 0xf0a088,
  hair: 0x4a2c18,
  ink: 0x20140c,

  gold: 0xffbf1f,
  goldDark: 0xc98d14,
  gem: 0xe0283c,
  seed: 0xffe066,
  leaf: 0x58c43a,

  walker: 0x7a4bc4,
  walkerBelly: 0xe9d8ff,
  hopper: 0x8fd14a,
  hopperBelly: 0xf4f0c8,
  thornShell: 0xc8642a,
  thornBelly: 0xe8c890,
  spike: 0x3a2a24,

  // Planting: leaves by kind, flowers, mushroom caps, the shore.
  bush: 0x3f9a34,
  hedge: 0x2f7d2c,
  canopy: 0x4fae3a,
  palm: 0x6cb83a,
  bark: 0x8a6440,
  fruit: 0xe0502a,
  blade: 0x5aa632,
  petalWhite: 0xfff4e0,
  petalPink: 0xff8fb8,
  petalYellow: 0xffd84a,
  petalLilac: 0xb08cff,
  mushroom: 0xd8423a,
  wetSand: 0xb09868,
  foam: 0xf4fbff,
  white: 0xffffff,
} as const;
