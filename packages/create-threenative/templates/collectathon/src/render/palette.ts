// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// `palette` is the six roles the render layer shares: the two sky bands (also the loading
// screen's track), the horizon distance fades into, the two colours the island is made of, and
// one saturated `accent` for everything the player can collect. `C` is the per-part colour table
// for the procedural models: a hero, a walker and a gem need more than six colours.

export const palette = {
  grass: 0x6fbf3f,
  /** Distance fades into this; also the loading screen's background. */
  horizon: 0xb9d8ee,
  rock: 0xb3a089,
  /** The loading screen's progress track. */
  skyHigh: 0x2f74c8,
  skyLow: 0x6fa8e0,
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

  body: 0xf06a4a,
  belly: 0xffe2c0,
  boots: 0x5a3b8c,
  gloves: 0xfdf6ea,
  cap: 0x3a7be0,
  ink: 0x20140c,

  gold: 0xffc93a,
  goldDark: 0xc98d14,
  gem: 0xe0283c,
  seed: 0xffe066,
  leaf: 0x58c43a,

  walker: 0x7a4bc4,
  walkerBelly: 0xe9d8ff,
  white: 0xffffff,
} as const;
