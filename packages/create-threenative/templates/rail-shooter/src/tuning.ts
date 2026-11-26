// Every number the rail shooter feels from, in one place.
//
// The reference is the Star Fox 64 reverse-engineering card set (`star-fox-64`, pinned to
// sonicdcer/sf64 4235c59). The cards give speeds in units per update at 30 updates a second. This
// kit keeps the card's ratios and scales them to metres: one card unit is `UNIT` metres. A constant
// without a card id beside it is this kit's own tuning.

const UPDATE_HZ = 30;
const UNIT = 0.4;
const PER_SECOND = UPDATE_HZ;
const DEGREES = Math.PI / 180;

export const SHIP = {
  /** Rail speed with no key held, m/s. Own tuning. */
  cruise: 22,
  /** arwing-boost: speed ceiling above cruise, 30 units (fox_play.c:5058). */
  boostMax: 30 * UNIT,
  /** arwing-boost: +2 units per update (fox_play.c:5057). */
  boostAccel: 2 * PER_SECOND * UNIT,
  /** arwing-brake: floor of 20 units below cruise (fox_play.c:5154). */
  brakeMin: -20 * UNIT,
  /** arwing-brake: -1 unit per update (fox_play.c:5153). */
  brakeDecel: 1 * PER_SECOND * UNIT,
  /** arwing-brake: speed returns 0.5 unit per update when a key is up (fox_play.c:5168). */
  speedRecover: 0.5 * PER_SECOND * UNIT,
  /** arwing-boost: one shared gauge, 0 to 90 (fox_play.c:5048). */
  gaugeMax: 90,
  /** arwing-boost and arwing-brake: +3 per update on rails (fox_play.c:4962, 5093). */
  gaugeFill: 3 * PER_SECOND,
  /** arwing-boost and arwing-brake: -0.5 per update on rails (fox_play.c:4963, 5094). */
  gaugeRecover: 0.5 * PER_SECOND,
  /** The corridor around the rail, half width and half height in metres. Own tuning. */
  boxX: 11,
  boxY: 6,
  /** Lateral speed at full stick, m/s, and how fast it follows the stick (per second). Own tuning. */
  steerSpeed: 15,
  steerRate: 7,
  /** pitch-yaw: lateral and vertical velocity are spread by 1.4 on rails (fox_play.c:3580). */
  railSpread: 1.4,
  /** banking: a held shoulder button drives the bank target to 90 degrees (fox_play.c:3368). */
  bankHold: 90 * DEGREES,
  /** banking: the bank chases its target by 0.2 of the gap per update (fox_play.c:3369) as a rate per second. */
  bankChase: -Math.log(1 - 0.2) * PER_SECOND,
  /** banking: at most 10 degrees per update (fox_play.c:3366). */
  bankLimit: 10 * PER_SECOND * DEGREES,
  /** The bank a full stick adds, radians. Own tuning. */
  bankLean: 0.6,
  /** Hull radius for shots, metres. Own tuning. */
  radius: 1.3,
} as const;

export const ROLL = {
  /** barrel-roll: the second press must land within 10 updates (fox_play.c:3405). */
  tapWindow: 10 / UPDATE_HZ,
  /** barrel-roll: the spin lasts 10 updates (fox_play.c:3401). */
  spinTime: 10 / UPDATE_HZ,
  /** barrel-roll: 30 degrees per update while it spins (fox_play.c:3402). */
  spinRate: 30 * PER_SECOND * DEGREES,
  /**
   * barrel-roll: the rate then decays (fox_play.c:4857). The card decays 5 degrees per update per
   * update, which leaves 390 degrees. This kit decays so the whole roll is exactly one turn.
   */
  decayTime: (360 * DEGREES - 30 * PER_SECOND * DEGREES * (10 / UPDATE_HZ)) / (0.5 * 30 * PER_SECOND * DEGREES),
  /** barrel-roll: lateral velocity x1.5 during a roll (fox_play.c:4853). */
  steerScale: 1.5,
  /** How far from the hull a shot is turned back while the roll lasts, metres. Own tuning. */
  deflectRadius: 2.6,
  /** A turned shot flies back at this multiple of its speed and hurts enemies. Own tuning. */
  returnSpeed: 1.4,
} as const;

export const SHIELD = {
  /** shield-damage: the pool is 255 points (fox_play.c:4414). */
  max: 255,
  /** shield-damage: damage and healing apply 2 points per update (fox_play.c:5465, 5469, 5482). */
  rate: 2 * PER_SECOND,
  /** shield-damage: 20 updates of invulnerability after a hit (fox_play.c:888). */
  mercy: 20 / UPDATE_HZ,
  /** One scout shot, points. Own tuning. */
  shotDamage: 30,
  /** What a shield ring restores, points. Own tuning. */
  pickup: 100,
  /** shield-damage: the soft and hard warnings sit at 100 and 50 points (fox_play.c:900, 898). */
  warnSoft: 100,
  warnHard: 50,
} as const;

export const LASER = {
  /** laser-fire: a held button repeats every 4 updates (fox_play.c:3319). */
  interval: 4 / UPDATE_HZ,
  /** Bolt speed relative to the ship, m/s, and life in seconds. Own tuning. */
  speed: 120,
  life: 0.7,
  damage: 1,
} as const;

export const CHARGE = {
  /** charge-lock-on: the counter saturates at 21 updates (fox_play.c:3192). */
  full: 21 / UPDATE_HZ,
  /** charge-lock-on: searching starts past 20 updates and repeats every 4 (fox_play.c:3202, 3201). */
  searchFrom: 20 / UPDATE_HZ,
  searchEvery: 4 / UPDATE_HZ,
  /** charge-lock-on: a release past 10 updates fires the homing shot (fox_play.c:3243). */
  releaseMin: 10 / UPDATE_HZ,
  /** lock-on-tracking: a mark lasts 20 updates (fox_beam.c:1769). */
  markLife: 20 / UPDATE_HZ,
  /** lock-on-tracking: the search box, scaled to this kit's smaller scene, metres (fox_beam.c:1759). */
  searchRadius: 16,
  /** charge-lock-on: the homing shot lives 30 updates (fox_play.c:2953). */
  life: 30 / UPDATE_HZ,
  /** Speed relative to the ship, m/s, and damage. Own tuning. */
  speed: 95,
  damage: 6,
  /** lock-on-tracking: the turn rate ramps 3 degrees per update per update (fox_beam.c:2226). */
  turnRamp: 3 * PER_SECOND * PER_SECOND * DEGREES,
  turnMax: 360 * PER_SECOND * DEGREES,
} as const;

export const AIM = {
  /** How far ahead of the nose the reticle floats, metres. Own tuning. */
  distance: 45,
  /** How far the reticle leads the stick, metres either way. Own tuning. */
  leadX: 7,
  leadY: 4,
  follow: 14,
} as const;

export const CAMERA = {
  /** camera-rails: the eye follows the ship's offset at roughly 0.78 (fox_play.c:6110). */
  follow: 0.78,
  /** Setback behind the ship and lift above it, metres. Own tuning. */
  back: 11,
  lift: 3.4,
  look: 16,
  /** arwing-boost and arwing-brake: boost pulls the camera back, braking pulls it in (fox_play.c:5061, 5158). */
  boostBack: 4,
  brakeBack: -3,
  fov: 62,
  boostFov: 72,
  roll: 0.25,
} as const;

export const ENEMY = {
  /** Shot speed in the world, m/s, and the aim error that keeps a dodge possible. Own tuning. */
  shotSpeed: 38,
  shotLife: 4,
  shotRadius: 0.6,
  /** Enemies fire only inside this band ahead of the ship, metres. Own tuning. */
  fireNear: 10,
  fireFar: 105,
  scout: { hp: 2, radius: 1.8, interval: 1.7, speed: 34, score: 100 },
  gunship: { hp: 6, radius: 3, interval: 2.4, speed: 28, score: 250 },
} as const;

export const BOSS = {
  /** The ship holds at the end of the rail; the boss hangs this far beyond it, metres. Own tuning. */
  ahead: 55,
  engageDistance: 140,
  pod: { hp: 12, radius: 2.8, interval: 1.5, score: 500 },
  core: { hp: 30, radius: 3.6, score: 3000 },
  /** Phase 3 starts when the core falls under this share of its hit points. */
  rageShare: 0.4,
  sway: { x: 5, y: 1.8, speed: 0.7 },
} as const;
