// Every number the Lara-style body runs on, in one place.
//
// The simulation runs in the reference engine's own units at its own rate: 30 updates per second
// (`simulationRate`, TRX src/trx/game/const.h:5). Speeds are "units per update", angles are 1/65536
// of a turn. Only the render layer converts to metres (`UNIT`). Each constant names its card in
// `tomb-raider-i-ii` (see `engine_reference_detail`) as `card:file:line`. A constant marked "own" is
// not on any card: the kit tuned it by feel and by the playtests.

/** Metres per world unit: the 762-unit body of `bodyHeight` (const.h:13) is the mannequin's 1.8 m. */
export const UNIT = 1.8 / 762;
/** One simulation update, seconds. */
export const TICK = 1 / 30;
/** One angle unit in radians (65536 per full turn, run-steering card). */
export const ANGLE = (Math.PI * 2) / 65536;

/** One sector (a block of the grid) in units. room-portals card: const.h:8 (1024 per sector edge). */
export const SECTOR = 1024;
/** One "click", the height step the level is authored in: a quarter sector (own). */
export const CLICK = 256;

export const BODY_HEIGHT = 762; // collision-probes card: lara/const.h:13
export const BODY_RADIUS = 100; // collision-probes card: lara/const.h:16
/** Highest step she walks up or down; taller is a wall, deeper is a fall. roll card: const.h:36. */
export const STEP = 384;

export const HEALTH_POOL = 1000; // fall-damage card: lara/const.h:8
export const AIR_SUPPLY = 1800; // water-and-air card: lara/const.h:9

// --- Run steering and the turn ramp (run-steering card; sprint is not in this kit) ---------------
/** Turn rate added each update a direction is held. lara/const.h:20 */
export const TURN_INCREMENT = 409;
/** Turn rate removed each update no direction is held. lara/const.h:19 */
export const TURN_UNDO = 364;
/** Peak turn rate on the run and on the walk. lara/state/land.c:20, lara/const.h:21 */
export const RUN_TURN_CAP = 1456;
export const WALK_TURN_CAP = 728;
/** Body lean into a turn: roll units gained per update, and the cap. lara/const.h:25, const.h:26 */
export const LEAN_RATE = 273;
export const LEAN_CAP = 2002;
/** Airborne turn cap, a third of the run cap. lara/state/jump.c:11 */
export const JUMP_TURN_CAP = 546;
/** Turn rate while swimming: the walk cap, "the medium turn cap" (swim-dive card, swim.c:77). */
export const SWIM_TURN_CAP = WALK_TURN_CAP;

// --- Ground speeds (own: the cards give no forward speed) ----------------------------------------
export const RUN_SPEED = 80;
export const WALK_SPEED = 36;
export const BACK_SPEED = 28;
export const GROUND_ACCEL = 12;

// --- Jump, gravity, fall (jump, gravity, fall-damage cards) ---------------------------------------
/** Vertical speed gained per update, then the cap, then the slower growth past it. common.c:626 */
export const GRAVITY = 6;
export const TERMINAL_SPEED = 128; // const.h:12
export const TERMINAL_GROWTH = 1;
/** A press from standing compresses first, then launches (jump card, jump.c:20). Updates: own. */
export const COMPRESS_UPDATES = 4;
/** Launch speeds, own. Standing: 1.6 sectors of reach, one gap. Running: 2.7 sectors, two gaps. */
export const JUMP_RISE = 100;
export const STAND_JUMP_SPEED = 50;
export const RUN_JUMP_SPEED = 85;
/** How far ahead the floor is probed to pick the jump direction. const.h:7 */
export const DIRECTION_PROBE = 256;
/** Landing speed at which damage starts, the span over which it ramps, and the fatal limit. */
export const DAMAGE_START_SPEED = 140; // lara/const.h:39
export const DAMAGE_LENGTH = 14; // lara/const.h:40

// --- Ledge grab, hang, shimmy, climb (ledge-grab and climb-shimmy cards) --------------------------
/** The facing must lie within 35 degrees of a cardinal direction. lara/const.h:30 (6370 units). */
export const GRAB_CONE = 6370 * ANGLE;
/** The floor she passes over must lie this far below her, so she cannot grab while standing. jump.c:81 */
export const MIN_FLOOR_DROP = 200;
/** The ceiling above her head must clear the step allowance (ledge-grab card, jump.c:20). */
export const HEAD_CLEARANCE = STEP;
/** A hang needs this much drop under the ledge, else the catch is a stand-up. climb.c:11 */
export const MIN_HANG_DROP = 900;
/** Two ends of a ledge under her may differ by this much. lara/const.h:37 */
export const SLOPE_TOLERANCE = 60;
/** The reach window and the hang depth, own: hands sit 800 above the feet, reach 450 to 1000. */
export const HANG_REACH = 800;
export const GRAB_WINDOW: readonly [number, number] = [450, 1000];
/** How far from the wall face a catch is still offered: radius plus a hand. own */
export const GRAB_DISTANCE = BODY_RADIUS + 180;
/** Hanging body sits this far off the wall face. own */
export const HANG_OFFSET = BODY_RADIUS + 30;
export const SHIMMY_SPEED = 16; // own
/** Headroom the pull-up needs above the ledge: one body height. own */
export const PULL_UP_HEADROOM = BODY_HEIGHT;
/** The pull-up and the vault take this many updates (own) and end this far onto the ledge. */
export const CLIMB_UPDATES = 27;
export const CLIMB_DEPTH = 360;

// --- Water, swimming, air (water-and-air and swim-dive cards) -------------------------------------
/** Water deeper than this over the floor makes her swim; a shelf under two steps is stood on. control.c:1050 */
export const SWIM_DEPTH = 730; // lara/const.h:17
export const SHELF_DEPTH = STEP * 2; // swim.c:233 "less than two steps"
export const UNDERWATER_SPEED_CAP = 200; // state/swim.c:12
export const SURFACE_SPEED_CAP = 60; // state/swim.c:11
export const SWIM_GAIN = 8; // state/swim.c:110
export const SWIM_COAST = 6; // state/swim.c:136
/** Below two thirds of the cap a glide becomes treading water. state/swim.c:136 */
export const TREAD_FRACTION = 2 / 3;
export const DIVE_DELAY = 10; // lara/const.h:10
export const DIVE_START_SPEED = 80; // state/swim.c:179
export const DIVE_PITCH = -Math.PI / 4; // 45 degrees down (swim-dive card)
/** The card speeds are "fall speeds"; a move step is a quarter of one. own */
export const SWIM_MOVE_DIVISOR = 4;
export const SWIM_PITCH_RATE = 546; // own, the jump turn cap
/** Half the swimming body's height, and how far below the plane the surface body is parked. own */
export const SWIM_HALF_HEIGHT = 300;
export const SURFACE_PARK = 100;
export const AIR_REFILL_SURFACE = 10; // control.c:951
export const DROWN_DAMAGE = 5; // control.c:32

// --- Pickup (item-pickup card) --------------------------------------------------------------------
export const PICKUP_HALF_WIDTH = 256; // "a quarter of a wall sideways" (pickup.c:60)
export const PICKUP_HALF_HEIGHT = 100; // pickup.c:63
export const PICKUP_FRONT: readonly [number, number] = [0, 900]; // own: the item's front, not behind it
export const PICKUP_STAND_DISTANCE = 420; // own
export const PICKUP_MOVE_STEP = 16; // common.c:38
export const PICKUP_MOVE_TURN = 364; // common.c:39
export const PICKUP_UPDATES = 36; // own: 1.2 s of PickUp_Table

// --- Chase camera (camera-follow card) -------------------------------------------------------------
export const CAMERA_CHASE = 10; // los_camera.c:16 — the gap is divided by this each update
export const CAMERA_DISTANCE = 1536; // camera/const.h:7
export const CAMERA_PITCH = 1820 * ANGLE; // los_camera.c:12, ten degrees down
export const CAMERA_MARGIN = 255; // los_camera.c:369
/** The aim point sits this far above the feet, inside the body. own */
export const CAMERA_AIM_HEIGHT = 560;

// --- Trap (own) -------------------------------------------------------------------------------------
export const BLADE_DAMAGE = 400;
export const BLADE_INVULNERABLE_UPDATES = 30;
