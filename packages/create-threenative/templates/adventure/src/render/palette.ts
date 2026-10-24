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
  /** The bright mist above the canopy, and the loading screen's progress track. */
  skyHigh: 0xd2e2da,
  /** The haze just above the trees, and the loading screen's background. */
  skyLow: 0xa9c4b8,
  /** Distance fades into this: a cool teal-green forest mist. */
  horizon: 0x8fae9f,
  grass: 0x4c6a2a,
  stone: 0x7d7a6c,
  /** The one saturated role: what the player can take or use. */
  accent: 0xf2b33d,
} as const;

export const C = {
  grassDark: 0x4e7a2a,
  grassTip: 0x7f9e44,
  dirt: 0x8b6a48,
  path: 0xb39a72,
  stoneDark: 0x5d5a52,
  moss: 0x5c7f33,
  mossLight: 0x4e6e2c,
  flagstone: 0x6b675e,
  flagstoneDark: 0x5c5850,
  flagstoneLight: 0x7a766b,
  grout: 0x2a2724,
  bark: 0x5a4130,
  leaf: 0x3f7a35,
  leafLight: 0x6aa046,
  wood: 0x9b6a3c,
  woodDark: 0x6b4426,
  iron: 0x4a4d52,
  pine: 0x2f5a32,
  pineLight: 0x46743c,
  deadwood: 0x8a8274,
  woodRing: 0xc49a6a,
  bush: 0x3a6b2e,
  fern: 0x4f8a3a,
  grassTall: 0x7ea548,
  litter: 0x8a6236,
  ivy: 0x2f5a2a,
  flowerGold: 0xf0c23a,
  flowerWhite: 0xf2efe6,
  flowerViolet: 0x9a6ad0,
  mushroomStem: 0xe9dcc4,
  mushroomCap: 0xc0392b,
  /** A firefly's glow: an emissive colour, never a light. */
  firefly: 0xd9ff7a,
  brass: 0xc79a3a,

  // The forest floor, the old trees and the hut
  soil: 0x33271c,
  soilWet: 0x2a2a20,
  forestMoss: 0x3e5820,
  mossBright: 0x4f6c26,
  cliff: 0x4e5446,
  rock: 0x6c6b5f,
  flagstone2: 0x6a665b,
  barkDeep: 0x2e231b,
  leafDeep: 0x2f5a22,
  leafSun: 0x6e9a32,
  broadleaf: 0x2f6a2a,
  flowerPink: 0xe07ab8,
  thatch: 0xb08a4a,
  thatchDark: 0x7a5a2e,
  hutDoor: 0x4a3020,
  lanternGlow: 0xffb055,
  pitcher: 0xff8a2a,
  water: 0x1c3534,
  /** The companion orb: a soft white-blue light of its own. */
  orb: 0xcfe6ff,

  // Wren
  tunic: 0xa0502c,
  tunicTrim: 0xd29b3e,
  /** The tunic's hem band: a muted ochre, cloth rather than gold. */
  hem: 0xa8793a,
  undershirt: 0xe9dcc0,
  cap: 0x30448a,
  capDark: 0x1e2b5a,
  /** The hood's lining, rolled over the edge of the opening. */
  capLining: 0x5a72b4,
  trousers: 0x7a7458,
  bootCuff: 0x8f6a45,
  skin: 0xe8b98f,
  /** The skin's own faint warmth, added in shade. */
  skinGlow: 0x4a2416,
  mouth: 0x9a5444,
  hair: 0x5b3320,
  hairLight: 0x7a4428,
  sclera: 0xe6ded0,
  iris: 0x2e2014,
  lid: 0x24160e,
  blush: 0xe3a083,
  gloves: 0x9a6238,
  belt: 0x47301e,
  sole: 0x2a1d14,
  leather: 0x6b4a2e,
  blade: 0xd8dde3,
  ember: 0xff7a2a,
  shield: 0x8a5a32,
  lamp: 0xffd27a,
  /** The slash arc and the shield's block flash: additive, so they read under any exposure. */
  slash: 0xffb35a,
  flash: 0xfff1c2,

  // Mosslings, the Warden, the dummies
  mossBody: 0x6d9a3a,
  mossBelly: 0xb9c97a,
  eye: 0x1c1a14,
  eyeGlow: 0xffe08a,
  wardenStone: 0x575550,
  flickerFur: 0x4a3a5c,
  flickerBelly: 0x8a7a92,
  flickerWing: 0x2e2238,
  /** The red the Flicker's and the Thornback's eyes burn before they strike. */
  flickerTell: 0xff3b2a,
  thornShell: 0x4a3626,
  thornBelly: 0x7a8a4a,
  thorn: 0xd9cfae,
  /** The Thornback's rump sac: the one place a cut lands. */
  thornWeak: 0xb6ff6a,
  wardenRune: 0x6fd6ff,
  straw: 0xd4b257,

  heart: 0xe5484d,
  reticle: 0xffcf4a,
} as const;
