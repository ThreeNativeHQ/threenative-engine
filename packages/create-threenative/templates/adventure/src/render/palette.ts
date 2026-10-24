// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// `palette` is the six roles the render layer shares: the two sky bands, the haze the distance
// fades into, the meadow and the stone the world is made of, and one saturated `accent` for
// everything Wren can use — chests, the key, the lock-on reticle, the heart vessel.
//
// `C` is this game's colour table for the procedural models, named per part, so recolouring
// Wren's cloak never touches a rock.

export const palette = {
  /** The zenith, and the loading screen's progress track. */
  skyHigh: 0x3a78c4,
  /** The sky just above the haze, and the loading screen's background. */
  skyLow: 0x8fbfe6,
  /** Distance fades into this. */
  horizon: 0xd7e6ee,
  grass: 0x6f9a3c,
  stone: 0x8f8a7e,
  /** The one saturated role: what the player can take or use. */
  accent: 0xf2b33d,
} as const;

export const C = {
  grassDark: 0x4e7a2a,
  grassTip: 0x9fc25a,
  dirt: 0x8b6a48,
  path: 0xb39a72,
  stoneDark: 0x5d5a52,
  moss: 0x5c7f33,
  bark: 0x5a4130,
  leaf: 0x3f7a35,
  leafLight: 0x6aa046,
  wood: 0x9b6a3c,
  woodDark: 0x6b4426,
  iron: 0x4a4d52,
  brass: 0xc79a3a,

  // Wren
  cloak: 0x2f6b5e,
  cloakDark: 0x22504a,
  tunic: 0xd9c9a3,
  skin: 0xe8b98f,
  hair: 0x7a4a2a,
  leather: 0x6b4a2e,
  blade: 0xd8dde3,
  ember: 0xff7a2a,
  shield: 0x8a5a32,
  lamp: 0xffd27a,

  // Mosslings, the Warden, the dummies
  mossBody: 0x6d9a3a,
  mossBelly: 0xb9c97a,
  eye: 0x1c1a14,
  eyeGlow: 0xffe08a,
  wardenStone: 0x7d7a72,
  wardenRune: 0x6fd6ff,
  straw: 0xd4b257,

  heart: 0xe5484d,
  reticle: 0xffcf4a,
} as const;
