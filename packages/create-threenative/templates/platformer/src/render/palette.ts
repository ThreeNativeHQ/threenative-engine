// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// `palette` is the six roles the render layer shares: the loading screen's two sky bands, the
// distance the horizon fades into, the two colours a walkable surface is made of, and one
// saturated `accent` that marks everything the player can touch. Rename a role and every user of
// it moves with it, which is the point — there is no second copy of "the green" anywhere.
//
// `C` is this game's own colour table for the procedural models below it. A fox with a jacket, a
// gold coin and a red mushroom cap needs more than six colours and pretending otherwise buys
// nothing: these are named per part, so swapping one creature's fur never touches a rock.

export const palette = {
  grass: 0x5cbb37,
  /** Distance fades into this; also the loading screen's background. */
  horizon: 0xa9dcf7,
  rock: 0xa8927a,
  /** The loading screen's progress track. */
  skyHigh: 0x0a63c8,
  skyLow: 0x2b93e8,
  /** The one saturated role: coins, gems, stars, the goal. */
  accent: 0xffd23f,
} as const;

/** Colours sampled from the reference frame, by part. */
export const C = {
  skyTop: 0x2e88e0,
  skyBottom: 0xbfe4fb,
  fog: 0xa8d6f5,
  sun: 0xfff4d6,

  grass: 0x5cbb37,
  grassDark: 0x3f8f28,
  grassLight: 0x8ede4f,
  dirt: 0x8a6a45,

  rock: 0xa8927a,
  rockDark: 0x776352,
  rockLight: 0xc6b294,
  moss: 0x6a9b3f,

  wood: 0xd0904c,
  woodDark: 0x9c6330,
  woodPost: 0xb87a3c,
  rope: 0xdcc08a,

  fur: 0xf2952f,
  furDark: 0xd4761b,
  cream: 0xfbe7c9,
  jacket: 0x2f7fd6,
  jacketDark: 0x2263ab,
  pack: 0x5c7ea3,
  ink: 0x2b1a10,

  gold: 0xffd23f,
  goldDark: 0xd79a17,
  gem: 0x3fa9f5,
  gemLight: 0x9fe0ff,

  capRed: 0xdf4a3d,
  capDark: 0xa82f26,
  shellRed: 0x9e3527,
  snailBody: 0xa8c47a,
  spot: 0xfff3e2,

  water: 0x9fe3fb,
  cloud: 0xffffff,
  brick: 0xb08d72,
  brickDark: 0x8a6c55,
  roof: 0x3f7fbf,
  metal: 0x9aa7b4,
} as const;
