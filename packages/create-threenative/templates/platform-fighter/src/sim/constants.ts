// Every number the fighters feel, in one file, with the reference card it comes from.
//
// Reference: the `super-smash-bros-vetritheretri` card set of the reference MCP (a decompilation
// of a 1999 platform fighter). The cards give speeds in world units per frame at 60 Hz. One card
// unit is `UNIT` metres here, chosen so that the card's run speed (44) is 7.9 m/s for a 1.8 m
// mannequin and a full hop clears 3 m. Only algorithms and default constants are borrowed.

/** The simulation runs on fixed 60 Hz frames, exactly like the card's frame data. */
export const STEP = 1 / 60;
/** Metres per card world unit. */
export const UNIT = 0.003;
const speed = (unitsPerFrame: number): number => unitsPerFrame * UNIT * 60;
const accel = (unitsPerFrameSquared: number): number => unitsPerFrameSquared * UNIT * 3600;

/** Hurtbox: the fighter is a box, feet at `y`, 0.7 m wide and 1.8 m tall. */
export const HALF_WIDTH = 0.35;
export const HEIGHT = 1.8;

// --- Ground movement. Cards `walk-speed-tiers`, `dash-run-transition`, `ground-friction`.
/** Full-tilt walk: stick 80 units times the walk multiplier 0.3 (203_MarioMain.c:243). */
export const WALK_SPEED = speed(80 * 0.3);
/** Run speed 44 (203_MarioMain.c:247). A stick tilt of 0.7 or more runs (ftcommon.h:33, 50/80 rounded up). */
export const RUN_SPEED = speed(44);
export const RUN_THRESHOLD = 0.7;
/** The burst a flick starts with, 54 (203_MarioMain.c:245), shed at 2.8 per frame (203_MarioMain.c:246). */
export const DASH_SPEED = speed(54);
export const DASH_DECEL = accel(2.8);
/** Floor friction 4 times traction 1.5 (mpcollision.c:15, 203_MarioMain.c:244). */
export const GROUND_FRICTION = accel(4 * 1.5);
/** A knocked-back fighter slides on a quarter of that (ftmain.c:1791). */
export const SLIDE_FRICTION = GROUND_FRICTION * 0.25;

// --- Air. Cards `air-drift-and-gravity`, `fast-fall`, `jump-force-and-shorthop`, `double-jump`.
export const GRAVITY = accel(2.4); // 203_MarioMain.c:257
export const TERMINAL_SPEED = speed(44); // 203_MarioMain.c:258
export const FAST_FALL_SPEED = speed(70); // 203_MarioMain.c:259
/** Stick 80 units at 0.025 per unit (203_MarioMain.c:254). */
export const AIR_ACCEL = accel(80 * 0.025);
export const AIR_MAX_SPEED = speed(30); // 203_MarioMain.c:255
export const AIR_FRICTION = accel(0.2); // 203_MarioMain.c:256
/** Speed above the limit is stepped down by 1 per frame (ftphysics.c:278). */
export const AIR_OVERSPEED_DECAY = accel(1);
/** Full hop: jump base 26 plus long-jump minimum 63 times 0.7 (203_MarioMain.c:250-251, ftcommon.h:51). */
export const FULL_HOP = speed(26 + 63 * 0.7);
/** Short hop: the same with the short-jump minimum 36 (ftcommon.h:50). */
export const SHORT_HOP = speed(26 + 36 * 0.7);
/** Release the jump button inside this many frames of the knee bend for a short hop (ftcommon.h:54). */
export const JUMP_SQUAT = 3;
/** The first extra jump (ftcommonjumpaerial.c:10). */
export const DOUBLE_JUMP = speed(60);
/** A downward flick below this tilt fast-falls (ftcommon.h:70) or drops through a platform (ftcommon.h:126). */
export const DOWN_FLICK = -53 / 80;

// --- Damage. Cards `knockback-formula`, `hitstun-and-damage-levels`, `hitlag-freeze`.
export const KB_WEIGHT_FACTOR = 1.4; // ftparam.c:1457
export const KB_BASE = 18; // ftparam.c:1457
export const KB_DAMAGE_COEF = 0.1; // ftparam.c:1463
export const KB_HIT_COEF = 0.05; // ftparam.c:1463
export const KB_CAP = 2500; // ftparam.c:1465
/** Hitstun frames are knockback divided by this (ftparam.c:1507). */
export const HITSTUN_DIVISOR = 1.875;
/** More hitstun than this lifts a grounded fighter off the floor (ftcommon.h:106). */
export const HEAVY_HITSTUN = 32;
/** Hitlag: damage over 3 plus 5 frames, for both fighters (ftparam.c:1514). */
export const hitlagFrames = (damage: number): number => Math.floor(damage / 3 + 5);
/**
 * Tuned for this kit, not borrowed: metres per second of launch speed per knockback unit, and the
 * deceleration of that launch. A strong hit at 120 percent crosses a 14 m stage and its blast zone.
 */
export const LAUNCH_PER_KB = 0.15;
export const LAUNCH_DECAY = 15;

// --- Shield. Cards `shield-decay-and-size`, `shield-pushback`.
export const SHIELD_MAX = 55; // ftmanager.c:431
export const SHIELD_DECAY_EVERY = 16; // ftcommon.h:234
export const SHIELD_HEAL_EVERY = 10; // ftmain.c:3845
export const SHIELD_BREAK_HEALTH = 30; // ftmain.c:3852
/** Size is 0.65 plus 0.35 times the health ratio (ftcommon.h:236-238). */
export const shieldScale = (health: number): number => 0.65 + 0.35 * (health / SHIELD_MAX);
/** Radius of the bubble at full health, metres. A body is 1.8 m tall. */
export const SHIELD_RADIUS = 1.05;
/** Shieldstun is 1.62 frames per damage point plus 4 (ftcommon.h:241,245). */
export const shieldStunFrames = (damage: number): number => Math.round(damage * 1.62 + 4);
/** Pushback: two card units per stun frame, in metres per second (ftcommon.h:246). */
export const SHIELD_PUSH_PER_STUN = 2 * UNIT * 60;
/** Frames before a fighter can act after it lets go of the shield (ftcommon.h:233). */
export const SHIELD_RELEASE = 8;
/** A broken shield leaves the fighter helpless this long. Tuned for this kit. */
export const SHIELD_BREAK_STUN = 180;

// --- Dodge roll. Tuned for this kit around the roll clip: 34 frames, intangible on frames 4 to 21.
export const ROLL_FRAMES = 34;
export const ROLL_INTANGIBLE_START = 4;
export const ROLL_INTANGIBLE_FRAMES = 18;
export const ROLL_DISTANCE = 3.2;
export const ROLL_MOVE_END = 26;

// --- Ledge. Card `ledge-hold`.
export const LEDGE_COOLDOWN = 30; // ftcommon.h:178
export const LEDGE_HOLD_HIGH_DAMAGE = 480; // ftcommon.h:182
export const LEDGE_HOLD_LOW_DAMAGE = 1080; // ftcommon.h:183
export const LEDGE_HIGH_DAMAGE_PERCENT = 100; // ftcommon.h:180
/** Intangible frames after a grab and through a get-up. Tuned for this kit. */
export const LEDGE_INVULN = 30;
export const GETUP_FRAMES = 36;
/** The feet of a fighter hanging on a ledge, relative to the ledge, and how far it hangs out. */
export const LEDGE_HANG_Y = -1.55;
/** Frames a fresh grab ignores the stick, so the grab cannot be dropped by the stick that made it. */
export const LEDGE_LOCK = 8;

// --- Blast zone and respawn. Card `blast-zone-knockout`. Frames and invulnerability tuned for this kit.
export const RESPAWN_DELAY = 90;
export const RESPAWN_INVULN = 120;
export const STOCKS = 3;
/** The CPU is a little heavier than the player, so weight shows in every fight. */
export const CPU_WEIGHT = 1.25;

// --- Charging a strong attack. Tuned for this kit: hold up to one second for 40 percent more damage.
export const CHARGE_FRAMES = 60;
export const CHARGE_BONUS = 0.4;
