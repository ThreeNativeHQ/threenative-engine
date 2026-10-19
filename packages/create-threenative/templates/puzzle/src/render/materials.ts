// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// One material per role, shared by every mesh that plays that role, so the whole vault is a couple
// of dozen draw-call-sharing surfaces rather than four hundred unique ones. Surface variety comes
// from alternating entries, never from a bitmap: `CanvasTexture` samples BLACK under
// `WebGPURenderer`, and a flagstone seam drawn as geometry reads correctly on every target.
//
// The room needs more tints than `palette.ts` has roles, so they live here, beside the material
// that wears them, and `palette.ts` keeps the six that are contracts rather than choices.

import {
  Color,
  DoubleSide,
  type Material,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Texture,
} from "three";
import { palette } from "./palette.js";

/** The seams between flagstones: one step darker than the floor, never black. */
const SEAM = 0x171d29;
/** The dark plinth under the plaster, and the skirting at the floor. */
const WALL_BASE = 0x2b3242;
/** Cut stone, not timber: the kerb the seal is set into. Never emissive. */
const SEAL_STONE = 0x434d5d;
/** The diamond insets and the rail highlights. */
const TIMBER_LIGHT = 0x8f6742;
/** The plank braces nailed across every crate face. */
const CRATE_BRACE = 0x3d2a1a;
/** The second crate tint, sea teal. `palette.prop` is the first. */
const CRATE_TEAL = 0x2b9187;
/** The third crate tint, amber. */
const CRATE_AMBER = 0xdb9835;
/** Hanging banners on the east wall. */
const BANNER = 0x1d3a5c;
/** The warden: unpainted, matte, the lightest thing in the room. */
const WARDEN = 0xefe7d6;

/** Lantern flame. Exported because the point light beside each flame is this same colour. */
export const LANTERN = 0xff9a3c;

export const floorMaterial = new MeshStandardMaterial({
  color: palette.floor,
  metalness: 0.04,
  roughness: 0.86,
});

export const floorSeamMaterial = new MeshStandardMaterial({ color: SEAM, roughness: 0.95 });

export const wallMaterial = new MeshStandardMaterial({ color: palette.wall, roughness: 0.92 });

export const wallBaseMaterial = new MeshStandardMaterial({ color: WALL_BASE, roughness: 0.9 });

export const timberMaterial = new MeshStandardMaterial({ color: palette.timber, roughness: 0.82 });

export const timberLightMaterial = new MeshStandardMaterial({
  color: TIMBER_LIGHT,
  roughness: 0.74,
});

/**
 * The three crate tints, cycled across the pile by a seeded draw. Three are the whole reason the
 * pile reads as a heap of crates rather than as one mass of colour: with one tint, forty bodies of
 * it are forty of the same thing.
 */
export const crateMaterials: readonly Material[] = [
  new MeshStandardMaterial({ color: palette.prop, roughness: 0.72 }),
  new MeshStandardMaterial({ color: CRATE_TEAL, roughness: 0.72 }),
  new MeshStandardMaterial({ color: CRATE_AMBER, roughness: 0.72 }),
];

/** The battens nailed across a crate's faces. Untextured on purpose: a batten is 6 cm thick. */
export const crateBraceMaterial = new MeshStandardMaterial({ color: CRATE_BRACE, roughness: 0.86 });

/**
 * A phase crate: the accent, emissive and translucent, so the room reads straight through it.
 *
 * A glass shell plus an emissive edge cage (`phaseCoreMaterial`), so it still reads as a
 * solid-shaped object rather than as a smudge. Emissive as well as lit because the collider behind
 * it is one a body can walk through, and the material is the only thing saying so before you try.
 */
export const phaseMaterial = new MeshStandardMaterial({
  color: palette.accent,
  emissive: new Color(palette.accent).multiplyScalar(0.55),
  metalness: 0,
  opacity: 0.55,
  roughness: 0.1,
  transparent: true,
});

/**
 * The edge cage inside a phase crate. Dimmer than the palette entry: at full value the ward clips
 * to white under bloom and stops reading as a crate-shaped thing at all.
 */
export const phaseCoreMaterial = new MeshBasicMaterial({
  color: new Color(palette.accent).multiplyScalar(0.46),
});

/**
 * The lantern flame. Below full value on purpose: an unclamped emissive at this bloom threshold
 * turns each lantern into a white disc and the wall behind it into a wash.
 */
export const lanternMaterial = new MeshBasicMaterial({
  color: new Color(LANTERN).multiplyScalar(0.8),
});

export const bannerMaterial = new MeshStandardMaterial({
  color: BANNER,
  roughness: 0.95,
  side: DoubleSide,
});

/**
 * The kerb around the seal. Cut stone: it was emissive for one iteration and the whole plate
 * clipped to a white square under bloom, and the seal is supposed to be the bright thing, not its
 * frame.
 */
export const sealRimMaterial = new MeshStandardMaterial({ color: SEAL_STONE, roughness: 0.82 });

export const wardenMaterial = new MeshStandardMaterial({ color: WARDEN, roughness: 0.62 });

export const wardenFootMaterial = new MeshStandardMaterial({
  color: new Color(WARDEN).multiplyScalar(0.72),
  roughness: 0.7,
});

/** The packaged proof glTF hangs on the east wall as a banner; it owns its sampled look. */
export function createBannerMaterial(texture: Texture): Material {
  return new MeshBasicMaterial({ map: texture, side: DoubleSide });
}
