// The one place a real-world size is declared.
//
// One metre is one metre. Everything that builds or measures a physical object imports
// from here, so the game renders at the right size. A model that arrives in centimetres is
// normalised on load — never accommodated by tuning a literal beside it.
//
// This file is why the 2.68 m soldier, the 1.19 m AK and the 1.43 m viewmodel cannot
// come back: there is no second place to write a size.

import type { Object3D } from "three";

/** Real-world sizes, in metres. */
export const scale = {
  /** Adult soldier, boots to head-top. */
  humanHeight: 1.78,
  /** Eye above the deck, standing. */
  eyeHeight: 1.66,
  /** Shoulder width; sets the hitbox width and depth. */
  shoulderWidth: 0.5,
  /** Body depth front to back. */
  bodyDepth: 0.32,
  /** AK-pattern rifle, muzzle to stock. */
  rifleLength: 0.88,
  /** Man-size range silhouette. */
  silhouette: { width: 0.5, height: 1.8 },
  /** Plate dimensions used by every target in the range. */
  targets: {
    wideWidth: 0.625,
    standardWidth: 0.5,
    narrowWidth: 0.45,
    extraWideWidth: 0.55,
    tallHeight: 1.8,
    highHeight: 1.62,
    almostHighHeight: 1.584,
    mediumHeight: 1.548,
    lowHeight: 1.44,
    shortHeight: 1.152,
    halfHeight: 1.008,
    quarterHeight: 0.81,
  },
  /** Steel personnel locker. */
  locker: { width: 0.9, height: 1.85, depth: 0.5 },
  /** Jersey-type concrete barricade. */
  barricade: { height: 1.0, depth: 0.6 },
  /** Perimeter wall. */
  wallHeight: 5.5,
  /** Handrail above its walking surface. */
  handrailHeight: 1.0,
  /** Visible muzzle flame. */
  muzzleFlash: 0.3,
  /** Small sole-to-ankle allowance used by the grounding solver. */
  ankleHeight: 0.02,
  /** Radius used to turn the head bone centre into a hit-zone boundary. */
  headRadius: 0.11,
  /** Fallback leg-zone fraction for rigs without named knee bones. */
  legZoneFraction: 0.36,
  /** Walking surface at the top of the raised range walkway. */
  walkwaySurface: 3.68,
  /** Raised walkway and ramp envelope. */
  walkway: { width: 9.4, depth: 5.6, thickness: 0.36 },
  ramp: { width: 2.6, length: 7.4, steps: 24 },
  /** Open drum dimensions used by the range shell and its arc colliders. */
  drum: { radius: 3.7, height: 1.55 },
} as const;
