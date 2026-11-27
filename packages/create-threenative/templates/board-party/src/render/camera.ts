// Two framings, one camera. The board is seen from above and a little south at the 45 degree lens the
// engine ships as its default, panning toward the active pawn: each update the remaining pan divides by
// a fixed divisor. The arena is a cut to a long narrow lens that flattens a wide stage.
// Reference: mario-party-1 `board-camera-follow` (pan divisor 3, src/overlays/ovl_3E_FirstMap/257020.c:228),
// `camera-slot-defaults` (45 degree lens, src/1DE40.c:14) and `minigame-camera-bringup` (10 degree lens,
// src/overlays/ovl_6F_MinigameInstructions/2DB2D0.c:67).
import { type PerspectiveCamera, Vector3 } from "three";
import { ARENA } from "../minigames/minigame.js";

const BOARD_FOV = 45;
const MINIGAME_FOV = 10;
/** The board camera sits high and a little south of what it looks at. */
const BOARD_OFFSET = new Vector3(0, 28, 12);
/** The arena camera tilts 35 degrees down (mario-party-1 `camera-slot-defaults` orbit rotation x 325). */
const ARENA_DISTANCE = 78;
const ARENA_OFFSET = new Vector3(
  0,
  Math.sin((35 * Math.PI) / 180) * ARENA_DISTANCE,
  Math.cos((35 * Math.PI) / 180) * ARENA_DISTANCE,
);
/** How much of the active pawn's position the board pan follows. The board fits on screen, so a third. */
const PAN_SHARE = 0.35;
/** The pan divisor, applied per update at 60 Hz. mario-party-1 `board-camera-follow` (257020.c:228). */
const PAN_DIVISOR = 3;
const _want = new Vector3();

export interface ICameraRig {
  /** Pan toward a board point, or hold the arena. */
  readonly follow: (x: number, z: number, arena: boolean, dt: number) => void;
}

export function createCamera(camera: PerspectiveCamera): ICameraRig {
  let arenaMode: boolean | undefined;
  const aim = new Vector3();
  return {
    follow: (x, z, arena, dt) => {
      if (arena !== arenaMode) {
        // A cut: the lens changes, so there is nothing to blend.
        arenaMode = arena;
        camera.fov = arena ? MINIGAME_FOV : BOARD_FOV;
        camera.updateProjectionMatrix();
        aim.set(arena ? ARENA.x : x * PAN_SHARE, 0, arena ? ARENA.z : z * PAN_SHARE);
        camera.position.copy(aim).add(arena ? ARENA_OFFSET : BOARD_OFFSET);
      }
      if (!arena) {
        _want.set(x * PAN_SHARE, 0, z * PAN_SHARE);
        aim.lerp(_want, 1 - (1 - 1 / PAN_DIVISOR) ** (dt * 60));
        camera.position.copy(aim).add(BOARD_OFFSET);
      }
      camera.lookAt(aim);
    },
  };
}
